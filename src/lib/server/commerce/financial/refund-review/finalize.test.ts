import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import type { FinancialAdminCommandExecutorContext } from '$lib/server/commerce/financial/admin-commands/handler';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';

const collaborators = vi.hoisted(() => ({
  listRoles: vi.fn(), appendAudit: vi.fn(), lockOrder: vi.fn(),
  loadAuthority: vi.fn(), lockAuthority: vi.fn(), lockEnrollment: vi.fn(),
  lockFinancialRows: vi.fn(), lockPurchaseFacts: vi.fn(), lockEntitlementFacts: vi.fn(),
  recomputeAccess: vi.fn(), projectEntitlement: vi.fn(), recomputeFinancial: vi.fn()
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
  lockPaymentPurchaseFacts: collaborators.lockPurchaseFacts,
  lockPaymentEntitlementFacts: collaborators.lockEntitlementFacts
}));
vi.mock('$lib/server/commerce/refund-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/commerce/refund-access')>()),
  recomputeRefundPurchaseAccess: collaborators.recomputeAccess
}));
vi.mock('$lib/server/commerce/grants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/commerce/grants')>()),
  projectEffectiveEntitlement: collaborators.projectEntitlement
}));
vi.mock('$lib/server/commerce/financial/sources/refund', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/commerce/financial/sources/refund')>()),
  recomputeLockedRefundFinancialProjectionForAdminCommand: collaborators.recomputeFinancial
}));

import { executeRefundAllocationFinalize, previewRefundFinalization } from './finalize';

const ADMIN_ID = '00000000-0000-4000-8000-000000012001';
const COMMAND_ID = '00000000-0000-4000-8000-000000012002';
const REFUND_ID = '00000000-0000-4000-8000-000000012003';
const SIBLING_REFUND_ID = '00000000-0000-4000-8000-000000012004';
const PAYMENT_ID = '00000000-0000-4000-8000-000000012005';
const ORDER_ID = '00000000-0000-4000-8000-000000012006';
const FIRST_ITEM_ID = '00000000-0000-4000-8000-000000012007';
const SECOND_ITEM_ID = '00000000-0000-4000-8000-000000012008';
const FIRST_TITLE_ID = '00000000-0000-4000-8000-000000012009';
const SECOND_TITLE_ID = '00000000-0000-4000-8000-000000012010';
const DRAFT_ID = '00000000-0000-4000-8000-000000012011';
const FIRST_DRAFT_ITEM_ID = '00000000-0000-4000-8000-000000012012';
const SECOND_DRAFT_ITEM_ID = '00000000-0000-4000-8000-000000012013';
const EXISTING_ALLOCATION_ID = '00000000-0000-4000-8000-000000012014';
const EXISTING_COMPONENT_ID = '00000000-0000-4000-8000-000000012015';
const FIRST_GRANT_ID = '00000000-0000-4000-8000-000000012016';
const SECOND_GRANT_ID = '00000000-0000-4000-8000-000000012017';
const USER_ID = '00000000-0000-4000-8000-000000012018';
const GUEST_ID = '00000000-0000-4000-8000-000000012019';
const BALANCE_ID = '00000000-0000-4000-8000-000000012020';
const SELECTED_SET_ID = '00000000-0000-4000-8000-000000012021';
const NEW_ALLOCATION_ID = '00000000-0000-4000-8000-000000012022';
const NEW_COMPONENT_ID = '00000000-0000-4000-8000-000000012023';
const EFFECT_ID = '00000000-0000-4000-8000-000000012024';
const PRESERVED_GRANT_ID = '00000000-0000-4000-8000-000000012025';
const CORRECTION_ID = '00000000-0000-4000-8000-000000012026';
const NOW = new Date('2026-08-22T10:00:00.000Z');
const TARGET_TIME = new Date('2026-08-21T10:00:00.000Z');
const SIBLING_TIME = new Date('2026-08-20T10:00:00.000Z');
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);
const dialect = new PgDialect();

function rendered(statement: SQL): string {
  return dialect.sqlToQuery(statement).sql.replaceAll(/\s+/gu, ' ').trim();
}

