import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import {
  appendClassificationDecisionLocked,
  classifyBalanceTransaction,
  classifyFeeDetail
} from './classification';
import { PermanentFinancialError } from './errors';

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';
const FINGERPRINT = 'a'.repeat(64);

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value.replaceAll("'", "''")}'`
  });
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

function decision(classification = 'charge') {
  return { status: 'classified' as const, classification: classification as 'charge', impact: 'informational' as const };
}

function row(classification = 'charge') {
  return {
    id: '33333333-3333-4333-8333-333333333333', subjectType: 'balance_transaction',
    subjectId: SUBJECT_ID, classifierVersion: 1, classification,
    sourceFingerprintSha256: FINGERPRINT, decidedAt: new Date()
  };
}

describe('financial classification V1', () => {
  it.each([
    ['charge', 'charge', 'charge', 1, 'charge'],
    ['charge', 'payment', 'charge', 1, 'charge'],
    ['charge', 'validation', 'charge', 1, 'charge'],
    ['refund', 'refund', 'refund', -1, 'refund'],
    ['refund', 'payment_refund', 'refund', -1, 'refund'],
    ['refund_failure', 'refund_failure', 'refund', 1, 'refund_failure'],
    ['dispute', 'adjustment', 'dispute', -1, 'dispute_withdrawal'],
    ['dispute', 'adjusted_for_overdraft_transaction', 'dispute', -1, 'dispute_withdrawal'],
    ['dispute_reversal', 'adjustment', 'dispute', 1, 'dispute_reinstatement'],
    ['payout', 'payout', 'payout', -1, 'payout'],
    ['fee', 'stripe_fee', 'charge', 1, 'fee_credit'],
    ['tax', 'tax_fee', 'adjustment', -1, 'provider_fee_tax'],
    ['other_adjustment', 'adjustment', 'adjustment', 1, 'other']
  ] as const)('%s/%s/%s classifies as %s', (reportingCategory, rawType, sourceFamily, amountMinor, classification) => {
    expect(classifyBalanceTransaction({ reportingCategory, rawType, sourceFamily, amountMinor }))
      .toMatchObject({ status: 'classified', classification });
  });

  it('returns one shared unknown decision for contradictions and novel evidence', () => {
    const contradiction = classifyBalanceTransaction({
      reportingCategory: 'charge', rawType: 'refund', sourceFamily: 'charge', amountMinor: 1
    });
    const novel = classifyBalanceTransaction({
      reportingCategory: 'future_category', rawType: 'future_type', sourceFamily: 'unknown', amountMinor: 1
    });
    expect(contradiction).toEqual(novel);
    expect(contradiction).toMatchObject({ status: 'unknown', safeCode: 'unsupported_category' });
  });

  it.each(['stripe_fee', 'stripe_fx_fee'])('classifies signed known fee evidence for %s without manufacturing a credit', (rawType) => {
    expect(classifyBalanceTransaction({ reportingCategory: 'fee', rawType, sourceFamily: 'charge', amountMinor: 1 }))
      .toMatchObject({ status: 'classified', classification: 'fee_credit' });
    for (const amountMinor of [0, -1]) {
      expect(classifyBalanceTransaction({ reportingCategory: 'fee', rawType, sourceFamily: 'charge', amountMinor }))
        .toMatchObject({ status: 'classified', classification: 'other' });
    }
  });

  it('rejects malformed provider evidence without retaining a provider value as its cause', () => {
    const invalid = { reportingCategory: 'charge', rawType: 'x'.repeat(101), sourceFamily: 'charge' as const, amountMinor: 1 };
    expect(() => classifyBalanceTransaction(invalid)).toThrow(PermanentFinancialError);
    try {
      classifyBalanceTransaction(invalid);
    } catch (error) {
      expect(error).toMatchObject({ safeCode: 'unsupported_provider_evidence' });
      expect(error).not.toHaveProperty('cause');
    }
  });

  it('does not mutate classification inputs', () => {
    const input = Object.freeze({ reportingCategory: 'charge', rawType: 'payment', sourceFamily: 'charge' as const, amountMinor: 1 });
    classifyBalanceTransaction(input);
    expect(input).toEqual({ reportingCategory: 'charge', rawType: 'payment', sourceFamily: 'charge', amountMinor: 1 });
  });

  it('rejects extra fields on pure classifier inputs', () => {
    expect(() => classifyBalanceTransaction({
      reportingCategory: 'charge', rawType: 'charge', sourceFamily: 'charge', amountMinor: 1, ignored: true
    } as never)).toThrow(PermanentFinancialError);
    expect(() => classifyFeeDetail({
      parentClassification: 'charge', rawType: 'stripe_fee', amountMinor: 1, ignored: true
    } as never)).toThrow(PermanentFinancialError);
    const inheritedCategory = Object.assign(
      Object.create({ reportingCategory: 'charge' }) as Record<string, unknown>,
      { sourceFamily: 'charge', rawType: 'charge', amountMinor: 1, ignored: true }
    );
    expect(() => classifyBalanceTransaction(inheritedCategory as never)).toThrow(PermanentFinancialError);
  });

  it.each([
    ['tax', 'charge', 'provider_fee_tax'],
    ['stripe_fee', 'charge', 'processing_fee'],
    ['payment_method_passthrough_fee', 'refund', 'refund_fee'],
    ['stripe_fee', 'refund_failure', 'refund_fee'],
    ['stripe_fee', 'dispute_withdrawal', 'dispute_fee'],
    ['stripe_fee', 'dispute_reinstatement', 'dispute_fee'],
    ['stripe_fee', 'payout', 'other'],
    ['application_fee', 'charge', 'other']
  ] as const)('classifies fee detail %s for %s', (rawType, parentClassification, classification) => {
    expect(classifyFeeDetail({ rawType, parentClassification, amountMinor: 1 }))
      .toMatchObject({ status: 'classified', classification });
  });

  it('returns unknown for a novel fee detail type or unknown parent', () => {
    expect(classifyFeeDetail({ rawType: 'future_fee', parentClassification: 'charge', amountMinor: 1 })).toMatchObject({ status: 'unknown' });
    expect(classifyFeeDetail({ rawType: 'stripe_fee', parentClassification: 'unknown', amountMinor: 1 })).toMatchObject({ status: 'unknown' });
  });

  it.each([
    'tax',
    'application_fee',
    'stripe_fee',
    'payment_method_passthrough_fee'
  ])('returns unknown for %s when the parent classification is unknown', (rawType) => {
    expect(classifyFeeDetail({ rawType, parentClassification: 'unknown', amountMinor: 1 }))
      .toEqual({
        status: 'unknown',
        classification: 'unknown',
        impact: 'exception',
        safeCode: 'unsupported_category'
      });
  });
});

