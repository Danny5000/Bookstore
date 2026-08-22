import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdministratorActor } from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { getRefundReviewDetail } from './query';

const collaborators = vi.hoisted(() => ({
  audit: vi.fn(),
  listRoles: vi.fn(),
  payoutEvidence: vi.fn()
}));

vi.mock('$lib/server/auth/identity', () => ({
  listRolesForUser: collaborators.listRoles
}));
vi.mock('$lib/server/commerce/reporting/audit', () => ({
  auditFinancialRefundDetailRead: collaborators.audit
}));
vi.mock('$lib/server/commerce/financial/payouts/repository', () => ({
  loadCurrentPayoutEvidence: collaborators.payoutEvidence
}));

const ADMIN_ID = '00000000-0000-4000-8000-000000011101';
const REFUND_ID = '00000000-0000-4000-8000-000000011103';
const ORDER_ID = '00000000-0000-4000-8000-000000011104';
const FIRST_ITEM_ID = '00000000-0000-4000-8000-000000011105';
const SECOND_ITEM_ID = '00000000-0000-4000-8000-000000011106';
const FIRST_TITLE_ID = '00000000-0000-4000-8000-000000011107';
const SECOND_TITLE_ID = '00000000-0000-4000-8000-000000011108';
const DRAFT_ID = '00000000-0000-4000-8000-000000011109';
const BALANCE_ID = '00000000-0000-4000-8000-000000011110';
const ADMIN: AdministratorActor = {
  type: 'user', id: ADMIN_ID, roles: ['customer', 'admin']
};
const dialect = new PgDialect();

function detailRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    refundId: REFUND_ID,
    orderId: ORDER_ID,
    status: 'succeeded',
    allocationStatus: 'draft',
    amountMinor: 500,
    currency: 'USD',
    orderSubtotalMinor: 900,
    orderTaxMinor: 100,
    orderTotalMinor: 1000,
    financialEvidenceStatus: 'fee_reconciled',
    balanceTransactionIds: [BALANCE_ID],
    items: [
      {
        orderItemId: FIRST_ITEM_ID,
        titleId: FIRST_TITLE_ID,
        soldAsTitle: 'First book',
        soldAsCreatorName: 'First Author',
        format: 'prose',
        paidSubtotalMinor: 540,
        paidTaxMinor: 60,
        paidTotalMinor: 600,
        currency: 'USD',
        finalizedRefundTotalMinor: 100,
        remainingRefundCapacityMinor: 500
      },
      {
        orderItemId: SECOND_ITEM_ID,
        titleId: SECOND_TITLE_ID,
        soldAsTitle: 'Second book',
        soldAsCreatorName: 'Second Author',
        format: 'comic',
        paidSubtotalMinor: 360,
        paidTaxMinor: 40,
        paidTotalMinor: 400,
        currency: 'USD',
        finalizedRefundTotalMinor: 0,
        remainingRefundCapacityMinor: 400
      }
    ],
    finalizedAllocations: [],
    allAllocationCount: 1,
    allComponentCount: 1,
    targetAllocationCount: 0,
    draftId: DRAFT_ID,
    draftVersion: 2,
    draftState: 'active',
    draftEditedByCurrentAdministrator: false,
    draftUpdatedAt: new Date('2026-08-22T12:02:00.000Z'),
    draftItems: [
      { orderItemId: FIRST_ITEM_ID, proposedTotalMinor: 300 },
      { orderItemId: SECOND_ITEM_ID, proposedTotalMinor: 200 }
    ],
    openIssueCount: 1,
    dataThroughAt: new Date('2026-08-22T12:03:00.000Z'),
    createdAt: new Date('2026-08-22T12:00:00.000Z'),
    updatedAt: new Date('2026-08-22T12:01:00.000Z'),
    ...overrides
  };
}

function fakeDatabase(rows: readonly unknown[]): {
  readonly db: Database;
  readonly execute: ReturnType<typeof vi.fn>;
  readonly transaction: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const execute = vi.fn(async () => call++ === 0 ? { rows: [] } : { rows });
  const transaction = vi.fn(async (
    work: (transaction: DatabaseTransaction) => Promise<unknown>
  ) => work({ execute } as unknown as DatabaseTransaction));
  return { db: { transaction } as unknown as Database, execute, transaction };
}

function rendered(query: SQL): string {
  return dialect.sqlToQuery(query).sql;
}

