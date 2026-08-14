import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import type { BalanceTransactionSnapshot } from '$lib/server/commerce/stripe/financial-types';
import { FINANCIAL_CLASSIFIER_VERSION } from './constants';
import { PermanentFinancialError } from './errors';
import {
  fingerprintBalanceTransaction,
  fingerprintBalanceTransactionFeeDetail,
  stageBalanceTransaction
} from './ledger';

const collaborators = vi.hoisted(() => ({
  appendClassificationDecisionLocked: vi.fn(),
  observeFinancialIssue: vi.fn()
}));

vi.mock('./classification', () => ({
  appendClassificationDecisionLocked: collaborators.appendClassificationDecisionLocked,
  classifyBalanceTransaction: (input: { reportingCategory: string }) => input.reportingCategory === 'future'
    ? { status: 'unknown', classification: 'unknown', impact: 'exception', safeCode: 'unsupported_category' }
    : { status: 'classified', classification: 'charge', impact: 'informational' },
  classifyFeeDetail: () => ({ status: 'classified', classification: 'processing_fee', impact: 'informational' })
}));

vi.mock('./issues', () => ({ observeFinancialIssue: collaborators.observeFinancialIssue }));

function snapshot(overrides: Partial<BalanceTransactionSnapshot> = {}): BalanceTransactionSnapshot {
  return {
    id: 'txn_test_ledger_101', livemode: false, sourceId: 'ch_test_ledger_101',
    sourceFamily: 'charge', rawType: 'charge', reportingCategory: 'charge',
    amountMinor: 1403, feeMinor: 71, netMinor: 1332, currency: 'USD', status: 'pending',
    balanceType: 'payments', createdAt: new Date('2026-08-01T00:00:00.000Z'),
    availableAt: new Date('2026-08-03T00:00:00.000Z'), exchangeRate: '1.2300',
    exchangeSourceCurrency: 'EUR', exchangeTargetCurrency: 'USD',
    feeDetails: [
      { ordinal: 1, rawType: 'tax', amountMinor: 1, currency: 'USD' },
      { ordinal: 0, rawType: 'stripe_fee', amountMinor: 70, currency: 'USD' }
    ],
    ...overrides
  };
}

