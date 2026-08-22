import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdministratorActor } from '$lib/server/auth/admin-policy';
import { setAdminRole } from '$lib/server/auth/roles';
import { createFinancialAdminCommandExecutors } from '$lib/server/commerce/financial/admin-commands/executors';
import {
  createFinancialAdminCommandHandler,
  type FinancialAdminCommandExecutor
} from '$lib/server/commerce/financial/admin-commands/handler';
import {
  getFinancialAdminCommandStatus,
  submitFinancialAdminCommand
} from '$lib/server/commerce/financial/admin-commands/repository';
import type { FinancialAdminPrivateCommand } from '$lib/server/commerce/financial/admin-commands/contracts';
import {
  executeRefundDraftDiscard,
  executeRefundDraftSave
} from '$lib/server/commerce/financial/refund-review/drafts';
import { getRefundReviewDetail } from '$lib/server/commerce/financial/refund-review/query';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import type { JobRecord } from '$lib/server/jobs/types';
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  workerDatabaseClient
} from './database';

interface RefundFixture {
  readonly refundId: string;
  readonly paymentId: string;
  readonly orderId: string;
  readonly firstItemId: string;
  readonly secondItemId: string;
}

interface DraftSideEffects {
  readonly target_refund_allocations: number;
  readonly target_financial_sets: number;
  readonly order_entitlement_grants: number;
  readonly outbox_messages: number;
  readonly open_target_issues: number;
}

function token(label: string): string {
  return `${label}_${randomUUID().replaceAll('-', '')}`;
}

function leaseCapability(label: string): string {
  return createHash('sha256').update(`refund-review:${label}`).digest('base64url');
}

async function createAdministrator(label: string): Promise<AdministratorActor> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [id, `Refund administrator ${label}`, `${label}-${id}@example.test`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [id]
  );
  return { type: 'user', id, roles: ['admin'] };
}

