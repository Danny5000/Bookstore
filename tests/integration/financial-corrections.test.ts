import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdministratorActor } from '$lib/server/auth/admin-policy';
import { createCommerceMessageEnqueuer } from '$lib/server/commerce/email/enqueue';
import { createFinancialAdminCommandExecutors } from
  '$lib/server/commerce/financial/admin-commands/executors';
import {
  createFinancialAdminCommandHandler,
  type FinancialAdminCommandExecutor
} from '$lib/server/commerce/financial/admin-commands/handler';
import {
  getFinancialAdminCommandStatus,
  submitFinancialAdminCommand
} from '$lib/server/commerce/financial/admin-commands/repository';
import type { FinancialAdminPrivateCommand } from
  '$lib/server/commerce/financial/admin-commands/contracts';
import {
  executeRefundDraftDiscard,
  executeRefundDraftSave
} from '$lib/server/commerce/financial/refund-review/drafts';
import {
  executeRefundAllocationFinalize,
  previewRefundFinalization
} from '$lib/server/commerce/financial/refund-review/finalize';
import {
  executeReportingCorrectionCreate,
  getReportingCorrectionSeed,
  previewReportingCorrection
} from '$lib/server/commerce/financial/refund-review/corrections';
import type { ReportingCorrectionPrepareInput } from
  '$lib/server/commerce/financial/refund-review/inputs';
import { reconcileRefundFinancialSource } from
  '$lib/server/commerce/financial/sources/refund';
import { createFixtureStripeGateway } from '$lib/server/commerce/stripe/fixture-gateway';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import { runWorker } from '$lib/server/jobs/runner';
import type { JobRecord } from '$lib/server/jobs/types';
import type {
  RefundReportingCorrectionPreviewDto,
  RefundReportingCorrectionSeedDto
} from '$lib/types/financial-reporting';
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
const FINANCIAL_ADMIN_COMMAND_JOB = 'commerce.financial-admin-command';
const CORRECTION_WORKER_TIMEOUT_MS = 25_000;
const CORRECTION_WORKER_SETTLEMENT_TIMEOUT_MS = 5_000;
const CORRECTION_FAULT_DDL_CONNECTION_TIMEOUT_MS = 2_000;
const CORRECTION_FAULT_DDL_TIMEOUT_MS = 5_000;

interface CorrectionFixture {
  readonly refundId: string;
  readonly paymentId: string;
  readonly orderId: string;
  readonly firstItemId: string;
  readonly secondItemId: string;
  readonly purchaserUserId: string;
  readonly purchaserEmail: string;
  readonly firstTitleId: string;
  readonly secondTitleId: string;
  readonly firstPurchaseGrantId: string;
  readonly secondPurchaseGrantId: string;
  readonly providerBalanceTransactionId: string;
  readonly stripe: ReturnType<typeof createFixtureStripeGateway>;
}

interface CorrectionFixtureOptions {
  readonly feeRawType?: 'stripe_fee' | 'tax';
}

interface ClaimedCommand {
  readonly job: JobRecord;
  readonly workerId: string;
  readonly repository: ReturnType<typeof createPostgresJobRepository>;
}

interface ProtectedCommerceSnapshot {
  readonly order_row: string;
  readonly payment_row: string;
  readonly refund_row: string;
  readonly order_items: string;
  readonly allocations: string;
  readonly components: string;
  readonly financial_sets: string;
  readonly financial_items: string;
  readonly effects: string;
  readonly grants: string;
  readonly entitlements: string;
  readonly copy_totals: string;
  readonly email_messages: number;
  readonly outbox_messages: number;
}

interface CorrectionDomainSnapshot {
  readonly correction_sets: string;
  readonly correction_items: string;
  readonly issue_states: string;
  readonly head_states: string;
  readonly correction_audits: string;
  readonly issue_resolution_audits: string;
  readonly refund_projection_audits: string;
}

interface FailedCommandLifecycle {
  readonly command_status: string;
  readonly safe_result_code: string | null;
  readonly safe_result: string | null;
  readonly command_completed: boolean;
  readonly job_status: string;
  readonly job_attempts: number;
  readonly job_max_attempts: number;
  readonly job_last_error: string | null;
  readonly job_completed: boolean;
}

interface CorrectionItemRow {
  readonly domain: 'presentment' | 'settlement';
  readonly source_allocation_set_id: string | null;
  readonly order_item_id: string;
  readonly component: 'refund_subtotal' | 'refund_tax' | 'refund_fee';
  readonly currency: string;
  readonly approved_absolute_minor: number;
  readonly delta_minor: number;
  readonly stable_tie_break_key: string;
}

function token(label: string): string {
  return `${label}_${randomUUID().replaceAll('-', '')}`;
}

function leaseCapability(label: string): string {
  return createHash('sha256').update(`financial-correction:${label}`).digest('base64url');
}

async function within<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function acquireBoundedOwnerClient(label: string): Promise<PoolClient> {
  const acquisition = ownerDatabaseClient.pool.connect();
  try {
    return await within(
      acquisition,
      CORRECTION_FAULT_DDL_CONNECTION_TIMEOUT_MS,
      `Timed out acquiring owner DDL connection for ${label}.`
    );
  } catch (error) {
    void acquisition.then(
      (client) => client.release(true),
      () => undefined
    );
    throw error;
  }
}

async function executeBoundedOwnerDdl(statement: string, label: string): Promise<void> {
  const client = await acquireBoundedOwnerClient(label);
  let reusable = false;
  try {
    await within(
      client.query(`
        begin;
        set local lock_timeout = '3s';
        set local statement_timeout = '4s';
        ${statement}
        commit;
      `),
      CORRECTION_FAULT_DDL_TIMEOUT_MS,
      `Timed out executing owner DDL for ${label}.`
    );
    reusable = true;
  } finally {
    if (reusable) client.release();
    else client.release(true);
  }
}

function correctionContext(label: string) {
  return {
    correlationId: `financial-correction-${label}`,
    requestMetadata: {
      method: 'POST',
      routeId: '/admin/sales/refunds/[refundId]?/prepareCorrection'
    }
  } as const;
}

async function createAdministrator(label: string): Promise<AdministratorActor> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [id, `Correction administrator ${label}`, `${label}-${id}@example.test`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [id]
  );
  return { type: 'user', id, roles: ['admin'] };
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

