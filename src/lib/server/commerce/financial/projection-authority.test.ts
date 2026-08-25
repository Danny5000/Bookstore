import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { PermanentFinancialError } from './errors';
import {
  loadFinancialProjectionAuthority,
  lockFinancialProjectionAuthority,
  lockFinancialProjectionEnrollment
} from './projection-authority';

const dialect = new PgDialect();
const active = { classifierVersion: 1, allocationAlgorithmVersion: 1 };
const canonicalActive = {
  ...active,
  pendingClassifierVersion: null,
  pendingAllocationAlgorithmVersion: null,
  pendingReplayId: null,
  pendingScanRunId: null
};
const validPending = {
  ...active,
  pendingClassifierVersion: 2,
  pendingAllocationAlgorithmVersion: 3,
  pendingReplayId: 'c2-a3',
  pendingScanRunId: '00000000-0000-4000-8000-000000000001'
};
const authorityQuery = 'select classifier_version as "classifierVersion", ' +
  'allocation_algorithm_version as "allocationAlgorithmVersion", ' +
  'pending_classifier_version as "pendingClassifierVersion", ' +
  'pending_allocation_algorithm_version as "pendingAllocationAlgorithmVersion", ' +
  'pending_replay_id as "pendingReplayId", pending_scan_run_id as "pendingScanRunId" ' +
  'from financial_projection_versions where singleton = true';

function executor(result: unknown = { rows: [active] }): {
  readonly transaction: DatabaseTransaction;
  readonly execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn().mockResolvedValue(result);
  return { transaction: { execute } as unknown as DatabaseTransaction, execute };
}

function rendered(query: unknown): { readonly sql: string; readonly params: unknown[] } {
  const compiled = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]);
  return {
    sql: compiled.sql.replaceAll(/\s+/gu, ' ').trim(),
    params: compiled.params
  };
}

async function expectInvalid(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
    throw new Error('Expected projection authority validation to reject.');
  } catch (error) {
    expect(error).toBeInstanceOf(PermanentFinancialError);
    expect((error as PermanentFinancialError).safeCode).toBe('source_linkage_mismatch');
  }
}

describe('financial projection authority', () => {
  it('canonicalizes omitted pending fields to null and tolerates provider columns', async () => {
    const { transaction } = executor({ rows: [{ ...active, providerColumn: 'ignored' }] });

    await expect(loadFinancialProjectionAuthority(transaction)).resolves.toEqual(canonicalActive);
  });

  it('preserves a valid all-present pending tuple', async () => {
    const { transaction } = executor({ rows: [validPending] });

    await expect(loadFinancialProjectionAuthority(transaction)).resolves.toEqual(validPending);
  });

  it.each([
    ['load', loadFinancialProjectionAuthority, authorityQuery],
    ['lock', lockFinancialProjectionAuthority, `${authorityQuery} for update`]
  ] as const)('%s issues one exact six-column parameterless query', async (
    _name,
    operation,
    expectedSql
  ) => {
    const { transaction, execute } = executor();

    await operation(transaction);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(rendered(execute.mock.calls[0]![0])).toEqual({ sql: expectedSql, params: [] });
  });

  it('uses the exact projection-enrollment advisory transaction lock', async () => {
    const { transaction, execute } = executor({ rows: [] });

    await lockFinancialProjectionEnrollment(transaction);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(rendered(execute.mock.calls[0]![0])).toEqual({
      sql: 'select pg_advisory_xact_lock(hashtextextended( $1, 0 ))',
      params: ['pale-orbit:financial:replay-enrollment']
    });
  });

  it.each([
    ['zero classifier', { classifierVersion: 0 }],
    ['fractional classifier', { classifierVersion: 1.5 }],
    ['unsafe classifier', { classifierVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ['above-int32 classifier', { classifierVersion: 2_147_483_648 }],
    ['zero allocation', { allocationAlgorithmVersion: 0 }],
    ['fractional allocation', { allocationAlgorithmVersion: 1.5 }],
    ['above-int32 allocation', { allocationAlgorithmVersion: 2_147_483_648 }]
  ])('rejects an invalid active version: %s', async (_name, override) => {
    const { transaction } = executor({ rows: [{ ...active, ...override }] });

    await expectInvalid(loadFinancialProjectionAuthority(transaction));
  });

  it.each([
    ['no row', []],
    ['duplicate rows', [active, active]],
    ['partial pending tuple', [{ ...active, pendingClassifierVersion: 2 }]],
    ['zero pending classifier', [{ ...validPending,
      pendingClassifierVersion: 0, pendingReplayId: 'c0-a3' }]],
    ['string pending allocation', [{ ...validPending, pendingAllocationAlgorithmVersion: '3' }]],
    ['mismatched replay id', [{ ...validPending, pendingReplayId: 'c2-a4' }]],
    ['uppercase UUID', [{ ...validPending,
      pendingScanRunId: '00000000-0000-4000-8000-00000000000A' }]],
    ['regressing classifier', [{ ...validPending, classifierVersion: 3 }]],
    ['regressing allocation', [{ ...validPending, allocationAlgorithmVersion: 4 }]],
    ['target equal active pair', [{ ...validPending,
      classifierVersion: 2, allocationAlgorithmVersion: 3 }]]
  ])('rejects an invalid authority result: %s', async (_name, rows) => {
    const { transaction } = executor({ rows });

    await expectInvalid(loadFinancialProjectionAuthority(transaction));
  });

  it('treats a missing rows property as no authority rows', async () => {
    const { transaction } = executor({});

    await expectInvalid(loadFinancialProjectionAuthority(transaction));
  });

  it.each([
    ['load', loadFinancialProjectionAuthority],
    ['lock', lockFinancialProjectionAuthority],
    ['enrollment', lockFinancialProjectionEnrollment]
  ] as const)('propagates %s executor rejection by identity', async (_name, operation) => {
    const rejection = new Error('executor rejected');
    const execute = vi.fn().mockRejectedValue(rejection);
    const transaction = { execute } as unknown as DatabaseTransaction;

    await expect(operation(transaction)).rejects.toBe(rejection);
  });
});