describe('audited refund review detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collaborators.listRoles.mockResolvedValue(['customer', 'admin']);
    collaborators.audit.mockResolvedValue(undefined);
    collaborators.payoutEvidence.mockResolvedValue({
      relevantBalanceTransactionCount: 1,
      authoritativeMembershipCount: 1,
      paidAutomaticStandardCompletedCount: 1,
      conflictingMembershipCount: 0,
      hasOpenExceptionIssue: false,
      hasMissingPayoutReversal: false
    });
  });

  it('authorizes before parsing the refund identity or opening a transaction', async () => {
    const database = fakeDatabase([]);
    await expect(getRefundReviewDetail(
      database.db,
      { type: 'anonymous' },
      'private malformed identity',
      { correlationId: 'private-denied' }
    )).rejects.toMatchObject({ name: 'AuthorizationError', code: 'unauthenticated' });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('returns null for malformed or missing refunds without an audit', async () => {
    const malformed = fakeDatabase([]);
    await expect(getRefundReviewDetail(
      malformed.db, ADMIN, 'NOT-CANONICAL', { correlationId: 'refund-malformed' }
    )).resolves.toBeNull();
    expect(malformed.transaction).not.toHaveBeenCalled();

    const missing = fakeDatabase([]);
    await expect(getRefundReviewDetail(
      missing.db, ADMIN, REFUND_ID, { correlationId: 'refund-missing' }
    )).resolves.toBeNull();
    expect(collaborators.audit).not.toHaveBeenCalled();
  });

  it('locks roles, reloads authorization, builds an exact safe DTO, then audits', async () => {
    const database = fakeDatabase([detailRow()]);
    const context = {
      correlationId: 'refund-detail-safe',
      requestMetadata: {
        method: 'GET', routeId: '/admin/sales/refunds/[refundId]'
      }
    } as const;

    const result = await getRefundReviewDetail(database.db, ADMIN, REFUND_ID, context);

    expect(rendered(database.execute.mock.calls[0]![0] as SQL)).toContain(
      "pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))"
    );
    const query = rendered(database.execute.mock.calls[1]![0] as SQL);
    expect(query).toContain('refund_allocation_components');
    expect(query).toContain('refund_allocation_drafts');
    expect(query).toContain('refund_allocation_draft_items');
    expect(query).toContain('stripe_balance_transactions');
    expect(collaborators.payoutEvidence).toHaveBeenCalledWith(
      expect.any(Object), [BALANCE_ID]
    );
    expect(collaborators.audit).toHaveBeenCalledWith(expect.any(Object), {
      actor: { type: 'user', id: ADMIN_ID, roles: ['customer', 'admin'] },
      refundId: REFUND_ID,
      context
    });
    expect(result).toEqual({
      refundId: REFUND_ID,
      orderId: ORDER_ID,
      status: 'succeeded',
      allocationStatus: 'draft',
      financialState: 'payout_reconciled',
      amountMinor: 500,
      currency: 'USD',
      orderSubtotalMinor: 900,
      orderTaxMinor: 100,
      orderTotalMinor: 1000,
      items: detailRow().items,
      finalizedAllocations: [],
      draft: {
        draftId: DRAFT_ID,
        version: 2,
        state: 'active',
        lastEditedBy: 'another_administrator',
        updatedAt: '2026-08-22T12:02:00.000Z',
        proposedTotalMinor: 500,
        remainderMinor: 0,
        items: detailRow().draftItems
      },
      finalizationPreview: null,
      correctionPreview: null,
      recoveryPreviews: [],
      openIssueCount: 1,
      dataThroughAt: '2026-08-22T12:03:00.000Z',
      createdAt: '2026-08-22T12:00:00.000Z',
      updatedAt: '2026-08-22T12:01:00.000Z'
    });
    expect(Object.keys(result!)).toHaveLength(20);
    expect(JSON.stringify(result)).not.toMatch(
      /customer|email|provider|stripe|adminId|correlation|balanceTransaction/iu
    );
  });

  it('reauthorizes current persisted roles before reading any refund facts', async () => {
    collaborators.listRoles.mockResolvedValueOnce(['customer']);
    const database = fakeDatabase([detailRow()]);
    await expect(getRefundReviewDetail(
      database.db, ADMIN, REFUND_ID, { correlationId: 'refund-demoted' }
    )).rejects.toMatchObject({ name: 'AuthorizationError', code: 'forbidden' });
    expect(database.execute).toHaveBeenCalledOnce();
    expect(collaborators.payoutEvidence).not.toHaveBeenCalled();
  });

  it('keeps a shared draft visible when later refund facts reduce an item capacity', async () => {
    const changed = detailRow({
      items: [
        {
          ...(detailRow().items as Record<string, unknown>[])[0],
          finalizedRefundTotalMinor: 200,
          remainingRefundCapacityMinor: 400
        },
        (detailRow().items as Record<string, unknown>[])[1]
      ],
      draftItems: [
        { orderItemId: FIRST_ITEM_ID, proposedTotalMinor: 500 },
        { orderItemId: SECOND_ITEM_ID, proposedTotalMinor: 0 }
      ]
    });
    const database = fakeDatabase([changed]);

    const result = await getRefundReviewDetail(
      database.db, ADMIN, REFUND_ID, { correlationId: 'refund-graph-changed' }
    );
    expect(result).toMatchObject({ draft: { proposedTotalMinor: 500 } });
    expect(result?.draft?.items[0]).toEqual({
      orderItemId: FIRST_ITEM_ID,
      proposedTotalMinor: 500
    });
    expect(collaborators.audit).toHaveBeenCalledOnce();
  });

  it.each([
    detailRow({ allComponentCount: 0 }),
    detailRow({ draftItems: [{ orderItemId: FIRST_ITEM_ID, proposedTotalMinor: 300 }] }),
    detailRow({
      draftItems: [
        { orderItemId: FIRST_ITEM_ID, proposedTotalMinor: 300 },
        { orderItemId: SECOND_ITEM_ID, proposedTotalMinor: 100 }
      ]
    }),
    detailRow({
      items: [{ ...(detailRow().items as Record<string, unknown>[])[0], remainingRefundCapacityMinor: -1 }]
    }),
    detailRow({ targetAllocationCount: 1, finalizedAllocations: [] })
  ])('fails closed on corrupt allocation, capacity, or draft output', async (row) => {
    const database = fakeDatabase([row]);
    await expect(getRefundReviewDetail(
      database.db, ADMIN, REFUND_ID, { correlationId: 'refund-corrupt' }
    )).rejects.toMatchObject({ name: 'RefundReviewRepositoryError' });
    expect(collaborators.audit).not.toHaveBeenCalled();
  });

  it('does not return successful detail when the fixed audit fails', async () => {
    collaborators.audit.mockRejectedValueOnce(new Error('private audit failure'));
    const database = fakeDatabase([detailRow()]);
    await expect(getRefundReviewDetail(
      database.db, ADMIN, REFUND_ID, { correlationId: 'refund-audit-failure' }
    )).rejects.toThrow('private audit failure');
  });
});