async function createCorrectionFixture(
  label: string,
  options: CorrectionFixtureOptions = {}
): Promise<CorrectionFixture> {
  const paidAt = new Date('2026-08-22T10:00:00.000Z');
  const refundCreatedAt = new Date('2026-08-22T11:00:00.000Z');
  const purchaserEmail = `${label}-${randomUUID()}@example.test`.toLowerCase();
  const purchaserUserId = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true) returning id`,
    [randomUUID(), `Correction purchaser ${label}`, purchaserEmail]
  )).rows[0]!.id;
  const titleIds = [randomUUID(), randomUUID()] as const;
  for (const [index, titleId] of titleIds.entries()) {
    await ownerDatabaseClient.pool.query(
      `insert into titles
         (id, slug, title, description, creator_name, format, price_minor, currency)
       values ($1, $2, $3, 'Correction fixture description', $4, $5, $6, 'USD')`,
      [
        titleId,
        `financial-correction-${label}-${index}-${titleId.slice(-8)}`,
        `Correction fixture title ${index + 1}`,
        `Correction creator ${index + 1}`,
        index === 0 ? 'prose' : 'comic',
        index === 0 ? 600 : 400
      ]
    );
  }
  const order = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into orders (
       status, initiating_user_id, purchase_email, currency,
       subtotal_minor, tax_minor, total_minor, client_checkout_attempt_id,
       quote_fingerprint_sha256, status_token_sha256, paid_at
     ) values (
       'paid', $1, $2, 'USD', 900, 100, 1000, $3,
       repeat('c', 64), repeat('d', 64), $4
     ) returning id`,
    [purchaserUserId, purchaserEmail, randomUUID(), paidAt]
  )).rows[0]!;
  const items = (await ownerDatabaseClient.pool.query<{ id: string; title_id: string }>(
    `insert into order_items (
       order_id, title_id, title_snapshot, creator_name_snapshot, format,
       currency, unit_subtotal_minor, tax_minor, total_minor
     ) values
       ($1, $2, 'First correction sold-as title', 'First creator', 'prose',
        'USD', 540, 60, 600),
       ($1, $3, 'Second correction sold-as title', 'Second creator', 'comic',
        'USD', 360, 40, 400)
     returning id, title_id`,
    [order.id, titleIds[0], titleIds[1]]
  )).rows;
  const itemIdByTitleId = new Map(items.map((row) => [row.title_id, row.id]));
  const firstItemId = itemIdByTitleId.get(titleIds[0]);
  const secondItemId = itemIdByTitleId.get(titleIds[1]);
  if (!firstItemId || !secondItemId) {
    throw new Error('Correction fixture order items were not returned completely.');
  }
  const stripePaymentIntentId = token('pi_financial_correction');
  const stripeChargeId = token('ch_financial_correction');
  const payment = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into payments (
       order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
       amount_minor, currency, payment_method_category, paid_at,
       financial_evidence_status
     ) values ($1, $2, $3, 'succeeded', 1000, 'USD', 'card', $4, 'pending')
     returning id`,
    [order.id, stripePaymentIntentId, stripeChargeId, paidAt]
  )).rows[0]!;
  const stripeRefundId = token('re_financial_correction');
  const refund = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refunds (
       payment_id, stripe_refund_id, status, amount_minor, currency, reason,
       provider_created_at, allocation_status, financial_evidence_status
     ) values ($1, $2, 'succeeded', 500, 'USD', 'requested_by_customer',
       $3, 'needs_review', 'pending') returning id`,
    [payment.id, stripeRefundId, refundCreatedAt]
  )).rows[0]!;
  const grants = (await ownerDatabaseClient.pool.query<{
    id: string;
    order_item_id: string;
  }>(
    `insert into entitlement_grants (
       title_id, user_id, source, order_item_id, state, state_reason, granted_at
     ) values
       ($1, $3, 'purchase', $4, 'active', 'payment_succeeded', $6),
       ($2, $3, 'purchase', $5, 'active', 'payment_succeeded', $6)
     returning id, order_item_id`,
    [titleIds[0], titleIds[1], purchaserUserId, firstItemId, secondItemId, paidAt]
  )).rows;
  const grantIdByItemId = new Map(grants.map((row) => [row.order_item_id, row.id]));
  const firstPurchaseGrantId = grantIdByItemId.get(firstItemId);
  const secondPurchaseGrantId = grantIdByItemId.get(secondItemId);
  if (!firstPurchaseGrantId || !secondPurchaseGrantId) {
    throw new Error('Correction fixture purchase grants were not returned completely.');
  }
  await ownerDatabaseClient.pool.query(
    `insert into entitlements (user_id, title_id, granted_at)
     values ($1, $2, $4), ($1, $3, $4)`,
    [purchaserUserId, titleIds[0], titleIds[1], paidAt]
  );

  const providerBalanceTransactionId = token('txn_financial_correction');
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
    balanceTransactionId: token('txn_charge_financial_correction'),
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
    feeDetails: [{
      ordinal: 0,
      rawType: options.feeRawType ?? 'stripe_fee',
      amountMinor: 10,
      currency: 'USD'
    }]
  }));
  await expect(reconcileRefundFinancialSource(
    workerDatabaseClient.db,
    stripe.gateway,
    { refundId: refund.id, correlationId: `correction-source-${label}` },
    new AbortController().signal
  )).resolves.toMatchObject({
    status: 'pending',
    sourceKind: 'refund',
    sourceId: refund.id,
    safeCode: 'allocation_incomplete'
  });
  await completeFixtureClassificationJobs(refund.id);
  return {
    refundId: refund.id,
    paymentId: payment.id,
    orderId: order.id,
    firstItemId,
    secondItemId,
    purchaserUserId,
    purchaserEmail,
    firstTitleId: titleIds[0],
    secondTitleId: titleIds[1],
    firstPurchaseGrantId,
    secondPurchaseGrantId,
    providerBalanceTransactionId,
    stripe
  };
}

function executorMap(input: {
  readonly refundAllocationFinalize?: FinancialAdminCommandExecutor;
  readonly refundReportingCorrectionCreate?: FinancialAdminCommandExecutor;
} = {}) {
  const future = (name: string): FinancialAdminCommandExecutor => async () => {
    throw new Error(`${name} is intentionally unavailable in this integration lane`);
  };
  return createFinancialAdminCommandExecutors({
    refundDraftSave: executeRefundDraftSave as FinancialAdminCommandExecutor,
    refundDraftDiscard: executeRefundDraftDiscard as FinancialAdminCommandExecutor,
    refundAllocationFinalize: input.refundAllocationFinalize ?? future('finalize'),
    refundReportingCorrectionCreate:
      input.refundReportingCorrectionCreate ?? future('correction'),
    administrativeRecoveryActivate: future('recovery activate'),
    administrativeRecoveryDeactivate: future('recovery deactivate')
  });
}

const finalizationExecutors = executorMap({
  refundAllocationFinalize: executeRefundAllocationFinalize as FinancialAdminCommandExecutor
});

const correctionExecutors = executorMap({
  refundReportingCorrectionCreate:
    executeReportingCorrectionCreate as FinancialAdminCommandExecutor
});

async function claimCommand(expectedCommandId: string, label: string): Promise<ClaimedCommand> {
  const capability = leaseCapability(label);
  const repository = createPostgresJobRepository(
    workerDatabaseClient.db,
    { ...applicationConfig.jobs, leaseMs: 60_000 },
    undefined,
    'local-only',
    { classifierVersion: 1, allocationAlgorithmVersion: 1 },
    () => capability
  );
  const workerId = `financial-correction-${label}`;
  const job = await repository.claimNext(workerId);
  expect(job).not.toBeNull();
  expect(job!.payload).toEqual({ commandId: expectedCommandId });
  return { job: job!, workerId, repository };
}

async function executeClaimedCommand(
  claimed: ClaimedCommand,
  executors = correctionExecutors
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
  executors = correctionExecutors
): Promise<unknown | null> {
  return executeClaimedCommand(await claimCommand(expectedCommandId, label), executors);
}

async function runCorrectionCommandWorkerToTerminal(
  commandId: string,
  label: string
): Promise<void> {
  let capabilityGeneration = 0;
  const repository = createPostgresJobRepository(
    workerDatabaseClient.db,
    {
      ...applicationConfig.jobs,
      leaseMs: 60_000,
      retryBaseMs: 1,
      retryMaxMs: 1
    },
    undefined,
    'local-only',
    { classifierVersion: 1, allocationAlgorithmVersion: 1 },
    () => leaseCapability(`${label}-${capabilityGeneration++}`)
  );
  const handler = createFinancialAdminCommandHandler({
    database: workerDatabaseClient.db,
    executors: correctionExecutors,
    accessMessages
  });
  const controller = new AbortController();
  let polls = 0;
  let observationError: unknown;
  const operation = runWorker({
    repository,
    handlers: new Map([[FINANCIAL_ADMIN_COMMAND_JOB, handler]]),
    workerId: `financial-correction-worker-${label}`,
    concurrency: 1,
    pollIntervalMs: 1,
    leaseRenewalIntervalMs: 20_000,
    signal: controller.signal,
    beforePoll: async () => {
      polls += 1;
      if (polls > 512) {
        observationError = new Error(
          'Reporting-correction worker exceeded its bounded poll budget.'
        );
        controller.abort();
        return;
      }
      try {
        const lifecycle = await readFailedCommandLifecycle(commandId);
        if (lifecycle.job_status === 'failed') {
          controller.abort();
          return;
        }
        if (
          lifecycle.command_status !== 'pending' ||
          (lifecycle.job_status !== 'pending' && lifecycle.job_status !== 'running')
        ) {
          observationError = new Error(
            'Reporting-correction worker reached an unexpected command/job state.'
          );
          controller.abort();
        }
      } catch (error) {
        observationError = error;
        controller.abort();
      }
    },
    sleep: async () => {},
    leaseRenewalSleep: async (_milliseconds, signal) => {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  });

  let workerError: unknown;
  try {
    await within(
      operation,
      CORRECTION_WORKER_TIMEOUT_MS,
      `Timed out running reporting-correction worker for ${label}.`
    );
  } catch (error) {
    workerError = error;
  } finally {
    controller.abort();
    try {
      await within(
        operation,
        CORRECTION_WORKER_SETTLEMENT_TIMEOUT_MS,
        `Timed out settling reporting-correction worker for ${label}.`
      );
    } catch (error) {
      if (workerError === undefined) workerError = error;
    }
  }

  if (workerError !== undefined) throw workerError;
  if (observationError !== undefined) throw observationError;
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
    context: { correlationId: `financial-correction-${label}` }
  });
}

