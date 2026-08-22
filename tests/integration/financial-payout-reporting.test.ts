import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdministratorActor } from '$lib/server/auth/admin-policy';
import {
  PAYOUT_PAGE_SIZE,
  decodePayoutCursor,
  getPayoutDetail,
  listPayouts
} from '$lib/server/commerce/reporting/payouts';
import {
  PAYOUT_DETAIL_DTO_KEYS,
  PAYOUT_SUMMARY_DTO_KEYS
} from '$lib/types/financial-reporting';
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
    [id, `Payout administrator ${label}`, `${label}-${id}@example.test`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [id]
  );
  return { type: 'user', id, roles: ['admin'] };
}

interface PayoutFixture {
  readonly payoutId: string;
  readonly providerId: string;
}

async function insertPayout(input: {
  readonly label: string;
  readonly automatic?: boolean;
  readonly method?: 'standard' | 'instant' | 'unknown';
  readonly status?: 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled';
  readonly reconciliationStatus?: 'completed' | 'in_progress' | 'not_applicable';
  readonly amountMinor?: number;
  readonly currency?: 'USD' | 'EUR';
  readonly liveMode?: boolean;
  readonly financialGeneration?: number;
  readonly providerCreatedAt?: string;
  readonly retrievedAt?: string;
  readonly originalProviderPayoutId?: string;
  readonly reversedByProviderPayoutId?: string;
}): Promise<PayoutFixture> {
  const providerId = token(`${input.label}_private_provider_payout`);
  const stored = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into stripe_payouts
       (provider_id, live_mode, amount_minor, currency, automatic, method, status,
        reconciliation_status, provider_created_at, arrival_at, retrieved_at,
        original_provider_payout_id, reversed_by_provider_payout_id,
        financial_generation, fingerprint_sha256)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             '2026-08-05T00:00:00.000Z', $10, $11, $12, $13, repeat('e', 64))
     returning id`,
    [
      providerId,
      input.liveMode ?? false,
      input.amountMinor ?? 777,
      input.currency ?? 'USD',
      input.automatic ?? true,
      input.method ?? 'standard',
      input.status ?? 'paid',
      input.reconciliationStatus ?? 'completed',
      input.providerCreatedAt ?? '2026-08-04T00:00:00.123456Z',
      input.retrievedAt ?? '2026-08-04T01:00:00.000Z',
      input.originalProviderPayoutId ?? null,
      input.reversedByProviderPayoutId ?? null,
      input.financialGeneration ?? 1
    ]
  );
  return { payoutId: stored.rows[0]!.id, providerId };
}

async function publishMembership(
  payoutId: string,
  generation: number,
  balanceTransactionIds: readonly string[]
): Promise<string> {
  const run = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into payout_import_runs
       (payout_id, generation, state, candidate_count, page_count, safe_outcome,
        started_at, updated_at, completed_at)
     values ($1, $2, 'published', $3, 1, 'published',
             '2026-08-04T01:30:00.000Z', '2026-08-04T02:00:00.000Z',
             '2026-08-04T02:00:00.000Z')
     returning id`,
    [payoutId, generation, balanceTransactionIds.length]
  );
  for (const balanceTransactionId of balanceTransactionIds) {
    await ownerDatabaseClient.pool.query(
      `insert into payout_import_run_entries (run_id, balance_transaction_id)
       values ($1, $2)`,
      [run.rows[0]!.id, balanceTransactionId]
    );
    await ownerDatabaseClient.pool.query(
      `insert into stripe_payout_balance_transactions
         (payout_id, balance_transaction_id, published_from_run_id, published_at)
       values ($1, $2, $3, '2026-08-04T02:00:00.000Z')`,
      [payoutId, balanceTransactionId, run.rows[0]!.id]
    );
  }
  return run.rows[0]!.id;
}

