import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdministratorActor } from '$lib/server/auth/admin-policy';
import { FINANCIAL_REPLAY_ID } from '$lib/server/commerce/financial/constants';
import { createCommerceClaimAuthorization } from './commerce-claim-capability';
import { claimGuestPurchases } from '$lib/server/commerce/claims';
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
  createAdministrativeRecoveryExecutors,
  getAdministrativeRecoverySeed,
  previewAdministrativeRecovery,
  previewAdministrativeRecoveryDeactivation
} from '$lib/server/commerce/financial/refund-review/recovery';
import type { AdministrativeRecoveryPrepareInput } from
  '$lib/server/commerce/financial/refund-review/inputs';
import {
  executeReportingCorrectionCreate,
  getReportingCorrectionSeed,
  previewReportingCorrection
} from '$lib/server/commerce/financial/refund-review/corrections';
import { replayFinancialClassification } from '$lib/server/commerce/financial/rebase';
import { createFinancialClassificationSubjectJob } from
  '$lib/server/commerce/financial/jobs';
import {
  commitFinancialScanPage,
  finalizeFinancialReplay,
  loadClassificationReplayPage,
  startOrResumeFinancialScan
} from '$lib/server/commerce/financial/scans/repository';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import type { JobRecord } from '$lib/server/jobs/types';
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  workerDatabaseClient
} from './database';

const accessMessages = createCommerceMessageEnqueuer(applicationConfig.origin);
const FIXED_AT = new Date('2026-08-22T12:00:00.000Z');

interface RecoveryFixture {
  readonly actor: AdministratorActor;
  readonly claimantId: string;
  readonly claimantEmail: string;
  readonly titleId: string;
  readonly orderId: string;
  readonly orderItemId: string;
  readonly paymentId: string;
  readonly refundId: string;
  readonly refundAllocationId: string;
  readonly finalizationDraftId: string;
  readonly finalizationEffectId: string;
  readonly purchaseGrantId: string;
  readonly correctionSetId: string;
  readonly grossAllocationSetId: string;
  readonly feeAllocationSetId: string;
  readonly balanceTransactionId: string;
  readonly sourceFingerprint: string;
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
  readonly partialPresentmentCorrection: boolean;
}

interface ClaimedRecoveryCommand {
  readonly job: JobRecord;
  readonly workerId: string;
  readonly repository: ReturnType<typeof createPostgresJobRepository>;
}

interface RecoveryDomainSnapshot {
  readonly grants: string;
  readonly entitlements: string;
  readonly recovery_audits: string;
  readonly recovery_messages: string;
}

function token(label: string): string {
  return `${label}_${randomUUID().replaceAll('-', '')}`;
}

function leaseCapability(label: string): string {
  return createHash('sha256').update(`administrative-recovery:${label}`).digest('base64url');
}

function requestContext(label: string) {
  return {
    correlationId: `administrative-recovery-${label}`,
    requestMetadata: {
      method: 'POST',
      routeId: '/admin/sales/refunds/[refundId]?/prepareRecovery'
    }
  } as const;
}

async function createAdministrator(label: string): Promise<AdministratorActor> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [id, `Recovery administrator ${label}`, `${label}-${id}@example.test`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [id]
  );
  return { type: 'user', id, roles: ['admin'] };
}

async function createRecoveryFixture(
  label: string,
  options: { readonly partialPresentmentCorrection?: boolean } = {}
): Promise<RecoveryFixture> {
  const actor = await createAdministrator(label);
  const claimantId = randomUUID();
  const claimantEmail = `${label}-${claimantId}@example.test`.toLowerCase();
  const titleId = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const paymentId = randomUUID();
  const refundId = randomUUID();
  const sourceFingerprint = createHash('sha256')
    .update(`recovery-source:${label}`).digest('hex');

  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [claimantId, `Recovery reader ${label}`, claimantEmail]
  );
  const guestIdentity = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into guest_identities (email) values ($1) returning id`,
    [claimantEmail]
  )).rows[0]!;
  await ownerDatabaseClient.pool.query(
    `insert into titles (
       id, slug, title, description, creator_name, format,
       price_minor, currency, visibility
     ) values ($1, $2, $3, $4, $5, 'prose', 1100, 'USD', 'private')`,
    [
      titleId,
      `recovery-${titleId}`,
      `Recovered title ${label}`,
      'Administrative recovery integration fixture',
      'Recovery author'
    ]
  );
  await ownerDatabaseClient.pool.query(
    `insert into orders (
       id, status, initiating_user_id, guest_identity_id, purchase_email,
       currency, subtotal_minor, tax_minor, total_minor,
       client_checkout_attempt_id, quote_fingerprint_sha256,
       stripe_checkout_session_id, status_token_sha256, checkout_expires_at, paid_at
     ) values (
       $1, 'paid', null, $2, $3, 'USD', 1000, 100, 1100, $4,
       repeat('3', 64), $5, repeat('4', 64), $6, $6
     )`,
    [
      orderId,
      guestIdentity.id,
      claimantEmail,
      randomUUID(),
      `cs_recovery_${randomUUID()}`,
      FIXED_AT
    ]
  );
  await ownerDatabaseClient.pool.query(
    `insert into order_items (
       id, order_id, title_id, title_snapshot, creator_name_snapshot, format,
       currency, unit_subtotal_minor, tax_minor, total_minor, stripe_line_item_id
     ) values ($1, $2, $3, $4, 'Recovery author', 'prose',
       'USD', 1000, 100, 1100, $5)`,
    [orderItemId, orderId, titleId, `Recovered title ${label}`, `li_${randomUUID()}`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into payments (
       id, order_id, stripe_payment_intent_id, stripe_latest_charge_id,
       status, amount_minor, currency, payment_method_category, paid_at
     ) values ($1, $2, $3, $4, 'succeeded', 1100, 'USD', 'card', $5)`,
    [
      paymentId,
      orderId,
      `pi_recovery_${randomUUID()}`,
      `ch_recovery_${randomUUID()}`,
      FIXED_AT
    ]
  );
  const stripeRefundId = `re_recovery_${randomUUID()}`;
  await ownerDatabaseClient.pool.query(
    `insert into refunds (
       id, payment_id, stripe_refund_id, status, amount_minor, currency,
       provider_created_at, allocation_status, financial_evidence_status
     ) values (
       $1, $2, $3, 'succeeded', 100, 'USD', $4, 'finalized', 'fee_reconciled'
     )`,
    [refundId, paymentId, stripeRefundId, new Date(FIXED_AT.getTime() + 60_000)]
  );
  const projection = (await ownerDatabaseClient.pool.query<{
    classifier_version: number;
    allocation_algorithm_version: number;
  }>(
    `select classifier_version, allocation_algorithm_version
     from financial_projection_versions where singleton = true`
  )).rows[0]!;
  const balanceTransactionId = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into stripe_balance_transactions (
       provider_id, live_mode, source_family, source_id, raw_type,
       reporting_category, balance_type, amount_minor, fee_minor, net_minor,
       currency, status, provider_created_at, available_at, fingerprint_sha256
     ) values (
       $1, false, 'refund', $2, 'refund', 'refund', 'payments',
       -100, 0, -100, 'USD', 'available', $3, $3, $4
     ) returning id`,
    [token('txn_recovery'), stripeRefundId, FIXED_AT, sourceFingerprint]
  )).rows[0]!.id;
  await ownerDatabaseClient.pool.query(
    `insert into financial_classification_versions (
       subject_type, subject_id, classifier_version, classification,
       source_fingerprint_sha256
     ) values ('balance_transaction', $1, $2, 'refund', $3)`,
    [balanceTransactionId, projection.classifier_version, sourceFingerprint]
  );
  const allocationIdentityPrefix =
    `refund:${refundId}:${balanceTransactionId}:finalized:replay:${FINANCIAL_REPLAY_ID}`;
  const allocationSets = (await ownerDatabaseClient.pool.query<{
    id: string;
    basis: 'gross_amount' | 'fee';
  }>(
    `insert into financial_allocation_sets (
       allocation_identity, balance_transaction_id, source_kind,
       source_internal_id, basis, scope, expected_effect_minor, currency,
       algorithm_version, classifier_version, source_fingerprint_sha256
     ) values
       ($1, $2, 'refund', $3, 'gross_amount', 'title', -100, 'USD', $4, $5, $6),
       ($7, $2, 'refund', $3, 'fee', 'title', 0, 'USD', $4, $5, $6)
     returning id, basis`,
    [
      `${allocationIdentityPrefix}:gross`,
      balanceTransactionId,
      refundId,
      projection.allocation_algorithm_version,
      projection.classifier_version,
      sourceFingerprint,
      `${allocationIdentityPrefix}:fee`
    ]
  )).rows;
  const grossAllocationSetId = allocationSets.find(
    (row) => row.basis === 'gross_amount'
  )!.id;
  const feeAllocationSetId = allocationSets.find((row) => row.basis === 'fee')!.id;
  await ownerDatabaseClient.pool.query(
    `insert into financial_item_allocations (
       allocation_set_id, order_item_id, component, effect_minor, currency,
       tie_break_key
     ) values ($1, $2, 'refund_subtotal', -100, 'USD', $3)`,
    [
      grossAllocationSetId,
      orderItemId,
      `${orderItemId}:subtotal`
    ]
  );
  const refundAllocationId = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refund_allocations (
       refund_id, order_item_id, amount_minor, source
     ) values ($1, $2, 100, 'administrative') returning id`,
    [refundId, orderItemId]
  )).rows[0]!.id;
  await ownerDatabaseClient.pool.query(
    `insert into refund_allocation_components (
       refund_allocation_id, refund_id, order_item_id, subtotal_minor,
       tax_minor, total_minor, currency
     ) values ($1, $2, $3, 100, 0, 100, 'USD')`,
    [refundAllocationId, refundId, orderItemId]
  );
  const correctionSetId = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refund_reporting_correction_sets (
       refund_id, correction_version, kind, base_allocation_set_id,
       source_fingerprint_sha256, approved_by_admin_id, created_by_admin_id,
       correlation_id
     ) values (
       $1, 1, 'allocation_attribution_correction', $2, $3, $4, $4, $5
     ) returning id`,
    [refundId, grossAllocationSetId, sourceFingerprint, actor.id, token('recovery_correction')]
  )).rows[0]!.id;
  await ownerDatabaseClient.pool.query(
    `insert into refund_reporting_correction_items (
       correction_set_id, domain, source_allocation_set_id, order_item_id,
       component, currency, approved_absolute_minor, delta_minor,
       stable_tie_break_key
     ) values
       ($1, 'settlement', $2, $3, 'refund_subtotal', 'USD', -90, 10, $4),
       ($1, 'settlement', $2, $3, 'refund_tax', 'USD', -10, -10, $5)`,
    [
      correctionSetId,
      grossAllocationSetId,
      orderItemId,
      `settlement:gross:${orderItemId}:refund_subtotal`,
      `settlement:gross:${orderItemId}:refund_tax`
    ]
  );
  if (options.partialPresentmentCorrection) {
    await ownerDatabaseClient.pool.query(
      `insert into refund_reporting_correction_items (
         correction_set_id, domain, source_allocation_set_id, order_item_id,
         component, currency, approved_absolute_minor, delta_minor,
         stable_tie_break_key
       ) values (
         $1, 'presentment', null, $2, 'refund_subtotal', 'USD', 100, 0, $3
       )`,
      [
        correctionSetId,
        orderItemId,
        `presentment:${orderItemId}:refund_subtotal`
      ]
    );
  }
  const purchaseGrantId = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into entitlement_grants (
       title_id, user_id, source, order_item_id, state, state_reason,
       granted_at, revoked_at, created_at, updated_at
     ) values (
       $1, null, 'purchase', $2, 'revoked', 'refund_fully_allocated',
       $3, $4, $3, $4
     ) returning id`,
    [titleId, orderItemId, FIXED_AT, new Date(FIXED_AT.getTime() + 120_000)]
  )).rows[0]!.id;
  const draftId = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refund_allocation_drafts (
       refund_id, state, version, created_by_admin_id, updated_by_admin_id,
       created_correlation_id, updated_correlation_id
     ) values ($1, 'active', 1, $2, $2, $3, $3) returning id`,
    [refundId, actor.id, token('recovery_draft')]
  )).rows[0]!.id;
  await ownerDatabaseClient.pool.query(
    `insert into refund_allocation_draft_items (
       draft_id, order_item_id, proposed_total_presentment_minor
     ) values ($1, $2, 100)`,
    [draftId, orderItemId]
  );
  await ownerDatabaseClient.pool.query(
    `update refund_allocation_drafts
     set state = 'finalized', version = 2, finalized_at = clock_timestamp(),
       updated_at = clock_timestamp(), updated_by_admin_id = $2,
       updated_correlation_id = $3
     where id = $1`,
    [
      draftId,
      actor.id,
      token('recovery_finalize')
    ]
  );
  const finalizationEffectId = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refund_allocation_finalization_effects (
       refund_id, refund_allocation_id, draft_id, draft_version, order_item_id,
       purchase_grant_id, before_purchase_grant_state, after_purchase_grant_state,
       before_effective_access, after_effective_access, transition, correlation_id
     ) values (
       $1, $2, $3, 2, $4, $5, 'unclaimed', 'revoked', false, false,
       'revoked_by_finalization', $6
     ) returning id`,
    [refundId, refundAllocationId, draftId, orderItemId, purchaseGrantId,
      token('recovery_effect')]
  )).rows[0]!.id;

  return {
    actor,
    claimantId,
    claimantEmail,
    titleId,
    orderId,
    orderItemId,
    paymentId,
    refundId,
    refundAllocationId,
    finalizationDraftId: draftId,
    finalizationEffectId,
    purchaseGrantId,
    correctionSetId,
    grossAllocationSetId,
    feeAllocationSetId,
    balanceTransactionId,
    sourceFingerprint,
    classifierVersion: projection.classifier_version,
    allocationAlgorithmVersion: projection.allocation_algorithm_version,
    partialPresentmentCorrection: options.partialPresentmentCorrection ?? false
  };
}