async function finalizeFixture(
  actor: AdministratorActor,
  fixture: CorrectionFixture,
  label: string
): Promise<void> {
  const draft = await submit(actor, {
    kind: 'refund_draft_save',
    refundId: fixture.refundId,
    expectedVersion: null,
    items: [
      { orderItemId: fixture.firstItemId, totalPresentmentMinor: 250 },
      { orderItemId: fixture.secondItemId, totalPresentmentMinor: 250 }
    ]
  }, `${label}-draft`);
  expect(await runClaimedCommand(draft.commandId, `${label}-draft`, executorMap())).toBeNull();
  const draftStatus = await getFinancialAdminCommandStatus(
    databaseClient.db,
    actor,
    draft.commandId
  );
  if (
    draftStatus?.status !== 'succeeded' ||
    draftStatus.kind !== 'refund_draft_save' ||
    draftStatus.resultCode !== 'draft_saved'
  ) {
    throw new Error('Expected the correction fixture draft to be saved.');
  }
  const preview = await previewRefundFinalization(
    databaseClient.db,
    actor,
    {
      refundId: fixture.refundId,
      expectedActiveDraftVersion: draftStatus.result.draftVersion
    },
    correctionContext(`${label}-finalization-preview`)
  );
  expect(preview).toMatchObject({
    refundId: fixture.refundId,
    proposedTotalMinor: 500,
    remainderMinor: 0,
    items: expect.arrayContaining([
      expect.objectContaining({
        orderItemId: fixture.firstItemId,
        proposedSubtotalMinor: 225,
        proposedTaxMinor: 25,
        wouldBeFullyRefunded: false
      }),
      expect.objectContaining({
        orderItemId: fixture.secondItemId,
        proposedSubtotalMinor: 225,
        proposedTaxMinor: 25,
        wouldBeFullyRefunded: false
      })
    ])
  });
  const finalized = await submit(actor, {
    kind: 'refund_allocation_finalize',
    refundId: fixture.refundId,
    expectedActiveDraftVersion: draftStatus.result.draftVersion,
    previewFingerprint: preview.previewFingerprint,
    confirmation: 'finalize_refund_allocation'
  }, `${label}-finalize`);
  expect(await runClaimedCommand(
    finalized.commandId,
    `${label}-finalize`,
    finalizationExecutors
  )).toBeNull();
  await expect(getFinancialAdminCommandStatus(
    databaseClient.db,
    actor,
    finalized.commandId
  )).resolves.toMatchObject({
    status: 'succeeded',
    resultCode: 'allocation_finalized',
    result: {
      refundId: fixture.refundId,
      accessChanged: false,
      emailQueued: false
    }
  });
  await completeFixtureClassificationJobs(fixture.refundId);
}

async function createFinalizedCorrectionFixture(
  actor: AdministratorActor,
  label: string,
  options: CorrectionFixtureOptions = {}
): Promise<CorrectionFixture> {
  const fixture = await createCorrectionFixture(label, options);
  await finalizeFixture(actor, fixture, label);
  return fixture;
}

async function loadSeed(
  actor: AdministratorActor,
  fixture: CorrectionFixture,
  label: string
): Promise<RefundReportingCorrectionSeedDto> {
  const seed = await getReportingCorrectionSeed(
    databaseClient.db,
    actor,
    fixture.refundId,
    correctionContext(`${label}-seed`)
  );
  if (seed === null) throw new Error('Expected a reporting-correction seed.');
  return seed;
}

function prepareInput(
  seed: RefundReportingCorrectionSeedDto,
  fixture: CorrectionFixture,
  totals: readonly [number, number]
): ReportingCorrectionPrepareInput {
  const expectedNextCorrectionVersion = seed.expectedNextCorrectionVersion;
  const expectedBaseAllocationSetId = seed.expectedBaseAllocationSetId;
  const expectedSourceFingerprint = seed.expectedSourceFingerprint;
  if (
    !seed.eligible ||
    expectedNextCorrectionVersion === null ||
    expectedBaseAllocationSetId === null ||
    expectedSourceFingerprint === null
  ) {
    throw new Error('Expected an eligible reporting-correction seed.');
  }
  return {
    refundId: fixture.refundId,
    reason: 'allocation_attribution_correction',
    expectedNextCorrectionVersion,
    expectedBaseAllocationSetId,
    expectedSourceFingerprint,
    items: [
      { orderItemId: fixture.firstItemId, totalPresentmentMinor: totals[0] },
      { orderItemId: fixture.secondItemId, totalPresentmentMinor: totals[1] }
    ]
  };
}

async function prepareCorrection(
  actor: AdministratorActor,
  fixture: CorrectionFixture,
  totals: readonly [number, number],
  label: string
): Promise<{
  readonly seed: RefundReportingCorrectionSeedDto;
  readonly input: ReportingCorrectionPrepareInput;
  readonly preview: RefundReportingCorrectionPreviewDto;
}> {
  const seed = await loadSeed(actor, fixture, label);
  const input = prepareInput(seed, fixture, totals);
  const preview = await previewReportingCorrection(
    databaseClient.db,
    actor,
    input,
    correctionContext(`${label}-preview`)
  );
  return { seed, input, preview };
}

function correctionCommand(
  input: ReportingCorrectionPrepareInput,
  preview: RefundReportingCorrectionPreviewDto
): Extract<FinancialAdminPrivateCommand, { kind: 'refund_reporting_correction_create' }> {
  if (!preview.eligible || preview.previewFingerprint === null) {
    throw new Error('Expected an eligible reporting-correction preview.');
  }
  return {
    kind: 'refund_reporting_correction_create',
    ...input,
    previewFingerprint: preview.previewFingerprint,
    confirmation: 'create_reporting_correction'
  };
}

async function executePreparedCorrection(
  actor: AdministratorActor,
  prepared: Awaited<ReturnType<typeof prepareCorrection>>,
  label: string,
  idempotencyKey = randomUUID()
) {
  const command = correctionCommand(prepared.input, prepared.preview);
  const submitted = await submit(actor, command, label, idempotencyKey);
  expect(await runClaimedCommand(submitted.commandId, label)).toBeNull();
  const status = await getFinancialAdminCommandStatus(
    databaseClient.db,
    actor,
    submitted.commandId
  );
  if (
    status?.status !== 'succeeded' ||
    status.kind !== 'refund_reporting_correction_create' ||
    status.resultCode !== 'correction_created'
  ) {
    throw new Error('Expected a succeeded reporting-correction command.');
  }
  return { command, submitted, status };
}

async function readProtectedCommerceSnapshot(
  fixture: CorrectionFixture
): Promise<ProtectedCommerceSnapshot> {
  return (await ownerDatabaseClient.pool.query<ProtectedCommerceSnapshot>(
    `select
       coalesce((select to_jsonb(order_row)::text from orders order_row
         where order_row.id = $7), 'null') as order_row,
       coalesce((select to_jsonb(payment_row)::text from payments payment_row
         where payment_row.id = $8), 'null') as payment_row,
       coalesce((select to_jsonb(refund_row)::text from refunds refund_row
         where refund_row.id = $1), 'null') as refund_row,
       coalesce((select jsonb_agg(to_jsonb(order_item) order by order_item.id)::text
         from order_items order_item where order_item.order_id = $7), '[]') as order_items,
       coalesce((select string_agg(
         allocation.id::text || ':' || allocation.order_item_id::text || ':' ||
           allocation.amount_minor::text || ':' || allocation.source::text,
         ',' order by allocation.id)
         from refund_allocations allocation where allocation.refund_id = $1), '')
         as allocations,
       coalesce((select string_agg(
         component.id::text || ':' || component.order_item_id::text || ':' ||
           component.subtotal_minor::text || ':' || component.tax_minor::text || ':' ||
           component.total_minor::text || ':' || component.currency,
         ',' order by component.id)
         from refund_allocation_components component where component.refund_id = $1), '')
         as components,
       coalesce((select jsonb_agg(to_jsonb(allocation_set) order by allocation_set.id)::text
         from financial_allocation_sets allocation_set
         where allocation_set.source_kind = 'refund'
           and allocation_set.source_internal_id = $1), '[]') as financial_sets,
       coalesce((select jsonb_agg(to_jsonb(item) order by item.id)::text
         from financial_item_allocations item
         join financial_allocation_sets allocation_set
           on allocation_set.id = item.allocation_set_id
         where allocation_set.source_kind = 'refund'
           and allocation_set.source_internal_id = $1), '[]') as financial_items,
       coalesce((select string_agg(
         effect.id::text || ':' || effect.purchase_grant_id::text || ':' ||
           effect.before_purchase_grant_state::text || ':' ||
           effect.after_purchase_grant_state::text || ':' || effect.transition::text,
         ',' order by effect.id)
         from refund_allocation_finalization_effects effect where effect.refund_id = $1), '')
         as effects,
       coalesce((select jsonb_agg(to_jsonb(grant_row) order by grant_row.id)::text
         from entitlement_grants grant_row
         where grant_row.order_item_id in (
           select purchase_grant.order_item_id
           from entitlement_grants purchase_grant
           where purchase_grant.id in ($2, $3)
         )), '[]') as grants,
       coalesce((select string_agg(
         entitlement.title_id::text || ':' || coalesce(entitlement.revoked_at::text, 'active'),
         ',' order by entitlement.title_id)
         from entitlements entitlement
         where entitlement.user_id = $4 and entitlement.title_id in ($5, $6)), '')
         as entitlements,
       coalesce((select string_agg(
         order_item.id::text || ':' ||
           coalesce(refunded.refunded_total_minor, 0)::text || ':' ||
           case when coalesce(refunded.refunded_total_minor, 0) >= order_item.total_minor
             then 'fully_refunded' else 'retained' end,
         ',' order by order_item.id)
         from order_items order_item
         left join lateral (
           select sum(component.total_minor)::integer as refunded_total_minor
           from refund_allocation_components component
           join refunds refund on refund.id = component.refund_id
           where component.order_item_id = order_item.id and refund.status = 'succeeded'
         ) refunded on true
         where order_item.order_id = $7), '') as copy_totals,
       (select count(*)::integer from outbox_messages message
         where message.topic = 'email.commerce.v1') as email_messages,
       (select count(*)::integer from outbox_messages) as outbox_messages`,
    [
      fixture.refundId,
      fixture.firstPurchaseGrantId,
      fixture.secondPurchaseGrantId,
      fixture.purchaserUserId,
      fixture.firstTitleId,
      fixture.secondTitleId,
      fixture.orderId,
      fixture.paymentId
    ]
  )).rows[0]!;
}