function defaultState() {
  const firstGrant = {
    id: FIRST_GRANT_ID, titleId: FIRST_TITLE_ID, userId: USER_ID as string | null,
    source: 'purchase' as const, orderItemId: FIRST_ITEM_ID,
    recoveryRefundAllocationId: null, state: 'active' as
      'unclaimed' | 'active' | 'suspended' | 'revoked',
    stateReason: 'payment_succeeded', grantedAt: NOW, suspendedAt: null as Date | null,
    revokedAt: null as Date | null, updatedAt: NOW
  };
  const secondGrant = {
    id: SECOND_GRANT_ID, titleId: SECOND_TITLE_ID, userId: USER_ID as string | null,
    source: 'purchase' as const, orderItemId: SECOND_ITEM_ID,
    recoveryRefundAllocationId: null, state: 'active' as
      'unclaimed' | 'active' | 'suspended' | 'revoked',
    stateReason: 'payment_succeeded', grantedAt: NOW, suspendedAt: null as Date | null,
    revokedAt: null as Date | null, updatedAt: NOW
  };
  return {
    authority: {
      classifierVersion: 1, allocationAlgorithmVersion: 2,
      pendingClassifierVersion: null as number | null,
      pendingAllocationAlgorithmVersion: null as number | null,
      pendingReplayId: null as string | null, pendingScanRunId: null as string | null
    },
    root: {
      refundId: REFUND_ID, refundPaymentId: PAYMENT_ID, stripeRefundId: 're_target',
      refundStatus: 'succeeded' as const, refundAmountMinor: 500, refundCurrency: 'USD',
      refundProviderCreatedAt: TARGET_TIME, refundAllocationStatus: 'draft' as
        'not_applicable' | 'needs_review' | 'draft' | 'finalized' | 'exception',
      refundFinancialEvidenceStatus: 'pending' as const, paymentId: PAYMENT_ID,
      paymentOrderId: ORDER_ID, stripePaymentIntentId: 'pi_target',
      paymentStatus: 'succeeded' as const, paymentAmountMinor: 1000,
      paymentCurrency: 'USD', paymentPaidAt: NOW,
      paymentFinancialEvidenceStatus: 'fee_reconciled' as const, orderId: ORDER_ID,
      orderStatus: 'paid' as const, orderInitiatingUserId: null as string | null,
      orderGuestIdentityId: GUEST_ID as string | null, orderCurrency: 'USD',
      orderSubtotalMinor: 900, orderTaxMinor: 100 as number | null,
      orderTotalMinor: 1000 as number | null, orderPaidAt: NOW as Date | null
    },
    items: [
      { id: FIRST_ITEM_ID, orderId: ORDER_ID, titleId: FIRST_TITLE_ID,
        titleSnapshot: 'First title', creatorNameSnapshot: 'First creator',
        format: 'prose' as const, currency: 'USD', unitSubtotalMinor: 540,
        taxMinor: 60 as number | null, totalMinor: 600 as number | null, createdAt: NOW },
      { id: SECOND_ITEM_ID, orderId: ORDER_ID, titleId: SECOND_TITLE_ID,
        titleSnapshot: 'Second title', creatorNameSnapshot: 'Second creator',
        format: 'comic' as const, currency: 'USD', unitSubtotalMinor: 360,
        taxMinor: 40 as number | null, totalMinor: 400 as number | null, createdAt: NOW }
    ],
    refunds: [
      { id: REFUND_ID, paymentId: PAYMENT_ID, stripeRefundId: 're_target',
        status: 'succeeded' as const, amountMinor: 500, currency: 'USD',
        providerCreatedAt: TARGET_TIME, allocationStatus: 'draft' as
          'not_applicable' | 'needs_review' | 'draft' | 'finalized' | 'exception',
        financialEvidenceStatus: 'pending' as const },
      { id: SIBLING_REFUND_ID, paymentId: PAYMENT_ID, stripeRefundId: 're_sibling',
        status: 'succeeded' as const, amountMinor: 100, currency: 'USD',
        providerCreatedAt: SIBLING_TIME, allocationStatus: 'finalized' as
          'not_applicable' | 'needs_review' | 'draft' | 'finalized' | 'exception',
        financialEvidenceStatus: 'fee_reconciled' as const }
    ],
    drafts: [{ id: DRAFT_ID, refundId: REFUND_ID, state: 'active' as
      'active' | 'finalized' | 'discarded',
      version: 2, updatedCorrelationId: 'draft-updated', updatedAt: NOW }],
    draftItems: [
      { id: FIRST_DRAFT_ITEM_ID, draftId: DRAFT_ID, orderItemId: FIRST_ITEM_ID,
        proposedTotalPresentmentMinor: 500, updatedAt: NOW },
      { id: SECOND_DRAFT_ITEM_ID, draftId: DRAFT_ID, orderItemId: SECOND_ITEM_ID,
        proposedTotalPresentmentMinor: 0, updatedAt: NOW }
    ],
    allocations: [{ id: EXISTING_ALLOCATION_ID, refundId: SIBLING_REFUND_ID,
      orderItemId: FIRST_ITEM_ID, amountMinor: 100, source: 'automatic' as const,
      createdAt: NOW }],
    components: [{ id: EXISTING_COMPONENT_ID, refundAllocationId: EXISTING_ALLOCATION_ID,
      refundId: SIBLING_REFUND_ID, orderItemId: FIRST_ITEM_ID, subtotalMinor: 90,
      taxMinor: 10, totalMinor: 100, currency: 'USD', createdAt: NOW }],
    correctionSets: [] as Array<Record<string, unknown>>,
    correctionItems: [] as Array<Record<string, unknown>>,
    purchaseGrants: [firstGrant, secondGrant],
    scopeGrants: [firstGrant, secondGrant] as Array<Record<string, unknown>>,
    scopeStates: [
      { userId: USER_ID, titleId: FIRST_TITLE_ID, active: true },
      { userId: USER_ID, titleId: SECOND_TITLE_ID, active: true }
    ],
    recipients: [{ userId: USER_ID, email: 'reader@example.com', emailVerified: true }],
    sourceBalances: [{ id: BALANCE_ID, fingerprintSha256: FINGERPRINT_A }],
    payoutMemberships: [] as Array<Record<string, unknown>>,
    selectedTips: [{ id: SELECTED_SET_ID, balanceTransactionId: BALANCE_ID,
      basis: 'gross_amount' as const, sourceFingerprintSha256: FINGERPRINT_A }],
    projectionHeads: [{ balanceTransactionId: BALANCE_ID,
      basis: 'gross_amount' as const, baseSetId: SELECTED_SET_ID,
      compatibleCorrectionTipId: null as string | null, isComplete: false,
      missingSourceCount: 1, proposedIssueCode: 'allocation_incomplete' as string | null }],
    afterGrantStates: [{ id: FIRST_GRANT_ID, state: 'revoked' as const }]
  };
}

