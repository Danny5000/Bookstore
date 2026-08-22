import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, AdministratorActor } from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import {
  PAYOUT_PAGE_SIZE,
  decodePayoutCursor,
  encodePayoutCursor,
  getPayoutDetail,
  listPayouts,
  parsePayoutListInput
} from './payouts';

const collaborators = vi.hoisted(() => ({
  audit: vi.fn(),
  listRoles: vi.fn()
}));

vi.mock('$lib/server/auth/identity', () => ({
  listRolesForUser: collaborators.listRoles
}));

vi.mock('./audit', () => ({
  auditFinancialPayoutDetailRead: collaborators.audit
}));

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const PAYOUT_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN: AdministratorActor = { type: 'user', id: ADMIN_ID, roles: ['admin'] };
const CUSTOMER: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };
const dialect = new PgDialect();

interface FakeDatabase {
  readonly db: Database;
  readonly execute: ReturnType<typeof vi.fn>;
  readonly transaction: ReturnType<typeof vi.fn>;
}

function fakeDatabase(responses: readonly unknown[]): FakeDatabase {
  let responseIndex = 0;
  const execute = vi.fn(async () => responses[responseIndex++] ?? { rows: [] });
  const transaction = vi.fn(async (
    work: (transaction: DatabaseTransaction) => Promise<unknown>
  ) => work({ execute } as unknown as DatabaseTransaction));
  return {
    db: { transaction } as unknown as Database,
    execute,
    transaction
  };
}

function rendered(query: SQL): { readonly sql: string; readonly params: unknown[] } {
  return dialect.sqlToQuery(query);
}

function availablePayoutRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payoutId: PAYOUT_ID,
    automatic: true,
    method: 'standard',
    status: 'paid',
    reconciliationStatus: 'completed',
    settlementCurrency: 'USD',
    amountMinor: '930',
    createdAt: new Date('2026-08-01T10:00:00.123Z'),
    createdAtCursor: '2026-08-01T10:00:00.123456Z',
    arrivalAt: new Date('2026-08-03T10:00:00.000Z'),
    associatedTransactionCount: '3',
    bookstoreLinkedTransactionCount: '2',
    membershipComplete: true,
    bookstoreLinkedSubtotalMinor: '1000',
    accountLevelAdjustmentCount: '1',
    accountLevelAdjustmentMinor: '-20',
    safeFailureCode: null,
    financialGeneration: '2',
    membershipGeneration: '2',
    historicalMembershipRetained: false,
    reversalState: 'none',
    openIssueCount: '0',
    freshnessAt: new Date('2026-08-03T12:00:00.000Z'),
    ...overrides
  };
}

function unavailablePayoutRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return availablePayoutRow({
    automatic: false,
    reconciliationStatus: 'not_applicable',
    associatedTransactionCount: null,
    bookstoreLinkedTransactionCount: null,
    membershipComplete: false,
    bookstoreLinkedSubtotalMinor: null,
    accountLevelAdjustmentCount: null,
    accountLevelAdjustmentMinor: null,
    membershipGeneration: null,
    historicalMembershipRetained: false,
    ...overrides
  });
}

function detailRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...availablePayoutRow(),
    bookstoreLinkedFeeImpactMinor: '-50',
    bookstoreLinkedNetMinor: '950',
    reversalAmountMinor: null,
    ...overrides
  };
}

