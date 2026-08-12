import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  fingerprintBalanceTransaction,
  fingerprintBalanceTransactionFeeDetail,
  stageBalanceTransaction
} from '$lib/server/commerce/financial/ledger';
import { PermanentFinancialError } from '$lib/server/commerce/financial/errors';
import { appendClassificationDecisionLocked } from '$lib/server/commerce/financial/classification';
import { observeFinancialIssue, resolveFinancialIssueAfterRecompute } from '$lib/server/commerce/financial/issues';
import type { BalanceTransactionSnapshot } from '$lib/server/commerce/stripe/financial-types';
import {
  auditEvents,
  financialClassificationVersions,
  financialReconciliationIssues,
  stripeBalanceTransactionFeeDetails,
  stripeBalanceTransactions
} from '$lib/server/db/schema';
import { databaseClient } from './database';

function snapshot(overrides: Partial<BalanceTransactionSnapshot> = {}): BalanceTransactionSnapshot {
  const suffix = randomUUID();
  return {
    id: `txn_financial_ledger_${suffix}`,
    livemode: false,
    sourceId: `ch_financial_ledger_${suffix}`,
    sourceFamily: 'charge',
    rawType: 'charge',
    reportingCategory: 'charge',
    amountMinor: 1_403,
    feeMinor: 71,
    netMinor: 1_332,
    currency: 'USD',
    status: 'pending',
    balanceType: 'payments',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    availableAt: new Date('2026-08-03T00:00:00.000Z'),
    exchangeRate: null,
    exchangeSourceCurrency: null,
    exchangeTargetCurrency: null,
    feeDetails: [
      { ordinal: 0, rawType: 'stripe_fee', amountMinor: 70, currency: 'USD' },
      { ordinal: 1, rawType: 'tax', amountMinor: 1, currency: 'USD' }
    ],
    ...overrides
  };
}

async function expectHistoryGuard(statement: string, values: unknown[] = []): Promise<void> {
  await expect(databaseClient.pool.query(statement, values)).rejects.toMatchObject({ code: '55000' });
}

function postgresLeaf(error: unknown): unknown {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const cause = (current as { cause?: unknown }).cause;
    if (!cause) break;
    current = cause;
  }
  return current;
}

function systemActor() {
  return { type: 'system' as const, id: 'financial-worker' };
}

