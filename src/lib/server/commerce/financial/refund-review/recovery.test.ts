import { createHash } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import {
  FinancialAdminConflictError,
  FinancialAdminDeniedError,
  FinancialAdminPermanentError,
  type FinancialAdminCommandExecutorContext
} from '$lib/server/commerce/financial/admin-commands/handler';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import {
  buildAdministrativeRecoveryActivationPreimage,
  createAdministrativeRecoveryExecutors,
  fingerprintAdministrativeRecoveryActivation,
  getAdministrativeRecoverySeed,
  loadAdministrativeRecoveryNotification,
  planAdministrativeRecoveryActivation,
  planAdministrativeRecoveryDeactivation,
  previewAdministrativeRecovery,
  previewAdministrativeRecoveryDeactivation,
  transitionAdministrativeRecoveryGrant,
  type AdministrativeRecoveryActivationFacts,
  type AdministrativeRecoveryDeactivationFacts,
  type AdministrativeRecoveryServiceDependencies
} from './recovery';

const REFUND_ID = '00000000-0000-4000-8000-000000014001';
const PAYMENT_ID = '00000000-0000-4000-8000-000000014002';
const ORDER_ID = '00000000-0000-4000-8000-000000014003';
const EFFECT_ID = '00000000-0000-4000-8000-000000014004';
const ALLOCATION_ID = '00000000-0000-4000-8000-000000014005';
const DRAFT_ID = '00000000-0000-4000-8000-000000014006';
const ITEM_ID = '00000000-0000-4000-8000-000000014007';
const TITLE_ID = '00000000-0000-4000-8000-000000014008';
const PURCHASE_GRANT_ID = '00000000-0000-4000-8000-000000014009';
const USER_ID = '00000000-0000-4000-8000-000000014010';
const RECOVERY_GRANT_ID = '00000000-0000-4000-8000-000000014011';
const CORRECTION_ID = '00000000-0000-4000-8000-000000014012';
const BASE_SET_ID = '00000000-0000-4000-8000-000000014013';
const PREDECESSOR_ID = '00000000-0000-4000-8000-000000014014';
const BALANCE_ID = '00000000-0000-4000-8000-000000014015';
const COMMAND_ID = '00000000-0000-4000-8000-000000014016';
const SOURCE_FINGERPRINT = 'a'.repeat(64);
const STATE_CHANGED_AT = '2026-08-22T14:15:16.123Z';
const dialect = new PgDialect();