async function claimFixture(fixture: RecoveryFixture, label: string): Promise<void> {
  const authorizationToken = await createCommerceClaimAuthorization(databaseClient.db, {
    email: fixture.claimantEmail,
    kind: 'password-reset'
  });
  await expect(claimGuestPurchases(databaseClient.db, {
    userId: fixture.claimantId,
    correlationId: `recovery-claim-${label}`,
    authorizationToken
  })).resolves.toMatchObject({ claimedOrderCount: 1 });
  await expect(ownerDatabaseClient.pool.query(
    `select user_id, state from entitlement_grants where id = $1`,
    [fixture.purchaseGrantId]
  )).resolves.toMatchObject({ rows: [{ user_id: fixture.claimantId, state: 'revoked' }] });
}

function unavailableExecutor(label: string): FinancialAdminCommandExecutor {
  return async () => {
    throw new Error(`${label} is intentionally unavailable in the recovery integration lane`);
  };
}

const administrativeRecoveryExecutors = createAdministrativeRecoveryExecutors();
const administrativeRecoveryActivate: FinancialAdminCommandExecutor =
  (context, command) => {
    if (command.kind !== 'administrative_recovery_activate') {
      throw new Error('Activation executor received another command kind');
    }
    return administrativeRecoveryExecutors.executeActivate(context, command);
  };
const administrativeRecoveryDeactivate: FinancialAdminCommandExecutor =
  (context, command) => {
    if (command.kind !== 'administrative_recovery_deactivate') {
      throw new Error('Deactivation executor received another command kind');
    }
    return administrativeRecoveryExecutors.executeDeactivate(context, command);
  };
const reportingCorrectionCreate: FinancialAdminCommandExecutor = (context, command) => {
  if (command.kind !== 'refund_reporting_correction_create') {
    throw new Error('Reporting-correction executor received another command kind');
  }
  return executeReportingCorrectionCreate(context, command);
};

const recoveryExecutors = createFinancialAdminCommandExecutors({
  refundDraftSave: unavailableExecutor('draft save'),
  refundDraftDiscard: unavailableExecutor('draft discard'),
  refundAllocationFinalize: unavailableExecutor('finalization'),
  refundReportingCorrectionCreate: reportingCorrectionCreate,
  administrativeRecoveryActivate,
  administrativeRecoveryDeactivate
});

function recoveryHandler() {
  return createFinancialAdminCommandHandler({
    database: workerDatabaseClient.db,
    executors: recoveryExecutors,
    accessMessages
  });
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
    context: { correlationId: `administrative-recovery-${label}` }
  });
}

async function claimRecoveryCommand(
  commandId: string,
  label: string
): Promise<ClaimedRecoveryCommand> {
  const repository = createPostgresJobRepository(
    workerDatabaseClient.db,
    { ...applicationConfig.jobs, leaseMs: 30_000 },
    undefined,
    'local-only',
    { classifierVersion: 1, allocationAlgorithmVersion: 1 },
    () => leaseCapability(label)
  );
  const workerId = `administrative-recovery-${label}`;
  for (let skipped = 0; skipped < 20; skipped += 1) {
    const job = await repository.claimNext(workerId);
    expect(job).not.toBeNull();
    if (job!.payload.commandId === commandId) {
      expect(job!.payload).toEqual({ commandId });
      return { job: job!, workerId, repository };
    }
    expect(job!.type).not.toBe('commerce.financial-admin-command');
    await expect(repository.complete(job!.id, workerId)).resolves.toBe(true);
  }
  throw new Error('Timed out draining unrelated jobs before the recovery command.');
}

