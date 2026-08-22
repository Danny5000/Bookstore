import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinancialAdminCommandExecutorContext } from '$lib/server/commerce/financial/admin-commands/handler';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import {
  executeRefundDraftDiscard,
  executeRefundDraftSave
} from './drafts';

const collaborators = vi.hoisted(() => ({
  appendAudit: vi.fn(),
  lockOrder: vi.fn(),
  lockPurchaseFacts: vi.fn()
}));

vi.mock('$lib/server/audit/service', () => ({ appendAuditEvent: collaborators.appendAudit }));
vi.mock('$lib/server/commerce/lock', () => ({ lockOrder: collaborators.lockOrder }));
vi.mock('$lib/server/commerce/reconciliation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/commerce/reconciliation')>()),
  lockPaymentPurchaseFacts: collaborators.lockPurchaseFacts
}));

const ADMIN_ID = '00000000-0000-4000-8000-000000011201';
const COMMAND_ID = '00000000-0000-4000-8000-000000011202';
const REFUND_ID = '00000000-0000-4000-8000-000000011203';
const SIBLING_REFUND_ID = '00000000-0000-4000-8000-000000011204';
const PAYMENT_ID = '00000000-0000-4000-8000-000000011205';
const ORDER_ID = '00000000-0000-4000-8000-000000011206';
const FIRST_ITEM_ID = '00000000-0000-4000-8000-000000011207';
const SECOND_ITEM_ID = '00000000-0000-4000-8000-000000011208';
const ALLOCATION_ID = '00000000-0000-4000-8000-000000011209';
const DRAFT_ID = '00000000-0000-4000-8000-000000011210';
const dialect = new PgDialect();

function rendered(statement: SQL): string {
  return dialect.sqlToQuery(statement).sql.replaceAll(/\s+/gu, ' ').trim();
}

function recorded(statement: SQL): string {
  const query = dialect.sqlToQuery(statement);
  return `${query.sql.replaceAll(/\s+/gu, ' ').trim()} params=${JSON.stringify(query.params)}`;
}

function facts(overrides: Record<string, unknown> = {}) {
  return {
    payment: {
      id: PAYMENT_ID, orderId: ORDER_ID, status: 'succeeded', amountMinor: 1000,
      currency: 'USD', paidAt: new Date('2026-08-22T10:00:00.000Z')
    },
    order: {
      id: ORDER_ID, status: 'paid', currency: 'USD', totalMinor: 1000,
      paidAt: new Date('2026-08-22T10:00:00.000Z')
    },
    refunds: [
      {
        id: REFUND_ID, paymentId: PAYMENT_ID, status: 'succeeded', amountMinor: 500,
        currency: 'USD', allocationStatus: 'needs_review'
      },
      {
        id: SIBLING_REFUND_ID, paymentId: PAYMENT_ID, status: 'succeeded', amountMinor: 100,
        currency: 'USD', allocationStatus: 'finalized'
      }
    ],
    refundDrafts: [],
    refundDraftItems: [],
    refundAllocations: [{
      id: ALLOCATION_ID, refundId: SIBLING_REFUND_ID, orderItemId: FIRST_ITEM_ID,
      amountMinor: 100, source: 'automatic'
    }],
    refundComponents: [{
      refundAllocationId: ALLOCATION_ID, refundId: SIBLING_REFUND_ID,
      orderItemId: FIRST_ITEM_ID, subtotalMinor: 90, taxMinor: 10,
      totalMinor: 100, currency: 'USD'
    }],
    correctionSets: [],
    correctionItems: [],
    disputes: [],
    disputeItemAllocations: [],
    orderItems: [
      {
        id: FIRST_ITEM_ID, orderId: ORDER_ID, titleId: FIRST_ITEM_ID,
        currency: 'USD', unitSubtotalMinor: 540, taxMinor: 60, totalMinor: 600
      },
      {
        id: SECOND_ITEM_ID, orderId: ORDER_ID, titleId: SECOND_ITEM_ID,
        currency: 'USD', unitSubtotalMinor: 360, taxMinor: 40, totalMinor: 400
      }
    ],
    ...overrides
  };
}

