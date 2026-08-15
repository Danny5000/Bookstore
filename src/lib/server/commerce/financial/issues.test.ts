import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import {
  observeFinancialIssue,
  resolveFinancialIssueAfterRecompute,
  type FinancialIssueRow
} from './issues';

const RESOURCE_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value.replaceAll("'", "''")}'`
  });
}

function issue(overrides: Partial<FinancialIssueRow> = {}): FinancialIssueRow {
  return {
    id: ISSUE_ID, resourceType: 'payment', resourceId: RESOURCE_ID, safeCode: 'missing_source',
    state: 'open', impact: 'pending', firstObservedAt: new Date('2026-08-12T00:00:00.000Z'),
    lastObservedAt: new Date('2026-08-12T00:00:00.000Z'), occurrenceCount: 1,
    correlationId: 'observe-1', resolvedByAdminId: null, resolvedAt: null, ...overrides
  };
}

function executor(responses: Array<unknown[] | Error>) {
  const calls: SQL[] = [];
  return {
    calls,
    tx: {
      execute: async (query: SQL) => {
        calls.push(query);
        const response = responses.shift() ?? [];
        if (response instanceof Error) throw response;
        return { rows: response };
      }
    } as never
  };
}

function observe(overrides: Record<string, unknown> = {}) {
  return {
    resourceType: 'payment', resourceId: RESOURCE_ID, safeCode: 'missing_source', impact: 'pending',
    actor: { type: 'system', id: 'financial-worker' }, correlationId: 'observe-1', ...overrides
  } as never;
}

function resolve(status: 'resolved' | 'still_open', overrides: Record<string, unknown> = {}) {
  return {
    resourceType: 'payment', resourceId: RESOURCE_ID, safeCode: 'missing_source',
    proof: { status, resourceType: 'payment', resourceId: RESOURCE_ID, safeCode: 'missing_source' },
    actor: { type: 'system', id: 'financial-worker' }, correlationId: 'resolve-1', ...overrides
  } as never;
}