function activationFacts(
  overrides: Partial<AdministrativeRecoveryActivationFacts> = {}
): AdministrativeRecoveryActivationFacts {
  return {
    refundId: REFUND_ID,
    paymentId: PAYMENT_ID,
    orderId: ORDER_ID,
    finalizationEffectId: EFFECT_ID,
    recoveryReferenceId: ALLOCATION_ID,
    finalizationDraftId: DRAFT_ID,
    finalizationDraftVersion: 3,
    orderItemId: ITEM_ID,
    titleId: TITLE_ID,
    soldAsTitle: 'Recovered & Accounted',
    purchaseGrantId: PURCHASE_GRANT_ID,
    purchaseUserId: USER_ID,
    purchaseGrantState: 'revoked',
    effectTransition: 'revoked_by_finalization',
    effectBeforePurchaseGrantState: 'active',
    effectAfterPurchaseGrantState: 'revoked',
    allocationSource: 'administrative',
    allocationTotalMinor: 900,
    allocationSubtotalMinor: 800,
    allocationTaxMinor: 100,
    itemSubtotalMinor: 1_000,
    itemTaxMinor: 100,
    itemTotalMinor: 1_100,
    itemCurrency: 'USD',
    existingRecoveryGrantId: RECOVERY_GRANT_ID,
    existingRecoveryGrantState: 'revoked',
    existingRecoveryStateChangedAt: STATE_CHANGED_AT,
    correctionSetId: CORRECTION_ID,
    correctionVersion: 4,
    correctionKind: 'allocation_attribution_correction',
    correctionBaseSetId: BASE_SET_ID,
    correctionPredecessorSetId: PREDECESSOR_ID,
    correctionSourceFingerprint: SOURCE_FINGERPRINT,
    projectionClassifierVersion: 1,
    projectionAllocationAlgorithmVersion: 2,
    projectionPending: false,
    sourceBalanceTransactionId: BALANCE_ID,
    sourceFingerprint: SOURCE_FINGERPRINT,
    projectionHeadLines: [
      `projection_head=gross_amount|${BASE_SET_ID}|${CORRECTION_ID}|title|USD|-900|1|0|-`,
      `projection_head=fee|${BASE_SET_ID}|${CORRECTION_ID}|account|USD|-10|1|0|-`
    ],
    projectionItemLines: [
      `projection_item=gross_amount|${BASE_SET_ID}|${CORRECTION_ID}|${ITEM_ID}|refund_subtotal|-800|USD`,
      `projection_item=gross_amount|${BASE_SET_ID}|${CORRECTION_ID}|${ITEM_ID}|refund_tax|-100|USD`
    ],
    presentmentEvidenceLines: [
      `presentment_evidence=${REFUND_ID}|correction|-|${CORRECTION_ID}|4|refund_subtotal|800`,
      `presentment_evidence=${REFUND_ID}|correction|-|${CORRECTION_ID}|4|refund_tax|100`
    ],
    cumulativeRefundSubtotalMinor: 800,
    cumulativeRefundTaxMinor: 100,
    effectiveAccessBefore: false,
    projectionComplete: true,
    bindingLinksValid: true,
    causalLinksValid: true,
    ...overrides
  };
}

function activateInput() {
  return {
    refundId: REFUND_ID,
    finalizationEffectId: EFFECT_ID,
    orderItemId: ITEM_ID,
    expectedCorrectionSetId: CORRECTION_ID,
    expectedCorrectionVersion: 4,
    expectedSourceFingerprint: SOURCE_FINGERPRINT
  } as const;
}

function deactivationFacts(
  overrides: Partial<AdministrativeRecoveryDeactivationFacts> = {}
): AdministrativeRecoveryDeactivationFacts {
  return {
    refundId: REFUND_ID,
    recoveryGrantId: RECOVERY_GRANT_ID,
    recoveryReferenceId: ALLOCATION_ID,
    stateChangedAt: STATE_CHANGED_AT,
    orderItemId: ITEM_ID,
    titleId: TITLE_ID,
    soldAsTitle: 'Recovered & Accounted',
    state: 'active',
    effectiveAccessBefore: true,
    anotherActiveGrantExists: false,
    linkageValid: true,
    ...overrides
  };
}