function activeFacts(overrides: Record<string, unknown> = {}) {
  return facts({
    refunds: [
      { ...(facts().refunds[0] as object), allocationStatus: 'draft' },
      facts().refunds[1]
    ],
    refundDrafts: [{
      id: DRAFT_ID,
      refundId: REFUND_ID,
      state: 'active',
      version: 2,
      createdByAdminId: ADMIN_ID,
      updatedByAdminId: ADMIN_ID,
      createdCorrelationId: 'draft-created',
      updatedCorrelationId: 'draft-updated'
    }],
    refundDraftItems: [
      { draftId: DRAFT_ID, orderItemId: FIRST_ITEM_ID, proposedTotalPresentmentMinor: 500 },
      { draftId: DRAFT_ID, orderItemId: SECOND_ITEM_ID, proposedTotalPresentmentMinor: 0 }
    ],
    ...overrides
  });
}

function fakeTransaction(): {
  readonly transaction: DatabaseTransaction;
  readonly execute: ReturnType<typeof vi.fn>;
  readonly statements: string[];
} {
  const statements: string[] = [];
  const execute = vi.fn(async (statement: SQL) => {
    const text = rendered(statement);
    statements.push(recorded(statement));
    if (text.includes('join payments')) {
      return { rows: [{ paymentId: PAYMENT_ID, orderId: ORDER_ID }] };
    }
    if (text.includes('from orders') && text.includes('for update')) {
      return { rows: [{
        id: ORDER_ID, status: 'paid', currency: 'USD', totalMinor: 1000,
        paidAt: new Date('2026-08-22T10:00:00.000Z')
      }] };
    }
    if (text.includes('from payments') && text.includes('for update')) {
      return { rows: [{
        id: PAYMENT_ID, orderId: ORDER_ID, status: 'succeeded', amountMinor: 1000,
        currency: 'USD', paidAt: new Date('2026-08-22T10:00:00.000Z')
      }] };
    }
    if (text.includes('insert into refund_allocation_drafts')) {
      return { rows: [{ id: DRAFT_ID, version: 1 }] };
    }
    if (text.includes('update refund_allocation_drafts')) {
      return { rows: [{ id: DRAFT_ID, version: text.includes("state = 'discarded'") ? 3 : 3 }] };
    }
    if (text.includes('update refunds')) return { rows: [{ id: REFUND_ID }] };
    return { rows: [] };
  });
  return {
    transaction: { execute } as unknown as DatabaseTransaction,
    execute,
    statements
  };
}

function context(transaction: DatabaseTransaction): FinancialAdminCommandExecutorContext {
  return {
    transaction,
    commandId: COMMAND_ID,
    actor: { type: 'user', id: ADMIN_ID, roles: ['customer', 'admin'] },
    correlationId: 'refund-draft-command',
    signal: new AbortController().signal,
    enqueueAccessChange: vi.fn(async () => undefined)
  };
}

function saveCommand(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'refund_draft_save' as const,
    refundId: REFUND_ID,
    expectedVersion: null,
    items: [
      { orderItemId: FIRST_ITEM_ID, totalPresentmentMinor: 400 },
      { orderItemId: SECOND_ITEM_ID, totalPresentmentMinor: 100 }
    ],
    ...overrides
  };
}

