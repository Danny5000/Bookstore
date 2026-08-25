import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import type { FinancialAdminCommandExecutorContext } from
  '$lib/server/commerce/financial/admin-commands/handler';
import type { FinancialComponent } from '$lib/server/commerce/financial/types';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';

const collaborators = vi.hoisted(() => ({
  listRoles: vi.fn(),
  appendAudit: vi.fn(),
  loadAuthority: vi.fn(),
  lockAuthority: vi.fn(),
  lockOrder: vi.fn(),
  lockEnrollment: vi.fn(),
  lockFinancialRows: vi.fn(),
  lockPurchaseFacts: vi.fn(),
  planCorrection: vi.fn(),
  recomputeFinancial: vi.fn()
}));

vi.mock('$lib/server/auth/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/auth/identity')>()),
  listRolesForUser: collaborators.listRoles
}));
vi.mock('$lib/server/audit/service', () => ({ appendAuditEvent: collaborators.appendAudit }));
vi.mock('$lib/server/commerce/lock', () => ({ lockOrder: collaborators.lockOrder }));
vi.mock('$lib/server/commerce/financial/projection-authority', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('$lib/server/commerce/financial/projection-authority')
  >()),
  loadFinancialProjectionAuthority: collaborators.loadAuthority,
  lockFinancialProjectionAuthority: collaborators.lockAuthority,
  lockFinancialProjectionEnrollment: collaborators.lockEnrollment
}));
vi.mock('$lib/server/commerce/financial/locks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/commerce/financial/locks')>()),
  lockFinancialProjectionRows: collaborators.lockFinancialRows
}));
vi.mock('$lib/server/commerce/reconciliation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/commerce/reconciliation')>()),
  lockPaymentPurchaseFacts: collaborators.lockPurchaseFacts
}));
vi.mock('./correction-plan', () => ({
  planRefundReportingCorrection: collaborators.planCorrection
}));
vi.mock('$lib/server/commerce/financial/sources/refund', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/commerce/financial/sources/refund')>()),
  recomputeLockedRefundFinancialProjectionForReportingCorrectionCommand:
    collaborators.recomputeFinancial
}));

import {
  executeReportingCorrectionCreate,
  getReportingCorrectionSeed,
  previewReportingCorrection
} from './corrections';

const ADMIN_ID = '00000000-0000-4000-8000-000000013001';
const COMMAND_ID = '00000000-0000-4000-8000-000000013002';
const REFUND_ID = '00000000-0000-4000-8000-000000013003';
const SIBLING_REFUND_ID = '00000000-0000-4000-8000-000000013004';
const PAYMENT_ID = '00000000-0000-4000-8000-000000013005';
const ORDER_ID = '00000000-0000-4000-8000-000000013006';
const FIRST_ITEM_ID = '00000000-0000-4000-8000-000000013007';
const SECOND_ITEM_ID = '00000000-0000-4000-8000-000000013008';
const FIRST_TITLE_ID = '00000000-0000-4000-8000-000000013009';
const SECOND_TITLE_ID = '00000000-0000-4000-8000-000000013010';
const BALANCE_ID = '00000000-0000-4000-8000-000000013011';
const GROSS_SET_ID = '00000000-0000-4000-8000-000000013012';
const FEE_SET_ID = '00000000-0000-4000-8000-000000013013';
const RAW_TIP_ID = '00000000-0000-4000-8000-000000013014';
const NEW_CORRECTION_ID = '00000000-0000-4000-8000-000000013015';
const ALLOCATION_ID = '00000000-0000-4000-8000-000000013016';
const COMPONENT_ID = '00000000-0000-4000-8000-000000013017';
const PAYOUT_ID = '00000000-0000-4000-8000-000000013018';
const NOW = new Date('2026-08-22T12:00:00.000Z');
const FINGERPRINT = 'a'.repeat(64);
const PREVIEW_FINGERPRINT = 'b'.repeat(64);
const dialect = new PgDialect();

function rendered(statement: SQL): string {
  return dialect.sqlToQuery(statement).sql.replaceAll(/\s+/gu, ' ').trim();
}