describe('payout reporting input and cursor', () => {
  it('accepts only an optional canonical six-digit timestamp cursor and fixes page size at 50', () => {
    expect(parsePayoutListInput(
      new URL('https://books.example.test/admin/sales/payouts')
    )).toEqual({ pageSize: PAYOUT_PAGE_SIZE });

    const cursor = {
      providerCreatedAt: '2026-08-01T10:00:00.123456Z',
      payoutId: PAYOUT_ID
    };
    const encoded = encodePayoutCursor(cursor);
    expect(decodePayoutCursor(encoded)).toEqual(cursor);
    expect(parsePayoutListInput(
      new URL(`https://books.example.test/admin/sales/payouts?cursor=${encoded}`)
    )).toEqual({ pageSize: PAYOUT_PAGE_SIZE, cursor });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encoded).not.toContain('=');
  });

  it.each([
    '?unknown=value',
    '?cursor=',
    '?cursor=first&cursor=second',
    '?cursor=not-canonical',
    `?cursor=${Buffer.from(JSON.stringify({
      version: 1,
      filterFingerprint: '0'.repeat(64),
      providerCreatedAt: '2026-08-01T10:00:00.123456Z',
      payoutId: PAYOUT_ID
    })).toString('base64url')}`,
    `?cursor=${Buffer.from(JSON.stringify({
      version: 1,
      filterFingerprint: '0'.repeat(64),
      providerCreatedAt: '2026-08-01T10:00:00.123Z',
      payoutId: PAYOUT_ID
    })).toString('base64url')}`
  ])('rejects malformed, duplicate, unknown, foreign, or imprecise cursor input %s', (search) => {
    expect(() => parsePayoutListInput(
      new URL(`https://books.example.test/admin/sales/payouts${search}`)
    )).toThrow(expect.objectContaining({
      name: 'SalesReportingInputError',
      code: 'invalid_request',
      status: 400
    }));
  });
});

