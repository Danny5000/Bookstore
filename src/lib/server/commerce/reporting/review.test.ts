import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, AdministratorActor } from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import {
  FINANCIAL_ISSUE_PAGE_SIZE,
  decodeFinancialIssueCursor,
  encodeFinancialIssueCursor,
  getFinancialIssueDetail,
  listFinancialIssues,
  parseFinancialIssueListInput
} from './review';

const collaborators = vi.hoisted(() => ({
  audit: vi.fn(),
  listRoles: vi.fn()
}));

vi.mock('$lib/server/auth/identity', () => ({
  listRolesForUser: collaborators.listRoles
}));

vi.mock('./audit', () => ({
  auditFinancialIssueDetailRead: collaborators.audit
}));

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const REFUND_ID = '33333333-3333-4333-8333-333333333333';
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

function issueRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issueId: ISSUE_ID,
    resourceType: 'refund',
    resourceId: REFUND_ID,
    safeCode: 'allocation_incomplete',
    state: 'open',
    impact: 'pending',
    firstObservedAt: new Date('2026-08-01T10:00:00.000Z'),
    firstObservedAtCursor: '2026-08-01T10:00:00.000000Z',
    lastObservedAt: new Date('2026-08-02T11:00:00.000Z'),
    occurrenceCount: '2',
    actionabilityRank: '0',
    impactRank: '1',
    refundId: REFUND_ID,
    ...overrides
  };
}

describe('financial issue queue input and cursor', () => {
  it('accepts only an optional single canonical cursor and fixes the page size at 50', () => {
    expect(parseFinancialIssueListInput(
      new URL('https://books.example.test/admin/sales/review')
    )).toEqual({ pageSize: FINANCIAL_ISSUE_PAGE_SIZE });

    const cursor = {
      actionabilityRank: 1 as const,
      impactRank: 0 as const,
      firstObservedAt: '2026-08-01T10:00:00.000000Z',
      issueId: ISSUE_ID
    };
    const encoded = encodeFinancialIssueCursor(cursor);
    expect(parseFinancialIssueListInput(
      new URL(`https://books.example.test/admin/sales/review?cursor=${encoded}`)
    )).toEqual({ pageSize: FINANCIAL_ISSUE_PAGE_SIZE, cursor });
    expect(decodeFinancialIssueCursor(encoded)).toEqual(cursor);
  });

  it.each([
    '?unknown=value',
    '?cursor=',
    '?cursor=first&cursor=second',
    '?cursor=not-canonical',
    `?cursor=${Buffer.from(JSON.stringify({
      version: 1,
      filterFingerprint: '0'.repeat(64),
      actionabilityRank: 0,
      impactRank: 0,
      firstObservedAt: '2026-08-01T10:00:00.000000Z',
      issueId: ISSUE_ID
    })).toString('base64url')}`
  ])('rejects malformed, duplicate, unknown, or foreign cursor input %s', (search) => {
    expect(() => parseFinancialIssueListInput(
      new URL(`https://books.example.test/admin/sales/review${search}`)
    )).toThrow(expect.objectContaining({
      name: 'SalesReportingInputError',
      code: 'invalid_request',
      status: 400
    }));
  });
});