function defaultState() {
  return {
    authority: {
      classifierVersion: 1,
      allocationAlgorithmVersion: 2,
      pendingClassifierVersion: null as number | null,
      pendingAllocationAlgorithmVersion: null as number | null,
      pendingReplayId: null as string | null,
      pendingScanRunId: null as string | null
    },
    planningRoot: {
      refundId: REFUND_ID,
      paymentId: PAYMENT_ID,
      orderId: ORDER_ID,
      stripeRefundId: 're_correction',
      refundStatus: 'succeeded' as const,
      allocationStatus: 'finalized' as const,
      financialEvidenceStatus: 'fee_reconciled' as const,
      amountMinor: 500,
      currency: 'USD',
      targetBalanceCount: 1,
      targetBalanceTransactionId: BALANCE_ID as string | null,
      grossBaseCount: 1,
      grossAllocationSetId: GROSS_SET_ID,
      feeBaseCount: 1,
      feeAllocationSetId: FEE_SET_ID as string | null,
      sourceFingerprint: FINGERPRINT,
      settlementCurrency: 'USD' as string | null,
      currentHeadCount: 2,
      currentReportingComplete: true,
      currentHeadIssueCodes: [] as string[],
      rawTipCount: 0,
      rawTipId: null as string | null,
      rawTipCorrectionVersion: null as number | null,
      rawTipBaseAllocationSetId: null as string | null,
      rawTipSourceFingerprint: null as string | null,
      compatibleTipCount: 0,
      compatibleTipHeadCount: 0,
      compatibleTipId: null as string | null,
      compatibleTipCorrectionVersion: null as number | null
    },
    planningItems: [
      {
        orderItemId: FIRST_ITEM_ID,
        titleId: FIRST_TITLE_ID,
        soldAsTitle: 'First title',
        paidSubtotalMinor: 540,
        paidTaxMinor: 60,
        paidTotalMinor: 600,
        effectiveSiblingSubtotalMinor: 90,
        effectiveSiblingTaxMinor: 10,
        immutablePresentmentSubtotalMinor: 450,
        immutablePresentmentTaxMinor: 50,
        immutableSettlementSubtotalMinor: -441 as number | null,
        immutableSettlementTaxMinor: -49 as number | null,
        immutableRefundFeeImpactMinor: -9 as number | null,
        compatiblePresentmentSubtotalMinor: null as number | null,
        compatiblePresentmentTaxMinor: null as number | null,
        compatibleSettlementSubtotalMinor: null as number | null,
        compatibleSettlementTaxMinor: null as number | null,
        compatibleRefundFeeImpactMinor: null as number | null
      },
      {
        orderItemId: SECOND_ITEM_ID,
        titleId: SECOND_TITLE_ID,
        soldAsTitle: 'Second title',
        paidSubtotalMinor: 360,
        paidTaxMinor: 40,
        paidTotalMinor: 400,
        effectiveSiblingSubtotalMinor: 0,
        effectiveSiblingTaxMinor: 0,
        immutablePresentmentSubtotalMinor: 0,
        immutablePresentmentTaxMinor: 0,
        immutableSettlementSubtotalMinor: 0 as number | null,
        immutableSettlementTaxMinor: 0 as number | null,
        immutableRefundFeeImpactMinor: 0 as number | null,
        compatiblePresentmentSubtotalMinor: null as number | null,
        compatiblePresentmentTaxMinor: null as number | null,
        compatibleSettlementSubtotalMinor: null as number | null,
        compatibleSettlementTaxMinor: null as number | null,
        compatibleRefundFeeImpactMinor: null as number | null
      }
    ],
    feeComponents: [{ component: 'refund_fee' as FinancialComponent,
      amountMinor: -9, currency: 'USD' }],
    sourceBalances: [{ id: BALANCE_ID, fingerprintSha256: FINGERPRINT }],
    payoutMemberships: [{ payoutId: PAYOUT_ID, expectedGeneration: 3,
      balanceTransactionId: BALANCE_ID }],
    selectedTips: [
      { id: GROSS_SET_ID, balanceTransactionId: BALANCE_ID,
        basis: 'gross_amount' as const, sourceFingerprintSha256: FINGERPRINT },
      { id: FEE_SET_ID, balanceTransactionId: BALANCE_ID,
        basis: 'fee' as const, sourceFingerprintSha256: FINGERPRINT }
    ],
    projectionHeads: [
      { balanceTransactionId: BALANCE_ID, basis: 'gross_amount' as const,
        baseSetId: GROSS_SET_ID, compatibleCorrectionTipId: null as string | null,
        isComplete: true, proposedIssueCode: null as string | null },
      { balanceTransactionId: BALANCE_ID, basis: 'fee' as const,
        baseSetId: FEE_SET_ID, compatibleCorrectionTipId: null as string | null,
        isComplete: true, proposedIssueCode: null as string | null }
    ],
    postHeads: [
      { basis: 'gross_amount' as const, rawTipCount: 1, rawTipId: NEW_CORRECTION_ID,
        baseSetId: GROSS_SET_ID, compatibleCorrectionTipId: NEW_CORRECTION_ID,
        isComplete: true },
      { basis: 'fee' as const, rawTipCount: 1, rawTipId: NEW_CORRECTION_ID,
        baseSetId: FEE_SET_ID, compatibleCorrectionTipId: NEW_CORRECTION_ID,
        isComplete: true }
    ]
  };
}

type TestState = ReturnType<typeof defaultState>;

function cloneState(): TestState {
  return structuredClone(defaultState());
}

function markerFor(statement: SQL): string {
  const text = rendered(statement);
  return /reporting-correction:([a-z-]+)/u.exec(text)?.[1] ??
    (text.includes('pale-orbit:user-roles:admin') ? 'role-lock' : 'other');
}

