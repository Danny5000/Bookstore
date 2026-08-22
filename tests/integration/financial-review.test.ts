import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdministratorActor } from '$lib/server/auth/admin-policy';
import {
  FINANCIAL_ISSUE_PAGE_SIZE,
  decodeFinancialIssueCursor,
  getFinancialIssueDetail,
  listFinancialIssues
} from '$lib/server/commerce/reporting/review';
import { FINANCIAL_ISSUE_DTO_KEYS } from '$lib/types/financial-reporting';
import { databaseClient, ownerDatabaseClient } from './database';

let sequence = 0;

function token(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}_${randomUUID().replaceAll('-', '')}`;
}

async function createAdministrator(label: string): Promise<AdministratorActor> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [id, `Review administrator ${label}`, `${label}-${id}@example.test`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [id]
  );
  return { type: 'user', id, roles: ['admin'] };
}

interface RefundFixture {
  readonly paymentId: string;
  readonly refundId: string;
  readonly chargeId: string;
}

async function createActionableRefund(
  actor: AdministratorActor,
  label: string
): Promise<RefundFixture> {
  const email = `${label}-${actor.id}@example.test`;
  const order = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into orders
       (status, initiating_user_id, purchase_email, currency, subtotal_minor, tax_minor,
        total_minor, client_checkout_attempt_id, quote_fingerprint_sha256,
        status_token_sha256, paid_at)
     values ('paid', $1, $2, 'USD', 1000, 0, 1000, $3,
             repeat('a', 64), repeat('b', 64), '2026-08-01T09:00:00.000Z')
     returning id`,
    [actor.id, email, randomUUID()]
  );
  const chargeId = token('review_private_charge');
  const payment = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into payments
       (order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
        amount_minor, currency, paid_at, financial_evidence_status)
     values ($1, $2, $3, 'succeeded', 1000, 'USD',
             '2026-08-01T09:00:00.000Z', 'pending')
     returning id`,
    [order.rows[0]!.id, token('review_private_intent'), chargeId]
  );
  const refund = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refunds
       (payment_id, stripe_refund_id, status, amount_minor, currency,
        provider_created_at, allocation_status, financial_evidence_status)
     values ($1, $2, 'succeeded', 500, 'USD', '2026-08-01T10:00:00.000Z',
             'needs_review', 'pending')
     returning id`,
    [payment.rows[0]!.id, token('review_private_refund')]
  );
  return {
    paymentId: payment.rows[0]!.id,
    refundId: refund.rows[0]!.id,
    chargeId
  };
}

async function insertIssue(input: {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly safeCode: string;
  readonly impact: 'pending' | 'exception' | 'informational';
  readonly observedAt?: string;
}): Promise<string> {
  const result = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into financial_reconciliation_issues
       (resource_type, resource_id, safe_code, impact, first_observed_at,
        last_observed_at, correlation_id)
     values ($1, $2, $3, $4, $5, $5, $6)
     returning id`,
    [
      input.resourceType,
      input.resourceId,
      input.safeCode,
      input.impact,
      input.observedAt ?? '2026-08-01T10:00:00.000Z',
      token('review_private_issue')
    ]
  );
  return result.rows[0]!.id;
}

async function insertVersionedAuthorityWitnesses(
  refund: RefundFixture
): Promise<{
  readonly activeClassificationIssueId: string;
  readonly retiredClassificationIssueId: string;
  readonly currentAllocationIssueId: string;
  readonly supersededAllocationIssueId: string;
}> {
  const fingerprint = 'c'.repeat(64);
  const balance = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into stripe_balance_transactions
       (provider_id, live_mode, source_family, source_id, raw_type, reporting_category,
        balance_type, amount_minor, fee_minor, net_minor, currency, status,
        provider_created_at, available_at, fingerprint_sha256)
     values ($1, false, 'charge', $2, 'future_kind', 'future_kind', 'payments',
             1000, 0, 1000, 'USD', 'available', '2026-08-01T09:00:00.000Z',
             '2026-08-02T09:00:00.000Z', $3)
     returning id`,
    [token('review_private_balance'), refund.chargeId, fingerprint]
  );
  const classifications: string[] = [];
  const classificationIssues: string[] = [];
  for (const classifierVersion of [1, 2]) {
    const classificationId = randomUUID();
    const issue = await ownerDatabaseClient.pool.query<{ id: string }>(
      `with inserted_classification as (
         insert into financial_classification_versions
           (id, subject_type, subject_id, classifier_version, classification,
            source_fingerprint_sha256)
         values ($1, 'balance_transaction', $2, $3, 'unknown', $4)
         returning id
       )
       insert into financial_reconciliation_issues
         (resource_type, resource_id, safe_code, impact, first_observed_at,
          last_observed_at, correlation_id)
       select 'financial_classification', id, 'unsupported_category', 'exception',
              '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z', $5
       from inserted_classification
       returning id`,
      [
        classificationId,
        balance.rows[0]!.id,
        classifierVersion,
        fingerprint,
        token('review_private_issue')
      ]
    );
    classifications.push(classificationId);
    classificationIssues.push(issue.rows[0]!.id);
  }
  const root = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into financial_allocation_sets
       (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
        basis, scope, expected_effect_minor, currency, algorithm_version,
        classifier_version, source_fingerprint_sha256)
     values ($1, $2, 'payment', $3, 'gross_amount', 'account', 1000, 'USD', 2, 1, $4)
     returning id`,
    [token('review_root'), balance.rows[0]!.id, refund.paymentId, fingerprint]
  );
  const successor = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into financial_allocation_sets
       (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
        basis, scope, expected_effect_minor, currency, algorithm_version,
        classifier_version, source_fingerprint_sha256, supersedes_set_id)
     values ($1, $2, 'payment', $3, 'gross_amount', 'account', 1000, 'USD', 2, 1, $4, $5)
     returning id`,
    [token('review_successor'), balance.rows[0]!.id, refund.paymentId, fingerprint, root.rows[0]!.id]
  );
  return {
    activeClassificationIssueId: classificationIssues[0]!,
    retiredClassificationIssueId: classificationIssues[1]!,
    supersededAllocationIssueId: await insertIssue({
      resourceType: 'allocation_set',
      resourceId: root.rows[0]!.id,
      safeCode: 'immutable_mismatch',
      impact: 'exception'
    }),
    currentAllocationIssueId: await insertIssue({
      resourceType: 'allocation_set',
      resourceId: successor.rows[0]!.id,
      safeCode: 'immutable_mismatch',
      impact: 'exception'
    })
  };
}