type TestState = ReturnType<typeof defaultState>;

function fakeDatabase(state: TestState, events: string[] = []) {
  const execute = vi.fn(async (statement: SQL) => {
    const text = rendered(statement);
    const marker = /refund-finalization:([a-z-]+)/u.exec(text)?.[1] ??
      (text.includes('pale-orbit:user-roles:admin') ? 'role-lock' : 'other');
    events.push(marker);
    switch (marker) {
      case 'role-lock': return { rows: [] };
      case 'routing': return { rows: [{ paymentId: PAYMENT_ID, orderId: ORDER_ID }] };
      case 'preview-root': return { rows: [state.root] };
      case 'preview-items': return { rows: state.items };
      case 'preview-refunds': return { rows: state.refunds };
      case 'preview-drafts': return { rows: state.drafts };
      case 'preview-draft-items': return { rows: state.draftItems };
      case 'preview-allocations': return { rows: state.allocations };
      case 'preview-components': return { rows: state.components };
      case 'preview-correction-sets': return { rows: state.correctionSets };
      case 'preview-correction-items': return { rows: state.correctionItems };
      case 'preview-purchase-grants': return { rows: state.purchaseGrants };
      case 'scope-grants': return { rows: state.scopeGrants };
      case 'scope-states': return { rows: state.scopeStates };
      case 'recipients': return { rows: state.recipients };
      case 'source-balances': return { rows: state.sourceBalances };
      case 'payout-memberships': return { rows: state.payoutMemberships };
      case 'selected-tips': return { rows: state.selectedTips };
      case 'projection-heads': return { rows: state.projectionHeads };
      case 'locked-order': return { rows: [{ id: ORDER_ID, status: state.root.orderStatus,
        initiatingUserId: state.root.orderInitiatingUserId,
        guestIdentityId: state.root.orderGuestIdentityId, currency: state.root.orderCurrency,
        subtotalMinor: state.root.orderSubtotalMinor, taxMinor: state.root.orderTaxMinor,
        totalMinor: state.root.orderTotalMinor, paidAt: state.root.orderPaidAt }] };
      case 'locked-payment': return { rows: [{ id: PAYMENT_ID, orderId: ORDER_ID,
        stripePaymentIntentId: state.root.stripePaymentIntentId,
        status: state.root.paymentStatus, amountMinor: state.root.paymentAmountMinor,
        currency: state.root.paymentCurrency, paidAt: state.root.paymentPaidAt,
        financialEvidenceStatus: state.root.paymentFinancialEvidenceStatus }] };
      case 'insert-allocation': return { rows: [{ id: NEW_ALLOCATION_ID }] };
      case 'insert-component': return { rows: [{ id: NEW_COMPONENT_ID }] };
      case 'freeze-draft': return { rows: [{ id: DRAFT_ID, version: 3 }] };
      case 'finalize-refund': return { rows: [{ id: REFUND_ID }] };
      case 'grant-after-states': return { rows: state.afterGrantStates };
      case 'insert-effect': return { rows: [{ id: EFFECT_ID }] };
      default: return { rows: [] };
    }
  });
  const transaction = { execute } as unknown as DatabaseTransaction;
  Object.assign(transaction, { testAuthority: state.authority });
  const database = { transaction: vi.fn(async (
    work: (tx: DatabaseTransaction) => Promise<unknown>
  ) => work(transaction)) } as unknown as Database;
  return { database, transaction, execute };
}