async function executeClaimedRecovery(
  claimed: ClaimedRecoveryCommand,
  options: { readonly retryableOnFailure?: boolean } = {}
): Promise<unknown | null> {
  try {
    await recoveryHandler()(claimed.job, new AbortController().signal);
    await expect(claimed.repository.complete(
      claimed.job.id,
      claimed.workerId,
      claimed.job.financialAdminLeaseCapability!
    )).resolves.toBe(true);
    return null;
  } catch (error) {
    await expect(claimed.repository.fail(
      claimed.job.id,
      claimed.workerId,
      'administrative recovery command failed',
      options.retryableOnFailure ?? false,
      claimed.job.financialAdminLeaseCapability!
    )).resolves.toBe(true);
    return error;
  }
}

async function runRecoveryCommand(commandId: string, label: string): Promise<unknown | null> {
  return executeClaimedRecovery(await claimRecoveryCommand(commandId, label));
}

async function activationPreview(fixture: RecoveryFixture, label: string) {
  const input: AdministrativeRecoveryPrepareInput = {
    refundId: fixture.refundId,
    finalizationEffectId: fixture.finalizationEffectId,
    orderItemId: fixture.orderItemId,
    expectedCorrectionSetId: fixture.correctionSetId,
    expectedCorrectionVersion: 1,
    expectedSourceFingerprint: fixture.sourceFingerprint
  };
  return previewAdministrativeRecovery(
    databaseClient.db,
    fixture.actor,
    input,
    requestContext(label)
  );
}

function activationCommand(
  fixture: RecoveryFixture,
  previewFingerprint: string
): Extract<FinancialAdminPrivateCommand, { kind: 'administrative_recovery_activate' }> {
  return {
    kind: 'administrative_recovery_activate',
    refundId: fixture.refundId,
    finalizationEffectId: fixture.finalizationEffectId,
    orderItemId: fixture.orderItemId,
    expectedCorrectionSetId: fixture.correctionSetId,
    expectedCorrectionVersion: 1,
    expectedSourceFingerprint: fixture.sourceFingerprint,
    previewFingerprint,
    confirmation: 'activate_persistent_recovery'
  };
}