describe('operational financial Needs Review', () => {
  it('returns only current authority, derives actionability, and exposes the exact safe DTO', async () => {
    const actor = await createAdministrator('authority');
    const refund = await createActionableRefund(actor, 'authority');
    const actionableIssueId = await insertIssue({
      resourceType: 'refund',
      resourceId: refund.refundId,
      safeCode: 'allocation_incomplete',
      impact: 'pending'
    });
    const witnesses = await insertVersionedAuthorityWitnesses(refund);

    const result = await listFinancialIssues(databaseClient.db, actor, {
      pageSize: FINANCIAL_ISSUE_PAGE_SIZE
    });
    const ids = result.issues.map((issue) => issue.issueId);

    expect(ids).toContain(actionableIssueId);
    expect(ids).toContain(witnesses.activeClassificationIssueId);
    expect(ids).toContain(witnesses.currentAllocationIssueId);
    expect(ids).not.toContain(witnesses.retiredClassificationIssueId);
    expect(ids).not.toContain(witnesses.supersededAllocationIssueId);
    expect(ids).toEqual([
      actionableIssueId,
      ...[
        witnesses.activeClassificationIssueId,
        witnesses.currentAllocationIssueId
      ].sort()
    ]);
    expect(result.issues.find((issue) => issue.issueId === actionableIssueId)).toMatchObject({
      actionability: 'refund_allocation_review',
      refundId: refund.refundId,
      operationallyCurrent: true
    });
    for (const issue of result.issues) {
      expect(Object.keys(issue)).toEqual(FINANCIAL_ISSUE_DTO_KEYS);
    }
    expect(JSON.stringify(result)).not.toMatch(
      /correlationId|providerId|stripe|purchaseEmail|requestMetadata/iu
    );
    await expect(ownerDatabaseClient.pool.query(
      `select count(*)::integer as count from audit_events`
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('pages across actionability and impact ranks without gaps or duplicates', async () => {
    const actor = await createAdministrator('pagination');
    const created = await ownerDatabaseClient.pool.query<{
      id: string;
      safe_code: string;
    }>(
      `with inserted_orders as (
         insert into orders
           (status, initiating_user_id, purchase_email, currency, subtotal_minor, tax_minor,
            total_minor, client_checkout_attempt_id, quote_fingerprint_sha256,
            status_token_sha256, paid_at)
         select 'paid', $1, $2, 'USD', 100, 0, 100, gen_random_uuid(),
                repeat('a', 64), repeat('b', 64), '2026-08-01T09:00:00.000Z'
         from generate_series(1, 51)
         returning id
       ), inserted_payments as (
         insert into payments
           (order_id, stripe_payment_intent_id, status, amount_minor, currency,
            paid_at, financial_evidence_status)
         select id, 'review_page_' || id::text, 'succeeded', 100, 'USD',
                '2026-08-01T09:00:00.000Z', 'pending'
         from inserted_orders
         returning id
       ), numbered_payments as (
         select id, row_number() over (order by id) as ordinal
         from inserted_payments
       )
       insert into financial_reconciliation_issues
         (resource_type, resource_id, safe_code, impact, first_observed_at,
          last_observed_at, correlation_id)
       select 'payment', id,
              case when ordinal <= 50 then 'missing_source' else 'immutable_mismatch' end,
              (case when ordinal <= 50 then 'pending' else 'exception' end)::financial_issue_impact,
              '2026-08-01T10:00:00.123456Z', '2026-08-01T10:00:00.123456Z',
              'review-page-' || id::text
       from numbered_payments
       returning id::text, safe_code`,
      [actor.id, `pagination-${actor.id}@example.test`]
    );
    const waitingIds = created.rows
      .filter((row) => row.safe_code === 'missing_source')
      .map((row) => row.id)
      .sort();
    const exceptionIds = created.rows
      .filter((row) => row.safe_code === 'immutable_mismatch')
      .map((row) => row.id);
    expect(waitingIds).toHaveLength(50);
    expect(exceptionIds).toHaveLength(1);
    const expectedIds = [...waitingIds, ...exceptionIds];

    const first = await listFinancialIssues(databaseClient.db, actor, {
      pageSize: FINANCIAL_ISSUE_PAGE_SIZE
    });
    expect(first.issues).toHaveLength(50);
    expect(first.issues.every((issue) => issue.actionability === 'wait_for_recovery')).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(decodeFinancialIssueCursor(first.nextCursor!).issueId).toBe(first.issues[49]!.issueId);
    const second = await listFinancialIssues(databaseClient.db, actor, {
      pageSize: FINANCIAL_ISSUE_PAGE_SIZE,
      cursor: decodeFinancialIssueCursor(first.nextCursor!)
    });
    const returnedIds = [...first.issues, ...second.issues].map((issue) => issue.issueId);

    expect(returnedIds).toEqual(expectedIds);
    expect(new Set(returnedIds).size).toBe(51);
    expect(second.issues).toMatchObject([{
      impact: 'exception',
      actionability: 'read_only'
    }]);
    expect(second.nextCursor).toBeNull();
  });

  it('audits one successful current detail read and never returns request or provider metadata', async () => {
    const actor = await createAdministrator('detail');
    const refund = await createActionableRefund(actor, 'detail');
    const issueId = await insertIssue({
      resourceType: 'refund',
      resourceId: refund.refundId,
      safeCode: 'allocation_incomplete',
      impact: 'pending'
    });
    const correlationId = token('review-detail');

    const detail = await getFinancialIssueDetail(databaseClient.db, actor, issueId, {
      correlationId,
      requestMetadata: { method: 'GET', routeId: '/admin/sales/review/[issueId]' }
    });
    expect(detail).toMatchObject({ issueId, refundId: refund.refundId });
    expect(Object.keys(detail!)).toEqual(FINANCIAL_ISSUE_DTO_KEYS);
    expect(JSON.stringify(detail)).not.toMatch(/correlationId|providerId|stripe|requestMetadata/iu);

    const audit = await ownerDatabaseClient.pool.query<{
      actor_id: string;
      action: string;
      resource_id: string;
      correlation_id: string;
      request_metadata: { method: string; route: string };
    }>(
      `select actor_id, action, resource_id, correlation_id, request_metadata
       from audit_events where correlation_id = $1`,
      [correlationId]
    );
    expect(audit.rows).toEqual([{
      actor_id: actor.id,
      action: 'financial.issue.view',
      resource_id: issueId,
      correlation_id: correlationId,
      request_metadata: {
        method: 'GET',
        route: `/admin/sales/issues/${issueId}`
      }
    }]);
  });

  it('rolls back and returns no detail when the fixed audit context is invalid', async () => {
    const actor = await createAdministrator('audit-failure');
    const refund = await createActionableRefund(actor, 'audit-failure');
    const issueId = await insertIssue({
      resourceType: 'refund',
      resourceId: refund.refundId,
      safeCode: 'allocation_incomplete',
      impact: 'pending'
    });

    await expect(getFinancialIssueDetail(databaseClient.db, actor, issueId, {
      correlationId: 'review-audit-failure',
      requestMetadata: { method: 'GET', routeId: '/admin/sales/export.csv' }
    })).rejects.toMatchObject({
      name: 'SalesReportingInputError',
      code: 'invalid_request',
      status: 400
    });
    await expect(ownerDatabaseClient.pool.query(
      `select count(*)::integer as count from audit_events`
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('returns no unaudited detail for invalid identities and denies a persisted role revocation', async () => {
    const actor = await createAdministrator('revoked');
    const missingId = randomUUID();

    await expect(getFinancialIssueDetail(
      databaseClient.db,
      actor,
      'NOT-A-CANONICAL-UUID',
      { correlationId: 'review-invalid' }
    )).resolves.toBeNull();
    await expect(getFinancialIssueDetail(
      databaseClient.db,
      actor,
      missingId,
      { correlationId: 'review-missing' }
    )).resolves.toBeNull();
    await ownerDatabaseClient.pool.query(
      `delete from user_roles where user_id = $1 and role = 'admin'`,
      [actor.id]
    );
    await expect(getFinancialIssueDetail(
      databaseClient.db,
      actor,
      missingId,
      { correlationId: 'review-revoked' }
    )).rejects.toMatchObject({ name: 'AuthorizationError', code: 'forbidden' });
    await expect(ownerDatabaseClient.pool.query(
      `select count(*)::integer as count from audit_events`
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