describe('financial balance-transaction ledger', () => {
  it('inserts complete immutable evidence and replays without duplicate history', async () => {
    const input = snapshot();
    const inserted = await stageBalanceTransaction(databaseClient.db, input, {
      correlationId: 'financial-ledger-insert'
    });
    const replayed = await stageBalanceTransaction(databaseClient.db, structuredClone(input), {
      correlationId: 'financial-ledger-replay'
    });

    expect(inserted.disposition).toBe('inserted');
    expect(replayed).toEqual({
      balanceTransactionId: inserted.balanceTransactionId,
      disposition: 'unchanged'
    });

    const parents = await databaseClient.db.select().from(stripeBalanceTransactions);
    const details = await databaseClient.db
      .select()
      .from(stripeBalanceTransactionFeeDetails)
      .orderBy(asc(stripeBalanceTransactionFeeDetails.ordinal));
    const decisions = await databaseClient.db.select().from(financialClassificationVersions);
    const imports = await databaseClient.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'financial.balance_transaction.imported'));

    expect(parents).toHaveLength(1);
    expect(details.map((detail) => detail.ordinal)).toEqual([0, 1]);
    expect(decisions).toHaveLength(3);
    expect(imports).toHaveLength(1);
    expect(imports[0]?.after).toEqual({
      disposition: 'inserted',
      status: 'pending',
      amountMinor: 1_403,
      feeMinor: 71,
      netMinor: 1_332,
      currency: 'USD',
      feeDetailCount: 2
    });
    expect(JSON.stringify(imports)).not.toContain(input.id);
    expect(JSON.stringify(imports)).not.toContain(input.rawType);
  });

  it('advances pending to available and never regresses on stale evidence', async () => {
    const pending = snapshot();
    const inserted = await stageBalanceTransaction(databaseClient.db, pending, {
      correlationId: 'financial-ledger-pending'
    });
    await expect(stageBalanceTransaction(databaseClient.db, {
      ...pending,
      status: 'available'
    }, { correlationId: 'financial-ledger-available' })).resolves.toEqual({
      balanceTransactionId: inserted.balanceTransactionId,
      disposition: 'advanced'
    });
    await expect(stageBalanceTransaction(databaseClient.db, pending, {
      correlationId: 'financial-ledger-stale'
    })).resolves.toEqual({
      balanceTransactionId: inserted.balanceTransactionId,
      disposition: 'unchanged'
    });

    const [stored] = await databaseClient.db.select().from(stripeBalanceTransactions);
    const imports = await databaseClient.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'financial.balance_transaction.imported'));
    expect(stored?.status).toBe('available');
    expect(imports).toHaveLength(2);
  });

  it('commits durable immutable-mismatch issues for amount, currency, source, and fingerprint collisions', async () => {
    const collisionCases: ReadonlyArray<readonly [string, (value: BalanceTransactionSnapshot) => BalanceTransactionSnapshot]> = [
      ['amount', (value) => ({ ...value, amountMinor: value.amountMinor + 1, netMinor: value.netMinor + 1 })],
      ['currency', (value) => ({
        ...value,
        currency: 'EUR',
        feeDetails: value.feeDetails.map((detail) => ({ ...detail, currency: 'EUR' }))
      })],
      ['source', (value) => ({ ...value, sourceId: `${value.sourceId}_changed` })]
    ];
    for (const [label, mutate] of collisionCases) {
      const original = snapshot();
      const inserted = await stageBalanceTransaction(databaseClient.db, original, {
        correlationId: `financial-ledger-${label}-original`
      });
      await expect(stageBalanceTransaction(databaseClient.db, mutate(original), {
        correlationId: `financial-ledger-${label}-collision`
      })).rejects.toMatchObject({ name: 'PermanentFinancialError', safeCode: 'immutable_mismatch' });
      const [stored] = await databaseClient.db.select().from(stripeBalanceTransactions)
        .where(eq(stripeBalanceTransactions.id, inserted.balanceTransactionId));
      expect(stored?.providerId).toBe(original.id);
      expect(stored?.amountMinor).toBe(original.amountMinor);
      expect(stored?.currency).toBe(original.currency);
      expect(stored?.sourceId).toBe(original.sourceId);
    }

    const forged = snapshot();
    const canonicalFingerprint = fingerprintBalanceTransaction(forged);
    const [forgedParent] = await databaseClient.db.insert(stripeBalanceTransactions).values({
      providerId: forged.id,
      liveMode: forged.livemode,
      sourceFamily: forged.sourceFamily,
      sourceId: forged.sourceId,
      rawType: forged.rawType,
      reportingCategory: forged.reportingCategory,
      balanceType: forged.balanceType,
      amountMinor: forged.amountMinor,
      feeMinor: forged.feeMinor,
      netMinor: forged.netMinor,
      currency: forged.currency,
      status: forged.status,
      providerCreatedAt: forged.createdAt,
      availableAt: forged.availableAt,
      exchangeRate: forged.exchangeRate,
      exchangeSourceCurrency: forged.exchangeSourceCurrency,
      exchangeTargetCurrency: forged.exchangeTargetCurrency,
      fingerprintSha256: 'f'.repeat(64)
    }).returning({ id: stripeBalanceTransactions.id });
    await databaseClient.db.insert(stripeBalanceTransactionFeeDetails).values(forged.feeDetails.map((detail) => ({
      balanceTransactionId: forgedParent!.id,
      ordinal: detail.ordinal,
      rawType: detail.rawType,
      amountMinor: detail.amountMinor,
      currency: detail.currency,
      fingerprintSha256: fingerprintBalanceTransactionFeeDetail(canonicalFingerprint, detail)
    })));
    await expect(stageBalanceTransaction(databaseClient.db, forged, {
      correlationId: 'financial-ledger-fingerprint-collision'
    })).rejects.toBeInstanceOf(PermanentFinancialError);

    const issues = await databaseClient.db.select().from(financialReconciliationIssues);
    expect(issues).toHaveLength(4);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceType: 'balance_transaction', safeCode: 'immutable_mismatch', impact: 'exception', occurrenceCount: 1
      })
    ]));
  });

  it('retains unknown evidence and converges concurrent identical staging', async () => {
    const unknown = snapshot({
      sourceFamily: 'unknown',
      sourceId: null,
      rawType: 'future_balance_type',
      reportingCategory: 'future_reporting_category',
      feeMinor: 0,
      netMinor: 1_403,
      feeDetails: []
    });
    const [first, second] = await Promise.all([
      stageBalanceTransaction(databaseClient.db, unknown, {
        correlationId: 'financial-ledger-concurrent-a'
      }),
      stageBalanceTransaction(databaseClient.db, structuredClone(unknown), {
        correlationId: 'financial-ledger-concurrent-b'
      })
    ]);

    expect([first.disposition, second.disposition].sort()).toEqual(['inserted', 'unchanged']);
    const parents = await databaseClient.db.select().from(stripeBalanceTransactions);
    const issues = await databaseClient.db.select().from(financialReconciliationIssues);
    expect(parents).toHaveLength(1);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.safeCode).toBe('unsupported_category');
  });

  it('persists exact immutable details and database history guards reject mutation or deletion', async () => {
    const input = snapshot();
    const staged = await stageBalanceTransaction(databaseClient.db, input, { correlationId: 'ledger-guards' });
    const [parent] = await databaseClient.db.select().from(stripeBalanceTransactions);
    const details = await databaseClient.db.select().from(stripeBalanceTransactionFeeDetails)
      .orderBy(asc(stripeBalanceTransactionFeeDetails.ordinal));
    const [classification] = await databaseClient.db.select().from(financialClassificationVersions);
    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, {
      resourceType: 'balance_transaction', resourceId: staged.balanceTransactionId, safeCode: 'missing_source',
      impact: 'pending', actor: systemActor(), correlationId: 'ledger-guard-issue'
    }));
    const [issue] = await databaseClient.db.select().from(financialReconciliationIssues);

    expect(details.map((detail) => ({ ordinal: detail.ordinal, rawType: detail.rawType, amountMinor: detail.amountMinor, currency: detail.currency, fingerprint: detail.fingerprintSha256 }))).toEqual([
      expect.objectContaining({ ordinal: 0, rawType: 'stripe_fee', amountMinor: 70, currency: 'USD', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      expect.objectContaining({ ordinal: 1, rawType: 'tax', amountMinor: 1, currency: 'USD', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    ]);
    await expectHistoryGuard('update stripe_balance_transactions set amount_minor = 1 where id = $1', [parent!.id]);
    await expectHistoryGuard('delete from stripe_balance_transaction_fee_details where id = $1', [details[0]!.id]);
    await expectHistoryGuard('update financial_classification_versions set classification = \'refund\' where id = $1', [classification!.id]);
    await expectHistoryGuard('delete from financial_reconciliation_issues where id = $1', [issue!.id]);
    await expectHistoryGuard(
      'update financial_reconciliation_issues set state = \'resolved\', resolved_at = now() where id = $1',
      [issue!.id]
    );
    await expectHistoryGuard('update financial_reconciliation_issues set impact = \'exception\' where id = $1', [issue!.id]);
    const secondResourceId = randomUUID();
    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, {
      resourceType: 'financial_scan_run', resourceId: secondResourceId, safeCode: 'missing_source',
      impact: 'pending', actor: systemActor(), correlationId: 'ledger-second-guard-issue'
    }));
    const [secondIssue] = await databaseClient.db.select().from(financialReconciliationIssues)
      .where(eq(financialReconciliationIssues.resourceId, secondResourceId));
    let crossIssueError: unknown;
    try {
      await databaseClient.db.transaction(async (tx) => {
        await resolveFinancialIssueAfterRecompute(tx, {
          resourceType: 'balance_transaction', resourceId: staged.balanceTransactionId, safeCode: 'missing_source',
          proof: {
            status: 'resolved', resourceType: 'balance_transaction', resourceId: staged.balanceTransactionId,
            safeCode: 'missing_source'
          },
          actor: systemActor(), correlationId: 'ledger-cross-issue-resolution'
        });
        await tx.execute(sql`
          update financial_reconciliation_issues
          set state = 'resolved', resolved_at = now()
          where id = ${secondIssue!.id}
        `);
      });
    } catch (error) {
      crossIssueError = error;
    }
    expect(postgresLeaf(crossIssueError)).toMatchObject({ code: '55000' });
    expect(await databaseClient.db.select().from(financialReconciliationIssues)
      .where(eq(financialReconciliationIssues.state, 'resolved'))).toHaveLength(0);
    await databaseClient.db.transaction((tx) => resolveFinancialIssueAfterRecompute(tx, {
      resourceType: 'balance_transaction', resourceId: staged.balanceTransactionId, safeCode: 'missing_source',
      proof: {
        status: 'resolved', resourceType: 'balance_transaction', resourceId: staged.balanceTransactionId,
        safeCode: 'missing_source'
      },
      actor: systemActor(), correlationId: 'ledger-guard-resolution'
    }));
    await expectHistoryGuard(
      'update financial_reconciliation_issues set resolved_at = resolved_at + interval \'1 second\' where id = $1',
      [issue!.id]
    );
  });

  it('serializes classification identities, retains versions, and rejects a fork', async () => {
    const staged = await stageBalanceTransaction(databaseClient.db, snapshot(), { correlationId: 'ledger-classification-base' });
    const [parent] = await databaseClient.db.select().from(stripeBalanceTransactions);
    const input = {
      subjectType: 'balance_transaction' as const, subjectId: staged.balanceTransactionId, classifierVersion: 2,
      sourceFingerprint: parent!.fingerprintSha256,
      decision: { status: 'classified' as const, classification: 'charge' as const, impact: 'informational' as const },
      correlationId: 'ledger-classification-v2'
    };
    const [first, second] = await Promise.all([
      databaseClient.db.transaction((tx) => appendClassificationDecisionLocked(tx, input)),
      databaseClient.db.transaction((tx) => appendClassificationDecisionLocked(tx, { ...input, correlationId: 'ledger-classification-v2-b' }))
    ]);
    expect(first.id).toBe(second.id);
    const versions = await databaseClient.db.select().from(financialClassificationVersions)
      .where(eq(financialClassificationVersions.subjectId, staged.balanceTransactionId));
    expect(versions.filter((entry) => entry.classifierVersion === 1)).toHaveLength(1);
    expect(versions.filter((entry) => entry.classifierVersion === 2)).toHaveLength(1);
    await expect(databaseClient.db.transaction((tx) => appendClassificationDecisionLocked(tx, {
      ...input, decision: { status: 'classified', classification: 'refund', impact: 'informational' }
    }))).rejects.toMatchObject({ safeCode: 'classification_fork' });
  });

  it('keeps a real issue lifecycle idempotent, reopens history, and emits only safe audited transitions', async () => {
    const source = snapshot({ rawType: 'payment' });
    const staged = await stageBalanceTransaction(databaseClient.db, source, { correlationId: 'ledger-issue-resource' });
    const open = {
      resourceType: 'balance_transaction' as const, resourceId: staged.balanceTransactionId,
      safeCode: 'missing_source' as const, impact: 'pending' as const, actor: systemActor(), correlationId: 'ledger-issue-open'
    };
    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, open));
    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, { ...open, correlationId: 'ledger-issue-repeat' }));
    const proof = { status: 'resolved' as const, resourceType: open.resourceType, resourceId: open.resourceId, safeCode: open.safeCode };
    const resolution = {
      resourceType: open.resourceType, resourceId: open.resourceId, safeCode: open.safeCode,
      actor: open.actor, proof
    };
    await databaseClient.db.transaction((tx) => resolveFinancialIssueAfterRecompute(tx, { ...resolution, correlationId: 'ledger-issue-resolve' }));
    await databaseClient.db.transaction((tx) => resolveFinancialIssueAfterRecompute(tx, { ...resolution, correlationId: 'ledger-issue-resolve-repeat' }));
    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, { ...open, correlationId: 'ledger-issue-reopen' }));

    const issues = await databaseClient.db.select().from(financialReconciliationIssues)
      .orderBy(asc(financialReconciliationIssues.firstObservedAt));
    const events = await databaseClient.db.select().from(auditEvents).orderBy(asc(auditEvents.occurredAt));
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ state: 'resolved', occurrenceCount: 2 });
    expect(issues[1]).toMatchObject({ state: 'open', occurrenceCount: 1 });
    const expectedAuditKeys: Readonly<Record<string, readonly string[]>> = {
      'financial.balance_transaction.imported': [
        'amountMinor', 'currency', 'disposition', 'feeDetailCount', 'feeMinor', 'netMinor', 'status'
      ],
      'financial.classification.appended': ['classification', 'classifierVersion', 'subjectType'],
      'financial.issue.opened': ['impact', 'occurrenceCount', 'resourceId', 'resourceType', 'safeCode', 'state'],
      'financial.issue.resolved': ['impact', 'occurrenceCount', 'resourceId', 'resourceType', 'safeCode', 'state']
    };
    for (const event of events.filter((entry) => entry.action.startsWith('financial.'))) {
      const expectedKeys = expectedAuditKeys[event.action];
      expect(expectedKeys, `unexpected financial audit action ${event.action}`).toBeDefined();
      expect(Object.keys((event.after ?? {}) as object).sort()).toEqual(expectedKeys);
      expect(JSON.stringify(event)).not.toContain(source.id);
      expect(JSON.stringify(event)).not.toContain(source.rawType);
    }
    expect(events.filter((entry) => entry.action === 'financial.issue.opened')).toHaveLength(2);
    expect(events.filter((entry) => entry.action === 'financial.issue.resolved')).toHaveLength(1);
    expect(events.some((entry) => entry.action === 'financial.balance_transaction.imported')).toBe(true);
    expect(events.some((entry) => entry.action === 'financial.classification.appended')).toBe(true);
  });

  it('rolls back classification and issue writes when an audit trigger rejects the enclosing transaction', async () => {
    const staged = await stageBalanceTransaction(databaseClient.db, snapshot(), { correlationId: 'ledger-audit-rollback-base' });
    const [parent] = await databaseClient.db.select().from(stripeBalanceTransactions);
    const triggerName = `ledger_audit_fail_${randomUUID().replaceAll('-', '')}`;
    const functionName = `${triggerName}_fn`;
    await expect(databaseClient.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`create function ${functionName}() returns trigger language plpgsql as $$ begin raise exception 'forced audit failure'; end; $$`));
      await tx.execute(sql.raw(`create trigger ${triggerName} before insert on audit_events for each row execute function ${functionName}()`));
      await appendClassificationDecisionLocked(tx, {
        subjectType: 'balance_transaction', subjectId: staged.balanceTransactionId, classifierVersion: 2,
        sourceFingerprint: parent!.fingerprintSha256,
        decision: { status: 'classified', classification: 'charge', impact: 'informational' }, correlationId: 'ledger-audit-rollback-classification'
      });
    })).rejects.toThrow();
    expect((await databaseClient.db.select().from(financialClassificationVersions)).filter((entry) => entry.classifierVersion === 2)).toHaveLength(0);

    const resourceId = randomUUID();
    await expect(databaseClient.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`create function ${functionName}() returns trigger language plpgsql as $$ begin raise exception 'forced audit failure'; end; $$`));
      await tx.execute(sql.raw(`create trigger ${triggerName} before insert on audit_events for each row execute function ${functionName}()`));
      await observeFinancialIssue(tx, {
        resourceType: 'financial_scan_run', resourceId, safeCode: 'missing_source', impact: 'pending',
        actor: systemActor(), correlationId: 'ledger-audit-rollback-issue'
      });
    })).rejects.toThrow();
    expect(await databaseClient.db.select().from(financialReconciliationIssues)
      .where(eq(financialReconciliationIssues.resourceId, resourceId))).toHaveLength(0);
  });

  it('retains a novel fee detail and records its bounded unknown issue', async () => {
    const input = snapshot({ feeDetails: [{ ordinal: 0, rawType: 'future_fee', amountMinor: 71, currency: 'USD' }] });
    await stageBalanceTransaction(databaseClient.db, input, { correlationId: 'ledger-unknown-fee' });
    const details = await databaseClient.db.select().from(stripeBalanceTransactionFeeDetails);
    const issues = await databaseClient.db.select().from(financialReconciliationIssues);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ rawType: 'future_fee', amountMinor: 71 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ resourceType: 'fee_detail', safeCode: 'unsupported_category', impact: 'exception' });
    expect(JSON.stringify(issues)).not.toContain('future_fee');
  });
});