function expectedInitialActivationFingerprint(fixture: RecoveryFixture): string {
  const presentmentEvidence = fixture.partialPresentmentCorrection
    ? [
        `presentment_evidence=${fixture.refundId}|correction|-|${fixture.correctionSetId}|1|refund_subtotal|100`,
        `presentment_evidence=${fixture.refundId}|correction|-|${fixture.correctionSetId}|1|refund_tax|0`
      ]
    : [
        `presentment_evidence=${fixture.refundId}|base|${fixture.refundAllocationId}|-|-|refund_subtotal|100`,
        `presentment_evidence=${fixture.refundId}|base|${fixture.refundAllocationId}|-|-|refund_tax|0`
      ];
  const cumulativeSubtotal = 100;
  const cumulativeTax = 0;
  const cumulativeTotal = cumulativeSubtotal + cumulativeTax;
  const preimage = [
    'pale-orbit.admin-recovery-preview.v1',
    `refund_id=${fixture.refundId}`,
    `payment_id=${fixture.paymentId}`,
    `order_id=${fixture.orderId}`,
    `finalization_effect_id=${fixture.finalizationEffectId}`,
    `recovery_reference_id=${fixture.refundAllocationId}`,
    `finalization_draft_id=${fixture.finalizationDraftId}`,
    'finalization_draft_version=2',
    `order_item_id=${fixture.orderItemId}`,
    `title_id=${fixture.titleId}`,
    `purchase_grant_id=${fixture.purchaseGrantId}`,
    'allocation_total_minor=100',
    'allocation_subtotal_minor=100',
    'allocation_tax_minor=0',
    'item_subtotal_minor=1000',
    'item_tax_minor=100',
    'item_total_minor=1100',
    'item_currency=USD',
    'existing_recovery_grant_id=-',
    'existing_recovery_grant_state=absent',
    'existing_recovery_grant_state_changed_at=-',
    `correction_set_id=${fixture.correctionSetId}`,
    'correction_version=1',
    'correction_kind=allocation_attribution_correction',
    `correction_base_set_id=${fixture.grossAllocationSetId}`,
    'correction_predecessor_correction_set_id=-',
    `correction_source_fingerprint_sha256=${fixture.sourceFingerprint}`,
    `projection_classifier_version=${fixture.classifierVersion}`,
    `projection_allocation_algorithm_version=${fixture.allocationAlgorithmVersion}`,
    `source_balance_transaction_id=${fixture.balanceTransactionId}`,
    `source_fingerprint_sha256=${fixture.sourceFingerprint}`,
    'projection_head_count=2',
    `projection_head=gross_amount|${fixture.grossAllocationSetId}|${fixture.correctionSetId}|title|USD|-100|1|0|-`,
    `projection_head=fee|${fixture.feeAllocationSetId}|${fixture.correctionSetId}|title|USD|0|1|0|-`,
    'projection_item_count=2',
    `projection_item=gross_amount|${fixture.grossAllocationSetId}|${fixture.correctionSetId}|${fixture.orderItemId}|refund_subtotal|-90|USD`,
    `projection_item=gross_amount|${fixture.grossAllocationSetId}|${fixture.correctionSetId}|${fixture.orderItemId}|refund_tax|-10|USD`,
    'presentment_evidence_count=2',
    ...presentmentEvidence,
    `cumulative_refund_subtotal_minor=${cumulativeSubtotal}`,
    `cumulative_refund_tax_minor=${cumulativeTax}`,
    `cumulative_refund_total_minor=${cumulativeTotal}`,
    `remaining_unrefunded_minor=${1100 - cumulativeTotal}`,
    'effective_access_before=0',
    'effective_access_after=1',
    'access_changed=1',
    'email_queued=1',
    ''
  ].join('\n');
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

async function readRecoverySnapshot(fixture: RecoveryFixture): Promise<RecoveryDomainSnapshot> {
  return (await ownerDatabaseClient.pool.query<RecoveryDomainSnapshot>(
    `select
       coalesce((select jsonb_agg(jsonb_build_array(
         recovery_grant.id, recovery_grant.source, recovery_grant.state,
         recovery_grant.state_reason, recovery_grant.user_id,
         recovery_grant.title_id, recovery_grant.order_item_id,
         recovery_grant.recovery_refund_allocation_id,
         to_char(timezone('UTC', recovery_grant.granted_at),
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         to_char(timezone('UTC', recovery_grant.revoked_at),
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         to_char(timezone('UTC', recovery_grant.updated_at),
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       ) order by recovery_grant.id)::text
       from entitlement_grants recovery_grant
       where recovery_grant.title_id = $1), '[]') as grants,
       coalesce((select jsonb_agg(to_jsonb(scope) order by scope.id)::text
       from entitlements scope where scope.user_id = $2 and scope.title_id = $1), '[]')
         as entitlements,
       coalesce((select jsonb_agg(jsonb_build_array(
         event.action, event.actor_id, event.resource_id, event.correlation_id,
         event.after
       ) order by event.id)::text from audit_events event
       where event.action in (
         'financial.recovery_grant.activated',
         'financial.recovery_grant.deactivated'
       ) and event.actor_id = $3), '[]') as recovery_audits,
       coalesce((select jsonb_agg(jsonb_build_array(
         message.topic, message.deduplication_key, message.payload
       ) order by message.id)::text from outbox_messages message
       where message.payload ->> 'template' =
         'commerce.administrative-recovery-access-changed'
         and message.payload ->> 'to' = $4), '[]')
         as recovery_messages`,
    [fixture.titleId, fixture.claimantId, fixture.actor.id, fixture.claimantEmail]
  )).rows[0]!;
}

async function recoveryGrantRow(refundAllocationId: string): Promise<{
  id: string;
  state: 'active' | 'revoked';
  state_changed_at: string;
}> {
  return (await ownerDatabaseClient.pool.query<{
    id: string;
    state: 'active' | 'revoked';
    state_changed_at: string;
  }>(
    `select id, state,
       to_char(timezone('UTC', updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         as state_changed_at
     from entitlement_grants
     where source = 'administrative' and recovery_refund_allocation_id = $1`,
    [refundAllocationId]
  )).rows[0]!;
}

async function activateFixture(fixture: RecoveryFixture, label: string) {
  const preview = await activationPreview(fixture, `${label}-preview`);
  expect(preview).toMatchObject({
    eligible: true,
    ineligibleReason: null,
    effectiveAccessBefore: false,
    effectiveAccessAfter: true,
    accessChanged: true,
    emailQueued: true,
    persistsUntilDeactivated: true
  });
  expect(preview.previewFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  const submitted = await submit(
    fixture.actor,
    activationCommand(fixture, preview.previewFingerprint!),
    `${label}-activate`
  );
  const commandError = await runRecoveryCommand(submitted.commandId, `${label}-activate`);
  expect(commandError).toBeNull();
  const status = await getFinancialAdminCommandStatus(
    databaseClient.db,
    fixture.actor,
    submitted.commandId
  );
  expect(status).toMatchObject({
    status: 'succeeded',
    resultCode: 'recovery_activated',
    result: { accessChanged: true, emailQueued: true }
  });
  return { preview, submitted, status, grant: await recoveryGrantRow(fixture.refundAllocationId) };
}

async function installFailureTrigger(input: {
  readonly label: string;
  readonly relation: string;
  readonly timing: 'before insert' | 'before insert or update';
  readonly condition?: string;
}): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `test_recovery_fault_${suffix}`;
  const triggerName = `test_recovery_fault_${suffix}`;
  await ownerDatabaseClient.pool.query(`
    create function ${functionName}() returns trigger language plpgsql as $$
    begin
      ${input.condition ? `if ${input.condition} then` : ''}
        raise exception using errcode = 'P0001', message = '${input.label}';
      ${input.condition ? 'end if;' : ''}
      return new;
    end
    $$;
    create trigger ${triggerName} ${input.timing} on ${input.relation}
    for each row execute function ${functionName}();
  `);
  return async () => {
    await ownerDatabaseClient.pool.query(`
      drop trigger if exists ${triggerName} on ${input.relation};
      drop function if exists ${functionName}();
    `);
  };
}

async function expireClaimedLease(claimed: ClaimedRecoveryCommand): Promise<void> {
  const client = await ownerDatabaseClient.pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    await client.query(
      `update financial_admin_job_claims
       set expires_at = issued_at + interval '1 millisecond'
       where job_id = $1`,
      [claimed.job.id]
    );
    await client.query(
      `update jobs set locked_at = statement_timestamp() - interval '10 seconds',
         run_at = statement_timestamp() - interval '10 seconds'
       where id = $1`,
      [claimed.job.id]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function removeAdministratorRole(actorId: string): Promise<void> {
  const client = await ownerDatabaseClient.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
    );
    await client.query(
      `delete from user_roles where user_id = $1 and role = 'admin'`,
      [actorId]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function createCompatibleSuccessor(fixture: RecoveryFixture): Promise<string> {
  const seed = await getReportingCorrectionSeed(
    databaseClient.db,
    fixture.actor,
    fixture.refundId,
    requestContext('recovery-successor-seed')
  );
  if (
    seed === null || !seed.eligible || seed.expectedNextCorrectionVersion === null ||
    seed.expectedBaseAllocationSetId === null || seed.expectedSourceFingerprint === null
  ) {
    throw new Error(`Expected an eligible successor reporting correction: ${JSON.stringify(seed)}`);
  }
  const input = {
    refundId: fixture.refundId,
    reason: 'allocation_attribution_correction',
    expectedNextCorrectionVersion: seed.expectedNextCorrectionVersion,
    expectedBaseAllocationSetId: seed.expectedBaseAllocationSetId,
    expectedSourceFingerprint: seed.expectedSourceFingerprint,
    items: [{ orderItemId: fixture.orderItemId, totalPresentmentMinor: 100 }]
  } as const;
  const preview = await previewReportingCorrection(
    databaseClient.db,
    fixture.actor,
    input,
    requestContext('recovery-successor-preview')
  );
  if (!preview.eligible || preview.previewFingerprint === null) {
    throw new Error('Expected an eligible successor reporting-correction preview.');
  }
  const submitted = await submit(fixture.actor, {
    kind: 'refund_reporting_correction_create',
    ...input,
    previewFingerprint: preview.previewFingerprint,
    confirmation: 'create_reporting_correction'
  }, 'recovery-successor');
  const commandError = await runRecoveryCommand(submitted.commandId, 'recovery-successor');
  const status = await getFinancialAdminCommandStatus(
    databaseClient.db, fixture.actor, submitted.commandId
  );
  if (commandError !== null) {
    throw new Error(
      `Expected the successor correction to succeed: ${JSON.stringify({ status, preview })}`
    );
  }
  expect(status).toMatchObject({ status: 'succeeded', resultCode: 'correction_created' });
  const successor = (await ownerDatabaseClient.pool.query<{ id: string }>(
    `select id from refund_reporting_correction_sets
     where refund_id = $1 and correction_version = $2`,
    [fixture.refundId, seed.expectedNextCorrectionVersion]
  )).rows[0];
  if (!successor) throw new Error('Expected the successor reporting correction.');
  return successor.id;
}

async function executeWithReplicationBypass(
  statement: string,
  values: readonly unknown[] = []
): Promise<void> {
  const client = await ownerDatabaseClient.pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    await client.query(statement, [...values]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function makeFixtureCumulativelyFullyRefunded(
  fixture: RecoveryFixture
): Promise<void> {
  const client = await ownerDatabaseClient.pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    await client.query(
      `update refunds set amount_minor = 1100 where id = $1`,
      [fixture.refundId]
    );
    await client.query(
      `update stripe_balance_transactions
       set amount_minor = -1100, net_minor = -1100
       where id = $1`,
      [fixture.balanceTransactionId]
    );
    await client.query(
      `update financial_allocation_sets
       set expected_effect_minor = -1100
       where id = $1`,
      [fixture.grossAllocationSetId]
    );
    await client.query(
      `update financial_item_allocations
       set effect_minor = case component
         when 'refund_subtotal' then -1000
         when 'refund_tax' then -100
         else effect_minor end
       where allocation_set_id = $1`,
      [fixture.grossAllocationSetId]
    );
    await client.query(
      `insert into financial_item_allocations (
         allocation_set_id, order_item_id, component, effect_minor, currency,
         tie_break_key
       ) values ($1, $2, 'refund_tax', -100, 'USD', $3)
       on conflict (allocation_set_id, order_item_id, component) do nothing`,
      [fixture.grossAllocationSetId, fixture.orderItemId, `${fixture.orderItemId}:tax`]
    );
    await client.query(
      `update refund_allocations set amount_minor = 1100 where id = $1`,
      [fixture.refundAllocationId]
    );
    await client.query(
      `update refund_allocation_components
       set subtotal_minor = 1000, tax_minor = 100, total_minor = 1100
       where refund_allocation_id = $1`,
      [fixture.refundAllocationId]
    );
    await client.query(
      `update refund_allocation_draft_items
       set proposed_total_presentment_minor = 1100
       where draft_id = $1 and order_item_id = $2`,
      [fixture.finalizationDraftId, fixture.orderItemId]
    );
    await client.query(
      `update refund_reporting_correction_items
       set approved_absolute_minor = case component
           when 'refund_subtotal' then -1000
           when 'refund_tax' then -100
           else approved_absolute_minor end,
         delta_minor = case component
           when 'refund_subtotal' then 0
           when 'refund_tax' then 0
           else delta_minor end
       where correction_set_id = $1 and domain = 'settlement'`,
      [fixture.correctionSetId]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function moveRecoveryStateTimestampAhead(grantId: string): Promise<string> {
  const client = await ownerDatabaseClient.pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    const result = await client.query<{ state_changed_at: string }>(
      `update entitlement_grants
       set updated_at = date_trunc(
         'milliseconds', clock_timestamp() + interval '5 seconds'
       )
       where id = $1
       returning to_char(
         timezone('UTC', updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ) as state_changed_at`,
      [grantId]
    );
    await client.query('commit');
    return result.rows[0]!.state_changed_at;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function waitForBlockedRecoveryExecutor(
  blockerPid: number
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = (await ownerDatabaseClient.pool.query<{
      pid: number;
      blockers: number[];
    }>(`
      select activity.pid, pg_blocking_pids(activity.pid) as blockers
      from pg_stat_activity activity
      where activity.pid <> pg_backend_pid()
        and activity.state = 'active'
        and activity.query like
          '%transition_administrative_recovery_grant_after_admin_command%'
      order by activity.pid
    `)).rows;
    const blocked = rows.find((row) => row.blockers.includes(blockerPid));
    if (blocked) return blocked.pid;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the administrative recovery executor barrier.');
}

describe('persistent administrative recovery', { timeout: 120_000 }, () => {
  it('becomes eligible only after the protected guest-claim lifecycle and preserves exact preview/routine parity', async () => {
    const fixture = await createRecoveryFixture('claim-parity', {
      partialPresentmentCorrection: true
    });
    const seedBefore = await getAdministrativeRecoverySeed(
      databaseClient.db,
      fixture.actor,
      fixture.refundId,
      requestContext('seed-before-claim')
    );
    expect(seedBefore).toMatchObject({
      refundId: fixture.refundId,
      activationCandidates: [{
        finalizationEffectId: fixture.finalizationEffectId,
        orderItemId: fixture.orderItemId,
        titleId: fixture.titleId,
        expectedCorrectionSetId: fixture.correctionSetId,
        expectedCorrectionVersion: 1,
        expectedSourceFingerprint: fixture.sourceFingerprint
      }],
      deactivationCandidates: []
    });
    await expect(activationPreview(fixture, 'before-claim')).resolves.toMatchObject({
      eligible: false,
      ineligibleReason: 'unclaimed_purchase',
      previewFingerprint: null,
      accessChanged: false,
      emailQueued: false
    });

    await claimFixture(fixture, 'claim-parity');
    const claimedPreview = await activationPreview(fixture, 'claim-parity-fingerprint');
    expect(claimedPreview.previewFingerprint)
      .toBe(expectedInitialActivationFingerprint(fixture));
    const before = await readRecoverySnapshot(fixture);
    const activated = await activateFixture(fixture, 'claim-parity');

    expect(activated.grant).toMatchObject({ state: 'active' });
    expect(activated.status).toMatchObject({
      result: {
        recoveryGrantId: activated.grant.id,
        accessChanged: true,
        emailQueued: true
      }
    });
    const after = await readRecoverySnapshot(fixture);
    expect(after.grants).not.toBe(before.grants);
    expect(after.entitlements).not.toBe(before.entitlements);
    expect(JSON.parse(after.recovery_audits)).toEqual([
      expect.arrayContaining([
        'financial.recovery_grant.activated',
        fixture.actor.id,
        activated.grant.id
      ])
    ]);
    expect(JSON.parse(after.recovery_messages)).toEqual([
      expect.arrayContaining([
        'email.commerce.v1',
        `commerce:recovery-access:${activated.grant.id}:active:${Date.parse(
          activated.grant.state_changed_at
        )}`
      ])
    ]);
  });

  it('waits on active projection authority without acquiring mutation locks or changing domain state', async () => {
    const fixture = await createRecoveryFixture('projection-lock');
    await claimFixture(fixture, 'projection-lock');
    const preview = await activationPreview(fixture, 'projection-lock');
    const submitted = await submit(
      fixture.actor,
      activationCommand(fixture, preview.previewFingerprint!),
      'projection-lock'
    );
    const claimed = await claimRecoveryCommand(submitted.commandId, 'projection-lock');
    const before = await readRecoverySnapshot(fixture);
    const blocker = await ownerDatabaseClient.pool.connect();
    let released = false;
    let operation: Promise<unknown | null> | undefined;
    try {
      await blocker.query('begin');
      const blockerPid = (await blocker.query<{ pid: number }>(
        'select pg_backend_pid() as pid'
      )).rows[0]!.pid;
      await blocker.query(
        `select singleton from financial_projection_versions
         where singleton = true for update`
      );
      operation = executeClaimedRecovery(claimed);
      void operation.catch(() => undefined);
      const executorPid = await waitForBlockedRecoveryExecutor(blockerPid);
      expect(await readRecoverySnapshot(fixture)).toEqual(before);
      await expect(ownerDatabaseClient.pool.query<{ relation: string; mode: string }>(`
        select relation.relname as relation, lock.mode
        from pg_locks lock
        join pg_class relation on relation.oid = lock.relation
        where lock.pid = $1 and lock.granted
          and lock.mode in (
            'RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock',
            'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'
          )
          and relation.relname in (
            'entitlement_grants', 'entitlements', 'audit_events',
            'outbox_messages', 'financial_admin_commands'
          )
        order by relation.relname, lock.mode
      `, [executorPid])).resolves.toMatchObject({ rows: [] });

      await blocker.query('commit');
      blocker.release();
      released = true;
      await expect(operation).resolves.toBeNull();
      expect((await recoveryGrantRow(fixture.refundAllocationId)).state).toBe('active');
    } finally {
      if (!released) {
        await blocker.query('rollback').catch(() => undefined);
        blocker.release();
      }
      await Promise.allSettled(operation ? [operation] : []);
    }
  }, 30_000);

  it('waits on the shared order advisory barrier without mutation, then succeeds', async () => {
    const fixture = await createRecoveryFixture('order-lock');
    await claimFixture(fixture, 'order-lock');
    const preview = await activationPreview(fixture, 'order-lock');
    expect(preview).toMatchObject({
      eligible: true,
      ineligibleReason: null,
      previewFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    const submitted = await submit(
      fixture.actor,
      activationCommand(fixture, preview.previewFingerprint!),
      'order-lock'
    );
    const claimed = await claimRecoveryCommand(submitted.commandId, 'order-lock');
    const before = await readRecoverySnapshot(fixture);
    const blocker = await ownerDatabaseClient.pool.connect();
    let released = false;
    let operation: Promise<unknown | null> | undefined;
    try {
      await blocker.query('begin');
      const blockerPid = (await blocker.query<{ pid: number }>(
        'select pg_backend_pid() as pid'
      )).rows[0]!.pid;
      await blocker.query(
        `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`pale-orbit:commerce:order:${fixture.orderId}`]
      );

      operation = executeClaimedRecovery(claimed);
      void operation.catch(() => undefined);
      const executorPid = await waitForBlockedRecoveryExecutor(blockerPid);
      await expect(ownerDatabaseClient.pool.query<{
        wait_event_type: string | null;
        wait_event: string | null;
        blockers: number[];
      }>(`
        select wait_event_type, wait_event, pg_blocking_pids(pid) as blockers
        from pg_stat_activity where pid = $1
      `, [executorPid])).resolves.toMatchObject({
        rows: [{
          wait_event_type: 'Lock',
          wait_event: 'advisory',
          blockers: expect.arrayContaining([blockerPid])
        }]
      });
      expect(await readRecoverySnapshot(fixture)).toEqual(before);
      await expect(ownerDatabaseClient.pool.query(
        `select status, safe_result_code, safe_result
         from financial_admin_commands where id = $1`,
        [submitted.commandId]
      )).resolves.toMatchObject({
        rows: [{ status: 'pending', safe_result_code: null, safe_result: null }]
      });

      await blocker.query('commit');
      blocker.release();
      released = true;
      await expect(operation).resolves.toBeNull();
      await expect(getFinancialAdminCommandStatus(
        databaseClient.db,
        fixture.actor,
        submitted.commandId
      )).resolves.toMatchObject({
        status: 'succeeded',
        resultCode: 'recovery_activated',
        result: { accessChanged: true, emailQueued: true }
      });
      expect((await recoveryGrantRow(fixture.refundAllocationId)).state).toBe('active');
      expect(await readRecoverySnapshot(fixture)).not.toEqual(before);
    } finally {
      if (!released) {
        await blocker.query('rollback').catch(() => undefined);
        blocker.release();
      }
      await Promise.allSettled(operation ? [operation] : []);
    }
  }, 30_000);

  it('replays the exact activation and deactivation without changing grants, audit, result, or outbox', async () => {
    const fixture = await createRecoveryFixture('exact-replay');
    await claimFixture(fixture, 'exact-replay');
    const preview = await activationPreview(fixture, 'exact-replay');
    const command = activationCommand(fixture, preview.previewFingerprint!);
    const idempotencyKey = randomUUID();
    const first = await submit(fixture.actor, command, 'exact-replay', idempotencyKey);
    expect(await runRecoveryCommand(first.commandId, 'exact-replay')).toBeNull();
    const activationStatus = await getFinancialAdminCommandStatus(
      databaseClient.db, fixture.actor, first.commandId
    );
    const afterActivation = await readRecoverySnapshot(fixture);
    const replay = await submit(fixture.actor, command, 'exact-replay-replay', idempotencyKey);
    expect(replay).toEqual({ ...first, status: 'succeeded' });
    expect(await getFinancialAdminCommandStatus(
      databaseClient.db, fixture.actor, replay.commandId
    )).toEqual(activationStatus);
    expect(await readRecoverySnapshot(fixture)).toEqual(afterActivation);

    const grant = await recoveryGrantRow(fixture.refundAllocationId);
    const deactivationPreview = await previewAdministrativeRecoveryDeactivation(
      databaseClient.db,
      fixture.actor,
      {
        refundId: fixture.refundId,
        recoveryGrantId: grant.id,
        recoveryReferenceId: fixture.refundAllocationId,
        expectedStateChangedAt: grant.state_changed_at
      },
      requestContext('deactivation-replay')
    );
    expect(deactivationPreview).toMatchObject({
      eligible: true,
      effectiveAccessBefore: true,
      effectiveAccessAfter: false,
      accessChanged: true,
      emailQueued: true
    });
    const deactivationCommand = {
      kind: 'administrative_recovery_deactivate',
      recoveryGrantId: grant.id,
      recoveryReferenceId: fixture.refundAllocationId,
      expectedStateChangedAt: grant.state_changed_at,
      confirmation: 'deactivate_persistent_recovery'
    } as const satisfies FinancialAdminPrivateCommand;
    const deactivationIdempotencyKey = randomUUID();
    const deactivation = await submit(
      fixture.actor,
      deactivationCommand,
      'deactivation-replay',
      deactivationIdempotencyKey
    );
    expect(await runRecoveryCommand(
      deactivation.commandId,
      'deactivation-replay'
    )).toBeNull();
    const deactivationStatus = await getFinancialAdminCommandStatus(
      databaseClient.db, fixture.actor, deactivation.commandId
    );
    expect(deactivationStatus).toMatchObject({
      status: 'succeeded',
      resultCode: 'recovery_deactivated',
      result: { recoveryGrantId: grant.id, accessChanged: true, emailQueued: true }
    });
    const afterDeactivation = await readRecoverySnapshot(fixture);
    const deactivationReplay = await submit(
      fixture.actor,
      deactivationCommand,
      'deactivation-replay-again',
      deactivationIdempotencyKey
    );
    expect(deactivationReplay).toEqual({ ...deactivation, status: 'succeeded' });
    expect(await getFinancialAdminCommandStatus(
      databaseClient.db, fixture.actor, deactivationReplay.commandId
    )).toEqual(deactivationStatus);
    expect(await readRecoverySnapshot(fixture)).toEqual(afterDeactivation);
  });

  it('allows only one activation transition for the same causal recovery reference', async () => {
    const fixture = await createRecoveryFixture('two-activations');
    await claimFixture(fixture, 'two-activations');
    const preview = await activationPreview(fixture, 'two-activations');
    const command = activationCommand(fixture, preview.previewFingerprint!);
    const first = await submit(fixture.actor, command, 'two-activations-first');
    expect(await runRecoveryCommand(first.commandId, 'two-activations-first')).toBeNull();
    const afterFirst = await readRecoverySnapshot(fixture);

    const second = await submit(fixture.actor, command, 'two-activations-second');
    expect(second.commandId).not.toBe(first.commandId);
    expect(await runRecoveryCommand(second.commandId, 'two-activations-second'))
      .toBeInstanceOf(Error);
    expect(await getFinancialAdminCommandStatus(
      databaseClient.db, fixture.actor, second.commandId
    )).toMatchObject({ status: 'conflict', resultCode: 'not_eligible', result: null });
    expect(await readRecoverySnapshot(fixture)).toEqual(afterFirst);
  });

  it('never fingerprints or marks an incomplete projection head eligible', async () => {
    const fixture = await createRecoveryFixture('incomplete-head');
    await claimFixture(fixture, 'incomplete-head');
    await expect(activationPreview(fixture, 'complete-head-control')).resolves.toMatchObject({
      eligible: true,
      previewFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    const client = await ownerDatabaseClient.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local session_replication_role = replica`);
      await client.query(
        `update financial_allocation_sets set expected_effect_minor = -1
         where id = $1`,
        [fixture.feeAllocationSetId]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    await expect(activationPreview(fixture, 'incomplete-head')).resolves.toMatchObject({
      eligible: false,
      ineligibleReason: 'correction_rebase_required',
      previewFingerprint: null,
      accessChanged: false,
      emailQueued: false
    });
  });

  it('discovers and deactivates the persistent grant independently after correction rebase', async () => {
    const fixture = await createRecoveryFixture('independent-deactivation');
    await claimFixture(fixture, 'independent-deactivation');
    const activated = await activateFixture(fixture, 'independent-deactivation');
    await createCompatibleSuccessor(fixture);
    await ownerDatabaseClient.pool.query(
      `insert into financial_reconciliation_issues (
         resource_type, resource_id, safe_code, impact, correlation_id
       ) values ('allocation_set', $1, 'correction_rebase_required', 'exception', $2)`,
      [fixture.grossAllocationSetId, token('recovery_rebase_issue')]
    );

    const seed = await getAdministrativeRecoverySeed(
      databaseClient.db,
      fixture.actor,
      fixture.refundId,
      requestContext('independent-deactivation-seed')
    );
    expect(seed?.activationCandidates).toEqual([]);
    expect(seed?.deactivationCandidates).toEqual([
      expect.objectContaining({
        recoveryGrantId: activated.grant.id,
        recoveryReferenceId: fixture.refundAllocationId,
        expectedStateChangedAt: activated.grant.state_changed_at,
        orderItemId: fixture.orderItemId,
        titleId: fixture.titleId
      })
    ]);
    const preview = await previewAdministrativeRecoveryDeactivation(
      databaseClient.db,
      fixture.actor,
      {
        refundId: fixture.refundId,
        recoveryGrantId: activated.grant.id,
        recoveryReferenceId: fixture.refundAllocationId,
        expectedStateChangedAt: activated.grant.state_changed_at
      },
      requestContext('independent-deactivation-preview')
    );
    expect(preview).toMatchObject({ eligible: true, ineligibleReason: null });
    const financialBefore = (await ownerDatabaseClient.pool.query<{ snapshot: string }>(`
      select jsonb_build_object(
        'refund', (select to_jsonb(candidate) from refunds candidate where id = $1),
        'allocations', (select jsonb_agg(to_jsonb(candidate) order by candidate.id)
          from refund_allocations candidate where candidate.refund_id = $1),
        'corrections', (select jsonb_agg(to_jsonb(candidate) order by candidate.id)
          from refund_reporting_correction_sets candidate
          where candidate.refund_id = $1)
      )::text as snapshot
    `, [fixture.refundId])).rows[0]!.snapshot;
    const deactivation = await submit(fixture.actor, {
      kind: 'administrative_recovery_deactivate',
      recoveryGrantId: activated.grant.id,
      recoveryReferenceId: fixture.refundAllocationId,
      expectedStateChangedAt: activated.grant.state_changed_at,
      confirmation: 'deactivate_persistent_recovery'
    }, 'independent-deactivation');
    expect(await runRecoveryCommand(
      deactivation.commandId,
      'independent-deactivation'
    )).toBeNull();
    expect((await recoveryGrantRow(fixture.refundAllocationId)).state).toBe('revoked');
    const financialAfter = (await ownerDatabaseClient.pool.query<{ snapshot: string }>(`
      select jsonb_build_object(
        'refund', (select to_jsonb(candidate) from refunds candidate where id = $1),
        'allocations', (select jsonb_agg(to_jsonb(candidate) order by candidate.id)
          from refund_allocations candidate where candidate.refund_id = $1),
        'corrections', (select jsonb_agg(to_jsonb(candidate) order by candidate.id)
          from refund_reporting_correction_sets candidate
          where candidate.refund_id = $1)
      )::text as snapshot
    `, [fixture.refundId])).rows[0]!.snapshot;
    expect(financialAfter).toBe(financialBefore);
  });

  it('preserves the active recovery grant through a real classifier replay and correction rebase',
    async () => {
      const fixture = await createRecoveryFixture('classifier-rebase-persistence');
      await claimFixture(fixture, 'classifier-rebase-persistence');
      const activated = await activateFixture(fixture, 'classifier-rebase-persistence');
      const recoveryBefore = await readRecoverySnapshot(fixture);
      const targetClassifierVersion = fixture.classifierVersion + 1;
      const targetAllocationAlgorithmVersion = fixture.allocationAlgorithmVersion;
      const replayId =
        `c${targetClassifierVersion}-a${targetAllocationAlgorithmVersion}`;

      const pending = await startOrResumeFinancialScan(workerDatabaseClient.db, {
        kind: 'composite_replay',
        classifierVersion: targetClassifierVersion,
        allocationAlgorithmVersion: targetAllocationAlgorithmVersion,
        replayId
      });
      const page = await loadClassificationReplayPage(
        workerDatabaseClient.db,
        pending,
        100
      );
      expect(page).toMatchObject({ hasMore: false, checkpoint: null });
      expect(page.data).toEqual([{
        subjectType: 'balance_transaction',
        subjectId: fixture.balanceTransactionId,
        sourceFingerprintSha256: fixture.sourceFingerprint
      }]);
      const children = page.data.map((subject) =>
        createFinancialClassificationSubjectJob({
          ...subject,
          classifierVersion: targetClassifierVersion,
          allocationAlgorithmVersion: targetAllocationAlgorithmVersion,
          scanRunId: pending.id
        })
      );
      const child = children[0];
      if (!child) throw new Error('Expected one classifier-replay child.');
      const sealed = await commitFinancialScanPage(workerDatabaseClient.db, {
        runId: pending.id,
        expectedPhase: 'classification_replay_page',
        expectedCheckpoint: null,
        expectedPageCount: 0,
        nextPhase: 'classification_replay_page',
        nextCheckpoint: null,
        processedCount: page.data.length,
        children,
        complete: true
      });
      if (sealed.cursorDigestSha256 === null) {
        throw new Error('Expected a sealed classifier-replay cursor digest.');
      }

      await expect(replayFinancialClassification({
        database: workerDatabaseClient.db,
        targetClassifierVersion,
        targetAllocationAlgorithmVersion
      }, {
        payload: child.payload,
        correlationId: 'classifier-rebase-persistence-replay',
        signal: new AbortController().signal
      })).resolves.toBeUndefined();
      const completedChildren = await workerDatabaseClient.pool.query<{ id: string }>(
        `update jobs set status = 'succeeded', attempts = 1, completed_at = now(),
           locked_at = null, locked_by = null, last_error = null
         where type = 'commerce.financial-classification'
           and deduplication_key = $1 and payload ->> 'scanRunId' = $2
         returning id`,
        [child.deduplicationKey, pending.id]
      );
      expect(completedChildren.rows).toHaveLength(1);
      await expect(finalizeFinancialReplay(workerDatabaseClient.db, {
        runId: pending.id,
        expectedCursorDigestSha256: sealed.cursorDigestSha256,
        expectedPageCount: sealed.pageCount,
        classifierVersion: targetClassifierVersion,
        allocationAlgorithmVersion: targetAllocationAlgorithmVersion,
        correlationId: 'classifier-rebase-persistence-activate'
      })).resolves.toMatchObject({ state: 'completed', safeOutcome: 'completed' });

      expect(await readRecoverySnapshot(fixture)).toEqual(recoveryBefore);
      expect(await recoveryGrantRow(fixture.refundAllocationId)).toEqual(activated.grant);
      await expect(ownerDatabaseClient.pool.query(
        `select classifier_version, allocation_algorithm_version,
           pending_classifier_version, pending_allocation_algorithm_version,
           pending_replay_id, pending_scan_run_id
         from financial_projection_versions where singleton = true`
      )).resolves.toMatchObject({ rows: [{
        classifier_version: targetClassifierVersion,
        allocation_algorithm_version: targetAllocationAlgorithmVersion,
        pending_classifier_version: null,
        pending_allocation_algorithm_version: null,
        pending_replay_id: null,
        pending_scan_run_id: null
      }] });

      const allocationHistory = await ownerDatabaseClient.pool.query<{
        id: string;
        basis: 'gross_amount' | 'fee';
        classifier_version: number;
        algorithm_version: number;
        supersedes_set_id: string | null;
      }>(
        `select id, basis, classifier_version, algorithm_version, supersedes_set_id
         from financial_allocation_sets where balance_transaction_id = $1
         order by classifier_version, algorithm_version, basis, id`,
        [fixture.balanceTransactionId]
      );
      expect(allocationHistory.rows).toHaveLength(4);
      const successors = allocationHistory.rows.filter((row) =>
        row.classifier_version === targetClassifierVersion &&
        row.algorithm_version === targetAllocationAlgorithmVersion
      );
      expect(successors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          basis: 'gross_amount', supersedes_set_id: fixture.grossAllocationSetId
        }),
        expect.objectContaining({
          basis: 'fee', supersedes_set_id: fixture.feeAllocationSetId
        })
      ]));
      const grossSuccessor = successors.find((row) => row.basis === 'gross_amount');
      if (!grossSuccessor) throw new Error('Expected the replayed gross allocation tip.');
      await expect(ownerDatabaseClient.pool.query(
        `select id, correction_version, kind, base_allocation_set_id,
           predecessor_correction_set_id, source_fingerprint_sha256
         from refund_reporting_correction_sets where refund_id = $1
         order by correction_version`,
        [fixture.refundId]
      )).resolves.toMatchObject({ rows: [
        {
          id: fixture.correctionSetId,
          correction_version: 1,
          kind: 'allocation_attribution_correction',
          base_allocation_set_id: fixture.grossAllocationSetId,
          predecessor_correction_set_id: null,
          source_fingerprint_sha256: fixture.sourceFingerprint
        },
        {
          id: expect.any(String),
          correction_version: 2,
          kind: 'classifier_rebase',
          base_allocation_set_id: grossSuccessor.id,
          predecessor_correction_set_id: fixture.correctionSetId,
          source_fingerprint_sha256: fixture.sourceFingerprint
        }
      ] });

      const seed = await getAdministrativeRecoverySeed(
        databaseClient.db,
        fixture.actor,
        fixture.refundId,
        requestContext('classifier-rebase-persistence-seed')
      );
      expect(seed?.activationCandidates).toEqual([]);
      expect(seed?.deactivationCandidates).toEqual([
        expect.objectContaining({
          recoveryGrantId: activated.grant.id,
          recoveryReferenceId: fixture.refundAllocationId,
          expectedStateChangedAt: activated.grant.state_changed_at,
          orderItemId: fixture.orderItemId,
          titleId: fixture.titleId
        })
      ]);
    }, 20_000);

  it('suppresses effective-change email when another active grant already supplies access', async () => {
    const fixture = await createRecoveryFixture('other-active-grant');
    await claimFixture(fixture, 'other-active-grant');
    await ownerDatabaseClient.pool.query(
      `insert into entitlement_grants (
         title_id, user_id, source, state, state_reason, granted_at
       ) values ($1, $2, 'preserved', 'active', 'administrative_preservation', $3)`,
      [fixture.titleId, fixture.claimantId, FIXED_AT]
    );
    await ownerDatabaseClient.pool.query(
      `insert into entitlements (user_id, title_id, granted_at, created_at, updated_at)
       values ($1, $2, $3, $3, $3)`,
      [fixture.claimantId, fixture.titleId, FIXED_AT]
    );

    const preview = await activationPreview(fixture, 'other-active-grant');
    expect(preview).toMatchObject({
      eligible: true,
      effectiveAccessBefore: true,
      effectiveAccessAfter: true,
      accessChanged: false,
      emailQueued: false
    });
    const submitted = await submit(
      fixture.actor,
      activationCommand(fixture, preview.previewFingerprint!),
      'other-active-grant'
    );
    expect(await runRecoveryCommand(submitted.commandId, 'other-active-grant')).toBeNull();
    expect(await getFinancialAdminCommandStatus(
      databaseClient.db, fixture.actor, submitted.commandId
    )).toMatchObject({
      status: 'succeeded',
      result: { accessChanged: false, emailQueued: false }
    });
    expect(JSON.parse((await readRecoverySnapshot(fixture)).recovery_messages)).toEqual([]);
  });

  it.each([
    ['correction tip', async (fixture: RecoveryFixture) => {
      await createCompatibleSuccessor(fixture);
    }],
    ['correction version', async (fixture: RecoveryFixture) => {
      await executeWithReplicationBypass(
        `update refund_reporting_correction_sets
         set correction_version = correction_version + 1 where id = $1`,
        [fixture.correctionSetId]
      );
    }],
    ['source fingerprint', async (fixture: RecoveryFixture) => {
      await executeWithReplicationBypass(
        `update stripe_balance_transactions set fingerprint_sha256 = repeat('f', 64)
         where id = $1`,
        [fixture.balanceTransactionId]
      );
    }],
    ['projection head', async (fixture: RecoveryFixture) => {
      await executeWithReplicationBypass(
        `update financial_allocation_sets set expected_effect_minor = -1
         where id = $1`,
        [fixture.feeAllocationSetId]
      );
    }],
    ['projection implementation', async (_fixture: RecoveryFixture) => {
      await executeWithReplicationBypass(
        `update financial_projection_versions
         set classifier_version = classifier_version + 1
         where singleton = true`
      );
    }],
    ['finalization provenance', async (fixture: RecoveryFixture) => {
      await executeWithReplicationBypass(
        `update refund_allocation_drafts
         set state = 'active', finalized_at = null
         where id = $1`,
        [fixture.finalizationDraftId]
      );
    }]
  ] as const)('fails closed on stale %s after prepare', async (_label, drift) => {
    const label = _label.replaceAll(' ', '-');
    const fixture = await createRecoveryFixture(`stale-${label}`);
    await claimFixture(fixture, `stale-${label}`);
    const preview = await activationPreview(fixture, `stale-${label}`);
    const before = await readRecoverySnapshot(fixture);
    await drift(fixture);
    const submitted = await submit(
      fixture.actor,
      activationCommand(fixture, preview.previewFingerprint!),
      `stale-${label}`
    );
    expect(await runRecoveryCommand(submitted.commandId, `stale-${label}`))
      .toBeInstanceOf(Error);
    expect(await getFinancialAdminCommandStatus(
      databaseClient.db, fixture.actor, submitted.commandId
    )).toMatchObject({ status: 'conflict', resultCode: 'stale_state', result: null });
    expect(await readRecoverySnapshot(fixture)).toEqual(before);
  });

  it('classifies a cumulative full-refund change after prepare as stale state', async () => {
    const fixture = await createRecoveryFixture('stale-full-refund');
    await claimFixture(fixture, 'stale-full-refund');
    const preview = await activationPreview(fixture, 'stale-full-refund');
    expect(preview).toMatchObject({
      eligible: true,
      previewFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });

    await makeFixtureCumulativelyFullyRefunded(fixture);
    await expect(activationPreview(fixture, 'current-full-refund')).resolves.toMatchObject({
      eligible: false,
      ineligibleReason: 'still_fully_refunded',
      previewFingerprint: null
    });
    const afterDrift = await readRecoverySnapshot(fixture);
    const submitted = await submit(
      fixture.actor,
      activationCommand(fixture, preview.previewFingerprint!),
      'stale-full-refund'
    );

    expect(await runRecoveryCommand(submitted.commandId, 'stale-full-refund'))
      .toBeInstanceOf(Error);
    expect(await getFinancialAdminCommandStatus(
      databaseClient.db, fixture.actor, submitted.commandId
    )).toMatchObject({ status: 'conflict', resultCode: 'stale_state', result: null });
    expect(await readRecoverySnapshot(fixture)).toEqual(afterDrift);
  });

  it('keeps recovery transition tokens and email dedupe keys monotonic across a rapid cycle',
    async () => {
      const fixture = await createRecoveryFixture('monotonic-cycle');
      await claimFixture(fixture, 'monotonic-cycle');
      const activated = await activateFixture(fixture, 'monotonic-cycle');
      const advancedActiveAt = await moveRecoveryStateTimestampAhead(activated.grant.id);

      const deactivation = await submit(fixture.actor, {
        kind: 'administrative_recovery_deactivate',
        recoveryGrantId: activated.grant.id,
        recoveryReferenceId: fixture.refundAllocationId,
        expectedStateChangedAt: advancedActiveAt,
        confirmation: 'deactivate_persistent_recovery'
      }, 'monotonic-cycle-deactivate');
      expect(await runRecoveryCommand(
        deactivation.commandId, 'monotonic-cycle-deactivate'
      )).toBeNull();
      const revoked = await recoveryGrantRow(fixture.refundAllocationId);
      expect(Date.parse(revoked.state_changed_at)).toBeGreaterThan(
        Date.parse(advancedActiveAt)
      );

      const reactivationPreview = await activationPreview(
        fixture, 'monotonic-cycle-reactivate'
      );
      expect(reactivationPreview).toMatchObject({
        eligible: true,
        recoveryGrantId: activated.grant.id
      });
      const reactivation = await submit(
        fixture.actor,
        activationCommand(fixture, reactivationPreview.previewFingerprint!),
        'monotonic-cycle-reactivate'
      );
      expect(await runRecoveryCommand(
        reactivation.commandId, 'monotonic-cycle-reactivate'
      )).toBeNull();
      const reactivated = await recoveryGrantRow(fixture.refundAllocationId);
      expect(Date.parse(reactivated.state_changed_at)).toBeGreaterThan(
        Date.parse(revoked.state_changed_at)
      );

      const messages = JSON.parse(
        (await readRecoverySnapshot(fixture)).recovery_messages
      ) as readonly [string, string, unknown][];
      const dedupeKeys = messages.map((message) => message[1]);
      expect(new Set(dedupeKeys).size).toBe(dedupeKeys.length);
      expect(dedupeKeys).toEqual(expect.arrayContaining([
        `commerce:recovery-access:${activated.grant.id}:revoked:${Date.parse(
          revoked.state_changed_at
        )}`,
        `commerce:recovery-access:${activated.grant.id}:active:${Date.parse(
          reactivated.state_changed_at
        )}`
      ]));
    });

  it('fails closed on a stale deactivation timestamp after a real state transition', async () => {
    const fixture = await createRecoveryFixture('stale-timestamp');
    await claimFixture(fixture, 'stale-timestamp');
    const activated = await activateFixture(fixture, 'stale-timestamp');
    const staleTimestamp = activated.grant.state_changed_at;
    const client = await ownerDatabaseClient.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local session_replication_role = replica`);
      await client.query(
        `update entitlement_grants
         set updated_at = date_trunc('milliseconds', updated_at + interval '1 second')
         where id = $1`,
        [activated.grant.id]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    const before = await readRecoverySnapshot(fixture);
    const submitted = await submit(fixture.actor, {
      kind: 'administrative_recovery_deactivate',
      recoveryGrantId: activated.grant.id,
      recoveryReferenceId: fixture.refundAllocationId,
      expectedStateChangedAt: staleTimestamp,
      confirmation: 'deactivate_persistent_recovery'
    }, 'stale-timestamp');
    expect(await runRecoveryCommand(submitted.commandId, 'stale-timestamp'))
      .toBeInstanceOf(Error);
    expect(await getFinancialAdminCommandStatus(
      databaseClient.db, fixture.actor, submitted.commandId
    )).toMatchObject({ status: 'conflict', resultCode: 'stale_state' });
    expect(await readRecoverySnapshot(fixture)).toEqual(before);
  });

  it.each([
    {
      label: 'protected routine audit',
      relation: 'audit_events',
      timing: 'before insert' as const,
      condition: `new.action = 'financial.recovery_grant.activated'`
    },
    {
      label: 'entitlement projection',
      relation: 'entitlements',
      timing: 'before insert or update' as const
    },
    {
      label: 'recovery outbox',
      relation: 'outbox_messages',
      timing: 'before insert' as const,
      condition: `new.payload ->> 'template' =
        'commerce.administrative-recovery-access-changed'`
    }
  ])('rolls back grant, projection, audit, outbox, and result on forced $label failure',
    async (fault) => {
      const faultLabel = `fault-${fault.label.replaceAll(' ', '-')}`;
      const fixture = await createRecoveryFixture(faultLabel);
      await claimFixture(fixture, faultLabel);
      const preview = await activationPreview(fixture, faultLabel);
      const submitted = await submit(
        fixture.actor,
        activationCommand(fixture, preview.previewFingerprint!),
        faultLabel
      );
      const before = await readRecoverySnapshot(fixture);
      const removeFault = await installFailureTrigger(fault);
      try {
        const claimed = await claimRecoveryCommand(submitted.commandId, faultLabel);
        expect(await executeClaimedRecovery(claimed, { retryableOnFailure: true }))
          .toBeInstanceOf(Error);
      } finally {
        await removeFault();
      }
      expect(await readRecoverySnapshot(fixture)).toEqual(before);
      expect(await getFinancialAdminCommandStatus(
        databaseClient.db, fixture.actor, submitted.commandId
      )).toMatchObject({ status: 'pending', resultCode: null, result: null });
    });

  it('rejects revoked administrator authority without any recovery side effect', async () => {
    const fixture = await createRecoveryFixture('revoked-admin');
    await claimFixture(fixture, 'revoked-admin');
    const preview = await activationPreview(fixture, 'revoked-admin');
    const submitted = await submit(
      fixture.actor,
      activationCommand(fixture, preview.previewFingerprint!),
      'revoked-admin'
    );
    const before = await readRecoverySnapshot(fixture);
    await removeAdministratorRole(fixture.actor.id);
    expect(await runRecoveryCommand(submitted.commandId, 'revoked-admin'))
      .toBeInstanceOf(Error);
    expect(await readRecoverySnapshot(fixture)).toEqual(before);
    await expect(ownerDatabaseClient.pool.query(
      `select status, safe_result_code from financial_admin_commands where id = $1`,
      [submitted.commandId]
    )).resolves.toMatchObject({
      rows: [{ status: 'denied', safe_result_code: 'capability_revoked' }]
    });
  });

  it.each(['forged', 'expired'] as const)(
    'rejects a %s lease capability before the protected grant transition',
    async (kind) => {
      const fixture = await createRecoveryFixture(`${kind}-capability`);
      await claimFixture(fixture, `${kind}-capability`);
      const preview = await activationPreview(fixture, `${kind}-capability`);
      const submitted = await submit(
        fixture.actor,
        activationCommand(fixture, preview.previewFingerprint!),
        `${kind}-capability`
      );
      const claimed = await claimRecoveryCommand(submitted.commandId, `${kind}-capability`);
      const before = await readRecoverySnapshot(fixture);
      if (kind === 'expired') await expireClaimedLease(claimed);
      const job = kind === 'forged'
        ? { ...claimed.job, financialAdminLeaseCapability: leaseCapability('forged-value') }
        : claimed.job;
      await expect(recoveryHandler()(job, new AbortController().signal))
        .rejects.toBeInstanceOf(Error);
      expect(await readRecoverySnapshot(fixture)).toEqual(before);
      await expect(ownerDatabaseClient.pool.query(
        `select status, safe_result_code, safe_result
         from financial_admin_commands where id = $1`,
        [submitted.commandId]
      )).resolves.toMatchObject({
        rows: [{ status: 'pending', safe_result_code: null, safe_result: null }]
      });
    }
  );
});