async function createRefundFixture(
  actor: AdministratorActor,
  label: string
): Promise<RefundFixture> {
  const titleIds = [randomUUID(), randomUUID()] as const;
  for (const [index, titleId] of titleIds.entries()) {
    await ownerDatabaseClient.pool.query(
      `insert into titles
         (id, slug, title, description, creator_name, format, price_minor, currency)
       values ($1, $2, $3, 'Safe fixture description', $4, $5, $6, 'USD')`,
      [
        titleId,
        `refund-review-${label}-${index}-${titleId.slice(-8)}`,
        `Refund fixture title ${index + 1}`,
        `Fixture creator ${index + 1}`,
        index === 0 ? 'prose' : 'comic',
        index === 0 ? 600 : 400
      ]
    );
  }
  const order = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into orders (
       status, initiating_user_id, purchase_email, currency, subtotal_minor,
       tax_minor, total_minor, client_checkout_attempt_id,
       quote_fingerprint_sha256, status_token_sha256, paid_at
     ) values (
       'paid', $1, $2, 'USD', 900, 100, 1000, $3,
       repeat('a', 64), repeat('b', 64), '2026-08-22T10:00:00.000Z'
     ) returning id`,
    [actor.id, `${label}-${actor.id}@example.test`, randomUUID()]
  )).rows[0]!;
  const insertedItems = (await ownerDatabaseClient.pool.query<{
    id: string;
    title_id: string;
  }>(
    `insert into order_items (
       order_id, title_id, title_snapshot, creator_name_snapshot, format,
       currency, unit_subtotal_minor, tax_minor, total_minor
     ) values
       ($1, $2, 'First sold-as title', 'First sold-as creator', 'prose',
        'USD', 540, 60, 600),
       ($1, $3, 'Second sold-as title', 'Second sold-as creator', 'comic',
        'USD', 360, 40, 400)
     returning id, title_id`
    , [order.id, titleIds[0], titleIds[1]]
  )).rows;
  const itemIdByTitleId = new Map(insertedItems.map((row) => [row.title_id, row.id]));
  const firstItemId = itemIdByTitleId.get(titleIds[0]);
  const secondItemId = itemIdByTitleId.get(titleIds[1]);
  if (firstItemId === undefined || secondItemId === undefined) {
    throw new Error('Refund fixture order items were not returned completely.');
  }
  const payment = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into payments (
       order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
       amount_minor, currency, paid_at, financial_evidence_status
     ) values ($1, $2, $3, 'succeeded', 1000, 'USD',
       '2026-08-22T10:00:00.000Z', 'pending') returning id`,
    [order.id, token('pi_refund_review'), token('ch_refund_review')]
  )).rows[0]!;
  const refund = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refunds (
       payment_id, stripe_refund_id, status, amount_minor, currency,
       provider_created_at, allocation_status, financial_evidence_status
     ) values ($1, $2, 'succeeded', 500, 'USD',
       '2026-08-22T11:00:00.000Z', 'needs_review', 'pending') returning id`,
    [payment.id, token('re_refund_review')]
  )).rows[0]!;
  await ownerDatabaseClient.pool.query(
    `insert into financial_reconciliation_issues (
       resource_type, resource_id, safe_code, impact, correlation_id
     ) values ('refund', $1, 'allocation_incomplete', 'pending', $2)`,
    [refund.id, token('refund_review_issue')]
  );
  return {
    refundId: refund.id,
    paymentId: payment.id,
    orderId: order.id,
    firstItemId,
    secondItemId
  };
}

async function addFinalizedSiblingRefund(fixture: RefundFixture, label: string): Promise<void> {
  const sibling = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refunds (
       payment_id, stripe_refund_id, status, amount_minor, currency,
       provider_created_at, allocation_status, financial_evidence_status
     ) values ($1, $2, 'succeeded', 200, 'USD',
       '2026-08-22T11:30:00.000Z', 'finalized', 'pending') returning id`,
    [fixture.paymentId, token(`re_${label}`)]
  )).rows[0]!;
  const allocation = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
     values ($1, $2, 200, 'automatic') returning id`,
    [sibling.id, fixture.firstItemId]
  )).rows[0]!;
  await ownerDatabaseClient.pool.query(
    `insert into refund_allocation_components (
       refund_allocation_id, refund_id, order_item_id,
       subtotal_minor, tax_minor, total_minor, currency
     ) values ($1, $2, $3, 180, 20, 200, 'USD')`,
    [allocation.id, sibling.id, fixture.firstItemId]
  );
}

async function readDraftSideEffects(fixture: RefundFixture): Promise<DraftSideEffects> {
  return (await ownerDatabaseClient.pool.query<DraftSideEffects>(
    `select
       (select count(*)::integer from refund_allocations
         where refund_id = $1) as target_refund_allocations,
       (select count(*)::integer from financial_allocation_sets
         where source_internal_id = $1) as target_financial_sets,
       (select count(*)::integer from entitlement_grants grant_row
         join order_items item on item.id = grant_row.order_item_id
         where item.order_id = $2) as order_entitlement_grants,
       (select count(*)::integer from outbox_messages) as outbox_messages,
       (select count(*)::integer from financial_reconciliation_issues
         where resource_type = 'refund' and resource_id = $1 and state = 'open')
         as open_target_issues`,
    [fixture.refundId, fixture.orderId]
  )).rows[0]!;
}

function executorMap() {
  const future = (name: string): FinancialAdminCommandExecutor => async () => {
    throw new Error(`${name} is intentionally unavailable before its task`);
  };
  return createFinancialAdminCommandExecutors({
    refundDraftSave: executeRefundDraftSave as FinancialAdminCommandExecutor,
    refundDraftDiscard: executeRefundDraftDiscard as FinancialAdminCommandExecutor,
    refundAllocationFinalize: future('finalize'),
    refundReportingCorrectionCreate: future('correction'),
    administrativeRecoveryActivate: future('recovery activate'),
    administrativeRecoveryDeactivate: future('recovery deactivate')
  });
}

async function runClaimedCommand(
  expectedCommandId: string,
  label: string
): Promise<{ readonly job: JobRecord; readonly error: unknown | null }> {
  const capability = leaseCapability(label);
  const repository = createPostgresJobRepository(
    workerDatabaseClient.db,
    { ...applicationConfig.jobs, leaseMs: 5_000 },
    undefined,
    'local-only',
    { classifierVersion: 1, allocationAlgorithmVersion: 1 },
    () => capability
  );
  const workerId = `refund-review-${label}`;
  const job = await repository.claimNext(workerId);
  expect(job).not.toBeNull();
  expect(job!.payload).toEqual({ commandId: expectedCommandId });
  const handler = createFinancialAdminCommandHandler({
    database: workerDatabaseClient.db,
    executors: executorMap()
  });
  let caught: unknown | null = null;
  try {
    await handler(job!, new AbortController().signal);
    await expect(repository.complete(
      job!.id, workerId, job!.financialAdminLeaseCapability!
    )).resolves.toBe(true);
  } catch (error: unknown) {
    caught = error;
    await expect(repository.fail(
      job!.id,
      workerId,
      'financial administrator command failed',
      false,
      job!.financialAdminLeaseCapability!
    )).resolves.toBe(true);
  }
  return { job: job!, error: caught };
}

async function submit(
  actor: AdministratorActor,
  command: FinancialAdminPrivateCommand,
  label: string,
  idempotencyKey = randomUUID()
) {
  return submitFinancialAdminCommand(databaseClient.db, {
    actor,
    idempotencyKey,
    command,
    context: { correlationId: `refund-review-${label}` }
  });
}

describe('audited refund detail and shared draft PostgreSQL contract', () => {
  it('returns one privacy-safe shared detail and writes its fixed audit atomically', async () => {
    const actor = await createAdministrator('detail');
    const fixture = await createRefundFixture(actor, 'detail');
    const context = {
      correlationId: `refund-detail-${randomUUID()}`,
      requestMetadata: {
        method: 'GET', routeId: '/admin/sales/refunds/[refundId]'
      }
    } as const;

    const result = await getRefundReviewDetail(
      databaseClient.db, actor, fixture.refundId, context
    );

    expect(result).toMatchObject({
      refundId: fixture.refundId,
      orderId: fixture.orderId,
      allocationStatus: 'needs_review',
      financialState: 'pending',
      amountMinor: 500,
      draft: null,
      openIssueCount: 1
    });
    expect(result?.items.map((item) => item.orderItemId).sort()).toEqual(
      [fixture.firstItemId, fixture.secondItemId].sort()
    );
    expect(JSON.stringify(result)).not.toMatch(
      /customer|email|provider|stripe|adminId|correlation|balanceTransaction/iu
    );
    await expect(ownerDatabaseClient.pool.query(
      `select count(*)::integer as count from audit_events
       where action = 'financial.refund_review.view' and resource_id = $1
         and correlation_id = $2`,
      [fixture.refundId, context.correlationId]
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it('creates, shares, no-ops, edits, conflicts, replays, and discards one complete draft', async () => {
    const firstAdmin = await createAdministrator('draft-first');
    const secondAdmin = await createAdministrator('draft-second');
    const fixture = await createRefundFixture(firstAdmin, 'shared-draft');
    const sideEffectsBefore = await readDraftSideEffects(fixture);
    const createCommand = {
      kind: 'refund_draft_save' as const,
      refundId: fixture.refundId,
      expectedVersion: null,
      items: [{ orderItemId: fixture.firstItemId, totalPresentmentMinor: 500 }]
    };
    const createKey = randomUUID();
    const created = await submit(firstAdmin, createCommand, 'create', createKey);
    expect(await submit(firstAdmin, createCommand, 'create-replay', createKey)).toEqual(created);
    expect((await runClaimedCommand(created.commandId, 'create')).error).toBeNull();

    const shared = await getRefundReviewDetail(
      databaseClient.db,
      secondAdmin,
      fixture.refundId,
      {
        correlationId: `shared-detail-${randomUUID()}`,
        requestMetadata: {
          method: 'GET', routeId: '/admin/sales/refunds/[refundId]'
        }
      }
    );
    expect(shared?.draft).toMatchObject({
      version: 1,
      lastEditedBy: 'another_administrator',
      proposedTotalMinor: 500,
      remainderMinor: 0
    });
    expect(shared?.draft?.items).toEqual(expect.arrayContaining([
      { orderItemId: fixture.firstItemId, proposedTotalMinor: 500 },
      { orderItemId: fixture.secondItemId, proposedTotalMinor: 0 }
    ]));

    const auditsBeforeNoop = (await ownerDatabaseClient.pool.query<{ count: number }>(
      `select count(*)::integer as count from audit_events
       where action like 'financial.refund_draft.%' and resource_id = $1`,
      [shared!.draft!.draftId]
    )).rows[0]!.count;
    const noop = await submit(secondAdmin, {
      ...createCommand,
      expectedVersion: 1
    }, 'noop');
    expect((await runClaimedCommand(noop.commandId, 'noop')).error).toBeNull();
    await expect(getFinancialAdminCommandStatus(
      databaseClient.db, secondAdmin, noop.commandId
    )).resolves.toMatchObject({
      status: 'succeeded',
      result: { refundId: fixture.refundId, draftVersion: 1, changed: false }
    });
    await expect(ownerDatabaseClient.pool.query(
      `select count(*)::integer as count from audit_events
       where action like 'financial.refund_draft.%' and resource_id = $1`,
      [shared!.draft!.draftId]
    )).resolves.toMatchObject({ rows: [{ count: auditsBeforeNoop }] });

    await addFinalizedSiblingRefund(fixture, 'graph-change');
    const graphChanged = await getRefundReviewDetail(
      databaseClient.db,
      secondAdmin,
      fixture.refundId,
      {
        correlationId: `graph-changed-detail-${randomUUID()}`,
        requestMetadata: {
          method: 'GET', routeId: '/admin/sales/refunds/[refundId]'
        }
      }
    );
    expect(graphChanged?.draft).toMatchObject({ version: 1, proposedTotalMinor: 500 });
    expect(graphChanged?.items.find((item) => item.orderItemId === fixture.firstItemId))
      .toMatchObject({ remainingRefundCapacityMinor: 400 });

    const edit = await submit(secondAdmin, {
      ...createCommand,
      expectedVersion: 1,
      items: [
        { orderItemId: fixture.firstItemId, totalPresentmentMinor: 100 },
        { orderItemId: fixture.secondItemId, totalPresentmentMinor: 400 }
      ]
    }, 'edit');
    expect((await runClaimedCommand(edit.commandId, 'edit')).error).toBeNull();
    const stale = await submit(firstAdmin, {
      ...createCommand,
      expectedVersion: 1,
      items: [{ orderItemId: fixture.firstItemId, totalPresentmentMinor: 500 }]
    }, 'stale');
    expect((await runClaimedCommand(stale.commandId, 'stale')).error).not.toBeNull();
    await expect(getFinancialAdminCommandStatus(
      databaseClient.db, firstAdmin, stale.commandId
    )).resolves.toMatchObject({ status: 'conflict', resultCode: 'stale_state' });

    const discard = await submit(secondAdmin, {
      kind: 'refund_draft_discard',
      refundId: fixture.refundId,
      expectedActiveDraftVersion: 2
    }, 'discard');
    expect((await runClaimedCommand(discard.commandId, 'discard')).error).toBeNull();
    await expect(ownerDatabaseClient.pool.query(
      `select draft.state, draft.version, refund.allocation_status
       from refund_allocation_drafts draft
       join refunds refund on refund.id = draft.refund_id
       where draft.id = $1`,
      [shared!.draft!.draftId]
    )).resolves.toMatchObject({
      rows: [{ state: 'discarded', version: 3, allocation_status: 'needs_review' }]
    });
    await expect(readDraftSideEffects(fixture)).resolves.toEqual(sideEffectsBefore);

    await expect(databaseClient.pool.query(
      `insert into refund_allocation_drafts (
         refund_id, created_by_admin_id, updated_by_admin_id,
         created_correlation_id, updated_correlation_id
       ) values ($1, $2, $2, 'web-forgery', 'web-forgery')`,
      [fixture.refundId, firstAdmin.id]
    )).rejects.toMatchObject({ code: '42501' });
  }, 20_000);

  it('reauthorizes a submitted actor at execution time before draft facts are read', async () => {
    const actor = await createAdministrator('demoted-target');
    const roleAdministrator = await createAdministrator('demotion-authority');
    const fixture = await createRefundFixture(actor, 'demotion');
    const submitted = await submit(actor, {
      kind: 'refund_draft_save',
      refundId: fixture.refundId,
      expectedVersion: null,
      items: [{ orderItemId: fixture.firstItemId, totalPresentmentMinor: 500 }]
    }, 'demoted');
    await setAdminRole(databaseClient.db, {
      actor: roleAdministrator,
      targetUserId: actor.id,
      enabled: false,
      correlationId: `refund-review-demotion-${randomUUID()}`
    });

    expect((await runClaimedCommand(submitted.commandId, 'demoted')).error).not.toBeNull();
    await expect(ownerDatabaseClient.pool.query(
      `select status, safe_result_code from financial_admin_commands where id = $1`,
      [submitted.commandId]
    )).resolves.toMatchObject({
      rows: [{ status: 'denied', safe_result_code: 'capability_revoked' }]
    });
    await expect(ownerDatabaseClient.pool.query(
      `select count(*)::integer as count from refund_allocation_drafts where refund_id = $1`,
      [fixture.refundId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  }, 15_000);

  it('rolls back draft mutation when its submitter audit is forced to fail', async () => {
    const actor = await createAdministrator('audit-rollback');
    const fixture = await createRefundFixture(actor, 'audit-rollback');
    const correlationId = `refund-review-audit-${randomUUID()}`;
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_refund_draft_audit_failure_${suffix}`;
    const triggerName = `test_refund_draft_audit_failure_${suffix}`;
    await ownerDatabaseClient.pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.action like 'financial.refund_draft.%'
          and new.correlation_id = '${correlationId}' then
          raise exception using errcode = '55000', message = 'forced audit rollback';
        end if;
        return new;
      end
      $$;
      create trigger ${triggerName} before insert on audit_events
      for each row execute function ${functionName}();
    `);
    try {
      const submitted = await submitFinancialAdminCommand(databaseClient.db, {
        actor,
        idempotencyKey: randomUUID(),
        command: {
          kind: 'refund_draft_save',
          refundId: fixture.refundId,
          expectedVersion: null,
          items: [{ orderItemId: fixture.firstItemId, totalPresentmentMinor: 500 }]
        },
        context: { correlationId }
      });
      expect((await runClaimedCommand(submitted.commandId, 'audit-rollback')).error)
        .not.toBeNull();
      await expect(ownerDatabaseClient.pool.query(
        `select refund.allocation_status,
           (select count(*)::integer from refund_allocation_drafts draft
             where draft.refund_id = refund.id) as draft_count
         from refunds refund where refund.id = $1`,
        [fixture.refundId]
      )).resolves.toMatchObject({
        rows: [{ allocation_status: 'needs_review', draft_count: 0 }]
      });
    } finally {
      await ownerDatabaseClient.pool.query(`drop trigger ${triggerName} on audit_events`);
      await ownerDatabaseClient.pool.query(`drop function ${functionName}()`);
    }
  }, 15_000);
});