async function readCorrectionDomainSnapshot(
  fixture: CorrectionFixture
): Promise<CorrectionDomainSnapshot> {
  return (await ownerDatabaseClient.pool.query<CorrectionDomainSnapshot>(
    `select
       coalesce((select jsonb_agg(to_jsonb(correction) order by correction.id)::text
         from refund_reporting_correction_sets correction
         where correction.refund_id = $1), '[]') as correction_sets,
       coalesce((select jsonb_agg(to_jsonb(item) order by item.id)::text
         from refund_reporting_correction_items item
         join refund_reporting_correction_sets correction
           on correction.id = item.correction_set_id
         where correction.refund_id = $1), '[]') as correction_items,
       coalesce((select jsonb_agg(to_jsonb(issue) order by issue.id)::text
         from financial_reconciliation_issues issue
         where (issue.resource_type = 'refund' and issue.resource_id = $1)
            or (issue.resource_type = 'allocation_set' and issue.resource_id in (
              select allocation_set.id from financial_allocation_sets allocation_set
              where allocation_set.source_kind = 'refund'
                and allocation_set.source_internal_id = $1
            ))), '[]')
         as issue_states,
       coalesce((select jsonb_agg(to_jsonb(head)
           order by head.balance_transaction_id, head.basis)::text
         from current_financial_projection_heads head
         where head.balance_transaction_id in (
           select distinct allocation_set.balance_transaction_id
           from financial_allocation_sets allocation_set
           where allocation_set.source_kind = 'refund'
             and allocation_set.source_internal_id = $1
         )), '[]') as head_states,
       coalesce((select jsonb_agg(to_jsonb(audit) order by audit.id)::text
         from audit_events audit
         where audit.action = 'financial.refund_correction.created'
           and audit.after ->> 'refundId' = $1::text), '[]') as correction_audits,
       coalesce((select jsonb_agg(to_jsonb(audit) order by audit.id)::text
         from audit_events audit
         join financial_reconciliation_issues issue
           on issue.id::text = audit.resource_id
         where audit.action = 'financial.issue.resolved'
           and audit.resource_type = 'financial_issue'
           and (
             (issue.resource_type = 'refund' and issue.resource_id = $1)
             or (issue.resource_type = 'allocation_set' and issue.resource_id in (
               select allocation_set.id from financial_allocation_sets allocation_set
               where allocation_set.source_kind = 'refund'
                 and allocation_set.source_internal_id = $1
             ))
           )), '[]') as issue_resolution_audits,
       coalesce((select jsonb_agg(to_jsonb(audit) order by audit.id)::text
         from audit_events audit
         where audit.action = 'financial.refund_reconciled'
           and audit.resource_type = 'refund'
           and audit.resource_id = $1::text), '[]') as refund_projection_audits`,
    [fixture.refundId]
  )).rows[0]!;
}

async function readFailedCommandLifecycle(commandId: string): Promise<FailedCommandLifecycle> {
  return (await ownerDatabaseClient.pool.query<FailedCommandLifecycle>(
    `select command.status::text as command_status,
       command.safe_result_code, command.safe_result::text as safe_result,
       command.completed_at is not null as command_completed,
       job.status::text as job_status, job.attempts as job_attempts,
       job.max_attempts as job_max_attempts, job.last_error as job_last_error,
       job.completed_at is not null as job_completed
     from financial_admin_commands command
     join jobs job on job.id = command.job_id
     where command.id = $1`,
    [commandId]
  )).rows[0]!;
}

async function readCorrectionItems(correctionSetId: string): Promise<CorrectionItemRow[]> {
  return (await ownerDatabaseClient.pool.query<CorrectionItemRow>(
    `select domain, source_allocation_set_id, order_item_id, component, currency,
       approved_absolute_minor, delta_minor, stable_tie_break_key
     from refund_reporting_correction_items
     where correction_set_id = $1
     order by stable_tie_break_key collate "C"`,
    [correctionSetId]
  )).rows;
}

function byTieKey(rows: readonly CorrectionItemRow[]): Record<string, CorrectionItemRow> {
  return Object.fromEntries(rows.map((row) => [row.stable_tie_break_key, row]));
}

async function addFinalizedSibling(fixture: CorrectionFixture): Promise<void> {
  const sibling = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refunds (
       payment_id, stripe_refund_id, status, amount_minor, currency,
       provider_created_at, allocation_status, financial_evidence_status
     ) values ($1, $2, 'succeeded', 350, 'USD',
       '2026-08-22T11:30:00.000Z', 'finalized', 'pending') returning id`,
    [fixture.paymentId, token('re_correction_capacity_sibling')]
  )).rows[0]!;
  const allocation = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
     values ($1, $2, 350, 'automatic') returning id`,
    [sibling.id, fixture.firstItemId]
  )).rows[0]!;
  await ownerDatabaseClient.pool.query(
    `insert into refund_allocation_components (
       refund_allocation_id, refund_id, order_item_id,
       subtotal_minor, tax_minor, total_minor, currency
     ) values ($1, $2, $3, 315, 35, 350, 'USD')`,
    [allocation.id, sibling.id, fixture.firstItemId]
  );
}

async function insertOpenRefundIssue(
  refundId: string,
  safeCode: 'allocation_mismatch' | 'correction_rebase_required',
  label: string
): Promise<string> {
  return (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into financial_reconciliation_issues (
       resource_type, resource_id, safe_code, impact, correlation_id
     ) values ('refund', $1, $2, 'exception', $3) returning id`,
    [refundId, safeCode, `financial-correction-${label}`]
  )).rows[0]!.id;
}

async function insertIncompatibleRawTip(
  actor: AdministratorActor,
  seed: RefundReportingCorrectionSeedDto,
  label: string
): Promise<string> {
  if (seed.expectedBaseAllocationSetId === null) {
    throw new Error('Expected an immutable gross base for the raw-tip fixture.');
  }
  return (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refund_reporting_correction_sets (
       refund_id, correction_version, kind, base_allocation_set_id,
       predecessor_correction_set_id, source_fingerprint_sha256,
       approved_by_admin_id, created_by_admin_id, correlation_id
     ) values (
       $1, 1, 'classifier_rebase', $2, null, repeat('f', 64),
       $3, null, $4
     ) returning id`,
    [seed.refundId, seed.expectedBaseAllocationSetId, actor.id,
      `financial-correction-${label}`]
  )).rows[0]!.id;
}

type CorrectionAtomicFaultSeam =
  | 'correction_set_insert'
  | 'correction_item_insert'
  | 'recompute_status_write'
  | 'issue_transition'
  | 'issue_resolution_audit'
  | 'correction_audit'
  | 'post_resolution_head_verification'
  | 'terminal_command_result_write';

interface CorrectionAtomicFaultCase {
  readonly seam: CorrectionAtomicFaultSeam;
  readonly label: string;
  readonly expectedAttempts: number;
  readonly expectedJobLastError: string;
}

interface CorrectionAtomicFaultScope {
  readonly fixture: CorrectionFixture;
  readonly issueId: string;
  readonly baseAllocationSetId: string;
  readonly commandId: string;
}

