import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { lockFinancialProjectionRows, lockPayoutImportRows } from './locks';
import { PermanentFinancialError, RetryableFinancialError } from './errors';
import type { FinancialIssueCode } from './types';

const PAYOUT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const BT_A = '33333333-3333-4333-8333-333333333333';
const BT_B = '44444444-4444-4444-8444-444444444444';
const FEE_A = '55555555-5555-4555-8555-555555555555';
const ALL_FINANCIAL_ISSUE_CODES = [
  'allocation_fork', 'allocation_incomplete', 'allocation_mismatch', 'classification_fork',
  'correction_rebase_required', 'currency_mismatch', 'generation_exhausted', 'immutable_mismatch',
  'missing_source', 'payout_incomplete', 'payout_membership_conflict',
  'payout_reversal_incomplete', 'source_linkage_mismatch', 'unsupported_category'
] as const satisfies readonly FinancialIssueCode[];

function rendered(query: SQL): string {
  return query.toQuery({ casing: {} as never, escapeName: (name) => `"${name}"`, escapeParam: (index) => `$${index + 1}`, escapeString: (value) => `'${value}'` }).sql;
}

function executor(responses: Array<unknown[] | Error> = []) {
  const calls: SQL[] = [];
  return {
    calls,
    tx: { execute: async (query: SQL) => {
      calls.push(query);
      const response = responses.shift() ?? [];
      if (response instanceof Error) throw response;
      return { rows: response };
    } } as never
  };
}