describe('balance transaction fingerprints', () => {
  it('is lower-hex deterministic, status-independent, decimal-normalized, and non-mutating', () => {
    const input = snapshot();
    const before = structuredClone(input);
    const reordered = Object.fromEntries(Object.entries(snapshot()).reverse()) as unknown as BalanceTransactionSnapshot;
    const fingerprint = fingerprintBalanceTransaction(input);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprintBalanceTransaction(reordered)).toBe(fingerprint);
    expect(fingerprintBalanceTransaction(snapshot({ status: 'available' }))).toBe(fingerprint);
    expect(fingerprintBalanceTransaction(snapshot({ exchangeRate: '1.23' }))).toBe(fingerprint);
    expect(fingerprintBalanceTransaction(snapshot({ amountMinor: 1404, netMinor: 1333 }))).not.toBe(fingerprint);
    expect(input).toEqual(before);
  });

  it('anchors each detail fingerprint to the parent and immutable detail tuple', () => {
    const parent = fingerprintBalanceTransaction(snapshot());
    const detail = snapshot().feeDetails[0]!;
    const fingerprint = fingerprintBalanceTransactionFeeDetail(parent, detail);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprintBalanceTransactionFeeDetail('b'.repeat(64), detail)).not.toBe(fingerprint);
    expect(fingerprintBalanceTransactionFeeDetail(parent, { ...detail, ordinal: 0 })).not.toBe(fingerprint);
  });

  it('requires exact detail-hash shapes and bounded immutable values without allowing a forged parent override', () => {
    const parent = fingerprintBalanceTransaction(snapshot());
    const detail = snapshot().feeDetails[0]!;
    const objectInput = { balanceTransactionFingerprint: parent, ...detail };
    expect(fingerprintBalanceTransactionFeeDetail(objectInput)).toMatch(/^[a-f0-9]{64}$/u);
    for (const invalid of [
      { ...objectInput, ignored: true },
      { ...objectInput, ordinal: 2_147_483_648 },
      { ...objectInput, amountMinor: 100_000_000 },
      { ...detail, balanceTransactionFingerprint: 'b'.repeat(64) }
    ]) {
      expect(() => fingerprintBalanceTransactionFeeDetail(parent, invalid as never)).toThrow(PermanentFinancialError);
    }
    expect(() => fingerprintBalanceTransactionFeeDetail({ ...objectInput, balanceTransactionFingerprint: parent, provider: 'stripe' } as never))
      .toThrow(PermanentFinancialError);
    const inheritedFingerprint = Object.assign(
      Object.create({ balanceTransactionFingerprint: parent }) as Record<string, unknown>,
      { ordinal: detail.ordinal, rawType: detail.rawType, amountMinor: detail.amountMinor, currency: detail.currency, ignored: true }
    );
    expect(() => fingerprintBalanceTransactionFeeDetail(inheritedFingerprint as never)).toThrow(PermanentFinancialError);
  });

  it.each([
    ['provider id', { id: 'txn_test_ledger_102' }],
    ['live mode', { livemode: true }],
    ['source family', { sourceFamily: 'refund' as const }],
    ['source id', { sourceId: 're_test_ledger_101' }],
    ['raw type', { rawType: 'payment' }],
    ['reporting category', { reportingCategory: 'fee' }],
    ['balance type', { balanceType: 'charges' }],
    ['amount and net', { amountMinor: 1404, netMinor: 1333 }],
    ['fee and net', { feeMinor: 70, netMinor: 1333, feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 69, currency: 'USD' }, { ordinal: 1, rawType: 'tax', amountMinor: 1, currency: 'USD' }] }],
    ['currency and exchange target', { currency: 'EUR', exchangeTargetCurrency: 'EUR', exchangeSourceCurrency: 'USD', feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 70, currency: 'EUR' }, { ordinal: 1, rawType: 'tax', amountMinor: 1, currency: 'EUR' }] }],
    ['provider created time', { createdAt: new Date('2026-08-01T00:00:01.000Z') }],
    ['available time', { availableAt: new Date('2026-08-03T00:00:01.000Z') }],
    ['exchange rate', { exchangeRate: '1.24' }],
    ['exchange source currency', { exchangeSourceCurrency: 'GBP' }],
    ['detail ordinal', { feeDetails: [{ ordinal: 0, rawType: 'tax', amountMinor: 1, currency: 'USD' }, { ordinal: 1, rawType: 'stripe_fee', amountMinor: 70, currency: 'USD' }] }],
    ['detail raw type', { feeDetails: [{ ordinal: 0, rawType: 'payment_method_passthrough_fee', amountMinor: 70, currency: 'USD' }, { ordinal: 1, rawType: 'tax', amountMinor: 1, currency: 'USD' }] }],
    ['detail amount', { feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 69, currency: 'USD' }, { ordinal: 1, rawType: 'tax', amountMinor: 2, currency: 'USD' }] }]
  ])('changes the parent fingerprint when immutable %s changes', (_label, overrides) => {
    expect(fingerprintBalanceTransaction(snapshot(overrides))).not.toBe(fingerprintBalanceTransaction(snapshot()));
  });

  it.each([
    ['ordinal gap', snapshot({ feeDetails: [{ ordinal: 1, rawType: 'stripe_fee', amountMinor: 71, currency: 'USD' }] })],
    ['duplicate ordinal', snapshot({ feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 35, currency: 'USD' }, { ordinal: 0, rawType: 'tax', amountMinor: 36, currency: 'USD' }] })],
    ['fee sum mismatch', snapshot({ feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 70, currency: 'USD' }] })],
    ['fee currency mismatch', snapshot({ feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 71, currency: 'EUR' }] })],
    ['unsafe amount', snapshot({ amountMinor: Number.MAX_SAFE_INTEGER + 1 })]
  ])('rejects %s before hashing', (_label, input) => {
    try {
      fingerprintBalanceTransaction(input);
      throw new Error('expected invalid snapshot to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentFinancialError);
      expect(error).not.toHaveProperty('cause');
    }
  });
});

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value.replaceAll("'", "''")}'`
  });
}

function database(
  responses: Array<unknown[] | Error>,
  authority: Record<string, unknown> = {
    classifierVersion: 1, allocationAlgorithmVersion: 1,
    pendingClassifierVersion: null, pendingAllocationAlgorithmVersion: null,
    pendingReplayId: null, pendingScanRunId: null
  }
) {
  responses.unshift([authority]);
  const calls: SQL[] = [];
  const tx = {
    execute: async (query: SQL) => {
      calls.push(query);
      if (rendered(query).params.includes('pale-orbit:financial:replay-enrollment')) {
        return { rows: [] };
      }
      const response = responses.shift() ?? [];
      if (response instanceof Error) throw response;
      return { rows: response };
    }
  };
  return { calls, tx, database: { transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx) } as never };
}