async function createTitleAndAccountEvidence(label: string): Promise<{
  readonly titleBalanceTransactionId: string;
  readonly accountBalanceTransactionId: string;
  readonly orderItemId: string;
  readonly privateValues: readonly string[];
}> {
  const titleId = randomUUID();
  const buyerId = randomUUID();
  const buyerEmail = `${label}-${buyerId}@example.test`;
  const privateChargeId = token(`${label}_private_charge`);
  const privateIntentId = token(`${label}_private_intent`);
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [buyerId, `Payout buyer ${label}`, buyerEmail]
  );
  await ownerDatabaseClient.pool.query(
    `insert into titles
       (id, slug, title, description, creator_name, format, price_minor, currency, visibility)
     values ($1, $2, $3, 'Payout fixture', 'Payout creator', 'prose', 120, 'USD', 'private')`,
    [titleId, `payout-${randomUUID().replaceAll('-', '')}`, `Payout title ${label}`]
  );
  const order = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into orders
       (status, initiating_user_id, purchase_email, currency, subtotal_minor, tax_minor,
        total_minor, client_checkout_attempt_id, quote_fingerprint_sha256,
        status_token_sha256, paid_at)
     values ('paid', $1, $2, 'USD', 100, 20, 120, $3,
             repeat('a', 64), repeat('b', 64), '2026-08-01T09:00:00.000Z')
     returning id`,
    [buyerId, buyerEmail, randomUUID()]
  );
  const item = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into order_items
       (order_id, title_id, title_snapshot, creator_name_snapshot, format, currency,
        unit_subtotal_minor, tax_minor, total_minor, stripe_line_item_id)
     values ($1, $2, 'Payout title snapshot', 'Payout creator snapshot', 'prose',
             'USD', 100, 20, 120, $3)
     returning id`,
    [order.rows[0]!.id, titleId, token(`${label}_private_line`)]
  );
  const payment = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into payments
       (order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
        amount_minor, currency, payment_method_category, paid_at, financial_evidence_status)
     values ($1, $2, $3, 'succeeded', 120, 'USD', 'card',
             '2026-08-01T09:00:00.000Z', 'fee_reconciled')
     returning id`,
    [order.rows[0]!.id, privateIntentId, privateChargeId]
  );

  const fingerprint = 'c'.repeat(64);
  const titleProviderTransactionId = token(`${label}_private_title_balance`);
  const titleBalance = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into stripe_balance_transactions
       (provider_id, live_mode, source_family, source_id, raw_type, reporting_category,
        balance_type, amount_minor, fee_minor, net_minor, currency, status,
        provider_created_at, available_at, fingerprint_sha256,
        first_imported_at, last_imported_at)
     values ($1, false, 'charge', $2, 'charge', 'charge', 'payments',
             120, 10, 110, 'USD', 'available', '2026-08-02T00:00:00.000Z',
             '2026-08-03T00:00:00.000Z', $3,
             '2026-08-03T01:00:00.000Z', '2026-08-03T02:00:00.000Z')
     returning id`,
    [titleProviderTransactionId, privateChargeId, fingerprint]
  );
  await ownerDatabaseClient.pool.query(
    `insert into financial_classification_versions
       (subject_type, subject_id, classifier_version, classification, source_fingerprint_sha256)
     values ('balance_transaction', $1, 1, 'charge', $2)`,
    [titleBalance.rows[0]!.id, fingerprint]
  );
  const feeDetail = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into stripe_balance_transaction_fee_details
       (balance_transaction_id, ordinal, raw_type, amount_minor, currency, fingerprint_sha256)
     values ($1, 0, 'stripe_fee', 10, 'USD', repeat('d', 64))
     returning id`,
    [titleBalance.rows[0]!.id]
  );
  await ownerDatabaseClient.pool.query(
    `insert into financial_classification_versions
       (subject_type, subject_id, classifier_version, classification, source_fingerprint_sha256)
     values ('fee_detail', $1, 1, 'processing_fee', repeat('d', 64))`,
    [feeDetail.rows[0]!.id]
  );
  const grossSet = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into financial_allocation_sets
       (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
        basis, scope, expected_effect_minor, currency, algorithm_version,
        classifier_version, source_fingerprint_sha256, created_at)
     values ($1, $2, 'payment', $3, 'gross_amount', 'title', 120, 'USD', 2, 1, $4,
             '2026-08-03T03:00:00.000Z')
     returning id`,
    [token(`${label}_gross_set`), titleBalance.rows[0]!.id, payment.rows[0]!.id, fingerprint]
  );
  const feeSet = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into financial_allocation_sets
       (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
        basis, scope, expected_effect_minor, currency, algorithm_version,
        classifier_version, source_fingerprint_sha256, created_at)
     values ($1, $2, 'payment', $3, 'fee', 'title', -10, 'USD', 2, 1, $4,
             '2026-08-03T03:00:00.000Z')
     returning id`,
    [token(`${label}_fee_set`), titleBalance.rows[0]!.id, payment.rows[0]!.id, fingerprint]
  );
  for (const allocation of [
    { setId: grossSet.rows[0]!.id, component: 'sale_subtotal', effect: 100 },
    { setId: grossSet.rows[0]!.id, component: 'sale_tax', effect: 20 },
    { setId: feeSet.rows[0]!.id, component: 'processing_fee', effect: -10 }
  ]) {
    await ownerDatabaseClient.pool.query(
      `insert into financial_item_allocations
         (allocation_set_id, order_item_id, component, effect_minor, currency, tie_break_key)
       values ($1, $2, $3, $4, 'USD', $5)`,
      [allocation.setId, item.rows[0]!.id, allocation.component, allocation.effect, token('payout_tie')]
    );
  }

  const accountProviderTransactionId = token(`${label}_private_account_balance`);
  const accountBalance = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into stripe_balance_transactions
       (provider_id, live_mode, raw_type, reporting_category, balance_type,
        amount_minor, fee_minor, net_minor, currency, status, provider_created_at,
        available_at, fingerprint_sha256, first_imported_at, last_imported_at)
     values ($1, false, 'adjustment', 'other_adjustment', 'payments', 25, 0, 25,
             'USD', 'available', '2026-08-02T01:00:00.000Z',
             '2026-08-03T01:00:00.000Z', repeat('f', 64),
             '2026-08-03T01:00:00.000Z', '2026-08-03T04:00:00.000Z')
     returning id`,
    [accountProviderTransactionId]
  );
  await ownerDatabaseClient.pool.query(
    `insert into financial_classification_versions
       (subject_type, subject_id, classifier_version, classification, source_fingerprint_sha256)
     values ('balance_transaction', $1, 1, 'other', repeat('f', 64))`,
    [accountBalance.rows[0]!.id]
  );
  const accountSourceInternalId = randomUUID();
  for (const allocation of [
    { basis: 'gross_amount', effect: 25 },
    { basis: 'fee', effect: 0 }
  ]) {
    await ownerDatabaseClient.pool.query(
      `insert into financial_allocation_sets
         (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
          basis, scope, expected_effect_minor, currency, algorithm_version,
          classifier_version, source_fingerprint_sha256, created_at)
       values ($1, $2, 'adjustment', $3, $4, 'account', $5, 'USD', 2, 1,
               repeat('f', 64), '2026-08-03T05:00:00.000Z')`,
      [
        token(`${label}_account_set`),
        accountBalance.rows[0]!.id,
        accountSourceInternalId,
        allocation.basis,
        allocation.effect
      ]
    );
  }

  return {
    titleBalanceTransactionId: titleBalance.rows[0]!.id,
    accountBalanceTransactionId: accountBalance.rows[0]!.id,
    orderItemId: item.rows[0]!.id,
    privateValues: [
      buyerId,
      buyerEmail,
      privateChargeId,
      privateIntentId,
      titleProviderTransactionId,
      accountProviderTransactionId
    ]
  };
}

