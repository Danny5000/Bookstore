import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AdministratorActor } from '$lib/server/auth/admin-policy';
import { setAdminRole } from '$lib/server/auth/roles';
import { createCommerceMessageEnqueuer } from '$lib/server/commerce/email/enqueue';
import { reconcileRefundFinancialSource } from '$lib/server/commerce/financial/sources/refund';
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
import {
  executeRefundAllocationFinalize,
  previewRefundFinalization
} from '$lib/server/commerce/financial/refund-review/finalize';
import { getRefundReviewDetail } from '$lib/server/commerce/financial/refund-review/query';
import { createFixtureStripeGateway } from '$lib/server/commerce/stripe/fixture-gateway';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import type { JobRecord } from '$lib/server/jobs/types';
import { balanceTransactionSnapshotFixture } from '../fixtures/stripe/balance-transaction';
import { chargeSnapshotFixture } from '../fixtures/stripe/charge';
import { paymentSnapshotFixture } from '../fixtures/stripe/payment';
import { refundSnapshotFixture } from '../fixtures/stripe/refund';
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  workerDatabaseClient
} from './database';

const accessMessages = createCommerceMessageEnqueuer(applicationConfig.origin);

interface RefundFixture {
  readonly refundId: string;
  readonly paymentId: string;
  readonly orderId: string;
  readonly firstItemId: string;
  readonly secondItemId: string;
}

interface FinalizationFixture extends RefundFixture {
  readonly purchaserUserId: string | null;
  readonly purchaserEmail: string;
  readonly firstTitleId: string;
  readonly secondTitleId: string;
  readonly firstPurchaseGrantId: string;
  readonly secondPurchaseGrantId: string;
  readonly stripePaymentIntentId: string;
  readonly stripeChargeId: string;
  readonly stripeRefundId: string;
  readonly providerBalanceTransactionId: string;
  readonly paidAt: Date;
  readonly refundCreatedAt: Date;
  readonly selectedAllocationSetIds: readonly string[];
  readonly stripe: ReturnType<typeof createFixtureStripeGateway>;
}