interface CorrectionAtomicFaultWitness {
  readonly lastValue: number;
  readonly isCalled: boolean;
}

interface CorrectionAtomicFaultInstallation {
  readonly cleanup: () => Promise<void>;
  readonly readTriggerWitness: () => Promise<CorrectionAtomicFaultWitness>;
}

const CORRECTION_ATOMIC_FAULTS = [
  {
    seam: 'correction_set_insert',
    label: 'correction-set insert',
    expectedAttempts: 8,
    expectedJobLastError: 'Transient job handler failure'
  },
  {
    seam: 'correction_item_insert',
    label: 'correction-item insert',
    expectedAttempts: 8,
    expectedJobLastError: 'Transient job handler failure'
  },
  {
    seam: 'recompute_status_write',
    label: 'correction recompute status write',
    expectedAttempts: 8,
    expectedJobLastError: 'Transient job handler failure'
  },
  {
    seam: 'issue_transition',
    label: 'correction-specific issue transition',
    expectedAttempts: 8,
    expectedJobLastError: 'Transient job handler failure'
  },
  {
    seam: 'issue_resolution_audit',
    label: 'issue-resolution audit insert',
    expectedAttempts: 8,
    expectedJobLastError: 'Transient job handler failure'
  },
  {
    seam: 'correction_audit',
    label: 'correction audit insert',
    expectedAttempts: 8,
    expectedJobLastError: 'Transient job handler failure'
  },
  {
    seam: 'post_resolution_head_verification',
    label: 'post-resolution complete-head verification',
    expectedAttempts: 1,
    expectedJobLastError: 'Financial administrator command permanently failed.'
  },
  {
    seam: 'terminal_command_result_write',
    label: 'terminal command-result write',
    expectedAttempts: 8,
    expectedJobLastError: 'Transient job handler failure'
  }
] as const satisfies readonly CorrectionAtomicFaultCase[];

function faultUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
    .test(value)) {
    throw new Error('Reporting-correction fault scope requires a canonical UUID.');
  }
  return `'${value}'::uuid`;
}

async function installCorrectionAtomicFault(
  fault: CorrectionAtomicFaultCase,
  scope: CorrectionAtomicFaultScope
): Promise<CorrectionAtomicFaultInstallation> {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `t13_correction_fault_${suffix}`;
  const triggerName = `t13_correction_fault_${suffix}`;
  const witnessSequenceName = `t13_correction_fault_witness_${suffix}`;
  const refundId = faultUuid(scope.fixture.refundId);
  const issueId = faultUuid(scope.issueId);
  const baseAllocationSetId = faultUuid(scope.baseAllocationSetId);
  const commandId = faultUuid(scope.commandId);
  const revoke = (name: string) => `
    revoke all on function public.${name}() from public,
      pale_orbit_runtime, pale_orbit_financial_worker, pale_orbit_storage_cleanup;`;
  const incrementWitness = `
    perform pg_catalog.nextval(
      'public.${witnessSequenceName}'::pg_catalog.regclass
    );`;

  let setupSql: string;
  let cleanupSql: string;
  switch (fault.seam) {
    case 'correction_set_insert':
      setupSql = `
        create function public.${functionName}() returns trigger
        language plpgsql security invoker set search_path = pg_catalog as $t13_fault$
        begin
          ${incrementWitness}
          raise exception using errcode = '55000',
            message = 'forced reporting correction set insert rollback';
        end
        $t13_fault$;
        ${revoke(functionName)}
        create trigger ${triggerName}
        before insert on public.refund_reporting_correction_sets
        for each row when (
          new.refund_id = ${refundId}
          and new.kind = 'allocation_attribution_correction'
        ) execute function public.${functionName}();`;
      cleanupSql = `
        drop trigger if exists ${triggerName}
          on public.refund_reporting_correction_sets;
        drop function if exists public.${functionName}();`;
      break;
    case 'correction_item_insert':
      setupSql = `
        create function public.${functionName}() returns trigger
        language plpgsql security invoker set search_path = pg_catalog as $t13_fault$
        begin
          if exists (
            select 1 from public.refund_reporting_correction_sets correction
            where correction.id = new.correction_set_id
              and correction.refund_id = ${refundId}
          ) then
            ${incrementWitness}
            raise exception using errcode = '55000',
              message = 'forced reporting correction item insert rollback';
          end if;
          return new;
        end
        $t13_fault$;
        ${revoke(functionName)}
        create trigger ${triggerName}
        before insert on public.refund_reporting_correction_items
        for each row execute function public.${functionName}();`;
      cleanupSql = `
        drop trigger if exists ${triggerName}
          on public.refund_reporting_correction_items;
        drop function if exists public.${functionName}();`;
      break;
    case 'recompute_status_write': {
      const seedFunctionName = `${functionName}_seed`;
      const seedTriggerName = `${triggerName}_seed`;
      setupSql = `
        create function public.${seedFunctionName}() returns trigger
        language plpgsql security definer set search_path = pg_catalog as $t13_fault$
        begin
          update public.refunds refund
          set financial_evidence_status = 'pending'
          where refund.id = new.refund_id
            and refund.id = ${refundId}
            and refund.financial_evidence_status = 'fee_reconciled';
          if not found then
            raise exception using errcode = '55000',
              message = 'reporting correction recompute fault seed was not applied';
          end if;
          return new;
        end
        $t13_fault$;
        ${revoke(seedFunctionName)}
        create function public.${functionName}() returns trigger
        language plpgsql security invoker set search_path = pg_catalog as $t13_fault$
        begin
          ${incrementWitness}
          raise exception using errcode = '55000',
            message = 'forced reporting correction recompute status rollback';
        end
        $t13_fault$;
        ${revoke(functionName)}
        create trigger ${seedTriggerName}
        after insert on public.refund_reporting_correction_sets
        for each row when (
          new.refund_id = ${refundId}
          and new.kind = 'allocation_attribution_correction'
        ) execute function public.${seedFunctionName}();
        create trigger ${triggerName}
        before update of financial_evidence_status on public.refunds
        for each row when (
          old.id = ${refundId}
          and old.financial_evidence_status = 'pending'
          and new.financial_evidence_status = 'fee_reconciled'
        ) execute function public.${functionName}();`;
      cleanupSql = `
        drop trigger if exists ${triggerName} on public.refunds;
        drop trigger if exists ${seedTriggerName}
          on public.refund_reporting_correction_sets;
        drop function if exists public.${functionName}();
        drop function if exists public.${seedFunctionName}();`;
      break;
    }
    case 'issue_transition':
      setupSql = `
        create function public.${functionName}() returns trigger
        language plpgsql security invoker set search_path = pg_catalog as $t13_fault$
        begin
          ${incrementWitness}
          raise exception using errcode = '55000',
            message = 'forced reporting correction issue transition rollback';
        end
        $t13_fault$;
        ${revoke(functionName)}
        create trigger ${triggerName}
        before update on public.financial_reconciliation_issues
        for each row when (
          old.id = ${issueId}
          and old.state = 'open'
          and new.state = 'resolved'
        ) execute function public.${functionName}();`;
      cleanupSql = `
        drop trigger if exists ${triggerName}
          on public.financial_reconciliation_issues;
        drop function if exists public.${functionName}();`;
      break;
    case 'issue_resolution_audit':
      setupSql = `
        create function public.${functionName}() returns trigger
        language plpgsql security invoker set search_path = pg_catalog as $t13_fault$
        begin
          ${incrementWitness}
          raise exception using errcode = '55000',
            message = 'forced reporting correction issue audit rollback';
        end
        $t13_fault$;
        ${revoke(functionName)}
        create trigger ${triggerName}
        before insert on public.audit_events
        for each row when (
          new.action = 'financial.issue.resolved'
          and new.resource_type = 'financial_issue'
          and new.resource_id = '${scope.issueId}'
        ) execute function public.${functionName}();`;
      cleanupSql = `
        drop trigger if exists ${triggerName} on public.audit_events;
        drop function if exists public.${functionName}();`;
      break;
    case 'correction_audit':
      setupSql = `
        create function public.${functionName}() returns trigger
        language plpgsql security invoker set search_path = pg_catalog as $t13_fault$
        begin
          ${incrementWitness}
          raise exception using errcode = '55000',
            message = 'forced reporting correction audit rollback';
        end
        $t13_fault$;
        ${revoke(functionName)}
        create trigger ${triggerName}
        before insert on public.audit_events
        for each row when (
          new.action = 'financial.refund_correction.created'
          and new.after ->> 'refundId' = '${scope.fixture.refundId}'
        ) execute function public.${functionName}();`;
      cleanupSql = `
        drop trigger if exists ${triggerName} on public.audit_events;
        drop function if exists public.${functionName}();`;
      break;
    case 'post_resolution_head_verification': {
      const injectedIssueId = faultUuid(randomUUID());
      setupSql = `
        create function public.${functionName}() returns trigger
        language plpgsql security definer set search_path = pg_catalog as $t13_fault$
        begin
          ${incrementWitness}
          insert into public.financial_reconciliation_issues (
            id, resource_type, resource_id, safe_code, impact, correlation_id
          ) values (
            ${injectedIssueId}, 'allocation_set', ${baseAllocationSetId},
            'allocation_mismatch', 'exception',
            'financial-correction-post-head-fault'
          );
          return new;
        end
        $t13_fault$;
        ${revoke(functionName)}
        create trigger ${triggerName}
        after insert on public.audit_events
        for each row when (
          new.action = 'financial.refund_reconciled'
          and new.resource_type = 'refund'
          and new.resource_id = '${scope.fixture.refundId}'
        ) execute function public.${functionName}();`;
      cleanupSql = `
        drop trigger if exists ${triggerName} on public.audit_events;
        drop function if exists public.${functionName}();`;
      break;
    }
    case 'terminal_command_result_write':
      setupSql = `
        create function public.${functionName}() returns trigger
        language plpgsql security invoker set search_path = pg_catalog as $t13_fault$
        begin
          ${incrementWitness}
          raise exception using errcode = '55000',
            message = 'forced reporting correction terminal result rollback';
        end
        $t13_fault$;
        ${revoke(functionName)}
        create trigger ${triggerName}
        before update on public.financial_admin_commands
        for each row when (
          old.id = ${commandId}
          and old.status = 'pending'
          and new.status = 'succeeded'
          and new.safe_result_code = 'correction_created'
        ) execute function public.${functionName}();`;
      cleanupSql = `
        drop trigger if exists ${triggerName}
          on public.financial_admin_commands;
        drop function if exists public.${functionName}();`;
      break;
  }

  const boundedSetupSql = `
    create sequence public.${witnessSequenceName}
      as integer start with 1 increment by 1 minvalue 1 cache 1;
    revoke all on sequence public.${witnessSequenceName} from public,
      pale_orbit_runtime, pale_orbit_financial_worker, pale_orbit_storage_cleanup;
    grant usage on sequence public.${witnessSequenceName}
      to pale_orbit_financial_worker;
    ${setupSql}`;
  const boundedCleanupSql = `
    ${cleanupSql}
    drop sequence if exists public.${witnessSequenceName};`;

  try {
    await executeBoundedOwnerDdl(boundedSetupSql, `${fault.seam} setup`);
  } catch (setupError) {
    try {
      await executeBoundedOwnerDdl(boundedCleanupSql, `${fault.seam} failed setup cleanup`);
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        `Reporting-correction fault setup and cleanup failed for ${fault.seam}.`,
        { cause: cleanupError }
      );
    }
    throw setupError;
  }
  return {
    cleanup: async () => {
      await executeBoundedOwnerDdl(boundedCleanupSql, `${fault.seam} cleanup`);
    },
    readTriggerWitness: async () => {
      const result = await within(
        ownerDatabaseClient.pool.query<CorrectionAtomicFaultWitness>(
          `select last_value::integer as "lastValue", is_called as "isCalled"
           from public.${witnessSequenceName}`
        ),
        CORRECTION_FAULT_DDL_TIMEOUT_MS,
        `Timed out reading reporting-correction trigger witness for ${fault.seam}.`
      );
      if (result.rows.length !== 1) {
        throw new Error(`Expected one reporting-correction trigger witness for ${fault.seam}.`);
      }
      return result.rows[0]!;
    }
  };
}