describe('financial lock ordering', () => {
  it('rejects malformed lock identities before issuing any query', async () => {
    const database = executor();
    await expect(lockFinancialProjectionRows(database.tx, {
      payoutGenerations: [{ payoutId: PAYOUT_ID.toUpperCase(), expectedGeneration: 0 }],
      balanceTransactionIds: [BT_A], classifierVersion: 0,
      issueKeys: []
    })).rejects.toBeInstanceOf(PermanentFinancialError);
    expect(database.calls).toHaveLength(0);

    await expect(lockFinancialProjectionRows(database.tx, {
      payoutGenerations: [{ payoutId: PAYOUT_ID, expectedGeneration: 1 }, { payoutId: PAYOUT_ID, expectedGeneration: 2 }],
      balanceTransactionIds: [BT_A], classifierVersion: 1, issueKeys: []
    })).rejects.toBeInstanceOf(PermanentFinancialError);
    await expect(lockFinancialProjectionRows(database.tx, {
      payoutGenerations: [], balanceTransactionIds: [BT_A], classifierVersion: 1,
      issueKeys: [{ resourceType: 'balance_transaction', resourceId: BT_A, safeCode: 'missing_source', extra: true }]
    } as never)).rejects.toBeInstanceOf(PermanentFinancialError);
    const inherited = Object.create({ issueKeys: [] });
    Object.assign(inherited, { payoutGenerations: [], balanceTransactionIds: [BT_A], classifierVersion: 1 });
    await expect(lockFinancialProjectionRows(database.tx, inherited)).rejects.toBeInstanceOf(PermanentFinancialError);
    await expect(lockFinancialProjectionRows(database.tx, {
      payoutGenerations: [], balanceTransactionIds: [BT_A], classifierVersion: 1, issueKeys: [], [Symbol('extra')]: true
    } as never)).rejects.toBeInstanceOf(PermanentFinancialError);
    expect(database.calls).toHaveLength(0);
  });

  it('fails closed with state_changed when requested locked rows are missing or stale', async () => {
    const payoutMissing = executor([[], []]);
    await expect(lockFinancialProjectionRows(payoutMissing.tx, {
      payoutGenerations: [{ payoutId: PAYOUT_ID, expectedGeneration: 3 }], balanceTransactionIds: [BT_A], classifierVersion: 1, issueKeys: []
    })).rejects.toMatchObject({ safeCode: 'state_changed' });

    const btMissing = executor([[], []]);
    await expect(lockFinancialProjectionRows(btMissing.tx, {
      payoutGenerations: [], balanceTransactionIds: [BT_A], classifierVersion: 1, issueKeys: []
    })).rejects.toBeInstanceOf(RetryableFinancialError);

    const importMissing = executor([[], []]);
    await expect(lockPayoutImportRows(importMissing.tx, { payoutId: PAYOUT_ID, runId: RUN_ID, expectedGeneration: 3 }))
      .rejects.toMatchObject({ safeCode: 'state_changed' });

    const runMissing = executor([[], [{ id: PAYOUT_ID, financialGeneration: 3 }], [], []]);
    await expect(lockPayoutImportRows(runMissing.tx, { payoutId: PAYOUT_ID, runId: RUN_ID, expectedGeneration: 3 }))
      .rejects.toMatchObject({ safeCode: 'state_changed' });
  });

  it('supports payout-only and fully empty projections without rendering IN ()', async () => {
    const payoutOnly = executor([[], [{ id: PAYOUT_ID, financialGeneration: 3 }], [], [], [], [], [], []]);
    await expect(lockFinancialProjectionRows(payoutOnly.tx, {
      payoutGenerations: [{ payoutId: PAYOUT_ID, expectedGeneration: 3 }], balanceTransactionIds: [], classifierVersion: 1, issueKeys: []
    })).resolves.toMatchObject({ payouts: [{ id: PAYOUT_ID, financialGeneration: 3 }], balanceTransactions: [] });
    expect(payoutOnly.calls.map(rendered).join('\n')).not.toContain('in ()');

    const empty = executor();
    await expect(lockFinancialProjectionRows(empty.tx, {
      payoutGenerations: [], balanceTransactionIds: [], classifierVersion: 1, issueKeys: []
    })).resolves.toMatchObject({ payouts: [], balanceTransactions: [] });
    expect(empty.calls.map(rendered).join('\n')).not.toContain('in ()');
  });

  it('fails closed when membership discovery expands beyond the requested payout and balance-transaction closure', async () => {
    const newlyApplicablePayout = executor([
      [], [], [{ id: BT_A, fingerprintSha256: 'a'.repeat(64) }],
      [{ payoutId: PAYOUT_ID, balanceTransactionId: BT_A }]
    ]);
    await expect(lockFinancialProjectionRows(newlyApplicablePayout.tx, {
      payoutGenerations: [], balanceTransactionIds: [BT_A], classifierVersion: 1, issueKeys: []
    })).rejects.toMatchObject({ safeCode: 'state_changed' });

    const payoutOnlyMissingTransaction = executor([
      [], [{ id: PAYOUT_ID, financialGeneration: 3 }], [],
      [{ payoutId: PAYOUT_ID, balanceTransactionId: BT_A }]
    ]);
    await expect(lockFinancialProjectionRows(payoutOnlyMissingTransaction.tx, {
      payoutGenerations: [{ payoutId: PAYOUT_ID, expectedGeneration: 3 }],
      balanceTransactionIds: [], classifierVersion: 1, issueKeys: []
    })).rejects.toMatchObject({ safeCode: 'state_changed' });
  });

  it('uses deterministic ASCII order for payout and issue lock identities without locale collation', async () => {
    const database = executor([
      [], [], [
        { id: PAYOUT_ID, financialGeneration: 3 },
        { id: RUN_ID, financialGeneration: 4 }
      ], [], [], [], [], [], [], [], [], []
    ]);
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => { throw new Error('locale ordering is not deterministic'); });
    try {
      await lockFinancialProjectionRows(database.tx, {
        payoutGenerations: [
          { payoutId: RUN_ID, expectedGeneration: 4 },
          { payoutId: PAYOUT_ID, expectedGeneration: 3 }
        ],
        balanceTransactionIds: [],
        classifierVersion: 1,
        issueKeys: [
          { resourceType: 'refund', resourceId: RUN_ID, safeCode: 'unsupported_category' },
          { resourceType: 'payment', resourceId: PAYOUT_ID, safeCode: 'currency_mismatch' }
        ]
      });
    } finally {
      localeCompare.mockRestore();
    }
    const parameters = database.calls.flatMap((query) => query.toQuery({
      casing: {} as never,
      escapeName: (name) => `"${name}"`,
      escapeParam: (index) => `$${index + 1}`,
      escapeString: (value) => `'${value}'`
    }).params);
    expect(parameters.filter((value) => typeof value === 'string' && value.startsWith('pale-orbit:financial:payout:'))).toEqual([
      `pale-orbit:financial:payout:${PAYOUT_ID}`,
      `pale-orbit:financial:payout:${RUN_ID}`
    ]);
    expect(parameters.filter((value) => typeof value === 'string' && value.startsWith('pale-orbit:financial:issue:'))).toEqual([
      `pale-orbit:financial:issue:payment:${PAYOUT_ID}:currency_mismatch`,
      `pale-orbit:financial:issue:refund:${RUN_ID}:unsupported_category`
    ]);
  });

  it('deduplicates and locks projection rows in published payout-to-issue order', async () => {
    const classification = {
      id: RUN_ID, subjectType: 'fee_detail', subjectId: FEE_A, classifierVersion: 2,
      sourceFingerprintSha256: 'c'.repeat(64), classification: 'unknown'
    };
    const database = executor([
      [], [{ id: PAYOUT_ID, financialGeneration: 3 }], [], [],
      [{ id: BT_A, fingerprintSha256: 'a'.repeat(64) }, { id: BT_B, fingerprintSha256: 'b'.repeat(64) }],
      [], [{ id: FEE_A, balanceTransactionId: BT_A }], [], [], [], [classification],
      [], [], [], [], [], [], [], []
    ]);
    const locked = await lockFinancialProjectionRows(database.tx, {
      payoutGenerations: [{ payoutId: PAYOUT_ID, expectedGeneration: 3 }, { payoutId: PAYOUT_ID, expectedGeneration: 3 }],
      balanceTransactionIds: [BT_B, BT_A, BT_B], classifierVersion: 2,
      issueKeys: [{ resourceType: 'balance_transaction', resourceId: BT_B, safeCode: 'missing_source' }]
    });
    const queries = database.calls.map(rendered).join('\n');
    const parameters = database.calls.flatMap((query) => query.toQuery({ casing: {} as never, escapeName: (name) => `"${name}"`, escapeParam: (index) => `$${index + 1}`, escapeString: (value) => `'${value}'` }).params);
    const positions = ['stripe_payouts', 'stripe_balance_transactions', 'stripe_payout_balance_transactions', 'financial_classification_versions', 'financial_allocation_sets', 'financial_item_allocations', 'financial_reconciliation_issues'].map((table) => queries.indexOf(table));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(queries).toContain('pg_advisory_xact_lock');
    expect(queries).toContain('for update');
    expect(queries).toContain('hashtext');
    const payoutRead = database.calls.map(rendered).find((query) => query.includes('from stripe_payouts') && query.includes('where id in'));
    expect(payoutRead).toContain('order by id for update');
    expect(parameters).toContain(`pale-orbit:financial:classification:balance_transaction:${BT_A}`);
    expect(parameters).not.toContain(`pale-orbit:financial:classification:balance_transaction:${BT_A}:2`);
    expect(parameters).toContain(`pale-orbit:financial:allocation:${BT_A}:gross_amount`);
    expect(parameters).toContain(`pale-orbit:financial:allocation:${BT_A}:fee`);
    expect(queries).toContain('source_fingerprint_sha256 as "sourceFingerprintSha256"');
    expect(queries).toContain('classification');
    expect(queries).toContain('subject_type as "subjectType"');
    expect(queries).toContain("subject_type = 'balance_transaction' and subject_id in");
    expect(queries).toContain("subject_type = 'fee_detail' and subject_id in");
    expect(parameters).toContain(`pale-orbit:financial:classification:fee_detail:${FEE_A}`);
    expect(locked.classifications).toEqual([classification]);
  });

  it('locks fresh payout import rows without accepting a purchase callback and returns both generations and state', async () => {
    const database = executor([
      [], [{ id: PAYOUT_ID, financialGeneration: 3 }], [],
      [{ id: RUN_ID, generation: 3, state: 'publishable' }],
      [{ balanceTransactionId: BT_A }], [], [{ id: BT_A }], [],
      ...ALL_FINANCIAL_ISSUE_CODES.map(() => []), [{ id: FEE_A }]
    ]);
    const locked = await lockPayoutImportRows(database.tx, { payoutId: PAYOUT_ID, runId: RUN_ID, expectedGeneration: 3 });
    const queries = database.calls.map(rendered).join('\n');
    const parameters = database.calls.flatMap((query) => query.toQuery({ casing: {} as never, escapeName: (name) => `"${name}"`, escapeParam: (index) => `$${index + 1}`, escapeString: (value) => `'${value}'` }).params);
    const positions = ['stripe_payouts', 'payout_import_runs', 'payout_import_run_entries', 'stripe_balance_transactions', 'stripe_payout_balance_transactions', 'financial_reconciliation_issues'].map((table) => queries.indexOf(table));
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(queries).toContain('financial_generation');
    expect(queries).toContain('for update');
    expect(queries).not.toContain('join stripe_balance_transactions bt');
    expect(queries).toContain("resource_type = 'payout'");
    const issueAdvisoryKeys = ALL_FINANCIAL_ISSUE_CODES
      .map((safeCode) => `pale-orbit:financial:issue:payout:${PAYOUT_ID}:${safeCode}`);
    const advisoryPositions = issueAdvisoryKeys.map((key) => parameters.indexOf(key));
    expect(advisoryPositions.every((position) => position >= 0)).toBe(true);
    expect(advisoryPositions).toEqual([...advisoryPositions].sort((left, right) => left - right));
    expect(parameters).toContain(`pale-orbit:financial:issue:payout:${PAYOUT_ID}:currency_mismatch`);
    expect(parameters).toContain(`pale-orbit:financial:issue:payout:${PAYOUT_ID}:missing_source`);
    expect(parameters).toContain(`pale-orbit:financial:issue:payout:${PAYOUT_ID}:unsupported_category`);
    expect(locked).toMatchObject({
      disposition: 'fresh',
      payoutFinancialGeneration: 3,
      runGeneration: 3,
      runState: 'publishable',
      issueIds: [FEE_A]
    });
    const payoutRead = database.calls.map(rendered)
      .find((query) => query.includes('from stripe_payouts'));
    const runRead = database.calls.map(rendered)
      .find((query) => query.includes('from payout_import_runs'));
    expect(payoutRead).not.toContain('financial_generation =');
    expect(runRead).not.toContain('generation =');
  });

  it('returns stale after locking payout and run when either generation no longer matches', async () => {
    const database = executor([
      [], [{ id: PAYOUT_ID, financialGeneration: 3 }], [],
      [{ id: RUN_ID, generation: 2, state: 'publishable' }]
    ]);
    await expect(lockPayoutImportRows(database.tx, { payoutId: PAYOUT_ID, runId: RUN_ID, expectedGeneration: 3 }))
      .resolves.toEqual({
        payoutId: PAYOUT_ID,
        runId: RUN_ID,
        disposition: 'stale',
        payoutFinancialGeneration: 3,
        runGeneration: 2,
        runState: 'publishable',
        balanceTransactionIds: [],
        issueIds: []
      });
    expect(database.calls).toHaveLength(4);
  });

  it('distinguishes an exact published replay after its generation increment', async () => {
    const database = executor([
      [], [{ id: PAYOUT_ID, financialGeneration: 4 }], [],
      [{ id: RUN_ID, generation: 3, state: 'published' }]
    ]);
    await expect(lockPayoutImportRows(database.tx, {
      payoutId: PAYOUT_ID, runId: RUN_ID, expectedGeneration: 3
    })).resolves.toMatchObject({
      disposition: 'published_replay',
      payoutFinancialGeneration: 4,
      runGeneration: 3,
      runState: 'published',
      balanceTransactionIds: [],
      issueIds: []
    });
    expect(database.calls).toHaveLength(4);
  });

  it('fails closed on an unknown locked payout-import state', async () => {
    const database = executor([
      [], [{ id: PAYOUT_ID, financialGeneration: 3 }], [],
      [{ id: RUN_ID, generation: 3, state: 'mystery' }]
    ]);
    await expect(lockPayoutImportRows(database.tx, {
      payoutId: PAYOUT_ID, runId: RUN_ID, expectedGeneration: 3
    })).rejects.toMatchObject({ safeCode: 'state_changed' });
  });
});