describe('operational financial issue list', () => {
  beforeEach(() => {
    collaborators.audit.mockReset();
    collaborators.listRoles.mockReset();
  });

  it.each<Actor>([{ type: 'anonymous' }, CUSTOMER])(
    'authorizes before validating input or opening a transaction for $type',
    async (actor) => {
      const database = fakeDatabase([]);
      await expect(listFinancialIssues(database.db, actor, {
        pageSize: 51 as never
      })).rejects.toMatchObject({
        name: 'AuthorizationError',
        code: actor.type === 'anonymous' ? 'unauthenticated' : 'forbidden'
      });
      expect(database.transaction).not.toHaveBeenCalled();
    }
  );

  it('imports the shared operational authority and requests one bounded sentinel row', async () => {
    const database = fakeDatabase([{ rows: [] }]);

    await expect(listFinancialIssues(database.db, ADMIN, {
      pageSize: FINANCIAL_ISSUE_PAGE_SIZE
    })).resolves.toEqual({ issues: [], currentCursor: null, nextCursor: null });

    expect(database.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only'
    });
    const query = rendered(database.execute.mock.calls[0]![0] as SQL);
    expect(query.sql).toContain('financial_reconciliation_issues');
    expect(query.sql).toContain('financial_projection_versions');
    expect(query.sql).toContain('financial_classification_versions');
    expect(query.sql).toContain('financial_allocation_sets');
    expect(query.sql).toContain('supersedes_set_id');
    expect(query.sql).not.toContain('current_financial_projection_heads');
    expect(query.sql).toMatch(/limit\s+\$\d+/u);
    expect(query.params).toContain(FINANCIAL_ISSUE_PAGE_SIZE + 1);
    expect(collaborators.audit).not.toHaveBeenCalled();
  });

  it('maps only current ambiguous refunds to a named workflow descriptor and uses fixed safe copy', async () => {
    const database = fakeDatabase([{ rows: [
      issueRow(),
      issueRow({
        issueId: '44444444-4444-4444-8444-444444444444',
        resourceType: 'payment',
        resourceId: '55555555-5555-4555-8555-555555555555',
        safeCode: 'missing_source',
        actionabilityRank: '1',
        refundId: null
      }),
      issueRow({
        issueId: '66666666-6666-4666-8666-666666666666',
        resourceType: 'balance_transaction',
        resourceId: '77777777-7777-4777-8777-777777777777',
        safeCode: 'immutable_mismatch',
        impact: 'exception',
        actionabilityRank: '2',
        impactRank: '0',
        refundId: null
      })
    ] }]);

    const result = await listFinancialIssues(database.db, ADMIN, {
      pageSize: FINANCIAL_ISSUE_PAGE_SIZE
    });

    expect(result.issues).toEqual([
      {
        issueId: ISSUE_ID,
        resourceType: 'refund',
        resourceId: REFUND_ID,
        safeCode: 'allocation_incomplete',
        state: 'open',
        impact: 'pending',
        actionability: 'refund_allocation_review',
        operationallyCurrent: true,
        safeReason: 'A refund allocation needs review.',
        firstObservedAt: '2026-08-01T10:00:00.000Z',
        lastObservedAt: '2026-08-02T11:00:00.000Z',
        occurrenceCount: 2,
        refundId: REFUND_ID
      },
      expect.objectContaining({
        actionability: 'wait_for_recovery',
        safeReason: 'Required financial evidence is not available yet.',
        refundId: null
      }),
      expect.objectContaining({
        actionability: 'read_only',
        safeReason: 'Stored financial evidence conflicts with its immutable record.',
        refundId: null
      })
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /correlationId|providerId|stripeId|providerMessage|customerId|email/iu
    );
  });

  it('uses actionability, impact, first observation, and issue ID as one stable keyset', async () => {
    const rows = Array.from({ length: FINANCIAL_ISSUE_PAGE_SIZE + 1 }, (_, index) => issueRow({
      issueId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      resourceType: 'payment',
      resourceId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      safeCode: 'immutable_mismatch',
      impact: 'exception',
      firstObservedAt: new Date('2026-08-01T10:00:00.123Z'),
      firstObservedAtCursor: '2026-08-01T10:00:00.123456Z',
      actionabilityRank: '2',
      impactRank: '0',
      refundId: null
    }));
    const first = fakeDatabase([{ rows }]);
    const result = await listFinancialIssues(first.db, ADMIN, {
      pageSize: FINANCIAL_ISSUE_PAGE_SIZE
    });

    expect(result.issues).toHaveLength(FINANCIAL_ISSUE_PAGE_SIZE);
    expect(result.nextCursor).not.toBeNull();
    const cursor = decodeFinancialIssueCursor(result.nextCursor!);
    expect(cursor).toEqual({
      actionabilityRank: 2,
      impactRank: 0,
      firstObservedAt: '2026-08-01T10:00:00.123456Z',
      issueId: rows[49]!.issueId
    });

    const second = fakeDatabase([{ rows: [] }]);
    await listFinancialIssues(second.db, ADMIN, {
      pageSize: FINANCIAL_ISSUE_PAGE_SIZE,
      cursor
    });
    const query = rendered(second.execute.mock.calls[0]![0] as SQL);
    expect(query.sql).toMatch(/actionability_rank[\s\S]*impact_rank[\s\S]*first_observed_at[\s\S]*issue_id/u);
    expect(query.sql).toMatch(/order by[\s\S]*actionability_rank[\s\S]*impact_rank[\s\S]*first_observed_at[\s\S]*issue_id/u);
    expect(query.sql).toMatch(
      /order by[\s\S]*actionability_rank\s+asc[\s\S]*impact_rank\s+asc[\s\S]*first_observed_at\s+asc[\s\S]*issue_id\s+asc/u
    );
    expect(query.params).toEqual(expect.arrayContaining([
      2,
      0,
      '2026-08-01T10:00:00.123456Z',
      rows[49]!.issueId,
      FINANCIAL_ISSUE_PAGE_SIZE + 1
    ]));
  });

  it('fails closed on impossible database output', async () => {
    const database = fakeDatabase([{ rows: [issueRow({ occurrenceCount: '-1' })] }]);

    await expect(listFinancialIssues(database.db, ADMIN, {
      pageSize: FINANCIAL_ISSUE_PAGE_SIZE
    })).rejects.toMatchObject({
      name: 'FinancialReviewRepositoryError',
      message: 'Financial review data is temporarily unavailable.'
    });
  });

  it.each([
    issueRow({ actionabilityRank: '0', refundId: null }),
    issueRow({ actionabilityRank: '1', impact: 'exception', impactRank: '0', refundId: null }),
    issueRow({ impactRank: '2' }),
    issueRow({ firstObservedAtCursor: '2026-08-01T10:00:01.000000Z' })
  ])('fails closed when database rank aliases contradict the issue facts', async (row) => {
    const database = fakeDatabase([{ rows: [row] }]);

    await expect(listFinancialIssues(database.db, ADMIN, {
      pageSize: FINANCIAL_ISSUE_PAGE_SIZE
    })).rejects.toMatchObject({ name: 'FinancialReviewRepositoryError' });
  });
});