describe('refund reporting correction PostgreSQL contract', () => {
  it('appends a first correction and a compatible successor without mutating commerce facts', async () => {
    const actor = await createAdministrator('successor');
    const fixture = await createFinalizedCorrectionFixture(actor, 'successor');
    const issueId = await insertOpenRefundIssue(
      fixture.refundId,
      'allocation_mismatch',
      'successor-issue'
    );
    const commerceBefore = await readProtectedCommerceSnapshot(fixture);
    const first = await prepareCorrection(actor, fixture, [300, 200], 'first');
    expect(first.seed).toMatchObject({
      baselineKind: 'immutable_base',
      currentReportingComplete: true,
      rawPredecessorCorrectionSetId: null,
      compatibleCorrectionSetId: null,
      expectedNextCorrectionVersion: 1,
      baselineTotalMinor: 500,
      eligible: true
    });
    expect(first.preview).toMatchObject({
      baselineKind: 'immutable_base',
      proposedTotalMinor: 500,
      proposedReportingComplete: true,
      compatibilityRepair: false,
      eligible: true,
      ineligibleReason: null
    });
    expect(first.preview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderItemId: fixture.firstItemId,
        baselineSubtotalMinor: 225,
        baselineTaxMinor: 25,
        proposedSubtotalMinor: 270,
        proposedTaxMinor: 30,
        subtotalDisplayDeltaMinor: 45,
        taxDisplayDeltaMinor: 5,
        proposedSettlementGrossMinor: -300,
        proposedRefundFeeImpactMinor: -6
      }),
      expect.objectContaining({
        orderItemId: fixture.secondItemId,
        baselineSubtotalMinor: 225,
        baselineTaxMinor: 25,
        proposedSubtotalMinor: 180,
        proposedTaxMinor: 20,
        subtotalDisplayDeltaMinor: -45,
        taxDisplayDeltaMinor: -5,
        proposedSettlementGrossMinor: -200,
        proposedRefundFeeImpactMinor: -4
      })
    ]));

    const idempotencyKey = randomUUID();
    const firstCommand = correctionCommand(first.input, first.preview);
    const firstSubmission = await submit(actor, firstCommand, 'first-create', idempotencyKey);
    expect(await submit(actor, firstCommand, 'first-create-replay', idempotencyKey))
      .toEqual(firstSubmission);
    expect(await runClaimedCommand(firstSubmission.commandId, 'first-create')).toBeNull();
    const firstStatus = await getFinancialAdminCommandStatus(
      databaseClient.db,
      actor,
      firstSubmission.commandId
    );
    expect(firstStatus).toMatchObject({
      status: 'succeeded',
      resultCode: 'correction_created',
      result: { refundId: fixture.refundId, correctionVersion: 1 }
    });
    if (
      firstStatus?.status !== 'succeeded' ||
      firstStatus.kind !== 'refund_reporting_correction_create' ||
      firstStatus.resultCode !== 'correction_created'
    ) {
      throw new Error('Expected the first correction command to succeed.');
    }
    const firstCorrectionSetId = firstStatus.result.correctionSetId;
    expect(await submit(actor, firstCommand, 'first-create-authoritative', idempotencyKey))
      .toEqual({ ...firstSubmission, status: 'succeeded' });

    const firstRows = await readCorrectionItems(firstCorrectionSetId);
    expect(firstRows).toHaveLength(10);
    expect(firstRows.map((row) => row.stable_tie_break_key)).toEqual([
      `presentment:${fixture.firstItemId}:refund_subtotal`,
      `presentment:${fixture.firstItemId}:refund_tax`,
      `presentment:${fixture.secondItemId}:refund_subtotal`,
      `presentment:${fixture.secondItemId}:refund_tax`,
      `settlement:fee:${fixture.firstItemId}:refund_fee`,
      `settlement:fee:${fixture.secondItemId}:refund_fee`,
      `settlement:gross:${fixture.firstItemId}:refund_subtotal`,
      `settlement:gross:${fixture.firstItemId}:refund_tax`,
      `settlement:gross:${fixture.secondItemId}:refund_subtotal`,
      `settlement:gross:${fixture.secondItemId}:refund_tax`
    ].sort());
    const firstByKey = byTieKey(firstRows);
    expect(firstByKey[`presentment:${fixture.firstItemId}:refund_subtotal`])
      .toMatchObject({ approved_absolute_minor: 270, delta_minor: 45 });
    expect(firstByKey[`presentment:${fixture.secondItemId}:refund_subtotal`])
      .toMatchObject({ approved_absolute_minor: 180, delta_minor: -45 });
    expect(firstByKey[`settlement:gross:${fixture.firstItemId}:refund_subtotal`])
      .toMatchObject({ approved_absolute_minor: -270, delta_minor: -45 });
    expect(firstByKey[`settlement:fee:${fixture.firstItemId}:refund_fee`])
      .toMatchObject({ approved_absolute_minor: -6, delta_minor: -1 });
    await expect(ownerDatabaseClient.pool.query(
      `select domain, source_allocation_set_id, currency,
         sum(delta_minor)::integer as delta_sum,
         sum(approved_absolute_minor)::integer as approved_sum
       from refund_reporting_correction_items where correction_set_id = $1
       group by domain, source_allocation_set_id, currency
       order by domain, source_allocation_set_id nulls first`,
      [firstCorrectionSetId]
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ domain: 'presentment', delta_sum: 0, approved_sum: 500 }),
        expect.objectContaining({ domain: 'settlement', delta_sum: 0, approved_sum: -500 }),
        expect.objectContaining({ domain: 'settlement', delta_sum: 0, approved_sum: -10 })
      ])
    });
    await expect(ownerDatabaseClient.pool.query(
      `select state, resolved_by_admin_id from financial_reconciliation_issues where id = $1`,
      [issueId]
    )).resolves.toMatchObject({
      rows: [{ state: 'resolved', resolved_by_admin_id: actor.id }]
    });
    await expect(ownerDatabaseClient.pool.query(
      `select head.basis, head.compatible_correction_tip_id, head.is_complete,
         head.missing_source_count, head.proposed_issue_code
       from current_financial_projection_heads head
       join financial_allocation_sets base on base.id = head.base_set_id
       where base.source_kind = 'refund' and base.source_internal_id = $1
       order by head.basis`,
      [fixture.refundId]
    )).resolves.toMatchObject({
      rows: [
        { basis: 'gross_amount', compatible_correction_tip_id: firstCorrectionSetId,
          is_complete: true, missing_source_count: 0, proposed_issue_code: null },
        { basis: 'fee', compatible_correction_tip_id: firstCorrectionSetId,
          is_complete: true, missing_source_count: 0, proposed_issue_code: null }
      ]
    });
    await expect(ownerDatabaseClient.pool.query(
      `select action, actor_id, resource_type, resource_id, correlation_id
       from audit_events
       where (action = 'financial.refund_correction.created' and resource_id = $1)
          or (action = 'financial.issue.resolved' and resource_id = $2)
       order by action`,
      [firstCorrectionSetId, issueId]
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({
          action: 'financial.refund_correction.created',
          actor_id: actor.id,
          resource_type: 'refund_reporting_correction_set',
          resource_id: firstCorrectionSetId,
          correlation_id: 'financial-correction-first-create'
        }),
        expect.objectContaining({
          action: 'financial.issue.resolved',
          actor_id: actor.id,
          resource_type: 'financial_issue',
          resource_id: issueId,
          correlation_id: 'financial-correction-first-create'
        })
      ])
    });
    expect(await readProtectedCommerceSnapshot(fixture)).toEqual(commerceBefore);

    const successor = await prepareCorrection(actor, fixture, [200, 300], 'successor');
    expect(successor.seed).toMatchObject({
      baselineKind: 'compatible_correction',
      rawPredecessorCorrectionSetId: firstCorrectionSetId,
      compatibleCorrectionSetId: firstCorrectionSetId,
      expectedNextCorrectionVersion: 2,
      currentReportingComplete: true
    });
    expect(successor.preview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderItemId: fixture.firstItemId,
        baselineSubtotalMinor: 270,
        baselineTaxMinor: 30,
        proposedSubtotalMinor: 180,
        proposedTaxMinor: 20,
        subtotalDisplayDeltaMinor: -90,
        taxDisplayDeltaMinor: -10,
        settlementGrossDisplayDeltaMinor: 100,
        refundFeeImpactDisplayDeltaMinor: 2
      }),
      expect.objectContaining({
        orderItemId: fixture.secondItemId,
        baselineSubtotalMinor: 180,
        baselineTaxMinor: 20,
        proposedSubtotalMinor: 270,
        proposedTaxMinor: 30,
        subtotalDisplayDeltaMinor: 90,
        taxDisplayDeltaMinor: 10,
        settlementGrossDisplayDeltaMinor: -100,
        refundFeeImpactDisplayDeltaMinor: -2
      })
    ]));
    const successorResult = await executePreparedCorrection(
      actor,
      successor,
      'successor-create'
    );
    const successorSetId = successorResult.status.result.correctionSetId;
    const successorRows = byTieKey(await readCorrectionItems(successorSetId));
    expect(successorRows[`presentment:${fixture.firstItemId}:refund_subtotal`])
      .toMatchObject({ approved_absolute_minor: 180, delta_minor: -45 });
    expect(successorRows[`presentment:${fixture.secondItemId}:refund_subtotal`])
      .toMatchObject({ approved_absolute_minor: 270, delta_minor: 45 });
    expect(successorRows[`settlement:gross:${fixture.firstItemId}:refund_subtotal`])
      .toMatchObject({ approved_absolute_minor: -180, delta_minor: 45 });
    expect(successorRows[`settlement:fee:${fixture.firstItemId}:refund_fee`])
      .toMatchObject({ approved_absolute_minor: -4, delta_minor: 1 });
    await expect(ownerDatabaseClient.pool.query(
      `select correction_version, predecessor_correction_set_id, base_allocation_set_id,
         source_fingerprint_sha256, approved_by_admin_id, created_by_admin_id
       from refund_reporting_correction_sets where id = $1`,
      [successorSetId]
    )).resolves.toMatchObject({
      rows: [{
        correction_version: 2,
        predecessor_correction_set_id: firstCorrectionSetId,
        base_allocation_set_id: successor.input.expectedBaseAllocationSetId,
        source_fingerprint_sha256: successor.input.expectedSourceFingerprint,
        approved_by_admin_id: actor.id,
        created_by_admin_id: actor.id
      }]
    });
    expect(await readProtectedCommerceSnapshot(fixture)).toEqual(commerceBefore);
  }, 60_000);

  it('repairs an incompatible raw tip with a numeric-zero immutable-base successor', async () => {
    const actor = await createAdministrator('repair');
    const fixture = await createFinalizedCorrectionFixture(actor, 'repair');
    const immutableSeed = await loadSeed(actor, fixture, 'repair-immutable');
    const incompatibleRawTipId = await insertIncompatibleRawTip(
      actor,
      immutableSeed,
      'repair-raw-tip'
    );
    const issueId = await insertOpenRefundIssue(
      fixture.refundId,
      'correction_rebase_required',
      'repair-issue'
    );
    const repair = await prepareCorrection(actor, fixture, [250, 250], 'repair');
    expect(repair.seed).toMatchObject({
      rawPredecessorCorrectionSetId: incompatibleRawTipId,
      compatibleCorrectionSetId: null,
      expectedNextCorrectionVersion: 2,
      baselineKind: 'immutable_base',
      currentReportingComplete: false,
      eligible: true
    });
    expect(repair.preview).toMatchObject({
      rawPredecessorCorrectionSetId: incompatibleRawTipId,
      compatibleCorrectionSetId: null,
      baselineKind: 'immutable_base',
      currentReportingComplete: false,
      proposedReportingComplete: true,
      compatibilityRepair: true,
      eligible: true,
      ineligibleReason: null
    });
    expect(repair.preview.items.every((item) =>
      item.subtotalDisplayDeltaMinor === 0 &&
      item.taxDisplayDeltaMinor === 0 &&
      item.settlementGrossDisplayDeltaMinor === 0 &&
      item.refundFeeImpactDisplayDeltaMinor === 0
    )).toBe(true);

    const repaired = await executePreparedCorrection(actor, repair, 'repair-create');
    const repairSetId = repaired.status.result.correctionSetId;
    const repairRows = await readCorrectionItems(repairSetId);
    expect(repairRows).toHaveLength(10);
    expect(repairRows.every((item) => item.delta_minor === 0)).toBe(true);
    await expect(ownerDatabaseClient.pool.query(
      `select correction_version, predecessor_correction_set_id,
         base_allocation_set_id, source_fingerprint_sha256
       from refund_reporting_correction_sets where id = $1`,
      [repairSetId]
    )).resolves.toMatchObject({
      rows: [{
        correction_version: 2,
        predecessor_correction_set_id: incompatibleRawTipId,
        base_allocation_set_id: repair.input.expectedBaseAllocationSetId,
        source_fingerprint_sha256: repair.input.expectedSourceFingerprint
      }]
    });
    await expect(ownerDatabaseClient.pool.query(
      `select state, resolved_by_admin_id from financial_reconciliation_issues where id = $1`,
      [issueId]
    )).resolves.toMatchObject({
      rows: [{ state: 'resolved', resolved_by_admin_id: actor.id }]
    });
    await expect(ownerDatabaseClient.pool.query(
      `select head.basis, head.compatible_correction_tip_id, head.is_complete,
         head.proposed_issue_code
       from current_financial_projection_heads head
       join financial_allocation_sets base on base.id = head.base_set_id
       where base.source_kind = 'refund' and base.source_internal_id = $1
       order by head.basis`,
      [fixture.refundId]
    )).resolves.toMatchObject({
      rows: [
        { basis: 'gross_amount', compatible_correction_tip_id: repairSetId,
          is_complete: true, proposed_issue_code: null },
        { basis: 'fee', compatible_correction_tip_id: repairSetId,
          is_complete: true, proposed_issue_code: null }
      ]
    });
  }, 45_000);

  it('fails closed on effective sibling capacity and a nonzero unsupported fee component', async () => {
    const actor = await createAdministrator('evidence-guards');
    const capacityFixture = await createFinalizedCorrectionFixture(actor, 'capacity');
    await addFinalizedSibling(capacityFixture);
    const capacity = await prepareCorrection(
      actor,
      capacityFixture,
      [300, 200],
      'capacity'
    );
    expect(capacity.seed).toMatchObject({ eligible: true, baselineTotalMinor: 500 });
    expect(capacity.preview).toMatchObject({
      eligible: false,
      ineligibleReason: 'immutable_conflict',
      previewFingerprint: null
    });
    await expect(ownerDatabaseClient.pool.query(
      `select count(*)::integer as count from refund_reporting_correction_sets
       where refund_id = $1`,
      [capacityFixture.refundId]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const unsupportedFixture = await createFinalizedCorrectionFixture(
      actor,
      'unsupported-fee',
      { feeRawType: 'tax' }
    );
    const unsupportedSeed = await loadSeed(actor, unsupportedFixture, 'unsupported-fee');
    expect(unsupportedSeed).toMatchObject({
      eligible: false,
      ineligibleReason: 'immutable_conflict',
      expectedNextCorrectionVersion: null,
      expectedBaseAllocationSetId: null,
      expectedSourceFingerprint: null,
      items: []
    });
    const activeGross = (await ownerDatabaseClient.pool.query<{
      id: string;
      source_fingerprint_sha256: string;
    }>(
      `select allocation_set.id, allocation_set.source_fingerprint_sha256
       from financial_allocation_sets allocation_set
       where allocation_set.source_kind = 'refund'
         and allocation_set.source_internal_id = $1
         and allocation_set.basis = 'gross_amount'
         and not exists (
           select 1 from financial_allocation_sets successor
           where successor.supersedes_set_id = allocation_set.id
         )`,
      [unsupportedFixture.refundId]
    )).rows[0]!;
    const unsupportedPreview = await previewReportingCorrection(
      databaseClient.db,
      actor,
      {
        refundId: unsupportedFixture.refundId,
        reason: 'allocation_attribution_correction',
        expectedNextCorrectionVersion: 1,
        expectedBaseAllocationSetId: activeGross.id,
        expectedSourceFingerprint: activeGross.source_fingerprint_sha256,
        items: [
          { orderItemId: unsupportedFixture.firstItemId, totalPresentmentMinor: 300 },
          { orderItemId: unsupportedFixture.secondItemId, totalPresentmentMinor: 200 }
        ]
      },
      correctionContext('unsupported-fee-preview')
    );
    expect(unsupportedPreview).toMatchObject({
      eligible: false,
      ineligibleReason: 'immutable_conflict',
      previewFingerprint: null
    });
  }, 60_000);

  it('serializes a unique-chain race and keeps repository replay idempotent', async () => {
    const firstAdmin = await createAdministrator('race-first');
    const secondAdmin = await createAdministrator('race-second');
    const fixture = await createFinalizedCorrectionFixture(firstAdmin, 'race');
    const [first, second] = await Promise.all([
      prepareCorrection(firstAdmin, fixture, [300, 200], 'race-first'),
      prepareCorrection(secondAdmin, fixture, [300, 200], 'race-second')
    ]);
    expect(second.preview.previewFingerprint).toBe(first.preview.previewFingerprint);
    const firstKey = randomUUID();
    const firstCommand = correctionCommand(first.input, first.preview);
    const firstSubmission = await submit(firstAdmin, firstCommand, 'race-first', firstKey);
    expect(await submit(firstAdmin, firstCommand, 'race-first-replay', firstKey))
      .toEqual(firstSubmission);
    const secondSubmission = await submit(
      secondAdmin,
      correctionCommand(second.input, second.preview),
      'race-second'
    );
    const firstClaim = await claimCommand(firstSubmission.commandId, 'race-first');
    const secondClaim = await claimCommand(secondSubmission.commandId, 'race-second');
    const outcomes = await Promise.all([
      executeClaimedCommand(firstClaim),
      executeClaimedCommand(secondClaim)
    ]);
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
    const [firstStatus, secondStatus] = await Promise.all([
      getFinancialAdminCommandStatus(databaseClient.db, firstAdmin, firstSubmission.commandId),
      getFinancialAdminCommandStatus(databaseClient.db, secondAdmin, secondSubmission.commandId)
    ]);
    if (firstStatus === null || secondStatus === null) {
      throw new Error('Expected both reporting-correction race statuses.');
    }
    expect([firstStatus.status, secondStatus.status].sort()).toEqual(['conflict', 'succeeded']);
    expect([firstStatus, secondStatus].find((status) => status.status === 'conflict'))
      .toMatchObject({ status: 'conflict', resultCode: 'stale_state' });
    await expect(ownerDatabaseClient.pool.query(
      `select count(*)::integer as correction_count,
         count(*) filter (where predecessor_correction_set_id is null)::integer as root_count,
         count(distinct correction_version)::integer as version_count
       from refund_reporting_correction_sets where refund_id = $1`,
      [fixture.refundId]
    )).resolves.toMatchObject({
      rows: [{ correction_count: 1, root_count: 1, version_count: 1 }]
    });
  }, 45_000);

  describe.sequential('production correction atomic rollback matrix', () => {
    let actor: AdministratorActor;
    let fixture: CorrectionFixture;
    let issueId: string;
    let prepared: Awaited<ReturnType<typeof prepareCorrection>>;
    let commerceBefore: ProtectedCommerceSnapshot;
    let domainBefore: CorrectionDomainSnapshot;

    beforeEach(async () => {
      actor = await createAdministrator('rollback-matrix');
      fixture = await createFinalizedCorrectionFixture(actor, 'rollback-matrix');
      issueId = await insertOpenRefundIssue(
        fixture.refundId,
        'allocation_mismatch',
        'rollback-matrix-issue'
      );
      prepared = await prepareCorrection(
        actor,
        fixture,
        [300, 200],
        'rollback-matrix'
      );
      commerceBefore = await readProtectedCommerceSnapshot(fixture);
      domainBefore = await readCorrectionDomainSnapshot(fixture);
    }, 60_000);

    it.each(CORRECTION_ATOMIC_FAULTS)(
      'rolls back every domain effect at the $label seam',
      async (fault) => {
        const label = `rollback-${fault.seam}`;
        const submitted = await submit(
          actor,
          correctionCommand(prepared.input, prepared.preview),
          label
        );
        const faultInstallation = await installCorrectionAtomicFault(fault, {
          fixture,
          issueId,
          baseAllocationSetId: prepared.input.expectedBaseAllocationSetId,
          commandId: submitted.commandId
        });
        try {
          expect(await readFailedCommandLifecycle(submitted.commandId)).toEqual({
            command_status: 'pending',
            safe_result_code: null,
            safe_result: null,
            command_completed: false,
            job_status: 'pending',
            job_attempts: 0,
            job_max_attempts: 8,
            job_last_error: null,
            job_completed: false
          });
          expect(await faultInstallation.readTriggerWitness()).toEqual({
            lastValue: 1,
            isCalled: false
          });

          await runCorrectionCommandWorkerToTerminal(submitted.commandId, label);

          expect(await faultInstallation.readTriggerWitness()).toEqual({
            lastValue: fault.expectedAttempts,
            isCalled: true
          });
          expect(await readCorrectionDomainSnapshot(fixture)).toEqual(domainBefore);
          expect(await readProtectedCommerceSnapshot(fixture)).toEqual(commerceBefore);
          await expect(getFinancialAdminCommandStatus(
            databaseClient.db,
            actor,
            submitted.commandId
          )).resolves.toMatchObject({
            status: 'failed',
            resultCode: 'command_failed',
            result: null,
            completedAt: expect.any(String)
          });
          expect(await readFailedCommandLifecycle(submitted.commandId)).toEqual({
            command_status: 'failed',
            safe_result_code: 'command_failed',
            safe_result: null,
            command_completed: true,
            job_status: 'failed',
            job_attempts: fault.expectedAttempts,
            job_max_attempts: 8,
            job_last_error: fault.expectedJobLastError,
            job_completed: true
          });
        } finally {
          await faultInstallation.cleanup();
        }
      },
      60_000
    );
  });
});
