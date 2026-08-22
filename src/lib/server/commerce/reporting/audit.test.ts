import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import {
  auditFinancialExportCompleted,
  auditFinancialIssueDetailRead,
  auditFinancialPayoutDetailRead,
  auditFinancialRefundDetailRead,
  type FinancialExportAuditInput,
  type FinancialIssueReadAuditInput,
  type FinancialPayoutReadAuditInput,
  type FinancialRefundReadAuditInput
} from './audit';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const REFUND_ID = '33333333-3333-4333-8333-333333333333';
const PAYOUT_ID = '44444444-4444-4444-8444-444444444444';
const FINGERPRINT = 'a'.repeat(64);

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value.replaceAll("'", "''")}'`
  });
}

function transaction(result: unknown = { rows: [{ private: 'must-not-escape' }] }): {
  readonly tx: DatabaseTransaction;
  readonly execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { tx: { execute } as unknown as DatabaseTransaction, execute };
}

const actor = { type: 'user', id: ACTOR_ID, roles: ['admin'] as const } as const;

function issueInput(overrides: Record<string, unknown> = {}): FinancialIssueReadAuditInput {
  return {
    actor,
    issueId: ISSUE_ID,
    context: {
      correlationId: 'audit.issue-1',
      requestMetadata: { method: 'GET', routeId: '/admin/sales/review/[issueId]' }
    },
    ...overrides
  } as FinancialIssueReadAuditInput;
}

function refundInput(overrides: Record<string, unknown> = {}): FinancialRefundReadAuditInput {
  return {
    actor,
    refundId: REFUND_ID,
    context: {
      correlationId: 'audit.refund-1',
      requestMetadata: { method: 'GET', routeId: '/admin/sales/refunds/[refundId]' }
    },
    ...overrides
  } as FinancialRefundReadAuditInput;
}

function payoutInput(overrides: Record<string, unknown> = {}): FinancialPayoutReadAuditInput {
  return {
    actor,
    payoutId: PAYOUT_ID,
    context: {
      correlationId: 'audit.payout-1',
      requestMetadata: { method: 'GET', routeId: '/admin/sales/payouts/[payoutId]' }
    },
    ...overrides
  } as FinancialPayoutReadAuditInput;
}

function exportInput(overrides: Record<string, unknown> = {}): FinancialExportAuditInput {
  return {
    actor,
    filterFingerprint: FINGERPRINT,
    rowCount: 12,
    byteCount: 3_456,
    currencyPairCount: 2,
    context: {
      correlationId: 'audit.export-1',
      requestMetadata: { method: 'GET', routeId: '/admin/sales/export.csv' }
    },
    ...overrides
  } as FinancialExportAuditInput;
}