describe('audited financial issue detail', () => {
  beforeEach(() => {
    collaborators.audit.mockReset().mockResolvedValue(undefined);
    collaborators.listRoles.mockReset().mockResolvedValue(['customer', 'admin']);
  });

  it('authorizes before parsing the issue ID or opening a transaction', async () => {
    const database = fakeDatabase([]);

    await expect(getFinancialIssueDetail(
      database.db,
      { type: 'anonymous' },
      'private malformed value',
      { correlationId: 'review-denied' }
    )).rejects.toMatchObject({ name: 'AuthorizationError', code: 'unauthenticated' });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('returns null for a malformed ID without querying after successful authorization', async () => {
    const database = fakeDatabase([]);

    await expect(getFinancialIssueDetail(
      database.db,
      ADMIN,
      'NOT-A-CANONICAL-UUID',
      { correlationId: 'review-malformed' }
    )).resolves.toBeNull();
    expect(database.transaction).not.toHaveBeenCalled();
    expect(collaborators.audit).not.toHaveBeenCalled();
  });

  it('locks roles, reloads and reauthorizes, builds the DTO, then audits in the same transaction', async () => {
    const order: string[] = [];
    const database = fakeDatabase([{ rows: [] }, { rows: [issueRow()] }]);
    database.execute.mockImplementation(async (_query: SQL) => {
      const index = database.execute.mock.calls.length;
      order.push(index === 1 ? 'role-lock' : 'detail-query');
      return index === 1 ? { rows: [] } : { rows: [issueRow()] };
    });
    collaborators.listRoles.mockImplementation(async () => {
      order.push('role-reload');
      return ['customer', 'admin'];
    });
    collaborators.audit.mockImplementation(async () => {
      order.push('audit');
    });
    const context = {
      correlationId: 'review-detail-1',
      requestMetadata: { method: 'GET', routeId: '/admin/sales/review/[issueId]' }
    };

    const result = await getFinancialIssueDetail(database.db, ADMIN, ISSUE_ID, context);

    expect(order).toEqual(['role-lock', 'role-reload', 'detail-query', 'audit']);
    expect(rendered(database.execute.mock.calls[0]![0] as SQL).sql).toContain(
      "pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))"
    );
    expect(collaborators.listRoles).toHaveBeenCalledWith(expect.any(Object), ADMIN_ID);
    expect(collaborators.audit).toHaveBeenCalledWith(expect.any(Object), {
      actor: { type: 'user', id: ADMIN_ID, roles: ['customer', 'admin'] },
      issueId: ISSUE_ID,
      context
    });
    expect(result).toMatchObject({
      issueId: ISSUE_ID,
      actionability: 'refund_allocation_review',
      refundId: REFUND_ID
    });
    expect(JSON.stringify(result)).not.toContain('review-detail-1');
  });

  it('returns null without an audit for missing, resolved, or retired operational authority', async () => {
    const database = fakeDatabase([{ rows: [] }, { rows: [] }]);

    await expect(getFinancialIssueDetail(
      database.db,
      ADMIN,
      ISSUE_ID,
      { correlationId: 'review-missing' }
    )).resolves.toBeNull();
    expect(collaborators.audit).not.toHaveBeenCalled();
  });

  it('reauthorizes current persisted roles before reading issue data', async () => {
    collaborators.listRoles.mockResolvedValueOnce(['customer']);
    const database = fakeDatabase([{ rows: [] }]);

    await expect(getFinancialIssueDetail(
      database.db,
      ADMIN,
      ISSUE_ID,
      { correlationId: 'review-demoted' }
    )).rejects.toMatchObject({ name: 'AuthorizationError', code: 'forbidden' });
    expect(database.execute).toHaveBeenCalledOnce();
    expect(collaborators.audit).not.toHaveBeenCalled();
  });

  it('returns no successful detail when the fixed audit call fails', async () => {
    collaborators.audit.mockRejectedValueOnce(new Error('private audit failure'));
    const database = fakeDatabase([{ rows: [] }, { rows: [issueRow()] }]);

    await expect(getFinancialIssueDetail(
      database.db,
      ADMIN,
      ISSUE_ID,
      { correlationId: 'review-audit-failure' }
    )).rejects.toThrow('private audit failure');
    expect(collaborators.audit).toHaveBeenCalledOnce();
  });
});