describe('worker-executed shared refund draft commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collaborators.appendAudit.mockResolvedValue({ id: 'audit' });
    collaborators.lockOrder.mockResolvedValue(undefined);
    collaborators.lockPurchaseFacts.mockResolvedValue(facts());
  });

  it('discovers without locks, then locks order, order row, payment row, and complete graph', async () => {
    const database = fakeTransaction();
    const order: string[] = [];
    database.execute.mockImplementation(async (statement: SQL) => {
      const text = rendered(statement);
      order.push(text.includes('join payments')
        ? 'discover'
        : text.includes('from orders')
          ? 'order-row'
          : text.includes('from payments')
            ? 'payment-row'
            : 'write');
      if (text.includes('join payments')) return { rows: [{ paymentId: PAYMENT_ID, orderId: ORDER_ID }] };
      if (text.includes('from orders')) return { rows: [{
        id: ORDER_ID, status: 'paid', currency: 'USD', totalMinor: 1000,
        paidAt: new Date('2026-08-22T10:00:00.000Z')
      }] };
      if (text.includes('from payments')) return { rows: [{
        id: PAYMENT_ID, orderId: ORDER_ID, status: 'succeeded', amountMinor: 1000,
        currency: 'USD', paidAt: new Date('2026-08-22T10:00:00.000Z')
      }] };
      if (text.includes('insert into refund_allocation_drafts')) {
        return { rows: [{ id: DRAFT_ID, version: 1 }] };
      }
      if (text.includes('update refunds')) return { rows: [{ id: REFUND_ID }] };
      return { rows: [] };
    });
    collaborators.lockOrder.mockImplementation(async () => { order.push('order-advisory'); });
    collaborators.lockPurchaseFacts.mockImplementation(async () => {
      order.push('complete-graph');
      return facts();
    });

    await executeRefundDraftSave(context(database.transaction), saveCommand());

    expect(order.slice(0, 5)).toEqual([
      'discover', 'order-advisory', 'order-row', 'payment-row', 'complete-graph'
    ]);
    expect(collaborators.lockPurchaseFacts).toHaveBeenCalledWith(
      database.transaction,
      expect.objectContaining({ id: PAYMENT_ID }),
      expect.objectContaining({ id: ORDER_ID })
    );
  });

  it('accepts the strict PostgreSQL timestamptz strings returned by raw lock queries', async () => {
    const database = fakeTransaction();
    const fallback = database.execute.getMockImplementation() as
      | ((statement: SQL) => Promise<unknown>)
      | undefined;
    database.execute.mockImplementation(async (statement: SQL) => {
      const text = rendered(statement);
      if (text.includes('from orders') && text.includes('for update')) {
        return { rows: [{
          id: ORDER_ID, status: 'paid', currency: 'USD', totalMinor: 1000,
          paidAt: '2026-08-22 10:00:00+00'
        }] };
      }
      if (text.includes('from payments') && text.includes('for update')) {
        return { rows: [{
          id: PAYMENT_ID, orderId: ORDER_ID, status: 'succeeded', amountMinor: 1000,
          currency: 'USD', paidAt: '2026-08-22 10:00:00+00'
        }] };
      }
      if (!fallback) throw new Error('Missing fake transaction implementation.');
      return fallback(statement);
    });

    await expect(executeRefundDraftSave(
      context(database.transaction), saveCommand()
    )).resolves.toEqual({ refundId: REFUND_ID, draftVersion: 1, changed: true });
  });

  it('creates a version-one full zero-inclusive snapshot, changes only draft status, and audits submitter', async () => {
    const database = fakeTransaction();
    const result = await executeRefundDraftSave(
      context(database.transaction), saveCommand()
    );

    expect(result).toEqual({ refundId: REFUND_ID, draftVersion: 1, changed: true });
    const sql = database.statements.join('\n');
    expect(sql).toContain('insert into refund_allocation_drafts');
    expect(sql).toContain('insert into refund_allocation_draft_items');
    expect(sql).toContain(FIRST_ITEM_ID);
    expect(sql).toContain(SECOND_ITEM_ID);
    expect(sql).toContain('update refunds');
    expect(sql).toContain('params=["draft"');
    expect(sql).not.toMatch(/financial_projection|entitlement|grant|outbox|jobs|delete from/iu);
    expect(collaborators.appendAudit).toHaveBeenCalledWith(database.transaction, {
      actor: context(database.transaction).actor,
      action: 'financial.refund_draft.created',
      outcome: 'succeeded',
      resourceType: 'refund_allocation_draft',
      resourceId: DRAFT_ID,
      correlationId: 'refund-draft-command',
      after: {
        refundId: REFUND_ID,
        draftVersion: 1,
        state: 'active',
        itemCount: 2,
        proposedTotalMinor: 500
      }
    });
  });

  it('increments an existing changed draft exactly once and upserts without deleting rows', async () => {
    collaborators.lockPurchaseFacts.mockResolvedValue(activeFacts());
    const database = fakeTransaction();
    const result = await executeRefundDraftSave(
      context(database.transaction), saveCommand({ expectedVersion: 2 })
    );

    expect(result).toEqual({ refundId: REFUND_ID, draftVersion: 3, changed: true });
    const sql = database.statements.join('\n');
    expect(sql).toContain('on conflict');
    expect(sql).toContain('version = version + 1');
    expect(sql).not.toContain('delete from refund_allocation_draft_items');
    expect(collaborators.appendAudit).toHaveBeenCalledWith(
      database.transaction,
      expect.objectContaining({ action: 'financial.refund_draft.updated' })
    );
  });

  it('returns a succeeded no-op without DML, version change, or domain audit', async () => {
    collaborators.lockPurchaseFacts.mockResolvedValue(activeFacts());
    const database = fakeTransaction();
    const result = await executeRefundDraftSave(
      context(database.transaction),
      saveCommand({
        expectedVersion: 2,
        items: [{ orderItemId: FIRST_ITEM_ID, totalPresentmentMinor: 500 }]
      })
    );

    expect(result).toEqual({ refundId: REFUND_ID, draftVersion: 2, changed: false });
    expect(database.statements).toHaveLength(3);
    expect(collaborators.appendAudit).not.toHaveBeenCalled();
  });

  it('reports safe stale-state conflicts for competing versions, changed graphs, and capacities', async () => {
    const stale = fakeTransaction();
    collaborators.lockPurchaseFacts.mockResolvedValueOnce(activeFacts());
    await expect(executeRefundDraftSave(
      context(stale.transaction), saveCommand({ expectedVersion: 1 })
    )).rejects.toMatchObject({ name: 'FinancialAdminConflictError', safeCode: 'stale_state' });

    const graph = fakeTransaction();
    collaborators.lockPurchaseFacts.mockResolvedValueOnce(activeFacts({
      refundDraftItems: [{
        draftId: DRAFT_ID, orderItemId: FIRST_ITEM_ID, proposedTotalPresentmentMinor: 100
      }]
    }));
    await expect(executeRefundDraftSave(
      context(graph.transaction), saveCommand({ expectedVersion: 2 })
    )).rejects.toMatchObject({ safeCode: 'stale_state' });

    const capacity = fakeTransaction();
    collaborators.lockPurchaseFacts.mockResolvedValueOnce(facts());
    await expect(executeRefundDraftSave(
      context(capacity.transaction), saveCommand({
        items: [{ orderItemId: FIRST_ITEM_ID, totalPresentmentMinor: 501 }]
      })
    )).rejects.toMatchObject({ safeCode: 'stale_state' });
  });

  it('rejects a snapshot whose complete total does not equal the succeeded refund', async () => {
    const database = fakeTransaction();

    await expect(executeRefundDraftSave(
      context(database.transaction),
      saveCommand({
        items: [{ orderItemId: FIRST_ITEM_ID, totalPresentmentMinor: 499 }]
      })
    )).rejects.toMatchObject({ safeCode: 'stale_state' });

    expect(database.statements).toHaveLength(3);
    expect(collaborators.appendAudit).not.toHaveBeenCalled();
  });

  it('discards the exact active version, restores needs-review, and audits once', async () => {
    collaborators.lockPurchaseFacts.mockResolvedValue(activeFacts());
    const database = fakeTransaction();
    const result = await executeRefundDraftDiscard(context(database.transaction), {
      kind: 'refund_draft_discard',
      refundId: REFUND_ID,
      expectedActiveDraftVersion: 2
    });

    expect(result).toEqual({ refundId: REFUND_ID, draftVersion: 3, changed: true });
    const sql = database.statements.join('\n');
    expect(sql).toContain("state = 'discarded'");
    expect(sql).toContain('version = version + 1');
    expect(sql).toContain('params=["needs_review"');
    expect(sql).not.toMatch(/financial_projection|entitlement|grant|outbox|jobs|delete from/iu);
    expect(collaborators.appendAudit).toHaveBeenCalledWith(
      database.transaction,
      expect.objectContaining({ action: 'financial.refund_draft.discarded' })
    );
  });

  it('propagates audit failure so the handler transaction cannot terminalize success', async () => {
    collaborators.appendAudit.mockRejectedValueOnce(new Error('private audit failure'));
    const database = fakeTransaction();
    await expect(executeRefundDraftSave(
      context(database.transaction), saveCommand()
    )).rejects.toThrow('private audit failure');
  });

  it('honors worker cancellation before discovering or mutating facts', async () => {
    const controller = new AbortController();
    controller.abort();
    const database = fakeTransaction();
    await expect(executeRefundDraftSave({
      ...context(database.transaction), signal: controller.signal
    }, saveCommand())).rejects.toMatchObject({ name: 'AbortError' });
    expect(database.execute).not.toHaveBeenCalled();
    expect(collaborators.lockOrder).not.toHaveBeenCalled();
  });
});