function fakeDatabase(state: TestState, events: string[] = []) {
  const execute = vi.fn(async (statement: SQL) => {
    const marker = markerFor(statement);
    events.push(marker);
    switch (marker) {
      case 'role-lock': return { rows: [] };
      case 'routing': return { rows: [{ paymentId: PAYMENT_ID, orderId: ORDER_ID }] };
      case 'locked-order': return { rows: [{ id: ORDER_ID, status: 'paid', currency: 'USD',
        totalMinor: 1000, paidAt: NOW }] };
      case 'locked-payment': return { rows: [{ id: PAYMENT_ID, orderId: ORDER_ID,
        status: 'succeeded', amountMinor: 1000, currency: 'USD', paidAt: NOW }] };
      case 'planning-root': return { rows: [state.planningRoot] };
      case 'planning-items': return { rows: state.planningItems };
      case 'fee-components': return { rows: state.feeComponents };
      case 'source-balances': return { rows: state.sourceBalances };
      case 'payout-memberships': return { rows: state.payoutMemberships };
      case 'selected-tips': return { rows: state.selectedTips };
      case 'projection-heads': return { rows: state.projectionHeads };
      case 'insert-set': return { rows: [{ id: NEW_CORRECTION_ID }] };
      case 'insert-item': return { rows: [{ id: NEW_CORRECTION_ID }] };
      case 'post-heads': return { rows: state.postHeads };
      default: return { rows: [] };
    }
  });
  const transaction = { execute } as unknown as DatabaseTransaction;
  Object.assign(transaction, { testAuthority: state.authority });
  const database = { transaction: vi.fn(async (
    work: (transaction: DatabaseTransaction) => Promise<unknown>
  ) => work(transaction)) } as unknown as Database;
  return { database, transaction, execute };
}

function purchaseFacts(state: TestState) {
  return {
    payment: { id: PAYMENT_ID, orderId: ORDER_ID, status: 'succeeded',
      amountMinor: 1000, currency: 'USD', paidAt: NOW },
    order: { id: ORDER_ID, status: 'paid', currency: 'USD', totalMinor: 1000, paidAt: NOW },
    refunds: [
      { id: REFUND_ID, paymentId: PAYMENT_ID, stripeRefundId: 're_correction',
        status: 'succeeded', amountMinor: 500, currency: 'USD', providerCreatedAt: NOW,
        allocationStatus: 'finalized', financialEvidenceStatus: 'fee_reconciled' },
      { id: SIBLING_REFUND_ID, paymentId: PAYMENT_ID, stripeRefundId: 're_sibling',
        status: 'succeeded', amountMinor: 100, currency: 'USD', providerCreatedAt: NOW,
        allocationStatus: 'finalized', financialEvidenceStatus: 'fee_reconciled' }
    ],
    refundDrafts: [], refundDraftItems: [],
    refundAllocations: [{ id: ALLOCATION_ID, refundId: REFUND_ID,
      orderItemId: FIRST_ITEM_ID, amountMinor: 500, source: 'administrative', createdAt: NOW }],
    refundComponents: [{ id: COMPONENT_ID, refundAllocationId: ALLOCATION_ID,
      refundId: REFUND_ID, orderItemId: FIRST_ITEM_ID, subtotalMinor: 450,
      taxMinor: 50, totalMinor: 500, currency: 'USD', createdAt: NOW }],
    correctionSets: state.planningRoot.rawTipId === null ? [] : [{
      id: state.planningRoot.rawTipId, refundId: REFUND_ID,
      correctionVersion: state.planningRoot.rawTipCorrectionVersion!,
      kind: 'allocation_attribution_correction',
      baseAllocationSetId: state.planningRoot.rawTipBaseAllocationSetId!,
      predecessorCorrectionSetId: null,
      sourceFingerprintSha256: state.planningRoot.rawTipSourceFingerprint!,
      approvedByAdminId: ADMIN_ID, createdByAdminId: ADMIN_ID,
      correlationId: 'prior-correction', createdAt: NOW
    }],
    correctionItems: [], disputes: [], disputeItemAllocations: [],
    orderItems: state.planningItems.map((item) => ({
      id: item.orderItemId, orderId: ORDER_ID, titleId: item.titleId,
      titleSnapshot: item.soldAsTitle, creatorNameSnapshot: 'Creator', format: 'prose',
      currency: 'USD', unitSubtotalMinor: item.paidSubtotalMinor,
      taxMinor: item.paidTaxMinor, totalMinor: item.paidTotalMinor,
      stripeLineItemId: null, createdAt: NOW
    }))
  };
}

function prepareInput() {
  return {
    refundId: REFUND_ID,
    reason: 'allocation_attribution_correction' as const,
    expectedNextCorrectionVersion: 1,
    expectedBaseAllocationSetId: GROSS_SET_ID,
    expectedSourceFingerprint: FINGERPRINT,
    items: [
      { orderItemId: FIRST_ITEM_ID, totalPresentmentMinor: 400 },
      { orderItemId: SECOND_ITEM_ID, totalPresentmentMinor: 100 }
    ]
  };
}