const PARENT_ID = '11111111-1111-4111-8111-111111111111';

describe('stageBalanceTransaction orchestration', () => {
  it.each([
    {
      label: 'behind',
      authority: { classifierVersion: 2, allocationAlgorithmVersion: 2 },
      implementation: { classifierVersion: 1, allocationAlgorithmVersion: 1 },
      expected: { name: 'RetryableFinancialError', safeCode: 'state_changed' }
    },
    {
      label: 'incomparable',
      authority: { classifierVersion: 2, allocationAlgorithmVersion: 1 },
      implementation: { classifierVersion: 1, allocationAlgorithmVersion: 2 },
      expected: { name: 'PermanentFinancialError', safeCode: 'source_linkage_mismatch' }
    }
  ])('rejects a $label worker before inserting provider evidence', async ({
    label, authority, implementation, expected
  }) => {
    const fake = database([], {
      ...authority,
      pendingClassifierVersion: null,
      pendingAllocationAlgorithmVersion: null,
      pendingReplayId: null,
      pendingScanRunId: null
    });

    await expect(stageBalanceTransaction(
      fake.database, snapshot(), { correlationId: `ledger-${label}-worker` }, implementation
    )).rejects.toMatchObject(expected);
    expect(fake.calls).toHaveLength(1);
  });

  it('uses the deployed implementation version and skips an active predecessor projection', async () => {
    collaborators.appendClassificationDecisionLocked.mockResolvedValue({ id: 'classification' });
    const fake = database([[], [], [{ id: PARENT_ID }], [{ id: 'fee-0' }],
      [{ id: 'fee-1' }], []]);

    await expect(stageBalanceTransaction(
      fake.database, snapshot(), { correlationId: 'ledger-deployed-version' },
      { classifierVersion: 2, allocationAlgorithmVersion: 3 }
    )).resolves.toMatchObject({ disposition: 'inserted' });

    for (const [, classificationInput] of collaborators.appendClassificationDecisionLocked.mock.calls) {
      expect(classificationInput).toMatchObject({ classifierVersion: 2 });
    }
    expect(fake.calls.map(rendered).map((query) => query.sql).join('\n'))
      .not.toMatch(/from stripe_balance_transactions balance\s+where balance\.id/iu);
  });

  it('rejects an incompatible pending replay before inserting provider evidence', async () => {
    const fake = database([[], [], [{ id: PARENT_ID }], [{ id: 'fee-0' }],
      [{ id: 'fee-1' }], []], {
      classifierVersion: 1, allocationAlgorithmVersion: 1,
      pendingClassifierVersion: 2, pendingAllocationAlgorithmVersion: 2,
      pendingReplayId: 'c2-a2',
      pendingScanRunId: '00000000-0000-4000-8000-000000000222'
    });

    await expect(stageBalanceTransaction(
      fake.database, snapshot(), { correlationId: 'ledger-incompatible-pending' },
      { classifierVersion: 3, allocationAlgorithmVersion: 3 }
    )).rejects.toMatchObject({
      name: 'PermanentFinancialError', safeCode: 'source_linkage_mismatch'
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('takes the provider advisory lock, inserts sorted evidence, classifies it, and writes one safe import audit', async () => {
    collaborators.appendClassificationDecisionLocked.mockResolvedValue({ id: 'classification' });
    const fake = database([[], [], [{ id: PARENT_ID }], [{ id: 'fee-0' }], [{ id: 'fee-1' }], []]);
    await expect(stageBalanceTransaction(fake.database, snapshot(), { correlationId: 'ledger-insert' }))
      .resolves.toEqual({ balanceTransactionId: PARENT_ID, disposition: 'inserted' });
    expect(rendered(fake.calls[0]!).sql).toMatch(
      /from financial_projection_versions[\s\S]*for update/iu
    );
    expect(rendered(fake.calls[1]!).sql).toContain('pg_advisory_xact_lock');
    expect(rendered(fake.calls[1]!).params).toContain('pale-orbit:financial:replay-enrollment');
    expect(rendered(fake.calls[2]!).sql).toContain('pg_advisory_xact_lock');
    expect(rendered(fake.calls[2]!).params).toContain('pale-orbit:financial:balance-transaction:txn_test_ledger_101');
    expect(rendered(fake.calls[3]!).sql).toContain('for update');
    expect(rendered(fake.calls[4]!).sql).toContain('insert into stripe_balance_transactions');
    expect(collaborators.appendClassificationDecisionLocked).toHaveBeenCalledTimes(3);
    for (const [, classificationInput] of collaborators.appendClassificationDecisionLocked.mock.calls) {
      expect(classificationInput).toMatchObject({ classifierVersion: FINANCIAL_CLASSIFIER_VERSION });
    }
    const audit = fake.calls.map(rendered).find((query) => query.sql.includes('financial.balance_transaction.imported'));
    expect(audit).toBeDefined();
    expect(audit!.params).toContain(JSON.stringify({ disposition: 'inserted', status: 'pending', amountMinor: 1403, feeMinor: 71, netMinor: 1332, currency: 'USD', feeDetailCount: 2 }));
    expect(audit!.params).not.toContain('txn_test_ledger_101');
  });

  it('returns unchanged exact evidence but advances only pending to available', async () => {
    const stored = { id: PARENT_ID, providerId: 'txn_test_ledger_101', liveMode: false, sourceFamily: 'charge', sourceId: 'ch_test_ledger_101', rawType: 'charge', reportingCategory: 'charge', balanceType: 'payments', amountMinor: 1403, feeMinor: 71, netMinor: 1332, currency: 'USD', status: 'pending', providerCreatedAt: new Date('2026-08-01T00:00:00.000Z'), availableAt: new Date('2026-08-03T00:00:00.000Z'), exchangeRate: '1.23', exchangeSourceCurrency: 'EUR', exchangeTargetCurrency: 'USD', fingerprintSha256: fingerprintBalanceTransaction(snapshot()) };
    collaborators.appendClassificationDecisionLocked.mockResolvedValue({ id: 'classification' });
    const exact = database([[], [stored], [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 70, currency: 'USD', fingerprintSha256: fingerprintBalanceTransactionFeeDetail(stored.fingerprintSha256, snapshot().feeDetails[1]!) }, { ordinal: 1, rawType: 'tax', amountMinor: 1, currency: 'USD', fingerprintSha256: fingerprintBalanceTransactionFeeDetail(stored.fingerprintSha256, snapshot().feeDetails[0]!) }]]);
    await expect(stageBalanceTransaction(exact.database, snapshot(), { correlationId: 'ledger-replay' }))
      .resolves.toEqual({ balanceTransactionId: PARENT_ID, disposition: 'unchanged' });
    expect(exact.calls).toHaveLength(7);

    const available = database([[], [stored], [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 70, currency: 'USD', fingerprintSha256: fingerprintBalanceTransactionFeeDetail(stored.fingerprintSha256, snapshot().feeDetails[1]!) }, { ordinal: 1, rawType: 'tax', amountMinor: 1, currency: 'USD', fingerprintSha256: fingerprintBalanceTransactionFeeDetail(stored.fingerprintSha256, snapshot().feeDetails[0]!) }], [{ id: PARENT_ID }], []]);
    await expect(stageBalanceTransaction(available.database, snapshot({ status: 'available' }), { correlationId: 'ledger-available' }))
      .resolves.toEqual({ balanceTransactionId: PARENT_ID, disposition: 'advanced' });
    expect(rendered(available.calls[5]!).sql).toContain("status = 'available'");
  });

  it('observes a collision within the transaction and throws only after it commits', async () => {
    const stored = { id: PARENT_ID, providerId: 'txn_test_ledger_101', fingerprintSha256: 'a'.repeat(64) };
    collaborators.observeFinancialIssue.mockResolvedValue({ id: 'issue' });
    const fake = database([[], [stored]]);
    await expect(stageBalanceTransaction(fake.database, snapshot({ amountMinor: 1404, netMinor: 1333 }), { correlationId: 'ledger-collision' }))
      .rejects.toMatchObject({ safeCode: 'immutable_mismatch' });
    expect(collaborators.observeFinancialIssue).toHaveBeenCalledWith(fake.tx, expect.objectContaining({
      resourceType: 'balance_transaction', resourceId: PARENT_ID, safeCode: 'immutable_mismatch', impact: 'exception'
    }));
  });
});