function cloneState(): TestState {
  return structuredClone(defaultState());
}

function preview(state: TestState, expectedVersion = state.drafts[0]?.version ?? 2) {
  const fake = fakeDatabase(state);
  return previewRefundFinalization(fake.database,
    { type: 'user', id: ADMIN_ID, roles: ['admin'] },
    { refundId: REFUND_ID, expectedActiveDraftVersion: expectedVersion },
    { correlationId: 'preview-refund-finalization' });
}

function purchaseFacts(state: TestState) {
  return {
    payment: { id: PAYMENT_ID, orderId: ORDER_ID,
      stripePaymentIntentId: state.root.stripePaymentIntentId,
      status: state.root.paymentStatus, amountMinor: state.root.paymentAmountMinor,
      currency: state.root.paymentCurrency, paidAt: state.root.paymentPaidAt,
      financialEvidenceStatus: state.root.paymentFinancialEvidenceStatus },
    order: { id: ORDER_ID, status: state.root.orderStatus,
      initiatingUserId: state.root.orderInitiatingUserId,
      guestIdentityId: state.root.orderGuestIdentityId, currency: state.root.orderCurrency,
      subtotalMinor: state.root.orderSubtotalMinor, taxMinor: state.root.orderTaxMinor,
      totalMinor: state.root.orderTotalMinor, paidAt: state.root.orderPaidAt },
    refunds: state.refunds, refundDrafts: state.drafts, refundDraftItems: state.draftItems,
    refundAllocations: state.allocations, refundComponents: state.components,
    correctionSets: state.correctionSets, correctionItems: state.correctionItems,
    disputes: [], disputeItemAllocations: [], orderItems: state.items
  };
}

function executorContext(transaction: DatabaseTransaction, events: string[]) {
  const enqueueAccessChange = vi.fn(async () => { events.push('email'); });
  return { transaction, commandId: COMMAND_ID,
    actor: { type: 'user' as const, id: ADMIN_ID, roles: ['admin'] as const },
    correlationId: 'finalize-command', signal: new AbortController().signal,
    enqueueAccessChange } satisfies FinancialAdminCommandExecutorContext;
}

async function executeState(state: TestState, events: string[] = []) {
  const prepared = await preview(state);
  const fake = fakeDatabase(state, events);
  const facts = purchaseFacts(state);
  collaborators.lockPurchaseFacts.mockImplementation(async () => {
    events.push('purchase-graph'); return facts;
  });
  const affected = [...new Map([...state.purchaseGrants, ...state.scopeGrants]
    .map((grant) => [String(grant.id), grant])).values()]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  collaborators.lockEntitlementFacts.mockImplementation(async () => {
    events.push('entitlement-graph');
    return { ...facts, grants: state.purchaseGrants, affectedScopeGrants: affected };
  });
  const context = executorContext(fake.transaction, events);
  const result = await executeRefundAllocationFinalize(context, {
    kind: 'refund_allocation_finalize', refundId: REFUND_ID,
    expectedActiveDraftVersion: 2, previewFingerprint: prepared.previewFingerprint,
    confirmation: 'finalize_refund_allocation'
  });
  return { result, prepared, fake, context };
}

function defaultMocks(): void {
  collaborators.listRoles.mockResolvedValue(['admin']);
  const authority = async (transaction: unknown) =>
    (transaction as { testAuthority: TestState['authority'] }).testAuthority;
  collaborators.loadAuthority.mockImplementation(authority);
  collaborators.lockAuthority.mockImplementation(authority);
  collaborators.lockOrder.mockResolvedValue(undefined);
  collaborators.lockEnrollment.mockResolvedValue(undefined);
  collaborators.lockFinancialRows.mockResolvedValue({ payouts: [], balanceTransactions: [],
    memberships: [], classifications: [], feeDetailIds: [], allocationSetIds: [], issueIds: [] });
  collaborators.recomputeFinancial.mockResolvedValue({ status: 'unchanged', refundId: REFUND_ID,
    financialEvidenceStatus: 'fee_reconciled' });
  collaborators.recomputeAccess.mockResolvedValue({
    grantTransitions: [{ grantId: FIRST_GRANT_ID, orderItemId: FIRST_ITEM_ID,
      userId: USER_ID, titleId: FIRST_TITLE_ID, beforeState: 'active', afterState: 'revoked' }],
    projectedScopes: [{ userId: USER_ID, titleId: FIRST_TITLE_ID,
      beforeActive: true, afterActive: false }]
  });
  collaborators.appendAudit.mockResolvedValue({ id: 'audit' });
}

beforeEach(() => {
  vi.clearAllMocks();
  defaultMocks();
});