function readyPlan(state: TestState = defaultState()) {
  return {
    kind: 'ready' as const,
    preview: {
      refundId: REFUND_ID,
      expectedBaseAllocationSetId: GROSS_SET_ID,
      rawPredecessorCorrectionSetId: state.planningRoot.rawTipId,
      compatibleCorrectionSetId: state.planningRoot.compatibleTipId,
      expectedNextCorrectionVersion: state.planningRoot.rawTipCorrectionVersion === null
        ? 1 : state.planningRoot.rawTipCorrectionVersion + 1,
      expectedSourceFingerprint: FINGERPRINT,
      previewFingerprint: PREVIEW_FINGERPRINT,
      baselineKind: state.planningRoot.compatibleTipId === null
        ? 'immutable_base' as const : 'compatible_correction' as const,
      currentReportingComplete: state.planningRoot.currentReportingComplete,
      proposedReportingComplete: true,
      compatibilityRepair: !state.planningRoot.currentReportingComplete,
      currency: 'USD', settlementCurrency: 'USD', baselineTotalMinor: 500,
      proposedTotalMinor: 500, eligible: true, ineligibleReason: null,
      items: []
    },
    fingerprintDocument: { version: 'refund-reporting-correction-preview-v1' as const },
    persistableItems: [
      { domain: 'settlement' as const, sourceAllocationSetId: FEE_SET_ID,
        orderItemId: FIRST_ITEM_ID, component: 'refund_fee' as const,
        currency: 'USD', approvedAbsoluteMinor: -7, deltaMinor: 2,
        stableTieBreakKey: `settlement:fee:${FIRST_ITEM_ID}:refund_fee` },
      { domain: 'presentment' as const, sourceAllocationSetId: null,
        orderItemId: FIRST_ITEM_ID, component: 'refund_subtotal' as const,
        currency: 'USD', approvedAbsoluteMinor: 360, deltaMinor: -90,
        stableTieBreakKey: `presentment:${FIRST_ITEM_ID}:refund_subtotal` }
    ]
  };
}

function context(transaction: DatabaseTransaction): FinancialAdminCommandExecutorContext {
  return {
    transaction, commandId: COMMAND_ID,
    actor: { type: 'user', id: ADMIN_ID, roles: ['admin'] },
    correlationId: 'reporting-correction-command',
    signal: new AbortController().signal,
    enqueueAccessChange: vi.fn()
  };
}

function command(state: TestState = defaultState()) {
  const prepared = prepareInput();
  return {
    kind: 'refund_reporting_correction_create' as const,
    ...prepared,
    expectedNextCorrectionVersion: state.planningRoot.rawTipCorrectionVersion === null
      ? 1 : state.planningRoot.rawTipCorrectionVersion + 1,
    previewFingerprint: PREVIEW_FINGERPRINT,
    confirmation: 'create_reporting_correction' as const
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  collaborators.listRoles.mockResolvedValue(['admin']);
  const authority = async (transaction: unknown) =>
    (transaction as { testAuthority: TestState['authority'] }).testAuthority;
  collaborators.loadAuthority.mockImplementation(authority);
  collaborators.lockAuthority.mockImplementation(authority);
  collaborators.lockOrder.mockResolvedValue(undefined);
  collaborators.lockEnrollment.mockResolvedValue(undefined);
  collaborators.lockFinancialRows.mockResolvedValue({ payouts: [], balanceTransactions: [],
    memberships: [], classifications: [], feeDetailIds: [], allocationSetIds: [], issueIds: [] });
  collaborators.planCorrection.mockImplementation(() => readyPlan());
  collaborators.recomputeFinancial.mockResolvedValue({ status: 'unchanged',
    refundId: REFUND_ID, financialEvidenceStatus: 'fee_reconciled' });
  collaborators.appendAudit.mockResolvedValue({ id: 'audit' });
});