describe('financial issue lifecycle', () => {
  it.each([
    observe({ resourceType: 'order' }), observe({ safeCode: 'provider_not_ready' }),
    observe({ impact: 'fatal' }), observe({ resourceId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }),
    observe({ correlationId: '' }), observe({ correlationId: 'c'.repeat(101) }),
    observe({ message: 'provider detail' }), observe({ evidence: { raw: true } }),
    observe({ actor: { type: 'anonymous' } }), observe({ actor: { type: 'guest', id: 'g' } }),
    observe({ actor: { type: 'system', id: '' } }),
    observe({ actor: { type: 'user', id: 'not-a-uuid', roles: ['admin'] } }),
    observe({ actor: { type: 'user', id: USER_ID, roles: ['invented'] } })
  ])('rejects malformed or unsupported observations before querying', async (input) => {
    const database = executor([]);
    await expect(observeFinancialIssue(database.tx, input)).rejects.toMatchObject({ safeCode: 'unsupported_provider_evidence' });
    expect(database.calls).toHaveLength(0);
  });

  it('rejects inherited required fields that conceal unexpected own fields before querying', async () => {
    const input = Object.assign(
      Object.create({ safeCode: 'missing_source' }) as Record<string, unknown>,
      {
        resourceType: 'payment', resourceId: RESOURCE_ID, impact: 'pending',
        actor: { type: 'system', id: 'financial-worker' }, correlationId: 'observe-1', message: 'hidden extra'
      }
    );
    const database = executor([]);
    await expect(observeFinancialIssue(database.tx, input as never))
      .rejects.toMatchObject({ safeCode: 'unsupported_provider_evidence' });
    expect(database.calls).toHaveLength(0);
  });

  it('locks, opens, and atomically audits a new issue with only safe fields', async () => {
    const database = executor([[], [], [issue()], []]);
    await expect(observeFinancialIssue(database.tx, observe())).resolves.toEqual(issue());
    expect(database.calls).toHaveLength(4);
    const lock = rendered(database.calls[0]!);
    expect(lock.sql).toContain('pg_advisory_xact_lock');
    expect(lock.params).toContain(`pale-orbit:financial:issue:payment:${RESOURCE_ID}:missing_source`);
    const current = rendered(database.calls[1]!);
    expect(current.sql).toContain('financial_reconciliation_issues');
    expect(current.sql).toContain("state = 'open'");
    expect(current.sql).toContain('for update');
    const audit = rendered(database.calls[3]!);
    expect(audit.params).toContain('financial.issue.opened');
    expect(audit.params).toContain(ISSUE_ID);
    expect(audit.params).toContain(JSON.stringify({ resourceType: 'payment', resourceId: RESOURCE_ID, safeCode: 'missing_source', impact: 'pending', state: 'open', occurrenceCount: 1 }));
  });

  it('accepts immutable classification rows as version-exact issue resources', async () => {
    const classificationIssue = issue({
      resourceType: 'financial_classification', safeCode: 'unsupported_category',
      impact: 'exception'
    });
    const database = executor([[], [], [classificationIssue], []]);
    await expect(observeFinancialIssue(database.tx, observe({
      resourceType: 'financial_classification', safeCode: 'unsupported_category',
      impact: 'exception'
    }))).resolves.toEqual(classificationIssue);
    expect(rendered(database.calls[0]!).params).toContain(
      `pale-orbit:financial:issue:financial_classification:${RESOURCE_ID}:unsupported_category`
    );
  });

  it('increments a matching open issue without audit and clamps its occurrence count', async () => {
    const current = issue({ occurrenceCount: 2_147_483_647, correlationId: 'first-observation', resolvedByAdminId: USER_ID });
    const updated = issue({ occurrenceCount: 2_147_483_647, correlationId: 'first-observation', resolvedByAdminId: USER_ID, lastObservedAt: new Date('2026-08-12T00:01:00.000Z') });
    const database = executor([[], [current], [updated]]);
    await expect(observeFinancialIssue(database.tx, observe({ correlationId: 'later-observation' }))).resolves.toEqual(updated);
    expect(database.calls).toHaveLength(3);
    const update = rendered(database.calls[2]!);
    expect(update.sql).toContain('least');
    expect(update.sql).toContain('2147483647');
    expect(update.params).not.toContain('later-observation');
  });

  it('fails closed if an open identity is observed with a contradictory impact', async () => {
    const database = executor([[], [issue({ impact: 'pending' })]]);
    await expect(observeFinancialIssue(database.tx, observe({ impact: 'exception' }))).rejects.toMatchObject({ safeCode: 'immutable_mismatch' });
    expect(database.calls).toHaveLength(2);
  });

  it('reopens history as a distinct row and audit after resolved history is ignored', async () => {
    const newIssue = issue({ id: randomUUID(), correlationId: 'reopened' });
    const database = executor([[], [], [newIssue], []]);
    await expect(observeFinancialIssue(database.tx, observe({ correlationId: 'reopened' }))).resolves.toEqual(newIssue);
    expect(database.calls).toHaveLength(4);
  });

  it('requires an exact recomputation proof before touching the transaction', async () => {
    const invalid = executor([]);
    await expect(resolveFinancialIssueAfterRecompute(invalid.tx, resolve('resolved', {
      proof: { status: 'resolved', resourceType: 'refund', resourceId: RESOURCE_ID, safeCode: 'missing_source' }
    }))).rejects.toMatchObject({ safeCode: 'unsupported_provider_evidence' });
    await expect(resolveFinancialIssueAfterRecompute(invalid.tx, resolve('resolved', { resolver: USER_ID }))).rejects.toMatchObject({ safeCode: 'unsupported_provider_evidence' });
    expect(invalid.calls).toHaveLength(0);
  });

  it.each([
    { label: 'customer-only', roles: ['customer'] },
    { label: 'roleless', roles: [] }
  ])('rejects a $label user resolver before querying', async ({ roles }) => {
    const database = executor([]);
    await expect(resolveFinancialIssueAfterRecompute(database.tx, resolve('resolved', {
      actor: { type: 'user', id: USER_ID, roles }
    }))).rejects.toMatchObject({ safeCode: 'unsupported_provider_evidence' });
    expect(database.calls).toHaveLength(0);
  });

  it('does not resolve the immutable fact that a classification row was unsupported', async () => {
    const database = executor([]);
    await expect(resolveFinancialIssueAfterRecompute(database.tx, resolve('resolved', {
      resourceType: 'financial_classification', safeCode: 'unsupported_category',
      proof: { status: 'resolved', resourceType: 'financial_classification',
        resourceId: RESOURCE_ID, safeCode: 'unsupported_category' }
    }))).rejects.toMatchObject({ safeCode: 'unsupported_provider_evidence' });
    expect(database.calls).toHaveLength(0);

    await expect(resolveFinancialIssueAfterRecompute(database.tx, resolve('still_open', {
      resourceType: 'financial_classification', safeCode: 'unsupported_category',
      proof: { status: 'still_open', resourceType: 'financial_classification',
        resourceId: RESOURCE_ID, safeCode: 'unsupported_category' }
    }))).resolves.toBeNull();
  });

  it('treats still_open proof as a no-op', async () => {
    const database = executor([]);
    await expect(resolveFinancialIssueAfterRecompute(database.tx, resolve('still_open'))).resolves.toBeNull();
    expect(database.calls).toHaveLength(0);
  });

  it('resolves an open issue for a user actor and atomically audits it', async () => {
    const resolved = issue({ state: 'resolved', resolvedByAdminId: USER_ID, resolvedAt: new Date('2026-08-12T00:02:00.000Z') });
    const database = executor([[], [issue()], [resolved]]);
    await expect(resolveFinancialIssueAfterRecompute(database.tx, resolve('resolved', {
      actor: { type: 'user', id: USER_ID, roles: ['customer', 'admin'] }
    }))).resolves.toEqual(resolved);
    expect(database.calls).toHaveLength(3);
    const transition = rendered(database.calls[2]!);
    expect(transition.sql).toContain('resolve_financial_reconciliation_issue');
    expect(transition.sql).not.toContain('update financial_reconciliation_issues');
    expect(transition.params).toEqual([
      ISSUE_ID, USER_ID, 'user', USER_ID, 'resolve-1'
    ]);
  });

  it('resolves for a system actor without an administrator id and is idempotent for absent opens', async () => {
    const resolved = issue({ state: 'resolved', resolvedAt: new Date('2026-08-12T00:02:00.000Z') });
    const system = executor([[], [issue()], [resolved]]);
    await expect(resolveFinancialIssueAfterRecompute(system.tx, resolve('resolved'))).resolves.toEqual(resolved);
    expect(rendered(system.calls[2]!).params).toEqual([
      ISSUE_ID, null, 'system', 'financial-worker', 'resolve-1'
    ]);

    const missing = executor([[], []]);
    await expect(resolveFinancialIssueAfterRecompute(missing.tx, resolve('resolved'))).resolves.toBeNull();
    expect(missing.calls).toHaveLength(2);
  });

  it('propagates audit failures so the caller transaction can roll back', async () => {
    const database = executor([[], [], [issue()], new Error('audit unavailable')]);
    await expect(observeFinancialIssue(database.tx, observe())).rejects.toThrow('audit unavailable');
  });
});