describe('refund allocation finalization preview', () => {
  it('authorizes both capabilities before parsing a resource or opening a transaction', async () => {
    const database = { transaction: vi.fn() } as unknown as Database;
    const actor: Actor = { type: 'user', id: 'not-a-resource-id', roles: ['admin'] };
    await expect(previewRefundFinalization(database, actor,
      { refundId: 'not-a-refund-id', expectedActiveDraftVersion: 0 },
      { correlationId: 'preview-auth-first' },
      { capabilityResolver: () => new Set(['sales.read']) }
    )).rejects.toMatchObject({ name: 'AuthorizationError', code: 'forbidden' });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('derives the exact shared split and identity-free access consequences', async () => {
    const result = await preview(cloneState());
    expect(result).toEqual({ refundId: REFUND_ID, expectedActiveDraftVersion: 2,
      previewFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u), currency: 'USD',
      proposedTotalMinor: 500, remainderMinor: 0,
      items: [
        { orderItemId: FIRST_ITEM_ID, titleId: FIRST_TITLE_ID, soldAsTitle: 'First title',
          proposedTotalMinor: 500, proposedSubtotalMinor: 450, proposedTaxMinor: 50,
          wouldBeFullyRefunded: true, purchaseGrantWouldBeRevoked: true,
          otherActiveGrantPreservesAccess: false, effectiveAccessWouldChange: true,
          emailQueued: true },
        { orderItemId: SECOND_ITEM_ID, titleId: SECOND_TITLE_ID, soldAsTitle: 'Second title',
          proposedTotalMinor: 0, proposedSubtotalMinor: 0, proposedTaxMinor: 0,
          wouldBeFullyRefunded: false, purchaseGrantWouldBeRevoked: false,
          otherActiveGrantPreservesAccess: false, effectiveAccessWouldChange: false,
          emailQueued: false }
      ]
    });
    expect(JSON.stringify(result)).not.toMatch(
      /reader@|"userId"|providerId|stripe|correlation/iu
    );
  });

  it('discovers source balances by the provider refund id, not the internal refund id', async () => {
    const state = cloneState();
    const fake = fakeDatabase(state);
    await previewRefundFinalization(fake.database,
      { type: 'user', id: ADMIN_ID, roles: ['admin'] },
      { refundId: REFUND_ID, expectedActiveDraftVersion: 2 },
      { correlationId: 'preview-source-linkage' });
    const sourceCall = fake.execute.mock.calls.find(([statement]) =>
      rendered(statement).includes('refund-finalization:source-balances')
    );
    expect(sourceCall).toBeDefined();
    const query = dialect.sqlToQuery(sourceCall![0]);
    expect(query.params).toContain('re_target');
    expect(query.params).not.toContain(REFUND_ID);
  });

  it('changes the fingerprint across every bound mutable dimension', async () => {
    const baseline = await preview(cloneState());
    const mutations: Array<(state: TestState) => void> = [
      (state) => { state.root.stripePaymentIntentId = 'pi_changed'; },
      (state) => { state.items[0]!.titleSnapshot = 'Renamed sold-as title'; },
      (state) => { state.allocations[0]!.createdAt = new Date('2026-08-22T10:00:01.000Z'); },
      (state) => { state.drafts[0]!.updatedAt = new Date('2026-08-22T10:00:02.000Z'); },
      (state) => { state.draftItems[0]!.proposedTotalPresentmentMinor = 400;
        state.draftItems[1]!.proposedTotalPresentmentMinor = 100; },
      (state) => { state.selectedTips[0]!.sourceFingerprintSha256 = FINGERPRINT_B; },
      (state) => { state.projectionHeads[0]!.missingSourceCount = 2; },
      (state) => { state.correctionSets.push({ id: CORRECTION_ID, refundId: REFUND_ID,
        correctionVersion: 1, kind: 'allocation_attribution_correction',
        baseAllocationSetId: SELECTED_SET_ID, predecessorCorrectionSetId: null,
        sourceFingerprintSha256: FINGERPRINT_A, correlationId: 'correction-created',
        createdAt: NOW });
        state.projectionHeads[0]!.compatibleCorrectionTipId = CORRECTION_ID; },
      (state) => { state.purchaseGrants[0]!.state = 'suspended';
        state.purchaseGrants[0]!.stateReason = 'dispute_opened';
        state.purchaseGrants[0]!.suspendedAt = NOW;
        state.scopeGrants[0] = state.purchaseGrants[0]!;
        state.scopeStates[0]!.active = false; }
    ];
    for (const mutate of mutations) {
      const state = cloneState(); mutate(state);
      expect((await preview(state)).previewFingerprint).not.toBe(baseline.previewFingerprint);
    }
  });

  it.each([
    ['partial', (state: TestState) => { state.draftItems[0]!.proposedTotalPresentmentMinor = 400;
      state.draftItems[1]!.proposedTotalPresentmentMinor = 100; }, false],
    ['suspended', (state: TestState) => { state.purchaseGrants[0]!.state = 'suspended';
      state.purchaseGrants[0]!.stateReason = 'dispute_opened';
      state.purchaseGrants[0]!.suspendedAt = NOW; state.scopeGrants[0] = state.purchaseGrants[0]!;
      state.scopeStates[0]!.active = false; }, true],
    ['already revoked', (state: TestState) => { state.purchaseGrants[0]!.state = 'revoked';
      state.purchaseGrants[0]!.stateReason = 'prior_revocation';
      state.purchaseGrants[0]!.revokedAt = NOW; state.scopeGrants[0] = state.purchaseGrants[0]!;
      state.scopeStates[0]!.active = false; }, false],
    ['unclaimed guest', (state: TestState) => { state.purchaseGrants[0]!.userId = null;
      state.purchaseGrants[0]!.state = 'unclaimed'; state.purchaseGrants[0]!.stateReason = 'guest_purchase';
      state.scopeGrants = [state.purchaseGrants[1]!]; state.scopeStates = [state.scopeStates[1]!]; }, true]
  ])('projects %s without manufacturing effective access or email', async (_label, mutate, revoke) => {
    const state = cloneState(); mutate(state);
    expect((await preview(state)).items[0]).toMatchObject({
      purchaseGrantWouldBeRevoked: revoke,
      effectiveAccessWouldChange: false,
      emailQueued: false
    });
  });

  it('recognizes another active grant and preserves effective access', async () => {
    const state = cloneState();
    state.scopeGrants.push({ ...state.purchaseGrants[0]!, id: PRESERVED_GRANT_ID,
      source: 'preserved', orderItemId: null, stateReason: 'legacy_preserved' });
    expect((await preview(state)).items[0]).toMatchObject({
      purchaseGrantWouldBeRevoked: true, otherActiveGrantPreservesAccess: true,
      effectiveAccessWouldChange: false, emailQueued: false
    });
  });

  it('does not let purchase grants revoked together preserve each other', async () => {
    const state = cloneState();
    state.root.refundAmountMinor = 900;
    state.refunds[0]!.amountMinor = 900;
    state.draftItems[1]!.proposedTotalPresentmentMinor = 400;
    state.items[1]!.titleId = FIRST_TITLE_ID;
    state.purchaseGrants[1]!.titleId = FIRST_TITLE_ID;
    state.scopeGrants[1] = state.purchaseGrants[1]!;
    state.scopeStates = [state.scopeStates[0]!];
    const result = await preview(state);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderItemId: FIRST_ITEM_ID,
        otherActiveGrantPreservesAccess: false, effectiveAccessWouldChange: true,
        emailQueued: true }),
      expect.objectContaining({ orderItemId: SECOND_ITEM_ID,
        otherActiveGrantPreservesAccess: false, effectiveAccessWouldChange: true,
        emailQueued: true })
    ]));
  });

  it('rejects stale version, capacity, chronology, and pending projection authority', async () => {
    await expect(preview(cloneState(), 1)).rejects.toMatchObject({ safeCode: 'stale_state' });
    const capacity = cloneState(); capacity.allocations[0]!.amountMinor = 200;
    capacity.components[0]!.subtotalMinor = 180; capacity.components[0]!.taxMinor = 20;
    capacity.components[0]!.totalMinor = 200;
    await expect(preview(capacity)).rejects.toMatchObject({ safeCode: 'stale_state' });
    const chronology = cloneState();
    chronology.root.refundProviderCreatedAt = new Date('2026-08-19T10:00:00.000Z');
    chronology.refunds[0]!.providerCreatedAt = chronology.root.refundProviderCreatedAt;
    await expect(preview(chronology)).rejects.toMatchObject({ safeCode: 'stale_state' });
    const unresolvedEarlierRefund = cloneState();
    unresolvedEarlierRefund.refunds[1]!.allocationStatus = 'needs_review';
    unresolvedEarlierRefund.allocations = [];
    unresolvedEarlierRefund.components = [];
    await expect(preview(unresolvedEarlierRefund)).rejects.toMatchObject({
      safeCode: 'stale_state'
    });
    const exhaustedVersion = cloneState();
    exhaustedVersion.drafts[0]!.version = 2_147_483_647;
    await expect(preview(exhaustedVersion, 2_147_483_647)).rejects.toMatchObject({
      safeCode: 'stale_state'
    });
    const pending = cloneState(); pending.authority.pendingClassifierVersion = 2;
    pending.authority.pendingAllocationAlgorithmVersion = 2;
    pending.authority.pendingReplayId = 'c2-a2'; pending.authority.pendingScanRunId = CORRECTION_ID;
    await expect(preview(pending)).rejects.toMatchObject({ safeCode: 'stale_state' });
  });

  it('classifies malformed component and entitlement invariants as command_failed', async () => {
    const component = cloneState(); component.components[0]!.taxMinor = 11;
    await expect(preview(component)).rejects.toMatchObject({ safeCode: 'command_failed' });
    const entitlement = cloneState(); entitlement.scopeStates[0]!.active = false;
    await expect(preview(entitlement)).rejects.toMatchObject({ safeCode: 'command_failed' });
    const wrongRefundCorrection = cloneState();
    wrongRefundCorrection.correctionSets.push({ id: CORRECTION_ID, refundId: SIBLING_REFUND_ID,
      correctionVersion: 1, kind: 'allocation_attribution_correction',
      baseAllocationSetId: SELECTED_SET_ID, predecessorCorrectionSetId: null,
      sourceFingerprintSha256: FINGERPRINT_A, correlationId: 'correction-created',
      createdAt: NOW });
    wrongRefundCorrection.projectionHeads[0]!.compatibleCorrectionTipId = CORRECTION_ID;
    await expect(preview(wrongRefundCorrection)).rejects.toMatchObject({
      safeCode: 'command_failed'
    });
  });
});