describe('reporting correction seed and preview', () => {
  it.each([
    ['seed without sales.read', 'seed', new Set(['reconciliation.manage'])],
    ['seed without reconciliation.manage', 'seed', new Set(['sales.read'])],
    ['preview without sales.read', 'preview', new Set(['reconciliation.manage'])],
    ['preview without reconciliation.manage', 'preview', new Set(['sales.read'])]
  ])('denies %s before parsing or database work', async (_label, operation, capabilities) => {
    const database = { transaction: vi.fn() } as unknown as Database;
    const actor: Actor = { type: 'user', id: 'not-an-id', roles: ['admin'] };
    const dependencies = { capabilityResolver: () => capabilities as never };
    const call = operation === 'seed'
      ? getReportingCorrectionSeed(database, actor, 'not-a-refund-id',
          { correlationId: 'seed-denied' }, dependencies)
      : previewReportingCorrection(database, actor, {
          ...prepareInput(), refundId: 'not-a-refund-id'
        }, { correlationId: 'preview-denied' }, dependencies);
    await expect(call).rejects.toMatchObject({ name: 'AuthorizationError', code: 'forbidden' });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('returns a distinct immutable-baseline seed while preserving incompatible raw history', async () => {
    const state = cloneState();
    state.planningRoot.currentReportingComplete = false;
    state.planningRoot.currentHeadIssueCodes = ['correction_rebase_required'];
    state.planningRoot.rawTipCount = 1;
    state.planningRoot.rawTipId = RAW_TIP_ID;
    state.planningRoot.rawTipCorrectionVersion = 4;
    state.planningRoot.rawTipBaseAllocationSetId =
      '00000000-0000-4000-8000-000000013099';
    state.planningRoot.rawTipSourceFingerprint = 'c'.repeat(64);
    for (const head of state.projectionHeads) {
      head.isComplete = false;
      head.proposedIssueCode = 'correction_rebase_required';
    }
    const fake = fakeDatabase(state);

    await expect(getReportingCorrectionSeed(fake.database,
      { type: 'user', id: ADMIN_ID, roles: ['admin'] }, REFUND_ID,
      { correlationId: 'seed-repair' }
    )).resolves.toMatchObject({
      refundId: REFUND_ID,
      expectedNextCorrectionVersion: 5,
      expectedBaseAllocationSetId: GROSS_SET_ID,
      expectedSourceFingerprint: FINGERPRINT,
      rawPredecessorCorrectionSetId: RAW_TIP_ID,
      compatibleCorrectionSetId: null,
      baselineKind: 'immutable_base',
      currentReportingComplete: false,
      baselineTotalMinor: 500,
      eligible: true,
      ineligibleReason: null,
      items: [
        expect.objectContaining({ orderItemId: FIRST_ITEM_ID, baselineTotalMinor: 500 }),
        expect.objectContaining({ orderItemId: SECOND_ITEM_ID, baselineTotalMinor: 0 })
      ]
    });
    expect(collaborators.planCorrection).not.toHaveBeenCalled();
  });

  it('fails the seed closed when active fee evidence has a nonrepresentable component', async () => {
    const state = cloneState();
    state.feeComponents = [
      { component: 'refund_fee', amountMinor: -8, currency: 'USD' },
      { component: 'provider_fee_tax', amountMinor: -1, currency: 'USD' }
    ];
    const fake = fakeDatabase(state);

    await expect(getReportingCorrectionSeed(fake.database,
      { type: 'user', id: ADMIN_ID, roles: ['admin'] }, REFUND_ID,
      { correlationId: 'seed-unsupported-fee' }
    )).resolves.toMatchObject({
      eligible: false,
      ineligibleReason: 'immutable_conflict',
      currentReportingComplete: true,
      expectedNextCorrectionVersion: null,
      expectedBaseAllocationSetId: null,
      expectedSourceFingerprint: null,
      items: []
    });
  });

  it('preserves current completeness in an ineligible preview', async () => {
    const state = cloneState();
    state.feeComponents = [
      { component: 'refund_fee', amountMinor: -8, currency: 'USD' },
      { component: 'provider_fee_tax', amountMinor: -1, currency: 'USD' }
    ];
    const fake = fakeDatabase(state);

    await expect(previewReportingCorrection(fake.database,
      { type: 'user', id: ADMIN_ID, roles: ['admin'] }, prepareInput(),
      { correlationId: 'preview-unsupported-fee' }
    )).resolves.toMatchObject({
      eligible: false,
      ineligibleReason: 'immutable_conflict',
      currentReportingComplete: true,
      proposedReportingComplete: false,
      previewFingerprint: null,
      items: []
    });
    expect(collaborators.planCorrection).not.toHaveBeenCalled();
  });

  it('authorizes again under the role lock and sends canonical facts to the shared planner', async () => {
    const state = cloneState();
    const fake = fakeDatabase(state);
    collaborators.planCorrection.mockReturnValue(readyPlan(state));

    await expect(previewReportingCorrection(fake.database,
      { type: 'user', id: ADMIN_ID, roles: ['admin'] }, prepareInput(),
      { correlationId: 'preview-correction' }
    )).resolves.toMatchObject({ previewFingerprint: PREVIEW_FINGERPRINT, eligible: true });

    expect(collaborators.planCorrection).toHaveBeenCalledWith(expect.objectContaining({
      request: prepareInput(),
      activeProjection: { classifierVersion: 1, allocationAlgorithmVersion: 2,
        replayId: 'c1-a2' },
      rawTip: null,
      compatibleTip: null,
      immutableBase: expect.objectContaining({
        grossAllocationSetId: GROSS_SET_ID,
        feeAllocationSetId: FEE_SET_ID,
        sourceFingerprint: FINGERPRINT
      }),
      items: state.planningItems
    }));
    expect(collaborators.listRoles).toHaveBeenCalledWith(fake.transaction, ADMIN_ID);
  });

  it('maps stale version, immutable base, and fingerprint bindings before calling the planner', async () => {
    for (const mutation of [
      { expectedNextCorrectionVersion: 2 },
      { expectedBaseAllocationSetId: '00000000-0000-4000-8000-000000013098' },
      { expectedSourceFingerprint: 'd'.repeat(64) }
    ]) {
      const fake = fakeDatabase(cloneState());
      collaborators.planCorrection.mockClear();
      await expect(previewReportingCorrection(fake.database,
        { type: 'user', id: ADMIN_ID, roles: ['admin'] },
        { ...prepareInput(), ...mutation },
        { correlationId: 'preview-stale-binding' }
      )).rejects.toMatchObject({ safeCode: 'stale_state' });
      expect(collaborators.planCorrection).not.toHaveBeenCalled();
    }
  });

  it('maps a stale current item membership to stale_state before calling the planner', async () => {
    const fake = fakeDatabase(cloneState());

    await expect(previewReportingCorrection(fake.database,
      { type: 'user', id: ADMIN_ID, roles: ['admin'] },
      { ...prepareInput(), items: [prepareInput().items[0]!] },
      { correlationId: 'preview-stale-membership' }
    )).rejects.toMatchObject({ safeCode: 'stale_state' });

    expect(collaborators.planCorrection).not.toHaveBeenCalled();
  });
});

describe('reporting correction executor', () => {
  it('uses the canonical locks, appends a sorted successor, recomputes, verifies, and audits', async () => {
    const state = cloneState();
    state.planningRoot.currentReportingComplete = false;
    state.planningRoot.currentHeadIssueCodes = ['correction_rebase_required'];
    state.planningRoot.rawTipCount = 1;
    state.planningRoot.rawTipId = RAW_TIP_ID;
    state.planningRoot.rawTipCorrectionVersion = 4;
    state.planningRoot.rawTipBaseAllocationSetId =
      '00000000-0000-4000-8000-000000013099';
    state.planningRoot.rawTipSourceFingerprint = 'c'.repeat(64);
    for (const head of state.projectionHeads) {
      head.isComplete = false;
      head.proposedIssueCode = 'correction_rebase_required';
    }
    const events: string[] = [];
    const fake = fakeDatabase(state, events);
    collaborators.lockAuthority.mockImplementation(async () => {
      events.push('projection-authority'); return state.authority;
    });
    collaborators.lockOrder.mockImplementation(async () => { events.push('order-advisory'); });
    collaborators.lockPurchaseFacts.mockImplementation(async () => {
      events.push('purchase-graph'); return purchaseFacts(state);
    });
    collaborators.lockEnrollment.mockImplementation(async () => { events.push('enrollment'); });
    collaborators.lockFinancialRows.mockImplementation(async () => {
      events.push('financial-closure'); return { payouts: [], balanceTransactions: [],
        memberships: [], classifications: [], feeDetailIds: [], allocationSetIds: [], issueIds: [] };
    });
    collaborators.planCorrection.mockReturnValue(readyPlan(state));
    collaborators.recomputeFinancial.mockImplementation(async () => {
      events.push('financial-recompute'); return { status: 'unchanged', refundId: REFUND_ID,
        financialEvidenceStatus: 'fee_reconciled' };
    });
    collaborators.appendAudit.mockImplementation(async () => {
      events.push('audit'); return { id: 'audit' };
    });
    const executorContext = context(fake.transaction);

    await expect(executeReportingCorrectionCreate(
      executorContext,
      command(state)
    )).resolves.toEqual({
      refundId: REFUND_ID,
      correctionSetId: NEW_CORRECTION_ID,
      correctionVersion: 5
    });

    expect(events.indexOf('projection-authority')).toBeLessThan(events.indexOf('order-advisory'));
    expect(events.indexOf('order-advisory')).toBeLessThan(events.indexOf('purchase-graph'));
    expect(events.indexOf('purchase-graph')).toBeLessThan(events.indexOf('enrollment'));
    expect(events.indexOf('enrollment')).toBeLessThan(events.indexOf('financial-closure'));
    expect(events.indexOf('financial-closure')).toBeLessThan(events.indexOf('insert-set'));
    expect(events.indexOf('insert-set')).toBeLessThan(events.indexOf('insert-item'));
    expect(events.indexOf('insert-item')).toBeLessThan(events.indexOf('financial-recompute'));
    expect(events.indexOf('financial-recompute')).toBeLessThan(events.indexOf('post-heads'));
    expect(events.indexOf('post-heads')).toBeLessThan(events.indexOf('audit'));
    expect(collaborators.lockFinancialRows).toHaveBeenCalledWith(fake.transaction,
      expect.objectContaining({
        payoutGenerations: [{ payoutId: PAYOUT_ID, expectedGeneration: 3 }],
        balanceTransactionIds: [BALANCE_ID],
        classifierVersion: 1,
        issueKeys: expect.arrayContaining([
          expect.objectContaining({ resourceType: 'refund', resourceId: REFUND_ID }),
          expect.objectContaining({ resourceType: 'allocation_set', resourceId: GROSS_SET_ID }),
          expect.objectContaining({ resourceType: 'allocation_set', resourceId: FEE_SET_ID })
        ])
      }));
    const insertSet = fake.execute.mock.calls.find(([statement]) =>
      markerFor(statement) === 'insert-set');
    expect(insertSet).toBeDefined();
    expect(dialect.sqlToQuery(insertSet![0]).params).toEqual(expect.arrayContaining([
      REFUND_ID, 5, GROSS_SET_ID, RAW_TIP_ID, FINGERPRINT, ADMIN_ID,
      'reporting-correction-command'
    ]));
    const insertedTieKeys = fake.execute.mock.calls
      .filter(([statement]) => markerFor(statement) === 'insert-item')
      .map(([statement]) => dialect.sqlToQuery(statement).params.at(-1));
    expect(insertedTieKeys).toEqual([
      `presentment:${FIRST_ITEM_ID}:refund_subtotal`,
      `settlement:fee:${FIRST_ITEM_ID}:refund_fee`
    ]);
    expect(collaborators.recomputeFinancial).toHaveBeenCalledWith(fake.transaction,
      expect.objectContaining({ refundId: REFUND_ID, allocationStatus: 'finalized' }),
      [FEE_SET_ID, GROSS_SET_ID].sort(), COMMAND_ID);
    expect(executorContext.enqueueAccessChange).not.toHaveBeenCalled();
    expect(collaborators.appendAudit).toHaveBeenCalledWith(fake.transaction,
      expect.objectContaining({ action: 'financial.refund_correction.created',
        resourceType: 'refund_reporting_correction_set',
        resourceId: NEW_CORRECTION_ID,
        after: expect.objectContaining({ correctionVersion: 5 }) }));
  });

  it('rejects a stale fingerprint before appending history', async () => {
    const state = cloneState();
    const fake = fakeDatabase(state);
    collaborators.lockPurchaseFacts.mockResolvedValue(purchaseFacts(state));
    collaborators.planCorrection.mockReturnValue(readyPlan(state));

    await expect(executeReportingCorrectionCreate(context(fake.transaction), {
      ...command(state), previewFingerprint: 'c'.repeat(64)
    })).rejects.toMatchObject({ safeCode: 'stale_state' });

    expect(fake.execute.mock.calls.some(([statement]) => markerFor(statement) === 'insert-set'))
      .toBe(false);
    expect(collaborators.recomputeFinancial).not.toHaveBeenCalled();
  });

  it('rejects a locked financial base that differs from the planning snapshot', async () => {
    const state = cloneState();
    state.selectedTips = state.selectedTips.filter((tip) => tip.basis !== 'fee');
    const fake = fakeDatabase(state);
    collaborators.lockPurchaseFacts.mockResolvedValue(purchaseFacts(state));

    await expect(executeReportingCorrectionCreate(
      context(fake.transaction), command(state)
    )).rejects.toMatchObject({ safeCode: 'stale_state' });
    expect(collaborators.planCorrection).not.toHaveBeenCalled();
    expect(fake.execute.mock.calls.some(([statement]) => markerFor(statement) === 'insert-set'))
      .toBe(false);
  });

  it('maps an already-complete equivalent locked plan to not_eligible', async () => {
    const state = cloneState();
    const fake = fakeDatabase(state);
    collaborators.lockPurchaseFacts.mockResolvedValue(purchaseFacts(state));
    collaborators.planCorrection.mockReturnValue({
      kind: 'ineligible',
      preview: { ...readyPlan(state).preview, previewFingerprint: null,
        eligible: false, ineligibleReason: 'no_change' },
      fingerprintDocument: null,
      persistableItems: []
    });

    await expect(executeReportingCorrectionCreate(
      context(fake.transaction), command(state)
    )).rejects.toMatchObject({ safeCode: 'not_eligible' });
    expect(fake.execute.mock.calls.some(([statement]) => markerFor(statement) === 'insert-set'))
      .toBe(false);
  });

  it('maps locked capacity or evidence drift from a formerly ready plan to stale_state', async () => {
    const state = cloneState();
    const fake = fakeDatabase(state);
    collaborators.lockPurchaseFacts.mockResolvedValue(purchaseFacts(state));
    collaborators.planCorrection.mockReturnValue({
      kind: 'ineligible',
      preview: { ...readyPlan(state).preview, previewFingerprint: null,
        eligible: false, ineligibleReason: 'immutable_conflict' },
      fingerprintDocument: null,
      persistableItems: []
    });

    await expect(executeReportingCorrectionCreate(
      context(fake.transaction), command(state)
    )).rejects.toMatchObject({ safeCode: 'stale_state' });
    expect(fake.execute.mock.calls.some(([statement]) => markerFor(statement) === 'insert-set'))
      .toBe(false);
  });

  it('rejects stale command bindings before re-planning or appending history', async () => {
    const state = cloneState();
    const fake = fakeDatabase(state);
    collaborators.lockPurchaseFacts.mockResolvedValue(purchaseFacts(state));

    await expect(executeReportingCorrectionCreate(context(fake.transaction), {
      ...command(state), expectedNextCorrectionVersion: 2
    })).rejects.toMatchObject({ safeCode: 'stale_state' });

    expect(collaborators.planCorrection).not.toHaveBeenCalled();
    expect(fake.execute.mock.calls.some(([statement]) => markerFor(statement) === 'insert-set'))
      .toBe(false);
  });

  it('rejects stale command item membership before re-planning or appending history', async () => {
    const state = cloneState();
    const fake = fakeDatabase(state);
    collaborators.lockPurchaseFacts.mockResolvedValue(purchaseFacts(state));

    await expect(executeReportingCorrectionCreate(context(fake.transaction), {
      ...command(state), items: [command(state).items[0]!]
    })).rejects.toMatchObject({ safeCode: 'stale_state' });

    expect(collaborators.planCorrection).not.toHaveBeenCalled();
    expect(fake.execute.mock.calls.some(([statement]) => markerFor(statement) === 'insert-set'))
      .toBe(false);
  });

  it('prioritizes stale bindings when the same drift also makes reporting ineligible', async () => {
    const state = cloneState();
    const driftedFingerprint = 'd'.repeat(64);
    state.planningRoot.sourceFingerprint = driftedFingerprint;
    state.planningRoot.currentReportingComplete = false;
    state.planningRoot.currentHeadIssueCodes = ['immutable_mismatch'];
    state.sourceBalances[0]!.fingerprintSha256 = driftedFingerprint;
    for (const tip of state.selectedTips) tip.sourceFingerprintSha256 = driftedFingerprint;
    for (const head of state.projectionHeads) {
      head.isComplete = false;
      head.proposedIssueCode = 'immutable_mismatch';
    }
    const fake = fakeDatabase(state);
    collaborators.lockPurchaseFacts.mockResolvedValue(purchaseFacts(state));

    await expect(executeReportingCorrectionCreate(
      context(fake.transaction), command(state)
    )).rejects.toMatchObject({ safeCode: 'stale_state' });
    expect(collaborators.planCorrection).not.toHaveBeenCalled();
  });

  it('rejects malformed direct commands before discovery', async () => {
    const fake = fakeDatabase(cloneState());
    await expect(executeReportingCorrectionCreate(context(fake.transaction), {
      ...command(), previewFingerprint: 'invalid'
    })).rejects.toMatchObject({ safeCode: 'invalid_command' });
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('fails closed when post-resolution heads do not expose the inserted raw tip', async () => {
    const state = cloneState();
    state.postHeads[0]!.compatibleCorrectionTipId = RAW_TIP_ID;
    const fake = fakeDatabase(state);
    collaborators.lockPurchaseFacts.mockResolvedValue(purchaseFacts(state));
    collaborators.planCorrection.mockReturnValue(readyPlan(state));

    await expect(executeReportingCorrectionCreate(
      context(fake.transaction), command(state)
    )).rejects.toMatchObject({ safeCode: 'command_failed' });
    expect(collaborators.appendAudit).not.toHaveBeenCalled();
  });

  it('fails closed when post-resolution raw topology is forked', async () => {
    const state = cloneState();
    state.postHeads[0]!.rawTipCount = 2;
    state.postHeads[1]!.rawTipCount = 2;
    const fake = fakeDatabase(state);
    collaborators.lockPurchaseFacts.mockResolvedValue(purchaseFacts(state));
    collaborators.planCorrection.mockReturnValue(readyPlan(state));

    await expect(executeReportingCorrectionCreate(
      context(fake.transaction), command(state)
    )).rejects.toMatchObject({ safeCode: 'command_failed' });
    expect(collaborators.appendAudit).not.toHaveBeenCalled();
  });

  it.each(['financial-recompute', 'audit'])(
    'surfaces a %s failure for handler-transaction rollback',
    async (seam) => {
      const state = cloneState();
      const fake = fakeDatabase(state);
      collaborators.lockPurchaseFacts.mockResolvedValue(purchaseFacts(state));
      collaborators.planCorrection.mockReturnValue(readyPlan(state));
      const message = `${seam} rollback witness`;
      if (seam === 'financial-recompute') {
        collaborators.recomputeFinancial.mockRejectedValueOnce(new Error(message));
      } else {
        collaborators.appendAudit.mockRejectedValueOnce(new Error(message));
      }

      await expect(executeReportingCorrectionCreate(
        context(fake.transaction), command(state)
      )).rejects.toThrow(message);
    }
  );
});