interface FinalizationFixtureOptions {
  readonly guest?: boolean;
  readonly otherActiveGrantForSecondTitle?: boolean;
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

async function completeFixtureClassificationJobs(refundId: string): Promise<void> {
  await ownerDatabaseClient.pool.query(
    `update jobs set status = 'succeeded', attempts = greatest(attempts, 1),
       completed_at = statement_timestamp(), updated_at = statement_timestamp(),
       locked_at = null, locked_by = null, last_error = null
     where type = 'commerce.financial-classification' and status = 'pending'
       and payload ->> 'subjectId' in (
         select source.id::text
         from financial_allocation_sets allocation_set
         join stripe_balance_transactions source
           on source.id = allocation_set.balance_transaction_id
         where allocation_set.source_kind = 'refund'
           and allocation_set.source_internal_id = $1
         union
         select detail.id::text
         from financial_allocation_sets allocation_set
         join stripe_balance_transaction_fee_details detail
           on detail.balance_transaction_id = allocation_set.balance_transaction_id
         where allocation_set.source_kind = 'refund'
           and allocation_set.source_internal_id = $1
       )`,
    [refundId]
  );
}

async function createAmbiguousFinalizationFixture(
  label: string,
  options: FinalizationFixtureOptions = {}
): Promise<FinalizationFixture> {
  const paidAt = new Date('2026-08-22T10:00:00.000Z');
  const refundCreatedAt = new Date('2026-08-22T11:00:00.000Z');
  const purchaseEmail = `${label}-${randomUUID()}@example.test`.toLowerCase();
  const purchaserUserId = options.guest
    ? null
    : (await ownerDatabaseClient.pool.query<{ id: string }>(
        `insert into "user" (id, name, email, email_verified)
         values ($1, $2, $3, true) returning id`,
        [randomUUID(), `Refund purchaser ${label}`, purchaseEmail]
      )).rows[0]!.id;
  const guestIdentityId = options.guest
    ? (await ownerDatabaseClient.pool.query<{ id: string }>(
        `insert into guest_identities (email) values ($1) returning id`,
        [purchaseEmail]
      )).rows[0]!.id
    : null;
  const titleIds = [randomUUID(), randomUUID()] as const;
  for (const [index, titleId] of titleIds.entries()) {
    await ownerDatabaseClient.pool.query(
      `insert into titles
         (id, slug, title, description, creator_name, format, price_minor, currency)
       values ($1, $2, $3, 'Finalization fixture description', $4, $5, $6, 'USD')`,
      [
        titleId,
        `refund-finalize-${label}-${index}-${titleId.slice(-8)}`,
        `Finalization fixture title ${index + 1}`,
        `Finalization creator ${index + 1}`,
        index === 0 ? 'prose' : 'comic',
        index === 0 ? 600 : 400
      ]
    );
  }
  const order = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into orders (
       status, initiating_user_id, guest_identity_id, purchase_email, currency,
       subtotal_minor, tax_minor, total_minor, client_checkout_attempt_id,
       quote_fingerprint_sha256, status_token_sha256, paid_at
     ) values (
       'paid', $1, $2, $3, 'USD', 900, 100, 1000, $4,
       repeat('c', 64), repeat('d', 64), $5
     ) returning id`,
    [purchaserUserId, guestIdentityId, purchaseEmail, randomUUID(), paidAt]
  )).rows[0]!;
  const items = (await ownerDatabaseClient.pool.query<{ id: string; title_id: string }>(
    `insert into order_items (
       order_id, title_id, title_snapshot, creator_name_snapshot, format,
       currency, unit_subtotal_minor, tax_minor, total_minor
     ) values
       ($1, $2, 'First finalization sold-as title', 'First creator', 'prose',
        'USD', 540, 60, 600),
       ($1, $3, 'Second finalization sold-as title', 'Second creator', 'comic',
        'USD', 360, 40, 400)
     returning id, title_id`,
    [order.id, titleIds[0], titleIds[1]]
  )).rows;
  const itemIdByTitleId = new Map(items.map((row) => [row.title_id, row.id]));
  const firstItemId = itemIdByTitleId.get(titleIds[0]);
  const secondItemId = itemIdByTitleId.get(titleIds[1]);
  if (!firstItemId || !secondItemId) {
    throw new Error('Finalization fixture items were not returned completely.');
  }
  const stripePaymentIntentId = token('pi_refund_finalize');
  const stripeChargeId = token('ch_refund_finalize');
  const payment = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into payments (
       order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
       amount_minor, currency, payment_method_category, paid_at,
       financial_evidence_status
     ) values ($1, $2, $3, 'succeeded', 1000, 'USD', 'card', $4, 'pending')
     returning id`,
    [order.id, stripePaymentIntentId, stripeChargeId, paidAt]
  )).rows[0]!;
  const stripeRefundId = token('re_refund_finalize');
  const refund = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refunds (
       payment_id, stripe_refund_id, status, amount_minor, currency, reason,
       provider_created_at, allocation_status, financial_evidence_status
     ) values ($1, $2, 'succeeded', 500, 'USD', 'requested_by_customer',
       $3, 'needs_review', 'pending') returning id`,
    [payment.id, stripeRefundId, refundCreatedAt]
  )).rows[0]!;
  const purchaseGrants = (await ownerDatabaseClient.pool.query<{
    id: string;
    order_item_id: string;
  }>(
    `insert into entitlement_grants (
       title_id, user_id, source, order_item_id, state, state_reason, granted_at
     ) values
       ($1, $3, 'purchase', $4, $6, 'payment_succeeded', $7),
       ($2, $3, 'purchase', $5, $6, 'payment_succeeded', $7)
     returning id, order_item_id`,
    [
      titleIds[0],
      titleIds[1],
      purchaserUserId,
      firstItemId,
      secondItemId,
      options.guest ? 'unclaimed' : 'active',
      paidAt
    ]
  )).rows;
  const grantIdByItemId = new Map(
    purchaseGrants.map((row) => [row.order_item_id, row.id])
  );
  const firstPurchaseGrantId = grantIdByItemId.get(firstItemId);
  const secondPurchaseGrantId = grantIdByItemId.get(secondItemId);
  if (!firstPurchaseGrantId || !secondPurchaseGrantId) {
    throw new Error('Finalization fixture grants were not returned completely.');
  }
  if (purchaserUserId !== null) {
    await ownerDatabaseClient.pool.query(
      `insert into entitlements (user_id, title_id, granted_at)
       values ($1, $2, $4), ($1, $3, $4)`,
      [purchaserUserId, titleIds[0], titleIds[1], paidAt]
    );
    if (options.otherActiveGrantForSecondTitle) {
      await ownerDatabaseClient.pool.query(
        `insert into entitlement_grants (
           title_id, user_id, source, state, state_reason, granted_at
         ) values ($1, $2, 'preserved', 'active', 'administrator_preserved', $3)`,
        [titleIds[1], purchaserUserId, paidAt]
      );
    }
  }

  const providerBalanceTransactionId = token('txn_refund_finalize');
  const stripe = createFixtureStripeGateway();
  stripe.harness.setRefund(refundSnapshotFixture({
    providerRefundId: stripeRefundId,
    paymentIntentId: stripePaymentIntentId,
    amountMinor: 500,
    providerCreatedAt: refundCreatedAt,
    balanceTransactionId: providerBalanceTransactionId
  }));
  stripe.harness.setPayment(paymentSnapshotFixture({
    paymentIntentId: stripePaymentIntentId,
    metadataOrderId: order.id,
    latestChargeId: stripeChargeId,
    amountMinor: 1000,
    paidAt
  }));
  stripe.harness.setCharge(chargeSnapshotFixture({
    id: stripeChargeId,
    paymentIntentId: stripePaymentIntentId,
    amountMinor: 1000,
    amountRefundedMinor: 500,
    currency: 'USD',
    balanceTransactionId: token('txn_charge_finalize'),
    createdAt: paidAt
  }));
  stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
    id: providerBalanceTransactionId,
    sourceId: stripeRefundId,
    sourceFamily: 'refund',
    rawType: 'refund',
    reportingCategory: 'refund',
    amountMinor: -500,
    feeMinor: 10,
    netMinor: -510,
    currency: 'USD',
    createdAt: refundCreatedAt,
    feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 10, currency: 'USD' }]
  }));
  await expect(reconcileRefundFinancialSource(
    workerDatabaseClient.db,
    stripe.gateway,
    { refundId: refund.id, correlationId: `refund-finalize-source-${label}` },
    new AbortController().signal
  )).resolves.toMatchObject({
    status: 'pending',
    sourceKind: 'refund',
    sourceId: refund.id,
    safeCode: 'allocation_incomplete'
  });
  const selectedAllocationSetIds = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `select id from financial_allocation_sets
     where source_kind = 'refund' and source_internal_id = $1
     order by id`,
    [refund.id]
  )).rows.map((row) => row.id);
  expect(selectedAllocationSetIds).toHaveLength(2);
  await expect(ownerDatabaseClient.pool.query(
    `select source.source_family, source.source_id,
       count(allocation_set.*)::integer as allocation_set_count
     from financial_allocation_sets allocation_set
     join stripe_balance_transactions source
       on source.id = allocation_set.balance_transaction_id
     where allocation_set.source_kind = 'refund'
       and allocation_set.source_internal_id = $1
     group by source.source_family, source.source_id`,
    [refund.id]
  )).resolves.toMatchObject({
    rows: [{
      source_family: 'refund',
      source_id: stripeRefundId,
      allocation_set_count: 2
    }]
  });
  await completeFixtureClassificationJobs(refund.id);
  return {
    refundId: refund.id,
    paymentId: payment.id,
    orderId: order.id,
    firstItemId,
    secondItemId,
    purchaserUserId,
    purchaserEmail: purchaseEmail,
    firstTitleId: titleIds[0],
    secondTitleId: titleIds[1],
    firstPurchaseGrantId,
    secondPurchaseGrantId,
    stripePaymentIntentId,
    stripeChargeId,
    stripeRefundId,
    providerBalanceTransactionId,
    paidAt,
    refundCreatedAt,
    selectedAllocationSetIds,
    stripe
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

function executorMap(input: {
  readonly refundAllocationFinalize?: FinancialAdminCommandExecutor;
} = {}) {
  const future = (name: string): FinancialAdminCommandExecutor => async () => {
    throw new Error(`${name} is intentionally unavailable before its task`);
  };
  return createFinancialAdminCommandExecutors({
    refundDraftSave: executeRefundDraftSave as FinancialAdminCommandExecutor,
    refundDraftDiscard: executeRefundDraftDiscard as FinancialAdminCommandExecutor,
    refundAllocationFinalize: input.refundAllocationFinalize ?? future('finalize'),
    refundReportingCorrectionCreate: future('correction'),
    administrativeRecoveryActivate: future('recovery activate'),
    administrativeRecoveryDeactivate: future('recovery deactivate')
  });
}

interface ClaimedCommand {
  readonly job: JobRecord;
  readonly workerId: string;
  readonly repository: ReturnType<typeof createPostgresJobRepository>;
}

async function claimCommand(expectedCommandId: string, label: string): Promise<ClaimedCommand> {
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
  return { job: job!, workerId, repository };
}

async function executeClaimedCommand(
  claimed: ClaimedCommand,
  executors = executorMap()
): Promise<unknown | null> {
  const handler = createFinancialAdminCommandHandler({
    database: workerDatabaseClient.db,
    executors,
    accessMessages
  });
  let caught: unknown | null = null;
  try {
    await handler(claimed.job, new AbortController().signal);
    await expect(claimed.repository.complete(
      claimed.job.id,
      claimed.workerId,
      claimed.job.financialAdminLeaseCapability!
    )).resolves.toBe(true);
  } catch (error: unknown) {
    caught = error;
    await expect(claimed.repository.fail(
      claimed.job.id,
      claimed.workerId,
      'financial administrator command failed',
      false,
      claimed.job.financialAdminLeaseCapability!
    )).resolves.toBe(true);
  }
  return caught;
}

async function runClaimedCommand(
  expectedCommandId: string,
  label: string,
  executors = executorMap()
): Promise<{ readonly job: JobRecord; readonly error: unknown | null }> {
  const claimed = await claimCommand(expectedCommandId, label);
  return {
    job: claimed.job,
    error: await executeClaimedCommand(claimed, executors)
  };
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

const finalizationExecutors = executorMap({
  refundAllocationFinalize: executeRefundAllocationFinalize as FinancialAdminCommandExecutor
});

async function saveCompleteFinalizationDraft(
  actor: AdministratorActor,
  fixture: FinalizationFixture,
  label: string
): Promise<number> {
  const submitted = await submit(actor, {
    kind: 'refund_draft_save',
    refundId: fixture.refundId,
    expectedVersion: null,
    items: [
      { orderItemId: fixture.firstItemId, totalPresentmentMinor: 100 },
      { orderItemId: fixture.secondItemId, totalPresentmentMinor: 400 }
    ]
  }, `${label}-draft`);
  expect((await runClaimedCommand(submitted.commandId, `${label}-draft`)).error).toBeNull();
  const status = await getFinancialAdminCommandStatus(
    databaseClient.db,
    actor,
    submitted.commandId
  );
  expect(status).toMatchObject({
    status: 'succeeded',
    result: { refundId: fixture.refundId, draftVersion: 1, changed: true }
  });
  if (
    status?.status !== 'succeeded' ||
    status.kind !== 'refund_draft_save' ||
    status.resultCode !== 'draft_saved'
  ) {
    throw new Error('Expected a saved finalization draft.');
  }
  return status.result.draftVersion;
}

async function previewFinalization(
  actor: AdministratorActor,
  fixture: FinalizationFixture,
  expectedActiveDraftVersion: number,
  label: string
) {
  return previewRefundFinalization(
    databaseClient.db,
    actor,
    { refundId: fixture.refundId, expectedActiveDraftVersion },
    {
      correlationId: `refund-finalize-preview-${label}-${randomUUID()}`,
      requestMetadata: {
        method: 'POST',
        routeId: '/admin/sales/refunds/[refundId]?/prepareFinalize'
      }
    }
  );
}

function finalizeCommand(
  fixture: FinalizationFixture,
  expectedActiveDraftVersion: number,
  previewFingerprint: string
): Extract<FinancialAdminPrivateCommand, { kind: 'refund_allocation_finalize' }> {
  return {
    kind: 'refund_allocation_finalize',
    refundId: fixture.refundId,
    expectedActiveDraftVersion,
    previewFingerprint,
    confirmation: 'finalize_refund_allocation'
  };
}

interface FinalizationMutationSnapshot {
  readonly allocation_status: string;
  readonly draft_state: string;
  readonly draft_version: number;
  readonly refund_allocations: number;
  readonly refund_components: number;
  readonly finalization_effects: number;
  readonly financial_items: number;
  readonly purchase_grant_states: string;
  readonly entitlement_states: string;
  readonly issue_states: string;
  readonly finalization_audits: number;
  readonly access_outbox: number;
  readonly access_dispatch_jobs: number;
}

async function readFinalizationMutationSnapshot(
  fixture: FinalizationFixture,
  commandId: string
): Promise<FinalizationMutationSnapshot> {
  return (await ownerDatabaseClient.pool.query<FinalizationMutationSnapshot>(
    `select refund.allocation_status,
       draft.state as draft_state,
       draft.version as draft_version,
       (select count(*)::integer from refund_allocations allocation
         where allocation.refund_id = refund.id) as refund_allocations,
       (select count(*)::integer from refund_allocation_components component
         where component.refund_id = refund.id) as refund_components,
       (select count(*)::integer from refund_allocation_finalization_effects effect
         where effect.refund_id = refund.id) as finalization_effects,
       (select count(*)::integer
          from financial_item_allocations item_allocation
          join financial_allocation_sets allocation_set
            on allocation_set.id = item_allocation.allocation_set_id
         where allocation_set.source_kind = 'refund'
           and allocation_set.source_internal_id = refund.id) as financial_items,
       (select string_agg(grant_row.id::text || ':' || grant_row.state::text, ',' order by grant_row.id)
          from entitlement_grants grant_row
         where grant_row.id in ($3, $4)) as purchase_grant_states,
       (select coalesce(string_agg(entitlement.title_id::text || ':' ||
          coalesce(entitlement.revoked_at::text, 'active'), ',' order by entitlement.title_id), '')
          from entitlements entitlement
         where $5::uuid is not null and entitlement.user_id = $5
           and entitlement.title_id in ($6, $7)) as entitlement_states,
       (select string_agg(issue.id::text || ':' || issue.state::text || ':' ||
          issue.occurrence_count::text || ':' || issue.last_observed_at::text || ':' ||
          issue.correlation_id || ':' || coalesce(issue.resolved_by_admin_id::text, '') || ':' ||
          coalesce(issue.resolved_at::text, ''), ',' order by issue.id)
          from financial_reconciliation_issues issue
         where (issue.resource_type = 'refund' and issue.resource_id = refund.id)
            or (issue.resource_type = 'allocation_set' and issue.resource_id = any($8::uuid[])))
          as issue_states,
       (select count(*)::integer from audit_events audit
         where audit.action = 'financial.refund_allocation.finalized'
           and audit.resource_id = refund.id::text) as finalization_audits,
       (select count(*)::integer from outbox_messages message
         where message.deduplication_key = $2) as access_outbox,
       (select count(*)::integer from jobs job
         where job.deduplication_key = $9) as access_dispatch_jobs
     from refunds refund
     join refund_allocation_drafts draft
       on draft.refund_id = refund.id and draft.state in ('active', 'finalized')
     where refund.id = $1`,
    [
      fixture.refundId,
      `commerce:access-change:event:${commandId}:v1`,
      fixture.firstPurchaseGrantId,
      fixture.secondPurchaseGrantId,
      fixture.purchaserUserId,
      fixture.firstTitleId,
      fixture.secondTitleId,
      fixture.selectedAllocationSetIds,
      `outbox-key:${createHash('sha256').update(
        `commerce:access-change:event:${commandId}:v1`
      ).digest('hex')}`
    ]
  )).rows[0]!;
}

type ForcedFinalizationFailure = 'audit' | 'outbox' | 'projection';

async function installForcedFinalizationFailure(
  kind: ForcedFinalizationFailure,
  fixture: FinalizationFixture,
  commandId: string
): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `test_refund_finalize_${kind}_failure_${suffix}`;
  const triggerName = `test_refund_finalize_${kind}_failure_${suffix}`;
  const deduplicationKey = `commerce:access-change:event:${commandId}:v1`;
  const configuration = kind === 'audit'
    ? {
        table: 'audit_events',
        condition: `new.action = 'financial.refund_allocation.finalized'
          and new.resource_id = '${fixture.refundId}'`
      }
    : kind === 'outbox'
      ? {
          table: 'outbox_messages',
          condition: `new.deduplication_key = '${deduplicationKey}'`
        }
      : {
          table: 'financial_item_allocations',
          condition: `exists (
            select 1 from financial_allocation_sets allocation_set
            where allocation_set.id = new.allocation_set_id
              and allocation_set.source_kind = 'refund'
              and allocation_set.source_internal_id = '${fixture.refundId}'::uuid
          )`
        };
  await ownerDatabaseClient.pool.query(`
    create function ${functionName}() returns trigger language plpgsql as $$
    begin
      if ${configuration.condition} then
        raise exception using errcode = '55000', message = 'forced ${kind} rollback';
      end if;
      return new;
    end
    $$;
    create trigger ${triggerName} before insert on ${configuration.table}
    for each row execute function ${functionName}();
  `);
  return async () => {
    await ownerDatabaseClient.pool.query(
      `drop trigger ${triggerName} on ${configuration.table}`
    );
    await ownerDatabaseClient.pool.query(`drop function ${functionName}()`);
  };
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

describe('ambiguous refund finalization PostgreSQL contract', () => {
  it('previews and atomically finalizes reconciled evidence with administrator issue attribution and authoritative replay', async () => {
    const actor = await createAdministrator('finalize-success');
    const fixture = await createAmbiguousFinalizationFixture('success');
    expect(fixture.purchaserUserId).not.toBe(actor.id);
    const selectedSetId = fixture.selectedAllocationSetIds[0]!;
    const historicalIssueCorrelation = `refund-finalize-selected-history-${randomUUID()}`;
    const historicalSelectedIssueId = (await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into financial_reconciliation_issues (
         resource_type, resource_id, safe_code, impact, correlation_id
       ) values (
         'allocation_set', $1, 'allocation_incomplete', 'pending', $2
       ) returning id`,
      [selectedSetId, historicalIssueCorrelation]
    )).rows[0]!.id;
    await workerDatabaseClient.pool.query(
      `select id from resolve_financial_issue_after_worker_recompute($1::uuid, $2::text)`,
      [historicalSelectedIssueId, historicalIssueCorrelation]
    );
    await ownerDatabaseClient.pool.query(
      `insert into financial_reconciliation_issues (
         resource_type, resource_id, safe_code, impact, correlation_id
       ) values ('allocation_set', $1, 'allocation_incomplete', 'pending', $2)`,
      [selectedSetId, `refund-finalize-selected-${randomUUID()}`]
    );
    const draftVersion = await saveCompleteFinalizationDraft(actor, fixture, 'success');
    const preview = await previewFinalization(actor, fixture, draftVersion, 'success');
    expect(preview).toMatchObject({
      refundId: fixture.refundId,
      expectedActiveDraftVersion: 1,
      previewFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      currency: 'USD',
      proposedTotalMinor: 500,
      remainderMinor: 0
    });
    expect(preview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderItemId: fixture.firstItemId,
        proposedTotalMinor: 100,
        proposedSubtotalMinor: 90,
        proposedTaxMinor: 10,
        wouldBeFullyRefunded: false,
        purchaseGrantWouldBeRevoked: false,
        otherActiveGrantPreservesAccess: false,
        effectiveAccessWouldChange: false,
        emailQueued: false
      }),
      expect.objectContaining({
        orderItemId: fixture.secondItemId,
        proposedTotalMinor: 400,
        proposedSubtotalMinor: 360,
        proposedTaxMinor: 40,
        wouldBeFullyRefunded: true,
        purchaseGrantWouldBeRevoked: true,
        otherActiveGrantPreservesAccess: false,
        effectiveAccessWouldChange: true,
        emailQueued: true
      })
    ]));

    const idempotencyKey = randomUUID();
    const command = finalizeCommand(fixture, draftVersion, preview.previewFingerprint);
    const submitted = await submit(actor, command, 'success-finalize', idempotencyKey);
    expect(await submit(actor, command, 'success-finalize-replay', idempotencyKey))
      .toEqual(submitted);
    expect((await runClaimedCommand(
      submitted.commandId,
      'success-finalize',
      finalizationExecutors
    )).error).toBeNull();

    await expect(getFinancialAdminCommandStatus(
      databaseClient.db,
      actor,
      submitted.commandId
    )).resolves.toMatchObject({
      status: 'succeeded',
      resultCode: 'allocation_finalized',
      result: {
        refundId: fixture.refundId,
        finalizedDraftVersion: 2,
        accessChanged: true,
        emailQueued: true
      }
    });
    const finalized = await readFinalizationMutationSnapshot(fixture, submitted.commandId);
    expect(finalized).toMatchObject({
      allocation_status: 'finalized',
      draft_state: 'finalized',
      draft_version: 2,
      refund_allocations: 2,
      refund_components: 2,
      finalization_effects: 2,
      finalization_audits: 1,
      access_outbox: 1,
      access_dispatch_jobs: 1
    });
    expect(finalized.financial_items).toBeGreaterThan(0);
    expect(finalized.purchase_grant_states).toContain(
      `${fixture.firstPurchaseGrantId}:active`
    );
    expect(finalized.purchase_grant_states).toContain(
      `${fixture.secondPurchaseGrantId}:revoked`
    );
    expect(finalized.entitlement_states).toContain(`${fixture.firstTitleId}:active`);
    expect(finalized.entitlement_states).toMatch(
      new RegExp(`${fixture.secondTitleId}:(?!active)`, 'u')
    );
    await expect(ownerDatabaseClient.pool.query(
      `select allocation.order_item_id, allocation.source,
         allocation.amount_minor, component.subtotal_minor,
         component.tax_minor, component.total_minor, component.currency
       from refund_allocations allocation
       join refund_allocation_components component
         on component.refund_allocation_id = allocation.id
       where allocation.refund_id = $1
       order by allocation.order_item_id`,
      [fixture.refundId]
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([
        {
          order_item_id: fixture.firstItemId,
          source: 'administrative',
          amount_minor: 100,
          subtotal_minor: 90,
          tax_minor: 10,
          total_minor: 100,
          currency: 'USD'
        },
        {
          order_item_id: fixture.secondItemId,
          source: 'administrative',
          amount_minor: 400,
          subtotal_minor: 360,
          tax_minor: 40,
          total_minor: 400,
          currency: 'USD'
        }
      ])
    });
    const issues = (await ownerDatabaseClient.pool.query<{
      id: string;
      resource_type: string;
      resource_id: string;
      safe_code: string;
      state: string;
      resolved_by_admin_id: string | null;
    }>(
      `select id, resource_type, resource_id, safe_code, state, resolved_by_admin_id
       from financial_reconciliation_issues
       where (resource_type = 'refund' and resource_id = $1)
          or (resource_type = 'allocation_set' and resource_id = $2)
       order by id`,
      [fixture.refundId, selectedSetId]
    )).rows;
    expect(issues).toHaveLength(3);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: historicalSelectedIssueId,
        resource_type: 'allocation_set',
        resource_id: selectedSetId,
        safe_code: 'allocation_incomplete',
        state: 'resolved',
        resolved_by_admin_id: null
      }),
      expect.objectContaining({
        resource_type: 'refund',
        resource_id: fixture.refundId,
        safe_code: 'allocation_incomplete',
        state: 'resolved',
        resolved_by_admin_id: actor.id
      }),
      expect.objectContaining({
        resource_type: 'allocation_set',
        resource_id: selectedSetId,
        safe_code: 'allocation_incomplete',
        state: 'resolved',
        resolved_by_admin_id: actor.id
      })
    ]));
    await expect(ownerDatabaseClient.pool.query(
      `select actor_id, correlation_id, before, after
       from audit_events
       where action = 'financial.refund_allocation.finalized'
         and resource_id = $1`,
      [fixture.refundId]
    )).resolves.toMatchObject({
      rows: [expect.objectContaining({
        actor_id: actor.id,
        correlation_id: 'refund-review-success-finalize'
      })]
    });
    await expect(ownerDatabaseClient.pool.query(
      `select refund.financial_evidence_status,
         count(head.*)::integer as head_count,
         bool_and(head.is_complete) as all_complete,
         bool_and(head.missing_source_count = 0 and head.proposed_issue_code is null)
           as no_projection_issue
       from refunds refund
       join current_financial_projection_heads head
         on head.balance_transaction_id in (
           select distinct allocation_set.balance_transaction_id
           from financial_allocation_sets allocation_set
           where allocation_set.source_kind = 'refund'
             and allocation_set.source_internal_id = refund.id
         )
       where refund.id = $1
       group by refund.financial_evidence_status`,
      [fixture.refundId]
    )).resolves.toMatchObject({
      rows: [{
        financial_evidence_status: 'fee_reconciled',
        head_count: 2,
        all_complete: true,
        no_projection_issue: true
      }]
    });
    await expect(ownerDatabaseClient.pool.query(
      `select topic, deduplication_key, payload
       from outbox_messages where deduplication_key = $1`,
      [`commerce:access-change:event:${submitted.commandId}:v1`]
    )).resolves.toMatchObject({
      rows: [expect.objectContaining({
        topic: 'email.commerce.v1',
        deduplication_key: `commerce:access-change:event:${submitted.commandId}:v1`,
        payload: expect.objectContaining({
          template: 'commerce.refund-access-changed',
          to: fixture.purchaserEmail,
          messageId: submitted.commandId,
          reasonCategory: 'refund_completed',
          affectedTitleCount: 1
        })
      })]
    });
    const replayed = await submit(actor, command, 'success-finalize-authoritative', idempotencyKey);
    expect(replayed).toEqual({ ...submitted, status: 'succeeded' });
    expect(await readFinalizationMutationSnapshot(fixture, submitted.commandId)).toEqual(finalized);
  }, 30_000);

  it('serializes two administrators so exactly one finalization wins the shared draft', async () => {
    const firstAdmin = await createAdministrator('finalize-race-first');
    const secondAdmin = await createAdministrator('finalize-race-second');
    const fixture = await createAmbiguousFinalizationFixture('race');
    const draftVersion = await saveCompleteFinalizationDraft(firstAdmin, fixture, 'race');
    const [firstPreview, secondPreview] = await Promise.all([
      previewFinalization(firstAdmin, fixture, draftVersion, 'race-first'),
      previewFinalization(secondAdmin, fixture, draftVersion, 'race-second')
    ]);
    expect(secondPreview.previewFingerprint).toBe(firstPreview.previewFingerprint);
    const firstSubmission = await submit(firstAdmin, finalizeCommand(
      fixture, draftVersion, firstPreview.previewFingerprint
    ), 'race-first');
    const secondSubmission = await submit(secondAdmin, finalizeCommand(
      fixture, draftVersion, secondPreview.previewFingerprint
    ), 'race-second');
    const firstClaim = await claimCommand(firstSubmission.commandId, 'race-first');
    const secondClaim = await claimCommand(secondSubmission.commandId, 'race-second');
    const outcomes = await Promise.all([
      executeClaimedCommand(firstClaim, finalizationExecutors),
      executeClaimedCommand(secondClaim, finalizationExecutors)
    ]);
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
    const [firstStatus, secondStatus] = await Promise.all([
      getFinancialAdminCommandStatus(databaseClient.db, firstAdmin, firstSubmission.commandId),
      getFinancialAdminCommandStatus(databaseClient.db, secondAdmin, secondSubmission.commandId)
    ]);
    if (firstStatus === null || secondStatus === null) {
      throw new Error('Expected both racing finalization command statuses.');
    }
    expect([firstStatus.status, secondStatus.status].sort()).toEqual(['conflict', 'succeeded']);
    const conflict = [firstStatus, secondStatus].find((status) => status.status === 'conflict');
    expect(conflict).toMatchObject({ status: 'conflict', resultCode: 'not_eligible' });
    await expect(ownerDatabaseClient.pool.query(
      `select
         (select count(*)::integer from refund_allocations where refund_id = $1)
           as allocations,
         (select count(*)::integer from refund_allocation_components where refund_id = $1)
           as components,
         (select count(*)::integer from refund_allocation_finalization_effects where refund_id = $1)
           as effects,
         (select count(*)::integer from audit_events
           where action = 'financial.refund_allocation.finalized' and resource_id = $1::text)
           as audits,
         (select count(*)::integer from outbox_messages
           where deduplication_key in ($2, $3)) as messages`,
      [
        fixture.refundId,
        `commerce:access-change:event:${firstSubmission.commandId}:v1`,
        `commerce:access-change:event:${secondSubmission.commandId}:v1`
      ]
    )).resolves.toMatchObject({
      rows: [{ allocations: 2, components: 2, effects: 2, audits: 1, messages: 1 }]
    });
  }, 30_000);

  it('rejects provider-backed refund drift and newly exhausted item capacity after preview', async () => {
    const actor = await createAdministrator('finalize-drift');

    const providerFixture = await createAmbiguousFinalizationFixture('provider-drift');
    const providerDraftVersion = await saveCompleteFinalizationDraft(
      actor, providerFixture, 'provider-drift'
    );
    const providerPreview = await previewFinalization(
      actor, providerFixture, providerDraftVersion, 'provider-drift'
    );
    await ownerDatabaseClient.pool.query(
      `update refunds set provider_created_at = provider_created_at + interval '1 millisecond',
         updated_at = statement_timestamp()
       where id = $1`,
      [providerFixture.refundId]
    );
    const providerSubmission = await submit(actor, finalizeCommand(
      providerFixture,
      providerDraftVersion,
      providerPreview.previewFingerprint
    ), 'provider-drift-finalize');
    const providerBefore = await readFinalizationMutationSnapshot(
      providerFixture,
      providerSubmission.commandId
    );
    expect((await runClaimedCommand(
      providerSubmission.commandId,
      'provider-drift-finalize',
      finalizationExecutors
    )).error).not.toBeNull();
    await expect(getFinancialAdminCommandStatus(
      databaseClient.db,
      actor,
      providerSubmission.commandId
    )).resolves.toMatchObject({ status: 'conflict', resultCode: 'stale_state' });
    expect(await readFinalizationMutationSnapshot(
      providerFixture,
      providerSubmission.commandId
    )).toEqual(providerBefore);

    const capacityFixture = await createAmbiguousFinalizationFixture('capacity-drift');
    const capacityDraftVersion = await saveCompleteFinalizationDraft(
      actor, capacityFixture, 'capacity-drift'
    );
    const capacityPreview = await previewFinalization(
      actor, capacityFixture, capacityDraftVersion, 'capacity-drift'
    );
    const sibling = (await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into refunds (
         payment_id, stripe_refund_id, status, amount_minor, currency,
         provider_created_at, allocation_status, financial_evidence_status
       ) values ($1, $2, 'succeeded', 100, 'USD',
         '2026-08-22T11:30:00.000Z', 'finalized', 'pending') returning id`,
      [capacityFixture.paymentId, token('re_capacity_drift')]
    )).rows[0]!;
    const siblingAllocation = (await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
       values ($1, $2, 100, 'automatic') returning id`,
      [sibling.id, capacityFixture.secondItemId]
    )).rows[0]!;
    await ownerDatabaseClient.pool.query(
      `insert into refund_allocation_components (
         refund_allocation_id, refund_id, order_item_id,
         subtotal_minor, tax_minor, total_minor, currency
       ) values ($1, $2, $3, 90, 10, 100, 'USD')`,
      [siblingAllocation.id, sibling.id, capacityFixture.secondItemId]
    );
    const capacitySubmission = await submit(actor, finalizeCommand(
      capacityFixture,
      capacityDraftVersion,
      capacityPreview.previewFingerprint
    ), 'capacity-drift-finalize');
    const capacityBefore = await readFinalizationMutationSnapshot(
      capacityFixture,
      capacitySubmission.commandId
    );
    expect((await runClaimedCommand(
      capacitySubmission.commandId,
      'capacity-drift-finalize',
      finalizationExecutors
    )).error).not.toBeNull();
    await expect(getFinancialAdminCommandStatus(
      databaseClient.db,
      actor,
      capacitySubmission.commandId
    )).resolves.toMatchObject({ status: 'conflict', resultCode: 'stale_state' });
    expect(await readFinalizationMutationSnapshot(
      capacityFixture,
      capacitySubmission.commandId
    )).toEqual(capacityBefore);
  }, 45_000);

  it('rejects a finalization when a projection replay becomes pending after preview', async () => {
    const actor = await createAdministrator('finalize-pending-projection');
    const fixture = await createAmbiguousFinalizationFixture('pending-projection');
    const draftVersion = await saveCompleteFinalizationDraft(
      actor, fixture, 'pending-projection'
    );
    const preview = await previewFinalization(
      actor, fixture, draftVersion, 'pending-projection'
    );
    const rollback = new Error('rollback pending projection fixture');
    try {
      await workerDatabaseClient.db.transaction(async (transaction) => {
        const pendingScanRunId = randomUUID();
        await transaction.execute(sql`
          update financial_projection_versions set
            pending_classifier_version = classifier_version + 1,
            pending_allocation_algorithm_version = allocation_algorithm_version,
            pending_replay_id = 'c' || (classifier_version + 1)::text ||
              '-a' || allocation_algorithm_version::text,
            pending_scan_run_id = ${pendingScanRunId}::uuid
          where singleton = true
        `);
        await expect(executeRefundAllocationFinalize({
          transaction,
          commandId: randomUUID(),
          actor,
          correlationId: `refund-finalize-pending-${randomUUID()}`,
          signal: new AbortController().signal,
          enqueueAccessChange: (input) => accessMessages.enqueueAccessChange(transaction, input)
        }, finalizeCommand(
          fixture,
          draftVersion,
          preview.previewFingerprint
        ))).rejects.toMatchObject({
          name: 'FinancialAdminConflictError',
          safeCode: 'stale_state'
        });
        throw rollback;
      });
      throw new Error('Pending projection fixture transaction unexpectedly committed.');
    } catch (error) {
      expect(error).toBe(rollback);
    }
    await expect(ownerDatabaseClient.pool.query(
      `select pending_classifier_version, pending_allocation_algorithm_version,
         pending_replay_id, pending_scan_run_id
       from financial_projection_versions where singleton = true`
    )).resolves.toMatchObject({
      rows: [{
        pending_classifier_version: null,
        pending_allocation_algorithm_version: null,
        pending_replay_id: null,
        pending_scan_run_id: null
      }]
    });
  }, 30_000);

  it.each([
    {
      label: 'another active grant',
      options: { otherActiveGrantForSecondTitle: true },
      expectedBeforeAccess: true,
      expectedAfterAccess: true,
      expectedOtherGrant: true,
      expectedBeforeGrantState: 'active'
    },
    {
      label: 'an unclaimed guest purchase',
      options: { guest: true },
      expectedBeforeAccess: false,
      expectedAfterAccess: false,
      expectedOtherGrant: false,
      expectedBeforeGrantState: 'unclaimed'
    }
  ])('revokes the fully refunded purchase grant without email for $label', async ({
    label,
    options,
    expectedBeforeAccess,
    expectedAfterAccess,
    expectedOtherGrant,
    expectedBeforeGrantState
  }) => {
    const actor = await createAdministrator(`finalize-${label.replaceAll(' ', '-')}`);
    const fixture = await createAmbiguousFinalizationFixture(
      `access-${label.replaceAll(' ', '-')}`,
      options
    );
    const draftVersion = await saveCompleteFinalizationDraft(
      actor,
      fixture,
      `access-${label.replaceAll(' ', '-')}`
    );
    const preview = await previewFinalization(
      actor,
      fixture,
      draftVersion,
      `access-${label.replaceAll(' ', '-')}`
    );
    expect(preview.items.find((item) => item.orderItemId === fixture.secondItemId))
      .toMatchObject({
        wouldBeFullyRefunded: true,
        purchaseGrantWouldBeRevoked: true,
        otherActiveGrantPreservesAccess: expectedOtherGrant,
        effectiveAccessWouldChange: false,
        emailQueued: false
      });
    const submitted = await submit(actor, finalizeCommand(
      fixture,
      draftVersion,
      preview.previewFingerprint
    ), `access-${label.replaceAll(' ', '-')}-finalize`);
    expect((await runClaimedCommand(
      submitted.commandId,
      `access-${label.replaceAll(' ', '-')}-finalize`,
      finalizationExecutors
    )).error).toBeNull();
    await expect(getFinancialAdminCommandStatus(
      databaseClient.db,
      actor,
      submitted.commandId
    )).resolves.toMatchObject({
      status: 'succeeded',
      result: {
        refundId: fixture.refundId,
        finalizedDraftVersion: 2,
        accessChanged: false,
        emailQueued: false
      }
    });
    await expect(ownerDatabaseClient.pool.query(
      `select grant_row.state,
         effect.before_purchase_grant_state,
         effect.after_purchase_grant_state,
         effect.before_effective_access,
         effect.after_effective_access,
         effect.transition,
         (select count(*)::integer from outbox_messages message
           where message.deduplication_key = $3) as message_count
       from entitlement_grants grant_row
       join refund_allocation_finalization_effects effect
         on effect.purchase_grant_id = grant_row.id
       where grant_row.id = $1 and effect.refund_id = $2`,
      [
        fixture.secondPurchaseGrantId,
        fixture.refundId,
        `commerce:access-change:event:${submitted.commandId}:v1`
      ]
    )).resolves.toMatchObject({
      rows: [{
        state: 'revoked',
        before_purchase_grant_state: expectedBeforeGrantState,
        after_purchase_grant_state: 'revoked',
        before_effective_access: expectedBeforeAccess,
        after_effective_access: expectedAfterAccess,
        transition: 'revoked_by_finalization',
        message_count: 0
      }]
    });
    if (fixture.purchaserUserId === null) {
      await expect(ownerDatabaseClient.pool.query(
        `select count(*)::integer as count from entitlements
         where title_id in ($1, $2)`,
        [fixture.firstTitleId, fixture.secondTitleId]
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } else {
      await expect(ownerDatabaseClient.pool.query(
        `select revoked_at from entitlements where user_id = $1 and title_id = $2`,
        [fixture.purchaserUserId, fixture.secondTitleId]
      )).resolves.toMatchObject({ rows: [{ revoked_at: null }] });
    }
  }, 30_000);

  it.each([
    'projection',
    'outbox',
    'audit'
  ] as const)('rolls back the complete finalization graph on forced %s failure', async (kind) => {
    const actor = await createAdministrator(`finalize-${kind}-rollback`);
    const fixture = await createAmbiguousFinalizationFixture(`${kind}-rollback`);
    const draftVersion = await saveCompleteFinalizationDraft(
      actor,
      fixture,
      `${kind}-rollback`
    );
    const preview = await previewFinalization(
      actor,
      fixture,
      draftVersion,
      `${kind}-rollback`
    );
    const submitted = await submit(actor, finalizeCommand(
      fixture,
      draftVersion,
      preview.previewFingerprint
    ), `${kind}-rollback-finalize`);
    const before = await readFinalizationMutationSnapshot(fixture, submitted.commandId);
    const removeFailure = await installForcedFinalizationFailure(
      kind,
      fixture,
      submitted.commandId
    );
    try {
      expect((await runClaimedCommand(
        submitted.commandId,
        `${kind}-rollback-finalize`,
        finalizationExecutors
      )).error).not.toBeNull();
      expect(await readFinalizationMutationSnapshot(fixture, submitted.commandId))
        .toEqual(before);
      await expect(ownerDatabaseClient.pool.query(
        `select status, safe_result_code, safe_result, completed_at
         from financial_admin_commands where id = $1`,
        [submitted.commandId]
      )).resolves.toMatchObject({
        rows: [{
          status: 'failed',
          safe_result_code: 'command_failed',
          safe_result: null,
          completed_at: expect.any(Date)
        }]
      });
    } finally {
      await removeFailure();
    }
  }, 30_000);
});