describe('refund allocation finalization executor', () => {
  it('locks, recomputes finance, changes grants, records effects, emails, and audits in order', async () => {
    const events: string[] = [];
    collaborators.lockAuthority.mockImplementation(async (transaction) => {
      events.push('projection-authority');
      return (transaction as unknown as { testAuthority: TestState['authority'] }).testAuthority;
    });
    collaborators.lockOrder.mockImplementation(async () => { events.push('order-advisory'); });
    collaborators.lockEnrollment.mockImplementation(async () => { events.push('enrollment'); });
    collaborators.lockFinancialRows.mockImplementation(async () => {
      events.push('financial-closure'); return { payouts: [], balanceTransactions: [],
        memberships: [], classifications: [], feeDetailIds: [], allocationSetIds: [], issueIds: [] };
    });
    collaborators.recomputeFinancial.mockImplementation(async () => {
      events.push('financial-recompute');
      return { status: 'unchanged', refundId: REFUND_ID, financialEvidenceStatus: 'fee_reconciled' };
    });
    collaborators.recomputeAccess.mockImplementation(async () => {
      events.push('access-reducer'); return { grantTransitions: [{ grantId: FIRST_GRANT_ID,
        orderItemId: FIRST_ITEM_ID, userId: USER_ID, titleId: FIRST_TITLE_ID,
        beforeState: 'active', afterState: 'revoked' }], projectedScopes: [{ userId: USER_ID,
        titleId: FIRST_TITLE_ID, beforeActive: true, afterActive: false }] };
    });
    collaborators.appendAudit.mockImplementation(async () => {
      events.push('audit'); return { id: 'audit' };
    });
    const { result, fake, context } = await executeState(cloneState(), events);
    expect(result).toEqual({ refundId: REFUND_ID, finalizedDraftVersion: 3,
      accessChanged: true, emailQueued: true });
    expect(events.indexOf('projection-authority')).toBeLessThan(events.indexOf('order-advisory'));
    expect(events.indexOf('purchase-graph')).toBeLessThan(events.indexOf('enrollment'));
    expect(events.indexOf('enrollment')).toBeLessThan(events.indexOf('financial-closure'));
    expect(events.indexOf('financial-closure')).toBeLessThan(events.indexOf('entitlement-graph'));
    expect(events.indexOf('financial-recompute')).toBeLessThan(events.indexOf('access-reducer'));
    expect(events.indexOf('access-reducer')).toBeLessThan(events.indexOf('insert-effect'));
    expect(events.indexOf('insert-effect')).toBeLessThan(events.indexOf('email'));
    expect(events.indexOf('email')).toBeLessThan(events.indexOf('audit'));
    expect(events.filter((event) => event === 'insert-allocation')).toHaveLength(1);
    expect(events.filter((event) => event === 'insert-component')).toHaveLength(1);
    expect(events.filter((event) => event === 'insert-effect')).toHaveLength(1);
    expect(collaborators.lockFinancialRows).toHaveBeenCalledWith(fake.transaction,
      expect.objectContaining({ classifierVersion: 1, issueKeys: expect.arrayContaining([
        expect.objectContaining({ resourceType: 'refund', resourceId: REFUND_ID }),
        expect.objectContaining({ resourceType: 'allocation_set', resourceId: SELECTED_SET_ID })
      ]) }));
    expect(collaborators.recomputeFinancial).toHaveBeenCalledWith(fake.transaction,
      expect.objectContaining({ refundId: REFUND_ID, allocationStatus: 'finalized',
        finalizedAllocations: [{ id: NEW_ALLOCATION_ID, orderItemId: FIRST_ITEM_ID,
          amountMinor: 500 }],
        refundComponents: [{ refundAllocationId: NEW_ALLOCATION_ID,
          orderItemId: FIRST_ITEM_ID, subtotalMinor: 450, taxMinor: 50, currency: 'USD' }] }),
      [SELECTED_SET_ID], COMMAND_ID);
    expect(context.enqueueAccessChange).toHaveBeenCalledWith({
      template: 'commerce.refund-access-changed', eventId: COMMAND_ID,
      to: 'reader@example.com', reasonCategory: 'refund_completed', affectedTitleCount: 1
    });
    expect(collaborators.appendAudit).toHaveBeenCalledWith(fake.transaction,
      expect.objectContaining({ action: 'financial.refund_allocation.finalized',
        resourceId: REFUND_ID, after: expect.objectContaining({ finalizedDraftVersion: 3 }) }));
  });

  it('records unchanged access and sends no email when another grant preserves access', async () => {
    const state = cloneState();
    state.scopeGrants.push({ ...state.purchaseGrants[0]!, id: PRESERVED_GRANT_ID,
      source: 'preserved', orderItemId: null, stateReason: 'legacy_preserved' });
    collaborators.recomputeAccess.mockResolvedValue({ grantTransitions: [{ grantId: FIRST_GRANT_ID,
      orderItemId: FIRST_ITEM_ID, userId: USER_ID, titleId: FIRST_TITLE_ID,
      beforeState: 'active', afterState: 'revoked' }], projectedScopes: [{ userId: USER_ID,
      titleId: FIRST_TITLE_ID, beforeActive: true, afterActive: true }] });
    const { result, context } = await executeState(state);
    expect(result).toMatchObject({ accessChanged: false, emailQueued: false });
    expect(context.enqueueAccessChange).not.toHaveBeenCalled();
  });

  it('rejects a stale fingerprint before any domain write', async () => {
    const state = cloneState(); const prepared = await preview(state);
    state.selectedTips[0]!.sourceFingerprintSha256 = FINGERPRINT_B;
    const events: string[] = []; const fake = fakeDatabase(state, events);
    const facts = purchaseFacts(state); collaborators.lockPurchaseFacts.mockResolvedValue(facts);
    collaborators.lockEntitlementFacts.mockResolvedValue({ ...facts, grants: state.purchaseGrants,
      affectedScopeGrants: state.scopeGrants });
    await expect(executeRefundAllocationFinalize(executorContext(fake.transaction, events), {
      kind: 'refund_allocation_finalize', refundId: REFUND_ID,
      expectedActiveDraftVersion: 2, previewFingerprint: prepared.previewFingerprint,
      confirmation: 'finalize_refund_allocation'
    })).rejects.toMatchObject({ safeCode: 'stale_state' });
    expect(events).not.toContain('insert-allocation');
  });

  it('leaves exact replay to the handler and treats a new finalized target as not eligible', async () => {
    const state = cloneState(); state.root.refundAllocationStatus = 'finalized';
    state.refunds[0]!.allocationStatus = 'finalized'; state.drafts[0]!.state = 'finalized';
    await expect(preview(state)).rejects.toMatchObject({ safeCode: 'not_eligible' });
  });

  it('rejects malformed direct commands before discovery', async () => {
    const fake = fakeDatabase(cloneState());
    await expect(executeRefundAllocationFinalize(executorContext(fake.transaction, []), {
      kind: 'refund_allocation_finalize', refundId: REFUND_ID,
      expectedActiveDraftVersion: 2, previewFingerprint: 'invalid',
      confirmation: 'finalize_refund_allocation'
    })).rejects.toMatchObject({ safeCode: 'invalid_command' });
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['projection', 'projection rollback witness'],
    ['outbox', 'outbox rollback witness'],
    ['audit', 'audit rollback witness']
  ])('surfaces %s failure so the handler transaction rolls all writes back', async (kind, message) => {
    if (kind === 'projection') collaborators.recomputeFinancial.mockRejectedValueOnce(new Error(message));
    if (kind === 'audit') collaborators.appendAudit.mockRejectedValueOnce(new Error(message));
    if (kind !== 'outbox') {
      await expect(executeState(cloneState())).rejects.toThrow(message);
      return;
    }
    const state = cloneState(); const prepared = await preview(state);
    const fake = fakeDatabase(state); const facts = purchaseFacts(state);
    collaborators.lockPurchaseFacts.mockResolvedValue(facts);
    collaborators.lockEntitlementFacts.mockResolvedValue({ ...facts, grants: state.purchaseGrants,
      affectedScopeGrants: state.scopeGrants });
    const context = executorContext(fake.transaction, []);
    context.enqueueAccessChange.mockRejectedValueOnce(new Error(message));
    await expect(executeRefundAllocationFinalize(context, {
      kind: 'refund_allocation_finalize', refundId: REFUND_ID,
      expectedActiveDraftVersion: 2, previewFingerprint: prepared.previewFingerprint,
      confirmation: 'finalize_refund_allocation'
    })).rejects.toThrow(message);
  });
});