describe('appendClassificationDecisionLocked', () => {
  it('rejects a classifier version above PostgreSQL int32 before querying', async () => {
    const database = executor([]);
    try {
      await appendClassificationDecisionLocked(database.tx, {
        subjectType: 'balance_transaction', subjectId: SUBJECT_ID,
        classifierVersion: 2_147_483_648, sourceFingerprint: FINGERPRINT,
        decision: decision(), correlationId: 'correlation-1'
      });
      throw new Error('expected oversized classifier version to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentFinancialError);
      expect(error).toMatchObject({ safeCode: 'unsupported_provider_evidence' });
      expect(error).not.toHaveProperty('cause');
    }
    expect(database.calls).toHaveLength(0);
  });

  it('locks the balance transaction before identity classification and appends an allowlisted audit event', async () => {
    const database = executor([[{ id: SUBJECT_ID, sourceFingerprint: FINGERPRINT }], [], [], [row()], []]);
    await expect(appendClassificationDecisionLocked(database.tx, {
      subjectType: 'balance_transaction', subjectId: SUBJECT_ID, classifierVersion: 1,
      sourceFingerprint: FINGERPRINT, decision: decision(), correlationId: 'correlation-1'
    })).resolves.toMatchObject({ id: row().id });
    expect(database.calls).toHaveLength(5);
    expect(rendered(database.calls[0]!).sql).toContain('stripe_balance_transactions');
    expect(rendered(database.calls[0]!).sql).toContain('for update');
    expect(rendered(database.calls[1]!).sql).toContain('pg_advisory_xact_lock');
    expect(rendered(database.calls[2]!).sql).toContain('financial_classification_versions');
    expect(rendered(database.calls[2]!).sql).toContain('for update');
    const audit = rendered(database.calls[4]!);
    expect(audit.sql).toContain('financial.classification.appended');
    expect(audit.params).not.toContain(FINGERPRINT);
    expect(audit.params).toContain(JSON.stringify({ subjectType: 'balance_transaction', classification: 'charge', classifierVersion: 1 }));
  });

  it('locks the fee parent before the fee detail and validates the exact fee fingerprint', async () => {
    const database = executor([
      [{ balanceTransactionId: PARENT_ID }],
      [{ id: SUBJECT_ID, balanceTransactionId: PARENT_ID, sourceFingerprint: FINGERPRINT }],
      [], [], [row()], []
    ]);
    await appendClassificationDecisionLocked(database.tx, {
      subjectType: 'fee_detail', subjectId: SUBJECT_ID, classifierVersion: 1,
      sourceFingerprint: FINGERPRINT, decision: decision(), correlationId: 'correlation-1'
    });
    const parentLock = rendered(database.calls[0]!);
    const feeLock = rendered(database.calls[1]!);
    expect(parentLock.sql).toContain('join stripe_balance_transactions bt');
    expect(parentLock.sql).toContain('for update of bt');
    expect(parentLock.sql).not.toContain('for update of bt, fd');
    expect(feeLock.sql).toContain('stripe_balance_transaction_fee_details');
    expect(feeLock.sql).toContain('for update');
    expect(feeLock.params).toContain(SUBJECT_ID);

    const mismatch = executor([
      [{ balanceTransactionId: PARENT_ID }],
      [{ id: SUBJECT_ID, balanceTransactionId: PARENT_ID, sourceFingerprint: 'b'.repeat(64) }]
    ]);
    await expect(appendClassificationDecisionLocked(mismatch.tx, {
      subjectType: 'fee_detail', subjectId: SUBJECT_ID, classifierVersion: 1,
      sourceFingerprint: FINGERPRINT, decision: decision(), correlationId: 'correlation-1'
    })).rejects.toMatchObject({ safeCode: 'unsupported_provider_evidence' });
    expect(mismatch.calls).toHaveLength(2);
  });

  it('fails safely if the fee subject is missing or changes parent while locks are acquired', async () => {
    const missingParent = executor([[]]);
    await expect(appendClassificationDecisionLocked(missingParent.tx, {
      subjectType: 'fee_detail', subjectId: SUBJECT_ID, classifierVersion: 1,
      sourceFingerprint: FINGERPRINT, decision: decision(), correlationId: 'correlation-1'
    })).rejects.toMatchObject({ safeCode: 'unsupported_provider_evidence' });
    expect(missingParent.calls).toHaveLength(1);

    const changedParent = executor([
      [{ balanceTransactionId: PARENT_ID }],
      [{
        id: SUBJECT_ID,
        balanceTransactionId: '44444444-4444-4444-8444-444444444444',
        sourceFingerprint: FINGERPRINT
      }]
    ]);
    await expect(appendClassificationDecisionLocked(changedParent.tx, {
      subjectType: 'fee_detail', subjectId: SUBJECT_ID, classifierVersion: 1,
      sourceFingerprint: FINGERPRINT, decision: decision(), correlationId: 'correlation-1'
    })).rejects.toMatchObject({ safeCode: 'unsupported_provider_evidence' });
    expect(changedParent.calls).toHaveLength(2);
  });

  it('uses one subject-stable advisory key across versions and fingerprints', async () => {
    const alternateFingerprint = 'b'.repeat(64);
    const first = executor([
      [{ id: SUBJECT_ID, sourceFingerprint: FINGERPRINT }], [], [row()]
    ]);
    const second = executor([
      [{ id: SUBJECT_ID, sourceFingerprint: alternateFingerprint }], [], [{
        ...row(), classifierVersion: 2, sourceFingerprintSha256: alternateFingerprint
      }]
    ]);
    await appendClassificationDecisionLocked(first.tx, {
      subjectType: 'balance_transaction', subjectId: SUBJECT_ID, classifierVersion: 1,
      sourceFingerprint: FINGERPRINT, decision: decision(), correlationId: 'correlation-1'
    });
    await appendClassificationDecisionLocked(second.tx, {
      subjectType: 'balance_transaction', subjectId: SUBJECT_ID, classifierVersion: 2,
      sourceFingerprint: alternateFingerprint, decision: decision(), correlationId: 'correlation-2'
    });
    const expectedKey = `pale-orbit:financial:classification:balance_transaction:${SUBJECT_ID}`;
    expect(rendered(first.calls[1]!).params).toEqual([expectedKey]);
    expect(rendered(second.calls[1]!).params).toEqual([expectedKey]);
  });

  it('is idempotent without audit when the locked identity agrees', async () => {
    const existing = row();
    const database = executor([[{ id: SUBJECT_ID, sourceFingerprint: FINGERPRINT }], [], [existing]]);
    await expect(appendClassificationDecisionLocked(database.tx, {
      subjectType: 'balance_transaction', subjectId: SUBJECT_ID, classifierVersion: 1,
      sourceFingerprint: FINGERPRINT, decision: decision(), correlationId: 'correlation-1'
    })).resolves.toBe(existing);
    expect(database.calls).toHaveLength(3);
  });

  it('rejects a locked identity fork and leaves higher versions additive', async () => {
    const fork = executor([[{ id: SUBJECT_ID, sourceFingerprint: FINGERPRINT }], [], [row('refund')]]);
    await expect(appendClassificationDecisionLocked(fork.tx, {
      subjectType: 'balance_transaction', subjectId: SUBJECT_ID, classifierVersion: 1,
      sourceFingerprint: FINGERPRINT, decision: decision(), correlationId: 'correlation-1'
    })).rejects.toMatchObject({ safeCode: 'classification_fork' });

    const higher = executor([[{ id: SUBJECT_ID, sourceFingerprint: FINGERPRINT }], [], [], [row('charge')], []]);
    await appendClassificationDecisionLocked(higher.tx, {
      subjectType: 'balance_transaction', subjectId: SUBJECT_ID, classifierVersion: 2,
      sourceFingerprint: FINGERPRINT, decision: decision(), correlationId: 'correlation-1'
    });
    expect(rendered(higher.calls[2]!).params).toContain(2);
    expect(rendered(higher.calls[3]!).sql).toContain('insert into financial_classification_versions');
  });

  it('strictly rejects invalid append fields before it queries and propagates audit failure', async () => {
    const invalid = executor([]);
    await expect(appendClassificationDecisionLocked(invalid.tx, {
      subjectType: 'balance_transaction', subjectId: SUBJECT_ID.toUpperCase(), classifierVersion: 0,
      sourceFingerprint: FINGERPRINT.toUpperCase(), decision: decision(), correlationId: ''
    })).rejects.toMatchObject({ safeCode: 'unsupported_provider_evidence' });
    expect(invalid.calls).toHaveLength(0);

    const auditFailure = executor([[{ id: SUBJECT_ID, sourceFingerprint: FINGERPRINT }], [], [], [row()], new Error('audit unavailable')]);
    await expect(appendClassificationDecisionLocked(auditFailure.tx, {
      subjectType: 'balance_transaction', subjectId: SUBJECT_ID, classifierVersion: 1,
      sourceFingerprint: FINGERPRINT, decision: decision(), correlationId: 'correlation-1'
    })).rejects.toThrow('audit unavailable');
  });
});