describe('fixed-action financial reporting audit clients', () => {
  it('calls only the issue-view scalar routine with fixed safe request metadata', async () => {
    const database = transaction();

    await expect(auditFinancialIssueDetailRead(database.tx, issueInput())).resolves.toBeUndefined();

    expect(database.execute).toHaveBeenCalledTimes(1);
    const query = rendered(database.execute.mock.calls[0]![0] as SQL);
    expect(query.sql).toMatch(/^select public\.append_financial_issue_view_audit\(/u);
    expect(query.params).toEqual([
      ACTOR_ID,
      ISSUE_ID,
      'audit.issue-1',
      'GET',
      `/admin/sales/issues/${ISSUE_ID}`
    ]);
    expect(`${query.sql}\n${query.params.join('\n')}`).not.toContain('financial.issue.view');
  });

  it('calls only the refund-review-view scalar routine with its exact resource route', async () => {
    const database = transaction();

    await expect(auditFinancialRefundDetailRead(database.tx, refundInput())).resolves.toBeUndefined();

    expect(database.execute).toHaveBeenCalledTimes(1);
    const query = rendered(database.execute.mock.calls[0]![0] as SQL);
    expect(query.sql).toMatch(/^select public\.append_financial_refund_review_view_audit\(/u);
    expect(query.params).toEqual([
      ACTOR_ID,
      REFUND_ID,
      'audit.refund-1',
      'GET',
      `/admin/sales/refunds/${REFUND_ID}`
    ]);
    expect(`${query.sql}\n${query.params.join('\n')}`).not.toContain('financial.refund_review.view');
  });

  it('calls only the payout-view scalar routine with its exact resource route', async () => {
    const database = transaction();

    await expect(auditFinancialPayoutDetailRead(database.tx, payoutInput())).resolves.toBeUndefined();

    expect(database.execute).toHaveBeenCalledTimes(1);
    const query = rendered(database.execute.mock.calls[0]![0] as SQL);
    expect(query.sql).toMatch(/^select public\.append_financial_payout_view_audit\(/u);
    expect(query.params).toEqual([
      ACTOR_ID,
      PAYOUT_ID,
      'audit.payout-1',
      'GET',
      `/admin/sales/payouts/${PAYOUT_ID}`
    ]);
    expect(`${query.sql}\n${query.params.join('\n')}`).not.toContain('financial.payout.view');
  });

  it('calls only the export scalar routine with a fingerprint and bounded counts', async () => {
    const database = transaction();

    await expect(auditFinancialExportCompleted(database.tx, exportInput())).resolves.toBeUndefined();

    expect(database.execute).toHaveBeenCalledTimes(1);
    const query = rendered(database.execute.mock.calls[0]![0] as SQL);
    expect(query.sql).toMatch(/^select public\.append_financial_sales_export_audit\(/u);
    expect(query.params).toEqual([
      ACTOR_ID,
      FINGERPRINT,
      'audit.export-1',
      12,
      3_456,
      2,
      'GET',
      '/admin/sales/export.csv'
    ]);
    expect(`${query.sql}\n${query.params.join('\n')}`).not.toContain('financial.sales_export');
    expect(query.params.every((value) => value === null || typeof value !== 'object')).toBe(true);
  });

  it('derives fixed GET metadata when the optional request metadata is absent', async () => {
    const database = transaction();
    const input = issueInput({ context: { correlationId: 'audit.issue-without-metadata' } });

    await expect(auditFinancialIssueDetailRead(database.tx, input)).resolves.toBeUndefined();

    expect(rendered(database.execute.mock.calls[0]![0] as SQL).params).toEqual([
      ACTOR_ID,
      ISSUE_ID,
      'audit.issue-without-metadata',
      'GET',
      `/admin/sales/issues/${ISSUE_ID}`
    ]);
  });

  it.each([
    ['noncanonical resource UUID', issueInput({ issueId: `${ISSUE_ID.slice(0, -1)}A` })],
    ['noncanonical actor UUID', issueInput({
      actor: { ...actor, id: `${ACTOR_ID.slice(0, -1)}A` }
    })],
    ['non-administrator actor', issueInput({ actor: { ...actor, roles: ['customer'] } })],
    ['duplicate role', issueInput({ actor: { ...actor, roles: ['admin', 'admin'] } })],
    ['unsafe correlation', issueInput({ context: { correlationId: 'private canary!' } })],
    ['oversized correlation', issueInput({ context: { correlationId: `a${'b'.repeat(100)}` } })],
    ['caller-selected action', issueInput({ action: 'financial.sales_export' })],
    ['caller-selected JSON', issueInput({ metadata: { private: 'canary' } })],
    ['extra context key', issueInput({ context: { correlationId: 'audit-1', request: 'private' } })],
    ['wrong request method', issueInput({
      context: {
        correlationId: 'audit-1',
        requestMetadata: { method: 'POST', routeId: '/admin/sales/review/[issueId]' }
      }
    })],
    ['wrong request route', issueInput({
      context: {
        correlationId: 'audit-1',
        requestMetadata: { method: 'GET', routeId: '/admin/sales/export.csv' }
      }
    })],
    ['extra request metadata', issueInput({
      context: {
        correlationId: 'audit-1',
        requestMetadata: {
          method: 'GET',
          routeId: '/admin/sales/review/[issueId]',
          body: 'private canary'
        }
      }
    })]
  ])('rejects %s before database work', async (_name, input) => {
    const database = transaction();

    await expect(auditFinancialIssueDetailRead(database.tx, input)).rejects.toMatchObject({
      name: 'SalesReportingInputError',
      code: 'invalid_request',
      status: 400,
      message: 'The sales reporting request is invalid.'
    });
    expect(database.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['noncanonical fingerprint', exportInput({ filterFingerprint: FINGERPRINT.toUpperCase() })],
    ['negative row count', exportInput({ rowCount: -1 })],
    ['fractional byte count', exportInput({ byteCount: 1.5 })],
    ['oversized currency-pair count', exportInput({ currencyPairCount: 2_147_483_648 })],
    ['unsafe row count', exportInput({ rowCount: Number.MAX_SAFE_INTEGER + 1 })],
    ['CSV contents', exportInput({ bytes: new Uint8Array([112, 114, 105, 118, 97, 116, 101]) })]
  ])('rejects export %s before database work', async (_name, input) => {
    const database = transaction();

    await expect(auditFinancialExportCompleted(database.tx, input)).rejects.toMatchObject({
      name: 'SalesReportingInputError',
      code: 'invalid_request',
      status: 400
    });
    expect(database.execute).not.toHaveBeenCalled();
  });

  it('contains accessor and proxy failures without evaluating or exposing private values', async () => {
    const accessor = issueInput() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, 'issueId', {
      enumerable: true,
      get() {
        throw new Error('private-accessor-canary');
      }
    });
    const proxy = new Proxy(issueInput(), {
      ownKeys() {
        throw new Error('private-proxy-canary');
      }
    });

    for (const [input, canary] of [
      [accessor, 'private-accessor-canary'],
      [proxy, 'private-proxy-canary']
    ] as const) {
      const database = transaction();
      let caught: unknown;
      try {
        await auditFinancialIssueDetailRead(database.tx, input as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        name: 'SalesReportingInputError',
        message: 'The sales reporting request is invalid.'
      });
      expect(String((caught as Error).message)).not.toContain(canary);
      expect(caught).not.toHaveProperty('cause');
      expect(database.execute).not.toHaveBeenCalled();
    }
  });

  it('sanitizes a database failure and never returns a raw scalar result', async () => {
    const rawFailure = Object.assign(new Error('private-database-canary'), {
      cause: { detail: 'raw database detail' }
    });
    const database = transaction(rawFailure);

    let caught: unknown;
    try {
      await auditFinancialRefundDetailRead(database.tx, refundInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'FinancialReportingAuditError',
      message: 'The financial reporting audit could not be recorded.'
    });
    expect(String((caught as Error).message)).not.toContain('private-database-canary');
    expect(caught).not.toHaveProperty('cause');
    expect(database.execute).toHaveBeenCalledTimes(1);
  });
});