describe('administrative recovery pure planning', () => {
  it('serializes the byte-exact v1 activation preimage and SHA-256 fingerprint', () => {
    const facts = activationFacts();
    const expected = [
      'pale-orbit.admin-recovery-preview.v1',
      `refund_id=${REFUND_ID}`,
      `payment_id=${PAYMENT_ID}`,
      `order_id=${ORDER_ID}`,
      `finalization_effect_id=${EFFECT_ID}`,
      `recovery_reference_id=${ALLOCATION_ID}`,
      `finalization_draft_id=${DRAFT_ID}`,
      'finalization_draft_version=3',
      `order_item_id=${ITEM_ID}`,
      `title_id=${TITLE_ID}`,
      `purchase_grant_id=${PURCHASE_GRANT_ID}`,
      'allocation_total_minor=900',
      'allocation_subtotal_minor=800',
      'allocation_tax_minor=100',
      'item_subtotal_minor=1000',
      'item_tax_minor=100',
      'item_total_minor=1100',
      'item_currency=USD',
      `existing_recovery_grant_id=${RECOVERY_GRANT_ID}`,
      'existing_recovery_grant_state=revoked',
      `existing_recovery_grant_state_changed_at=${STATE_CHANGED_AT}`,
      `correction_set_id=${CORRECTION_ID}`,
      'correction_version=4',
      'correction_kind=allocation_attribution_correction',
      `correction_base_set_id=${BASE_SET_ID}`,
      `correction_predecessor_correction_set_id=${PREDECESSOR_ID}`,
      `correction_source_fingerprint_sha256=${SOURCE_FINGERPRINT}`,
      'projection_classifier_version=1',
      'projection_allocation_algorithm_version=2',
      `source_balance_transaction_id=${BALANCE_ID}`,
      `source_fingerprint_sha256=${SOURCE_FINGERPRINT}`,
      'projection_head_count=2',
      ...facts.projectionHeadLines,
      'projection_item_count=2',
      ...facts.projectionItemLines,
      'presentment_evidence_count=2',
      ...facts.presentmentEvidenceLines,
      'cumulative_refund_subtotal_minor=800',
      'cumulative_refund_tax_minor=100',
      'cumulative_refund_total_minor=900',
      'remaining_unrefunded_minor=200',
      'effective_access_before=0',
      'effective_access_after=1',
      'access_changed=1',
      'email_queued=1',
      ''
    ].join('\n');

    expect(buildAdministrativeRecoveryActivationPreimage(facts)).toBe(expected);
    expect(fingerprintAdministrativeRecoveryActivation(facts)).toBe(
      createHash('sha256').update(expected, 'utf8').digest('hex')
    );
  });

  it('returns an eligible activation preview bound to the exact current facts', () => {
    const facts = activationFacts();
    expect(planAdministrativeRecoveryActivation(activateInput(), facts)).toEqual({
      refundId: REFUND_ID,
      finalizationEffectId: EFFECT_ID,
      orderItemId: ITEM_ID,
      titleId: TITLE_ID,
      soldAsTitle: 'Recovered & Accounted',
      expectedCorrectionSetId: CORRECTION_ID,
      expectedCorrectionVersion: 4,
      expectedSourceFingerprint: SOURCE_FINGERPRINT,
      previewFingerprint: fingerprintAdministrativeRecoveryActivation(facts),
      recoveryGrantId: RECOVERY_GRANT_ID,
      eligible: true,
      ineligibleReason: null,
      effectiveAccessBefore: false,
      effectiveAccessAfter: true,
      accessChanged: true,
      emailQueued: true,
      persistsUntilDeactivated: true
    });
  });

  it.each([
    ['not_causally_revoked', { causalLinksValid: false }],
    ['correction_rebase_required', { projectionComplete: false }],
    ['still_fully_refunded', { cumulativeRefundSubtotalMinor: 1_000 }],
    ['unclaimed_purchase', { purchaseUserId: null }],
    ['already_in_requested_state', { existingRecoveryGrantState: 'active' }]
  ] as const)('returns the safe %s activation reason without a fingerprint',
    (reason, mutation) => {
      expect(planAdministrativeRecoveryActivation(
        activateInput(), activationFacts(mutation)
      )).toMatchObject({ eligible: false, ineligibleReason: reason,
        previewFingerprint: null, accessChanged: false, emailQueued: false });
    });

  it('maps any optimistic activation binding drift to stale_state', () => {
    for (const mutation of [
      { refundId: ORDER_ID },
      { finalizationEffectId: ORDER_ID },
      { orderItemId: ORDER_ID },
      { expectedCorrectionSetId: ORDER_ID },
      { expectedCorrectionVersion: 5 },
      { expectedSourceFingerprint: 'b'.repeat(64) }
    ]) {
      expect(() => planAdministrativeRecoveryActivation(
        { ...activateInput(), ...mutation }, activationFacts()
      )).toThrowError(expect.objectContaining({ safeCode: 'stale_state' }));
    }
    expect(() => planAdministrativeRecoveryActivation(
      activateInput(), activationFacts({ bindingLinksValid: false })
    )).toThrowError(expect.objectContaining({ safeCode: 'stale_state' }));
  });

  it('fails a component-level presentment overage closed as incomplete projection', () => {
    expect(planAdministrativeRecoveryActivation(activateInput(), activationFacts({
      cumulativeRefundSubtotalMinor: 1_001,
      cumulativeRefundTaxMinor: 0
    }))).toMatchObject({ eligible: false,
      ineligibleReason: 'correction_rebase_required', previewFingerprint: null });
  });

  it('predicts deactivation from the exact grant timestamp and other active grants', () => {
    expect(planAdministrativeRecoveryDeactivation({
      refundId: REFUND_ID,
      recoveryGrantId: RECOVERY_GRANT_ID,
      recoveryReferenceId: ALLOCATION_ID,
      expectedStateChangedAt: STATE_CHANGED_AT
    }, deactivationFacts())).toEqual({
      refundId: REFUND_ID,
      recoveryGrantId: RECOVERY_GRANT_ID,
      recoveryReferenceId: ALLOCATION_ID,
      expectedStateChangedAt: STATE_CHANGED_AT,
      orderItemId: ITEM_ID,
      titleId: TITLE_ID,
      soldAsTitle: 'Recovered & Accounted',
      eligible: true,
      ineligibleReason: null,
      effectiveAccessBefore: true,
      effectiveAccessAfter: false,
      accessChanged: true,
      emailQueued: true
    });
    expect(planAdministrativeRecoveryDeactivation({
      refundId: REFUND_ID,
      recoveryGrantId: RECOVERY_GRANT_ID,
      recoveryReferenceId: ALLOCATION_ID,
      expectedStateChangedAt: STATE_CHANGED_AT
    }, deactivationFacts({ anotherActiveGrantExists: true }))).toMatchObject({
      effectiveAccessAfter: true, accessChanged: false, emailQueued: false
    });
  });

  it('treats a raced revoked deactivation as already requested and binding drift as stale', () => {
    expect(planAdministrativeRecoveryDeactivation({
      refundId: REFUND_ID, recoveryGrantId: RECOVERY_GRANT_ID,
      recoveryReferenceId: ALLOCATION_ID, expectedStateChangedAt: STATE_CHANGED_AT
    }, deactivationFacts({ state: 'revoked' }))).toMatchObject({
      eligible: false, ineligibleReason: 'already_in_requested_state'
    });
    expect(() => planAdministrativeRecoveryDeactivation({
      refundId: REFUND_ID, recoveryGrantId: RECOVERY_GRANT_ID,
      recoveryReferenceId: ALLOCATION_ID,
      expectedStateChangedAt: '2026-08-22T14:15:16.124Z'
    }, deactivationFacts())).toThrowError(expect.objectContaining({ safeCode: 'stale_state' }));
  });
});