describe('local payout list', () => {
  beforeEach(() => {
    collaborators.audit.mockReset();
    collaborators.listRoles.mockReset();
  });

  it.each<Actor>([{ type: 'anonymous' }, CUSTOMER])(
    'authorizes before validating input or opening a transaction for $type',
    async (actor) => {
      const database = fakeDatabase([]);
      await expect(listPayouts(database.db, actor, {
        pageSize: 51 as never
      })).rejects.toMatchObject({
        name: 'AuthorizationError',
        code: actor.type === 'anonymous' ? 'unauthenticated' : 'forbidden'
      });
      expect(database.transaction).not.toHaveBeenCalled();
    }
  );

  it('queries only immutable local membership and current projection evidence with one sentinel row', async () => {
    const database = fakeDatabase([{ rows: [] }]);

    await expect(listPayouts(database.db, ADMIN, {
      pageSize: PAYOUT_PAGE_SIZE
    })).resolves.toEqual({ payouts: [], currentCursor: null, nextCursor: null });

    expect(database.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only'
    });
    const query = rendered(database.execute.mock.calls[0]![0] as SQL);
    for (const relation of [
      'stripe_payouts',
      'payout_import_runs',
      'stripe_payout_balance_transactions',
      'stripe_balance_transactions',
      'current_financial_projection_heads',
      'current_financial_projection_items',
      'financial_allocation_sets',
      'refund_reporting_correction_sets',
      'financial_reconciliation_issues'
    ]) {
      expect(query.sql).toContain(relation);
    }
    expect(query.sql).not.toContain('payout_import_run_entries');
    expect(query.sql).not.toContain('stripe_events');
    expect(query.sql).not.toContain('"providerId"');
    expect(query.sql).not.toMatch(/\btransaction\./u);
    expect(query.sql).toMatch(
      /coalesce\(\s*payout\.automatic[\s\S]*?,\s*false\s*\)\s+as membership_complete/u
    );
    expect(query.sql).toContain("'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'");
    expect(query.sql).toMatch(/order by[\s\S]*provider_created_at\s+desc[\s\S]*payout_id\s+desc/u);
    expect(query.params).toContain(PAYOUT_PAGE_SIZE + 1);
    const targetPayoutsAt = query.sql.indexOf('with target_payouts as');
    const sentinelLimitAt = query.sql.indexOf('limit');
    const importRunsAt = query.sql.indexOf('payout_import_runs');
    expect(targetPayoutsAt).toBeGreaterThanOrEqual(0);
    expect(sentinelLimitAt).toBeGreaterThan(targetPayoutsAt);
    expect(sentinelLimitAt).toBeLessThan(importRunsAt);
    expect(query.sql.match(/target_payouts/gu)?.length).toBeGreaterThanOrEqual(7);
    expect(collaborators.audit).not.toHaveBeenCalled();
  });

  it('accepts only exact local failure or reciprocal payout evidence for reversals', async () => {
    const database = fakeDatabase([{ rows: [] }]);

    await listPayouts(database.db, ADMIN, { pageSize: PAYOUT_PAGE_SIZE });

    const query = rendered(database.execute.mock.calls[0]![0] as SQL).sql;
    for (const predicate of [
      /failure_transaction\.id\s*=\s*payout\.failure_balance_transaction_id/u,
      /failure_transaction\.live_mode\s*=\s*payout\.live_mode/u,
      /failure_transaction\.currency\s*=\s*payout\.currency/u,
      /failure_transaction\.source_family\s*=\s*'payout'/u,
      /failure_transaction\.source_id\s*=\s*payout\.provider_id/u,
      /failure_transaction\.raw_type\s*=\s*'payout_failure'/u,
      /failure_transaction\.reporting_category\s*=\s*'payout'/u,
      /failure_transaction\.balance_type\s*=\s*'payments'/u,
      /reciprocal\.provider_id\s*=\s*payout\.reversed_by_provider_payout_id/u,
      /reciprocal\.original_provider_payout_id\s*=\s*payout\.provider_id/u,
      /reciprocal\.live_mode\s*=\s*payout\.live_mode/u,
      /reciprocal\.currency\s*=\s*payout\.currency/u
    ]) {
      expect(query).toMatch(predicate);
    }
    expect(query).toMatch(
      /case\s+when[\s\S]*failure_transaction\.last_imported_at[\s\S]*end[\s\S]*case\s+when[\s\S]*reciprocal\.retrieved_at[\s\S]*end[\s\S]*as reversal_freshness_at/u
    );
  });

  it('uses the exact descending timestamp and internal-ID tuple for the next page', async () => {
    const rows = Array.from({ length: PAYOUT_PAGE_SIZE + 1 }, (_, index) =>
      availablePayoutRow({
        payoutId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      })
    );
    const first = fakeDatabase([{ rows }]);
    const result = await listPayouts(first.db, ADMIN, { pageSize: PAYOUT_PAGE_SIZE });

    expect(result.payouts).toHaveLength(PAYOUT_PAGE_SIZE);
    expect(decodePayoutCursor(result.nextCursor!)).toEqual({
      providerCreatedAt: '2026-08-01T10:00:00.123456Z',
      payoutId: rows[49]!.payoutId
    });

    const second = fakeDatabase([{ rows: [] }]);
    await listPayouts(second.db, ADMIN, {
      pageSize: PAYOUT_PAGE_SIZE,
      cursor: decodePayoutCursor(result.nextCursor!)
    });
    const query = rendered(second.execute.mock.calls[0]![0] as SQL);
    expect(query.sql).toMatch(
      /where\s+\(payout\.provider_created_at,\s*payout\.id\)\s*<\s*\(\$\d+::timestamptz,\s*\$\d+::uuid\)/u
    );
    expect(query.params).toEqual(expect.arrayContaining([
      '2026-08-01T10:00:00.123456Z',
      rows[49]!.payoutId,
      PAYOUT_PAGE_SIZE + 1
    ]));
  });

  it('returns exact current, historical, and unavailable membership unions without private IDs', async () => {
    const historical = availablePayoutRow({
      payoutId: '33333333-3333-4333-8333-333333333333',
      status: 'failed',
      membershipComplete: false,
      financialGeneration: '3',
      membershipGeneration: '2',
      historicalMembershipRetained: true,
      safeFailureCode: 'provider_failed',
      reversalState: 'reversed'
    });
    const manual = unavailablePayoutRow({
      payoutId: '44444444-4444-4444-8444-444444444444'
    });
    const instant = unavailablePayoutRow({
      payoutId: '55555555-5555-4555-8555-555555555555',
      automatic: true,
      method: 'instant'
    });
    const database = fakeDatabase([{ rows: [availablePayoutRow(), historical, manual, instant] }]);

    const result = await listPayouts(database.db, ADMIN, { pageSize: PAYOUT_PAGE_SIZE });

    expect(result.payouts).toEqual([
      expect.objectContaining({
        payoutId: PAYOUT_ID,
        membershipComplete: true,
        membershipGeneration: 2,
        bookstoreLinkedSubtotalMinor: 1000
      }),
      expect.objectContaining({
        payoutId: historical.payoutId,
        membershipComplete: false,
        historicalMembershipRetained: true,
        reversalState: 'reversed'
      }),
      expect.objectContaining({
        payoutId: manual.payoutId,
        associatedTransactionCount: null,
        membershipGeneration: null
      }),
      expect.objectContaining({
        payoutId: instant.payoutId,
        bookstoreLinkedSubtotalMinor: null
      })
    ]);
    expect(Object.keys(result.payouts[0]!)).toEqual([
      'payoutId',
      'automatic',
      'method',
      'status',
      'reconciliationStatus',
      'settlementCurrency',
      'amountMinor',
      'createdAt',
      'arrivalAt',
      'associatedTransactionCount',
      'bookstoreLinkedTransactionCount',
      'membershipComplete',
      'bookstoreLinkedSubtotalMinor',
      'accountLevelAdjustmentCount',
      'accountLevelAdjustmentMinor',
      'safeFailureCode',
      'financialGeneration',
      'membershipGeneration',
      'historicalMembershipRetained',
      'reversalState',
      'openIssueCount',
      'freshnessAt'
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /providerId|stripeId|balanceTransactionId|sourceId|correlationId|customer|email/iu
    );
  });

  it.each([
    availablePayoutRow({ providerId: 'po_private' }),
    availablePayoutRow({ createdAtCursor: '2026-08-01T10:00:00.124456Z' }),
    availablePayoutRow({ financialGeneration: '-1' }),
    availablePayoutRow({ membershipComplete: true, membershipGeneration: '1' }),
    availablePayoutRow({ bookstoreLinkedTransactionCount: '4' }),
    unavailablePayoutRow({ associatedTransactionCount: '0' }),
    availablePayoutRow({ bookstoreLinkedSubtotalMinor: '9007199254740992' })
  ])('fails closed on impossible or extra database output', async (row) => {
    const database = fakeDatabase([{ rows: [row] }]);

    await expect(listPayouts(database.db, ADMIN, {
      pageSize: PAYOUT_PAGE_SIZE
    })).rejects.toMatchObject({
      name: 'FinancialPayoutReportingRepositoryError',
      message: 'Payout reporting data is temporarily unavailable.'
    });
  });

  it('keeps provider access out of the reporting module boundary', () => {
    const source = readFileSync(new URL('./payouts.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/gateway|stripe-sdk|STRIPE_SECRET|fetch\s*\(/u);
    expect(source).not.toMatch(/from ['"][^'"]*financial\/payouts/u);
  });
});

describe('audited local payout detail', () => {
  beforeEach(() => {
    collaborators.audit.mockReset().mockResolvedValue(undefined);
    collaborators.listRoles.mockReset().mockResolvedValue(['customer', 'admin']);
  });

  it('authorizes before parsing the payout ID or opening a transaction', async () => {
    const database = fakeDatabase([]);

    await expect(getPayoutDetail(
      database.db,
      { type: 'anonymous' },
      'private malformed value',
      { correlationId: 'payout-denied' }
    )).rejects.toMatchObject({ name: 'AuthorizationError', code: 'unauthenticated' });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('returns null for a malformed ID without querying after successful authorization', async () => {
    const database = fakeDatabase([]);

    await expect(getPayoutDetail(
      database.db,
      ADMIN,
      'NOT-A-CANONICAL-UUID',
      { correlationId: 'payout-malformed' }
    )).resolves.toBeNull();
    expect(database.transaction).not.toHaveBeenCalled();
    expect(collaborators.audit).not.toHaveBeenCalled();
  });

  it('locks roles, reloads and reauthorizes, builds the complete DTO, then audits in one transaction', async () => {
    const order: string[] = [];
    const database = fakeDatabase([]);
    database.execute.mockImplementation(async () => {
      const index = database.execute.mock.calls.length;
      order.push(index === 1 ? 'role-lock' : 'detail-query');
      return index === 1 ? { rows: [] } : { rows: [detailRow()] };
    });
    collaborators.listRoles.mockImplementation(async () => {
      order.push('role-reload');
      return ['customer', 'admin'];
    });
    collaborators.audit.mockImplementation(async () => {
      order.push('audit');
    });
    const context = {
      correlationId: 'payout-detail-1',
      requestMetadata: { method: 'GET' as const, routeId: '/admin/sales/payouts/[payoutId]' }
    };

    const result = await getPayoutDetail(database.db, ADMIN, PAYOUT_ID, context);

    expect(order).toEqual(['role-lock', 'role-reload', 'detail-query', 'audit']);
    expect(rendered(database.execute.mock.calls[0]![0] as SQL).sql).toContain(
      "pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))"
    );
    expect(collaborators.listRoles).toHaveBeenCalledWith(expect.any(Object), ADMIN_ID);
    expect(collaborators.audit).toHaveBeenCalledWith(expect.any(Object), {
      actor: { type: 'user', id: ADMIN_ID, roles: ['customer', 'admin'] },
      payoutId: PAYOUT_ID,
      context
    });
    expect(result).toMatchObject({
      payoutId: PAYOUT_ID,
      bookstoreLinkedSubtotalMinor: 1000,
      bookstoreLinkedFeeImpactMinor: -50,
      bookstoreLinkedNetMinor: 950,
      reversalAmountMinor: null
    });
    expect(Object.keys(result!)).toHaveLength(25);
    expect(JSON.stringify(result)).not.toContain('payout-detail-1');
  });

  it('returns signed failure reversal evidence and retains historical membership', async () => {
    const database = fakeDatabase([{ rows: [] }, { rows: [detailRow({
      status: 'canceled',
      membershipComplete: false,
      financialGeneration: '3',
      membershipGeneration: '2',
      historicalMembershipRetained: true,
      reversalState: 'reversed',
      reversalAmountMinor: '-930'
    })] }]);

    await expect(getPayoutDetail(
      database.db,
      ADMIN,
      PAYOUT_ID,
      { correlationId: 'payout-reversed' }
    )).resolves.toMatchObject({
      reversalState: 'reversed',
      reversalAmountMinor: -930,
      historicalMembershipRetained: true
    });
  });

  it.each([
    {
      label: 'reversed without an amount',
      overrides: {
        status: 'canceled',
        membershipComplete: false,
        financialGeneration: '3',
        membershipGeneration: '2',
        historicalMembershipRetained: true,
        reversalState: 'reversed',
        reversalAmountMinor: null
      }
    },
    {
      label: 'none with an amount',
      overrides: { reversalState: 'none', reversalAmountMinor: '-930' }
    },
    {
      label: 'incomplete with an amount',
      overrides: {
        status: 'canceled',
        membershipComplete: false,
        financialGeneration: '3',
        membershipGeneration: '2',
        historicalMembershipRetained: true,
        reversalState: 'incomplete',
        reversalAmountMinor: '-930'
      }
    }
  ])('rejects a reversal DTO that is $label', async ({ overrides }) => {
    const database = fakeDatabase([{ rows: [] }, { rows: [detailRow(overrides)] }]);

    await expect(getPayoutDetail(
      database.db,
      ADMIN,
      PAYOUT_ID,
      { correlationId: 'payout-invalid-reversal' }
    )).rejects.toMatchObject({
      name: 'FinancialPayoutReportingRepositoryError',
      message: 'Payout reporting data is temporarily unavailable.'
    });
    expect(collaborators.audit).not.toHaveBeenCalled();
  });

  it('returns null without an audit for missing payout detail', async () => {
    const database = fakeDatabase([{ rows: [] }, { rows: [] }]);

    await expect(getPayoutDetail(
      database.db,
      ADMIN,
      PAYOUT_ID,
      { correlationId: 'payout-missing' }
    )).resolves.toBeNull();
    expect(collaborators.audit).not.toHaveBeenCalled();
  });

  it('reauthorizes current persisted roles before reading payout data', async () => {
    collaborators.listRoles.mockResolvedValueOnce(['customer']);
    const database = fakeDatabase([{ rows: [] }]);

    await expect(getPayoutDetail(
      database.db,
      ADMIN,
      PAYOUT_ID,
      { correlationId: 'payout-demoted' }
    )).rejects.toMatchObject({ name: 'AuthorizationError', code: 'forbidden' });
    expect(database.execute).toHaveBeenCalledOnce();
    expect(collaborators.audit).not.toHaveBeenCalled();
  });

  it('returns no successful detail when the fixed audit call fails', async () => {
    collaborators.audit.mockRejectedValueOnce(new Error('private audit failure'));
    const database = fakeDatabase([{ rows: [] }, { rows: [detailRow()] }]);

    await expect(getPayoutDetail(
      database.db,
      ADMIN,
      PAYOUT_ID,
      { correlationId: 'payout-audit-failure' }
    )).rejects.toThrow('private audit failure');
    expect(collaborators.audit).toHaveBeenCalledOnce();
  });
});