type TitleComponent =
  | 'refund_subtotal'
  | 'refund_tax'
  | 'refund_fee'
  | 'refund_failure_reversal'
  | 'dispute_subtotal'
  | 'dispute_tax'
  | 'dispute_fee'
  | 'dispute_reinstatement';

async function createTitleProjectionEvidence(input: {
  readonly label: string;
  readonly orderItemId: string;
  readonly sourceFamily: 'refund' | 'dispute';
  readonly sourceKind: 'refund' | 'dispute';
  readonly classification:
    | 'refund'
    | 'refund_failure'
    | 'dispute_withdrawal'
    | 'dispute_reinstatement';
  readonly feeClassification?: 'refund_fee' | 'dispute_fee';
  readonly amountMinor: number;
  readonly feeMinor: number;
  readonly grossItems: readonly { readonly component: TitleComponent; readonly effect: number }[];
  readonly feeItems?: readonly { readonly component: TitleComponent; readonly effect: number }[];
  readonly algorithmVersion?: number;
  readonly includeGrossHead?: boolean;
  readonly includeFeeHead?: boolean;
}): Promise<{ readonly balanceTransactionId: string; readonly privateProviderId: string }> {
  if (input.feeMinor > 0 && input.feeClassification === undefined) {
    throw new Error('Fee-bearing projection evidence requires a fee classification.');
  }
  const fingerprint = randomUUID().replaceAll('-', '').repeat(2);
  const privateProviderId = token(`${input.label}_private_balance`);
  const privateSourceId = token(`${input.label}_private_source`);
  const balance = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into stripe_balance_transactions
       (provider_id, live_mode, source_family, source_id, raw_type, reporting_category,
        balance_type, amount_minor, fee_minor, net_minor, currency, status,
        provider_created_at, available_at, fingerprint_sha256,
        first_imported_at, last_imported_at)
     values ($1, false, $2, $3, $4, $4, 'payments', $5, $6, $7, 'USD', 'available',
             '2026-08-02T02:00:00.000Z', '2026-08-03T02:00:00.000Z', $8,
             '2026-08-03T02:00:00.000Z', '2026-08-03T06:00:00.000Z')
     returning id`,
    [
      privateProviderId,
      input.sourceFamily,
      privateSourceId,
      input.classification,
      input.amountMinor,
      input.feeMinor,
      input.amountMinor - input.feeMinor,
      fingerprint
    ]
  );
  await ownerDatabaseClient.pool.query(
    `insert into financial_classification_versions
       (subject_type, subject_id, classifier_version, classification, source_fingerprint_sha256)
     values ('balance_transaction', $1, 1, $2, $3)`,
    [balance.rows[0]!.id, input.classification, fingerprint]
  );

  if (input.feeMinor > 0) {
    const feeDetail = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into stripe_balance_transaction_fee_details
         (balance_transaction_id, ordinal, raw_type, amount_minor, currency, fingerprint_sha256)
       values ($1, 0, $2, $3, 'USD', $4)
       returning id`,
      [balance.rows[0]!.id, input.feeClassification, input.feeMinor, fingerprint]
    );
    await ownerDatabaseClient.pool.query(
      `insert into financial_classification_versions
         (subject_type, subject_id, classifier_version, classification, source_fingerprint_sha256)
       values ('fee_detail', $1, 1, $2, $3)`,
      [feeDetail.rows[0]!.id, input.feeClassification, fingerprint]
    );
  }

  const sourceInternalId = randomUUID();
  const insertHead = async (
    basis: 'gross_amount' | 'fee',
    expectedEffectMinor: number,
    items: readonly { readonly component: TitleComponent; readonly effect: number }[]
  ): Promise<void> => {
    const allocationSet = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into financial_allocation_sets
         (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
          basis, scope, expected_effect_minor, currency, algorithm_version,
          classifier_version, source_fingerprint_sha256, created_at)
       values ($1, $2, $3, $4, $5, 'title', $6, 'USD', $7, 1, $8,
               '2026-08-03T07:00:00.000Z')
       returning id`,
      [
        token(`${input.label}_${basis}_set`),
        balance.rows[0]!.id,
        input.sourceKind,
        sourceInternalId,
        basis,
        expectedEffectMinor,
        input.algorithmVersion ?? 2,
        fingerprint
      ]
    );
    for (const item of items) {
      await ownerDatabaseClient.pool.query(
        `insert into financial_item_allocations
           (allocation_set_id, order_item_id, component, effect_minor, currency, tie_break_key)
         values ($1, $2, $3, $4, 'USD', $5)`,
        [allocationSet.rows[0]!.id, input.orderItemId, item.component, item.effect, token('component_tie')]
      );
    }
  };

  if (input.includeGrossHead ?? true) {
    await insertHead('gross_amount', input.amountMinor, input.grossItems);
  }
  if (input.includeFeeHead ?? true) {
    await insertHead('fee', -input.feeMinor, input.feeItems ?? []);
  }
  return { balanceTransactionId: balance.rows[0]!.id, privateProviderId };
}

async function auditCount(correlationId: string): Promise<number> {
  const result = await ownerDatabaseClient.pool.query<{ count: number }>(
    `select count(*)::integer as count from audit_events where correlation_id = $1`,
    [correlationId]
  );
  return result.rows[0]!.count;
}

async function totalAuditCount(): Promise<number> {
  const result = await ownerDatabaseClient.pool.query<{ count: number }>(
    `select count(*)::integer as count from audit_events`
  );
  return result.rows[0]!.count;
}

describe('local financial payout reporting', () => {
  it('reports signed title/account effects, retains historical membership, and audits detail only', async () => {
    const actor = await createAdministrator('aggregates');
    const evidence = await createTitleAndAccountEvidence('aggregates');
    const payout = await insertPayout({ label: 'aggregates', amountMinor: 777 });
    await publishMembership(payout.payoutId, 0, [
      evidence.titleBalanceTransactionId,
      evidence.accountBalanceTransactionId
    ]);
    const auditCountBeforeList = await totalAuditCount();

    const listed = await listPayouts(databaseClient.db, actor, { pageSize: PAYOUT_PAGE_SIZE });

    expect(listed.payouts).toEqual([expect.objectContaining({
      payoutId: payout.payoutId,
      amountMinor: 777,
      associatedTransactionCount: 2,
      bookstoreLinkedTransactionCount: 1,
      bookstoreLinkedSubtotalMinor: 100,
      accountLevelAdjustmentCount: 1,
      accountLevelAdjustmentMinor: 25,
      membershipComplete: true,
      membershipGeneration: 1,
      historicalMembershipRetained: false
    })]);
    expect(Object.keys(listed.payouts[0]!)).toEqual(PAYOUT_SUMMARY_DTO_KEYS);
    expect(await totalAuditCount()).toBe(auditCountBeforeList);

    const context = {
      correlationId: token('payout_detail_audit'),
      requestMetadata: {
        method: 'GET' as const,
        routeId: '/admin/sales/payouts/[payoutId]'
      }
    };
    const detail = await getPayoutDetail(
      databaseClient.db,
      actor,
      payout.payoutId,
      context
    );
    expect(detail).toMatchObject({
      bookstoreLinkedSubtotalMinor: 100,
      bookstoreLinkedFeeImpactMinor: -10,
      bookstoreLinkedNetMinor: 90,
      accountLevelAdjustmentMinor: 25,
      reversalState: 'none',
      reversalAmountMinor: null
    });
    expect(Object.keys(detail!)).toEqual(PAYOUT_DETAIL_DTO_KEYS);
    expect(await auditCount(context.correlationId)).toBe(1);

    const failure = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into stripe_balance_transactions
         (provider_id, live_mode, source_family, source_id, raw_type, reporting_category,
          balance_type, amount_minor, fee_minor, net_minor, currency, status,
          provider_created_at, available_at, fingerprint_sha256,
          first_imported_at, last_imported_at)
       values ($1, false, 'payout', $2, 'payout_failure', 'payout', 'payments',
               -777, 0, -777, 'USD', 'available', '2026-08-06T00:00:00.000Z',
               '2026-08-06T00:00:00.000Z', repeat('9', 64),
               '2026-08-06T00:00:00.000Z', '2026-08-06T03:00:00.000Z')
       returning id`,
      [token('aggregates_private_failure_balance'), payout.providerId]
    );
    await ownerDatabaseClient.pool.query(
      `update stripe_payouts
       set status = 'failed', financial_generation = 2,
           failure_balance_transaction_id = $2, safe_failure_code = 'provider_failed',
           retrieved_at = '2026-08-06T02:00:00.000Z'
       where id = $1`,
      [payout.payoutId, failure.rows[0]!.id]
    );

    const historical = await getPayoutDetail(databaseClient.db, actor, payout.payoutId, {
      correlationId: token('payout_historical_audit')
    });
    expect(historical).toMatchObject({
      membershipComplete: false,
      financialGeneration: 2,
      membershipGeneration: 1,
      historicalMembershipRetained: true,
      reversalState: 'reversed',
      reversalAmountMinor: -777,
      freshnessAt: '2026-08-06T03:00:00.000Z'
    });
    const serialized = JSON.stringify({ listed, detail, historical });
    for (const privateValue of [...evidence.privateValues, payout.providerId]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('sums refund and dispute title components while excluding tax-safe reinstatement tax', async () => {
    const actor = await createAdministrator('component-semantics');
    const titleFixture = await createTitleAndAccountEvidence('component-semantics');
    const refund = await createTitleProjectionEvidence({
      label: 'component-refund',
      orderItemId: titleFixture.orderItemId,
      sourceFamily: 'refund',
      sourceKind: 'refund',
      classification: 'refund',
      feeClassification: 'refund_fee',
      amountMinor: -120,
      feeMinor: 5,
      grossItems: [
        { component: 'refund_subtotal', effect: -100 },
        { component: 'refund_tax', effect: -20 }
      ],
      feeItems: [{ component: 'refund_fee', effect: -5 }]
    });
    const refundFailure = await createTitleProjectionEvidence({
      label: 'component-refund-failure',
      orderItemId: titleFixture.orderItemId,
      sourceFamily: 'refund',
      sourceKind: 'refund',
      classification: 'refund_failure',
      amountMinor: 120,
      feeMinor: 0,
      grossItems: [{ component: 'refund_failure_reversal', effect: 120 }]
    });
    const dispute = await createTitleProjectionEvidence({
      label: 'component-dispute',
      orderItemId: titleFixture.orderItemId,
      sourceFamily: 'dispute',
      sourceKind: 'dispute',
      classification: 'dispute_withdrawal',
      feeClassification: 'dispute_fee',
      amountMinor: -100,
      feeMinor: 15,
      grossItems: [
        { component: 'dispute_subtotal', effect: -80 },
        { component: 'dispute_tax', effect: -20 }
      ],
      feeItems: [{ component: 'dispute_fee', effect: -15 }]
    });
    const reinstatement = await createTitleProjectionEvidence({
      label: 'component-reinstatement-v2',
      orderItemId: titleFixture.orderItemId,
      sourceFamily: 'dispute',
      sourceKind: 'dispute',
      classification: 'dispute_reinstatement',
      amountMinor: 100,
      feeMinor: 0,
      grossItems: [
        { component: 'dispute_reinstatement', effect: 80 },
        { component: 'dispute_tax', effect: 20 }
      ],
      algorithmVersion: 2
    });
    await createTitleProjectionEvidence({
      label: 'component-unrelated-nonmember',
      orderItemId: titleFixture.orderItemId,
      sourceFamily: 'refund',
      sourceKind: 'refund',
      classification: 'refund_failure',
      amountMinor: 9_999,
      feeMinor: 0,
      grossItems: [{ component: 'refund_failure_reversal', effect: 9_999 }]
    });
    const payout = await insertPayout({ label: 'component-semantics', amountMinor: 0 });
    await publishMembership(payout.payoutId, 0, [
      refund.balanceTransactionId,
      refundFailure.balanceTransactionId,
      dispute.balanceTransactionId,
      reinstatement.balanceTransactionId
    ]);

    const detail = await getPayoutDetail(databaseClient.db, actor, payout.payoutId, {
      correlationId: token('component_semantics_audit')
    });

    expect(detail).toMatchObject({
      associatedTransactionCount: 4,
      bookstoreLinkedTransactionCount: 4,
      bookstoreLinkedSubtotalMinor: 20,
      bookstoreLinkedFeeImpactMinor: -20,
      bookstoreLinkedNetMinor: 0,
      accountLevelAdjustmentCount: 0,
      accountLevelAdjustmentMinor: 0,
      membershipComplete: true,
      membershipGeneration: 1
    });
    expect(JSON.stringify(detail)).not.toContain(reinstatement.privateProviderId);
  });

  it('fails the complete union closed for v1 reinstatement, missing heads, and incomplete heads', async () => {
    const actor = await createAdministrator('projection-heads');
    const titleFixture = await createTitleAndAccountEvidence('projection-heads');
    const v1Reinstatement = await createTitleProjectionEvidence({
      label: 'projection-v1-reinstatement',
      orderItemId: titleFixture.orderItemId,
      sourceFamily: 'dispute',
      sourceKind: 'dispute',
      classification: 'dispute_reinstatement',
      amountMinor: 120,
      feeMinor: 0,
      grossItems: [
        { component: 'dispute_reinstatement', effect: 100 },
        { component: 'dispute_tax', effect: 20 }
      ],
      algorithmVersion: 1
    });
    const v1Payout = await insertPayout({ label: 'projection-v1-payout' });
    await publishMembership(v1Payout.payoutId, 0, [v1Reinstatement.balanceTransactionId]);
    const missingFeeHead = await createTitleProjectionEvidence({
      label: 'projection-missing-fee',
      orderItemId: titleFixture.orderItemId,
      sourceFamily: 'refund',
      sourceKind: 'refund',
      classification: 'refund_failure',
      amountMinor: 50,
      feeMinor: 0,
      grossItems: [{ component: 'refund_failure_reversal', effect: 50 }],
      includeFeeHead: false
    });
    const incompleteGrossHead = await createTitleProjectionEvidence({
      label: 'projection-incomplete-gross',
      orderItemId: titleFixture.orderItemId,
      sourceFamily: 'refund',
      sourceKind: 'refund',
      classification: 'refund_failure',
      amountMinor: 50,
      feeMinor: 0,
      grossItems: [{ component: 'refund_failure_reversal', effect: 40 }]
    });
    const fixtures = [
      { payout: v1Payout, member: v1Reinstatement },
      { payout: await insertPayout({ label: 'projection-missing-payout' }), member: missingFeeHead },
      { payout: await insertPayout({ label: 'projection-incomplete-payout' }), member: incompleteGrossHead }
    ];
    for (const fixture of fixtures.slice(1)) {
      await publishMembership(fixture.payout.payoutId, 0, [fixture.member.balanceTransactionId]);
    }

    const listed = await listPayouts(databaseClient.db, actor, { pageSize: PAYOUT_PAGE_SIZE });

    const rows = new Map(listed.payouts.map((row) => [row.payoutId, row]));
    for (const fixture of fixtures) {
      expect(rows.get(fixture.payout.payoutId)).toMatchObject({
        associatedTransactionCount: null,
        bookstoreLinkedTransactionCount: null,
        bookstoreLinkedSubtotalMinor: null,
        accountLevelAdjustmentCount: null,
        accountLevelAdjustmentMinor: null,
        membershipGeneration: null,
        membershipComplete: false,
        historicalMembershipRetained: false
      });
    }
  });

  it('accepts only exact reciprocal and payout-failure evidence for reversal values and freshness', async () => {
    const actor = await createAdministrator('reversal-evidence');
    const original = await insertPayout({
      label: 'reciprocal-original',
      automatic: false,
      reconciliationStatus: 'not_applicable',
      amountMinor: 300,
      financialGeneration: 0
    });
    const reciprocal = await insertPayout({
      label: 'reciprocal-reversal',
      automatic: false,
      reconciliationStatus: 'not_applicable',
      amountMinor: -300,
      retrievedAt: '2026-08-08T00:00:00.000Z',
      originalProviderPayoutId: original.providerId,
      financialGeneration: 0
    });
    await ownerDatabaseClient.pool.query(
      `update stripe_payouts
       set reversed_by_provider_payout_id = $2,
           retrieved_at = '2026-08-07T00:00:00.000Z',
           financial_generation = 1
       where id = $1`,
      [original.payoutId, reciprocal.providerId]
    );

    const exactReciprocal = await getPayoutDetail(databaseClient.db, actor, original.payoutId, {
      correlationId: token('exact_reciprocal_audit')
    });
    expect(exactReciprocal).toMatchObject({
      reversalState: 'reversed',
      reversalAmountMinor: -300,
      freshnessAt: '2026-08-08T00:00:00.000Z'
    });

    const mismatchedOriginal = await insertPayout({
      label: 'mismatched-reciprocal-original',
      automatic: false,
      reconciliationStatus: 'not_applicable',
      amountMinor: 310,
      financialGeneration: 0
    });
    const mismatchedReciprocalPayout = await insertPayout({
      label: 'mismatched-reciprocal-reversal',
      automatic: false,
      reconciliationStatus: 'not_applicable',
      amountMinor: -310,
      currency: 'EUR',
      retrievedAt: '2026-08-09T00:00:00.000Z',
      originalProviderPayoutId: mismatchedOriginal.providerId,
      financialGeneration: 0
    });
    await ownerDatabaseClient.pool.query(
      `update stripe_payouts
       set reversed_by_provider_payout_id = $2,
           retrieved_at = '2026-08-07T00:00:00.000Z',
           financial_generation = 1
       where id = $1`,
      [mismatchedOriginal.payoutId, mismatchedReciprocalPayout.providerId]
    );
    const mismatchedReciprocal = await getPayoutDetail(
      databaseClient.db,
      actor,
      mismatchedOriginal.payoutId,
      { correlationId: token('mismatched_reciprocal_audit') }
    );
    expect(mismatchedReciprocal).toMatchObject({
      reversalState: 'incomplete',
      reversalAmountMinor: null,
      freshnessAt: '2026-08-07T00:00:00.000Z'
    });

    const failed = await insertPayout({
      label: 'mismatched-failure',
      automatic: false,
      status: 'failed',
      reconciliationStatus: 'not_applicable',
      amountMinor: 400,
      financialGeneration: 0
    });
    const mismatchedFailure = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into stripe_balance_transactions
         (provider_id, live_mode, source_family, source_id, raw_type, reporting_category,
          balance_type, amount_minor, fee_minor, net_minor, currency, status,
          provider_created_at, available_at, fingerprint_sha256,
          first_imported_at, last_imported_at)
       values ($1, false, 'payout', $2, 'payout_failure', 'payout', 'payments',
               -400, 0, -400, 'USD', 'available', '2026-08-10T00:00:00.000Z',
               '2026-08-10T00:00:00.000Z', repeat('8', 64),
               '2026-08-10T00:00:00.000Z', '2026-08-12T00:00:00.000Z')
       returning id`,
      [token('mismatched_private_failure'), token('wrong_private_payout_source')]
    );
    await ownerDatabaseClient.pool.query(
      `update stripe_payouts
       set failure_balance_transaction_id = $2,
           retrieved_at = '2026-08-11T00:00:00.000Z',
           financial_generation = 1
       where id = $1`,
      [failed.payoutId, mismatchedFailure.rows[0]!.id]
    );

    const mismatchedFailureDetail = await getPayoutDetail(
      databaseClient.db,
      actor,
      failed.payoutId,
      { correlationId: token('mismatched_failure_audit') }
    );
    expect(mismatchedFailureDetail).toMatchObject({
      reversalState: 'incomplete',
      reversalAmountMinor: null,
      freshnessAt: '2026-08-11T00:00:00.000Z'
    });
  });

  it('keeps empty first publication and exact recertification current at certified generation', async () => {
    const actor = await createAdministrator('empty-membership');
    const payout = await insertPayout({ label: 'empty-membership' });
    await publishMembership(payout.payoutId, 0, []);

    const first = await listPayouts(databaseClient.db, actor, { pageSize: PAYOUT_PAGE_SIZE });
    expect(first.payouts[0]).toMatchObject({
      associatedTransactionCount: 0,
      bookstoreLinkedTransactionCount: 0,
      bookstoreLinkedSubtotalMinor: 0,
      accountLevelAdjustmentCount: 0,
      accountLevelAdjustmentMinor: 0,
      membershipGeneration: 1,
      membershipComplete: true
    });

    await publishMembership(payout.payoutId, 1, []);
    const recertified = await listPayouts(databaseClient.db, actor, {
      pageSize: PAYOUT_PAGE_SIZE
    });
    expect(recertified.payouts[0]).toMatchObject({
      financialGeneration: 1,
      membershipGeneration: 1,
      membershipComplete: true,
      historicalMembershipRetained: false
    });
  });

  it('paginates non-millisecond ties without gaps and fails membership closed for unsupported modes', async () => {
    const actor = await createAdministrator('pagination');
    const created: PayoutFixture[] = [];
    for (let index = 0; index < PAYOUT_PAGE_SIZE + 2; index += 1) {
      created.push(await insertPayout({
        label: `precision-${index}`,
        automatic: index <= 1,
        method: index === 0 ? 'instant' : 'standard',
        reconciliationStatus: index === 1 ? 'completed' : 'not_applicable',
        providerCreatedAt: '2026-08-04T00:00:00.123456Z',
        financialGeneration: 0
      }));
    }
    await ownerDatabaseClient.pool.query(
      `insert into payout_import_runs
         (payout_id, generation, state, candidate_count, page_count, started_at, updated_at)
       values ($1, 0, 'collecting', 0, 0,
               '2026-08-04T01:00:00.000Z', '2026-08-04T01:00:00.000Z')`,
      [created[1]!.payoutId]
    );

    const first = await listPayouts(databaseClient.db, actor, { pageSize: PAYOUT_PAGE_SIZE });
    expect(first.payouts).toHaveLength(PAYOUT_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    expect(decodePayoutCursor(first.nextCursor!).providerCreatedAt).toBe(
      '2026-08-04T00:00:00.123456Z'
    );
    const second = await listPayouts(databaseClient.db, actor, {
      pageSize: PAYOUT_PAGE_SIZE,
      cursor: decodePayoutCursor(first.nextCursor!)
    });
    const ids = [...first.payouts, ...second.payouts].map((row) => row.payoutId);
    expect(ids).toHaveLength(PAYOUT_PAGE_SIZE + 2);
    expect(new Set(ids).size).toBe(PAYOUT_PAGE_SIZE + 2);
    expect(new Set(ids)).toEqual(new Set(created.map((row) => row.payoutId)));
    expect([...first.payouts, ...second.payouts].find(
      (row) => row.payoutId === created[1]!.payoutId
    )).toMatchObject({
      automatic: true,
      method: 'standard',
      reconciliationStatus: 'completed',
      associatedTransactionCount: null,
      membershipComplete: false
    });
    expect([...first.payouts, ...second.payouts].every((row) =>
      row.associatedTransactionCount === null &&
      row.bookstoreLinkedSubtotalMinor === null &&
      row.membershipGeneration === null &&
      !row.membershipComplete &&
      !row.historicalMembershipRetained
    )).toBe(true);
  });

  it('reauthorizes persisted roles and records no audit for invalid, missing, or demoted detail', async () => {
    const actor = await createAdministrator('authority');
    const payout = await insertPayout({
      label: 'authority',
      automatic: false,
      reconciliationStatus: 'not_applicable',
      financialGeneration: 0
    });
    const correlationId = token('payout_authority_audit');

    await expect(getPayoutDetail(
      databaseClient.db,
      actor,
      'NOT-A-UUID',
      { correlationId }
    )).resolves.toBeNull();
    await expect(getPayoutDetail(
      databaseClient.db,
      actor,
      randomUUID(),
      { correlationId }
    )).resolves.toBeNull();
    await ownerDatabaseClient.pool.query(
      `delete from user_roles where user_id = $1 and role = 'admin'`,
      [actor.id]
    );
    await expect(getPayoutDetail(
      databaseClient.db,
      actor,
      payout.payoutId,
      { correlationId }
    )).rejects.toMatchObject({ name: 'AuthorizationError', code: 'forbidden' });
    expect(await auditCount(correlationId)).toBe(0);
  });
});