describe('administrative recovery service authorization', () => {
  function fakeDatabase() {
    const transaction = { execute: vi.fn() } as unknown as DatabaseTransaction;
    const database = {
      transaction: vi.fn(async (work: (tx: DatabaseTransaction) => Promise<unknown>) =>
        work(transaction))
    } as unknown as Database;
    return { database, transaction };
  }

  it.each(['seed', 'activate', 'deactivate'] as const)(
    'requires both capabilities before %s database work', async (operation) => {
      const { database } = fakeDatabase();
      const actor: Actor = { type: 'user', id: USER_ID, roles: ['admin'] };
      const dependencies = { capabilityResolver: () => new Set(['sales.read']) as never };
      const call = operation === 'seed'
        ? getAdministrativeRecoverySeed(database, actor, REFUND_ID,
            { correlationId: 'recovery-seed' }, dependencies)
        : operation === 'activate'
          ? previewAdministrativeRecovery(database, actor, activateInput(),
              { correlationId: 'recovery-preview' }, dependencies)
          : previewAdministrativeRecoveryDeactivation(database, actor, {
              refundId: REFUND_ID, recoveryGrantId: RECOVERY_GRANT_ID,
              recoveryReferenceId: ALLOCATION_ID, expectedStateChangedAt: STATE_CHANGED_AT
            }, { correlationId: 'recovery-deactivate-preview' }, dependencies);
      await expect(call).rejects.toMatchObject({ name: 'AuthorizationError', code: 'forbidden' });
      expect(database.transaction).not.toHaveBeenCalled();
    });

  it('refreshes authorization under the role lock and keeps seed discovery independent', async () => {
    const { database, transaction } = fakeDatabase();
    const activationCandidates = [{
      finalizationEffectId: EFFECT_ID, orderItemId: ITEM_ID, titleId: TITLE_ID,
      soldAsTitle: 'Recovered & Accounted', expectedCorrectionSetId: CORRECTION_ID,
      expectedCorrectionVersion: 4, expectedSourceFingerprint: SOURCE_FINGERPRINT
    }];
    const deactivationCandidates = [{
      recoveryGrantId: RECOVERY_GRANT_ID, recoveryReferenceId: ALLOCATION_ID,
      expectedStateChangedAt: STATE_CHANGED_AT, orderItemId: ITEM_ID,
      titleId: TITLE_ID, soldAsTitle: 'Recovered & Accounted'
    }];
    const dependencies: AdministrativeRecoveryServiceDependencies = {
      listRoles: vi.fn(async () => ['admin'] as const),
      loadSeed: vi.fn(async () => ({ refundId: REFUND_ID,
        activationCandidates, deactivationCandidates }))
    };
    await expect(getAdministrativeRecoverySeed(database,
      { type: 'user', id: USER_ID, roles: ['admin'] }, REFUND_ID,
      { correlationId: 'recovery-seed' }, dependencies
    )).resolves.toEqual({ refundId: REFUND_ID, activationCandidates,
      deactivationCandidates });
    expect(transaction.execute).toHaveBeenCalledOnce();
    expect(dependencies.listRoles).toHaveBeenCalledWith(transaction, USER_ID);
    expect(dependencies.loadSeed).toHaveBeenCalledWith(transaction, REFUND_ID);
  });

  it('renders activation facts from one bounded projection-head snapshot', async () => {
    const execute = vi.fn(async (_statement: import('drizzle-orm').SQL) => ({ rows: [] }));
    const transaction = { execute } as unknown as DatabaseTransaction;
    const database = {
      transaction: vi.fn(async (work: (tx: DatabaseTransaction) => Promise<unknown>) =>
        work(transaction))
    } as unknown as Database;

    await expect(previewAdministrativeRecovery(
      database,
      { type: 'user', id: USER_ID, roles: ['admin'] },
      activateInput(),
      { correlationId: 'bounded-projection-snapshot' },
      { listRoles: vi.fn(async () => ['admin'] as const) }
    )).rejects.toMatchObject({ safeCode: 'stale_state' });

    expect(execute).toHaveBeenCalledTimes(2);
    const query = dialect.sqlToQuery(execute.mock.calls[1]![0]);
    expect(query.sql.match(/current_financial_projection_heads/gu)).toHaveLength(1);
    expect(query.sql).not.toContain('current_financial_projection_items');
    expect(query.sql).toContain('exact semantic parity');
  });
});

