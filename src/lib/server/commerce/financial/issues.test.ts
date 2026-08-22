import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import {
  observeFinancialIssue,
  resolveFinancialIssueAfterAdminCommand,
  resolveFinancialIssueAfterRecompute,
  type FinancialIssueRow
} from './issues';

const RESOURCE_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const COMMAND_ID = '44444444-4444-4444-8444-aaaaaaaaaaaa';

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
    observe({ resourceType: 'payout', safeCode: 'classification_fork' }),
    observe({ resourceType: 'payment', safeCode: 'payout_incomplete' }),
    observe({ safeCode: 'missing_source', impact: 'exception' }),
    observe({ safeCode: 'immutable_mismatch', impact: 'pending' }),
    observe({
      resourceType: 'financial_classification',
      safeCode: 'unsupported_category',
      impact: 'informational'
    }),
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
    const database = executor([[], [issue({ impact: 'exception' })]]);
    await expect(observeFinancialIssue(database.tx, observe())).rejects.toMatchObject({ safeCode: 'immutable_mismatch' });
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
    await expect(resolveFinancialIssueAfterRecompute(invalid.tx, resolve('resolved', {
      resourceType: 'payout', safeCode: 'classification_fork',
      proof: { status: 'resolved', resourceType: 'payout', resourceId: RESOURCE_ID,
        safeCode: 'classification_fork' }
    }))).rejects.toMatchObject({ safeCode: 'unsupported_provider_evidence' });
    expect(invalid.calls).toHaveLength(0);
  });

  it.each([
    { label: 'customer-only', roles: ['customer'] },
    { label: 'roleless', roles: [] },
    { label: 'administrator', roles: ['admin'] },
    { label: 'customer administrator', roles: ['customer', 'admin'] }
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

  it('uses only the worker-only database transition and is idempotent for absent opens', async () => {
    const resolved = issue({ state: 'resolved', resolvedAt: new Date('2026-08-12T00:02:00.000Z') });
    const system = executor([[], [issue()], [resolved]]);
    await expect(resolveFinancialIssueAfterRecompute(system.tx, resolve('resolved'))).resolves.toEqual(resolved);
    const transition = rendered(system.calls[2]!);
    expect(transition.sql).toContain('resolve_financial_issue_after_worker_recompute');
    expect(transition.sql).not.toContain('resolve_financial_reconciliation_issue');
    expect(transition.sql).not.toContain('update financial_reconciliation_issues');
    expect(transition.params).toEqual([ISSUE_ID, 'resolve-1']);

    const missing = executor([[], []]);
    await expect(resolveFinancialIssueAfterRecompute(missing.tx, resolve('resolved'))).resolves.toBeNull();
    expect(missing.calls).toHaveLength(2);
  });

  it.each([
    { commandId: 'not-a-uuid', issueId: ISSUE_ID },
    { commandId: '00000000-0000-0000-0000-000000000000', issueId: ISSUE_ID },
    { commandId: COMMAND_ID.toUpperCase(), issueId: ISSUE_ID },
    { commandId: COMMAND_ID, issueId: 'not-a-uuid' },
    { commandId: COMMAND_ID, issueId: ISSUE_ID, resolver: USER_ID }
  ])('rejects malformed administrator command proof before querying', async (input) => {
    const database = executor([]);
    await expect(resolveFinancialIssueAfterAdminCommand(database.tx, input as never))
      .rejects.toMatchObject({ safeCode: 'unsupported_provider_evidence' });
    expect(database.calls).toHaveLength(0);
  });

  it('uses only the command-bound protected transition and verifies administrator attribution', async () => {
    const resolved = issue({
      resourceType: 'refund',
      state: 'resolved',
      resolvedByAdminId: USER_ID,
      resolvedAt: new Date('2026-08-12T00:02:00.000Z')
    });
    const database = executor([[resolved]]);

    await expect(resolveFinancialIssueAfterAdminCommand(database.tx, {
      commandId: COMMAND_ID,
      issueId: ISSUE_ID
    })).resolves.toEqual(resolved);

    expect(database.calls).toHaveLength(1);
    const transition = rendered(database.calls[0]!);
    expect(transition.sql).toContain('resolve_financial_issue_after_admin_command');
    expect(transition.sql).not.toContain('resolve_financial_issue_after_worker_recompute');
    expect(transition.sql).not.toContain('resolve_financial_reconciliation_issue');
    expect(transition.sql).not.toContain('update financial_reconciliation_issues');
    expect(transition.params).toEqual([COMMAND_ID, ISSUE_ID]);
  });

  it('is idempotent for an absent open issue and rejects unverified protected results', async () => {
    const missing = executor([[]]);
    await expect(resolveFinancialIssueAfterAdminCommand(missing.tx, {
      commandId: COMMAND_ID,
      issueId: ISSUE_ID
    })).resolves.toBeNull();

    for (const row of [
      issue({
        resourceType: 'refund',
        id: RESOURCE_ID,
        state: 'resolved',
        resolvedByAdminId: USER_ID,
        resolvedAt: new Date('2026-08-12T00:02:00.000Z')
      }),
      issue({ resourceType: 'refund', state: 'open' }),
      issue({ resourceType: 'refund', state: 'resolved', resolvedByAdminId: null,
        resolvedAt: new Date('2026-08-12T00:02:00.000Z') }),
      issue({ resourceType: 'refund', state: 'resolved', resolvedByAdminId: USER_ID,
        lastObservedAt: new Date('2026-08-12T00:03:00.000Z'),
        resolvedAt: new Date('2026-08-12T00:02:00.000Z') }),
      { ...issue({ resourceType: 'refund', state: 'resolved', resolvedByAdminId: USER_ID,
        resolvedAt: new Date('2026-08-12T00:02:00.000Z') }), providerPayload: true }
    ]) {
      const invalid = executor([[row]]);
      await expect(resolveFinancialIssueAfterAdminCommand(invalid.tx, {
        commandId: COMMAND_ID,
        issueId: ISSUE_ID
      })).rejects.toThrow('Financial administrator issue transition returned invalid data.');
    }

    const duplicate = issue({
      resourceType: 'refund', state: 'resolved', resolvedByAdminId: USER_ID,
      resolvedAt: new Date('2026-08-12T00:02:00.000Z')
    });
    const multiple = executor([[duplicate, duplicate]]);
    await expect(resolveFinancialIssueAfterAdminCommand(multiple.tx, {
      commandId: COMMAND_ID,
      issueId: ISSUE_ID
    })).rejects.toThrow('Financial administrator issue transition returned invalid data.');
  });

  it('propagates audit failures so the caller transaction can roll back', async () => {
    const database = executor([[], [], [issue()], new Error('audit unavailable')]);
    await expect(observeFinancialIssue(database.tx, observe())).rejects.toThrow('audit unavailable');
  });
});