describe('administrative recovery protected transition and executors', () => {
  it('calls only the protected command-bound routine and parses its exact row', async () => {
    const execute = vi.fn(async (_statement: import('drizzle-orm').SQL) => ({ rows: [{
      recoveryGrantId: RECOVERY_GRANT_ID,
      recoveryUserId: USER_ID,
      recoveryTitleId: TITLE_ID,
      previousState: 'revoked',
      nextState: 'active',
      stateChangedAt: new Date(STATE_CHANGED_AT)
    }] }));
    await expect(transitionAdministrativeRecoveryGrant(
      { execute } as unknown as DatabaseTransaction, COMMAND_ID
    )).resolves.toEqual({
      recoveryGrantId: RECOVERY_GRANT_ID, recoveryUserId: USER_ID,
      recoveryTitleId: TITLE_ID, previousState: 'revoked', nextState: 'active',
      stateChangedAt: new Date(STATE_CHANGED_AT)
    });
    const query = dialect.sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toContain('transition_administrative_recovery_grant_after_admin_command');
    expect(query.sql).not.toMatch(/insert\s+into|update\s+entitlement_grants|delete\s+from/iu);
    expect(query.params).toEqual([COMMAND_ID]);
  });

  it('loads only the verified recipient derived from the transitioned grant', async () => {
    const execute = vi.fn(async (_statement: import('drizzle-orm').SQL) => ({ rows: [{
      to: 'reader@example.com', soldAsTitle: 'Recovered & Accounted'
    }] }));
    const transition = {
      recoveryGrantId: RECOVERY_GRANT_ID, recoveryUserId: USER_ID,
      recoveryTitleId: TITLE_ID, previousState: 'revoked' as const,
      nextState: 'active' as const, stateChangedAt: new Date(STATE_CHANGED_AT)
    };
    await expect(loadAdministrativeRecoveryNotification(
      { execute } as unknown as DatabaseTransaction, transition
    )).resolves.toEqual({ to: 'reader@example.com',
      soldAsTitle: 'Recovered & Accounted' });
    const query = dialect.sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toMatch(/account[.]email_verified\s*=\s*true/iu);
    expect(query.params).toEqual([
      RECOVERY_GRANT_ID, USER_ID, TITLE_ID, 'active'
    ]);
  });

  function executorContext(): FinancialAdminCommandExecutorContext {
    return {
      transaction: {} as DatabaseTransaction,
      commandId: COMMAND_ID,
      actor: { type: 'user', id: USER_ID, roles: ['admin'] },
      correlationId: 'recovery-command',
      signal: new AbortController().signal,
      enqueueAccessChange: vi.fn(async () => undefined)
    };
  }

  it.each([
    ['administrative_recovery_activate', 'active'],
    ['administrative_recovery_deactivate', 'revoked']
  ] as const)('projects and emails an effective %s transition using its actual timestamp',
    async (kind, nextState) => {
      const transitionGrant = vi.fn(async () => ({
        recoveryGrantId: RECOVERY_GRANT_ID, recoveryUserId: USER_ID,
        recoveryTitleId: TITLE_ID, previousState: nextState === 'active' ? 'revoked' : 'active',
        nextState, stateChangedAt: new Date(STATE_CHANGED_AT)
      } as const));
      const projectEntitlement = vi.fn(async () => ({
        beforeActive: nextState !== 'active', afterActive: nextState === 'active'
      }));
      const loadNotification = vi.fn(async () => ({
        to: 'reader@example.com', soldAsTitle: 'Recovered & Accounted'
      }));
      const executors = createAdministrativeRecoveryExecutors({
        transitionGrant, projectEntitlement, loadNotification
      });
      const context = executorContext();
      const result = kind === 'administrative_recovery_activate'
        ? await executors.executeActivate(context, {
            kind, ...activateInput(), previewFingerprint: 'b'.repeat(64),
            confirmation: 'activate_persistent_recovery'
          })
        : await executors.executeDeactivate(context, {
            kind, recoveryGrantId: RECOVERY_GRANT_ID,
            recoveryReferenceId: ALLOCATION_ID, expectedStateChangedAt: STATE_CHANGED_AT,
            confirmation: 'deactivate_persistent_recovery'
          });
      expect(result).toEqual({ recoveryGrantId: RECOVERY_GRANT_ID,
        accessChanged: true, emailQueued: true });
      expect(projectEntitlement).toHaveBeenCalledWith(context.transaction,
        USER_ID, TITLE_ID, new Date(STATE_CHANGED_AT));
      expect(context.enqueueAccessChange).toHaveBeenCalledWith({
        template: 'commerce.administrative-recovery-access-changed',
        eventId: COMMAND_ID,
        to: 'reader@example.com',
        soldAsTitle: 'Recovered & Accounted',
        accessState: nextState,
        recoveryGrantId: RECOVERY_GRANT_ID,
        stateChangedAt: STATE_CHANGED_AT
      });
    });

  it('does not load recipient or enqueue when another grant preserves effective access', async () => {
    const transitionGrant = vi.fn(async () => ({
      recoveryGrantId: RECOVERY_GRANT_ID, recoveryUserId: USER_ID,
      recoveryTitleId: TITLE_ID, previousState: 'active' as const,
      nextState: 'revoked' as const, stateChangedAt: new Date(STATE_CHANGED_AT)
    }));
    const loadNotification = vi.fn();
    const executors = createAdministrativeRecoveryExecutors({
      transitionGrant,
      projectEntitlement: vi.fn(async () => ({ beforeActive: true, afterActive: true })),
      loadNotification
    });
    const context = executorContext();
    await expect(executors.executeDeactivate(context, {
      kind: 'administrative_recovery_deactivate', recoveryGrantId: RECOVERY_GRANT_ID,
      recoveryReferenceId: ALLOCATION_ID, expectedStateChangedAt: STATE_CHANGED_AT,
      confirmation: 'deactivate_persistent_recovery'
    })).resolves.toEqual({ recoveryGrantId: RECOVERY_GRANT_ID,
      accessChanged: false, emailQueued: false });
    expect(loadNotification).not.toHaveBeenCalled();
    expect(context.enqueueAccessChange).not.toHaveBeenCalled();
  });

  it.each([
    ['40001', 'administrative recovery state is stale',
      FinancialAdminConflictError, 'stale_state'],
    ['40001', 'administrative recovery projection_incomplete',
      FinancialAdminConflictError, 'stale_state'],
    ['55000', 'administrative recovery is not eligible', FinancialAdminConflictError,
      'not_eligible'],
    ['55000', 'invalid administrative recovery command', FinancialAdminPermanentError,
      'invalid_command'],
    ['55000', 'administrative recovery purchase graph is invalid',
      FinancialAdminPermanentError, 'command_failed'],
    ['42501', 'financial administrator capability is not current',
      FinancialAdminDeniedError, 'capability_revoked'],
    ['42501', 'administrative recovery transition is not permitted',
      FinancialAdminDeniedError, 'capability_revoked']
  ] as const)('maps protected routine %s / %s to the safe handler error',
    async (code, message, ErrorClass, safeCode) => {
      const executors = createAdministrativeRecoveryExecutors({
        transitionGrant: vi.fn(async () => {
          throw Object.assign(new Error(message), { code });
        }),
        projectEntitlement: vi.fn(),
        loadNotification: vi.fn()
      });
      await expect(executors.executeActivate(executorContext(), {
        kind: 'administrative_recovery_activate', ...activateInput(),
        previewFingerprint: 'b'.repeat(64), confirmation: 'activate_persistent_recovery'
      })).rejects.toEqual(expect.objectContaining({
        name: ErrorClass.name, safeCode
      }));
    });

  it('leaves an unrelated serialization failure retryable', async () => {
    const serializationFailure = Object.assign(
      new Error('could not serialize access due to concurrent update'),
      { code: '40001' }
    );
    const executors = createAdministrativeRecoveryExecutors({
      transitionGrant: vi.fn(async () => { throw serializationFailure; }),
      projectEntitlement: vi.fn(),
      loadNotification: vi.fn()
    });
    await expect(executors.executeActivate(executorContext(), {
      kind: 'administrative_recovery_activate', ...activateInput(),
      previewFingerprint: 'b'.repeat(64), confirmation: 'activate_persistent_recovery'
    })).rejects.toBe(serializationFailure);
  });

  it.each(['42501', '55000'] as const)(
    'rethrows an unrelated %s database failure', async (code) => {
      const databaseFailure = Object.assign(new Error('unrelated database failure'), { code });
      const executors = createAdministrativeRecoveryExecutors({
        transitionGrant: vi.fn(async () => { throw databaseFailure; }),
        projectEntitlement: vi.fn(),
        loadNotification: vi.fn()
      });
      await expect(executors.executeActivate(executorContext(), {
        kind: 'administrative_recovery_activate', ...activateInput(),
        previewFingerprint: 'b'.repeat(64), confirmation: 'activate_persistent_recovery'
      })).rejects.toBe(databaseFailure);
    });
});
