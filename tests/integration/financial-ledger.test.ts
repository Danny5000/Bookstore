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
import {
  ownerDatabaseClient,
  workerDatabaseClient,
  workerDatabaseClient as databaseClient
} from './database';

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
  await expect(ownerDatabaseClient.pool.query(statement, values)).rejects.toMatchObject({ code: '55000' });
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

async function installRejectingAuditTrigger(functionName: string, triggerName: string): Promise<void> {
  await ownerDatabaseClient.db.execute(sql.raw(
    `create function ${functionName}() returns trigger language plpgsql as $$ begin raise exception 'forced audit failure'; end; $$`
  ));
  await ownerDatabaseClient.db.execute(sql.raw(
    `create trigger ${triggerName} before insert on audit_events for each row execute function ${functionName}()`
  ));
}

async function removeRejectingAuditTrigger(functionName: string, triggerName: string): Promise<void> {
  await ownerDatabaseClient.db.execute(sql.raw(`drop trigger if exists ${triggerName} on audit_events`));
  await ownerDatabaseClient.db.execute(sql.raw(`drop function if exists ${functionName}()`));
}

async function seedMutableIssueSubject(
  resourceType: 'payment' | 'refund' | 'dispute'
): Promise<string> {
  const orderId = randomUUID();
  const paymentId = randomUUID();
  const suffix = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into orders
       (id, currency, subtotal_minor, client_checkout_attempt_id,
        quote_fingerprint_sha256, status_token_sha256)
     values ($1, 'USD', 100, $2, $3, $3)`,
    [orderId, randomUUID(), 'a'.repeat(64)]
  );
  await ownerDatabaseClient.pool.query(
    `insert into payments
       (id, order_id, stripe_payment_intent_id, amount_minor, currency)
     values ($1, $2, $3, 100, 'USD')`,
    [paymentId, orderId, `pi_issue_subject_${suffix}`]
  );
  if (resourceType === 'payment') return paymentId;

  const resourceId = randomUUID();
  if (resourceType === 'refund') {
    await ownerDatabaseClient.pool.query(
      `insert into refunds
         (id, payment_id, stripe_refund_id, amount_minor, currency, provider_created_at)
       values ($1, $2, $3, 50, 'USD', now())`,
      [resourceId, paymentId, `re_issue_subject_${suffix}`]
    );
    return resourceId;
  }
  await ownerDatabaseClient.pool.query(
    `insert into disputes
       (id, payment_id, stripe_dispute_id, amount_minor, currency,
        provider_created_at, provider_updated_at)
     values ($1, $2, $3, 50, 'USD', now(), now())`,
    [resourceId, paymentId, `dp_issue_subject_${suffix}`]
  );
  return resourceId;
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
      resourceType: 'balance_transaction', resourceId: staged.balanceTransactionId,
      safeCode: 'immutable_mismatch', impact: 'exception', actor: systemActor(),
      correlationId: 'ledger-guard-issue'
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
    await expectHistoryGuard('update financial_reconciliation_issues set impact = \'pending\' where id = $1', [issue!.id]);
    const secondResourceId = staged.balanceTransactionId;
    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, {
      resourceType: 'balance_transaction', resourceId: secondResourceId,
      safeCode: 'classification_fork', impact: 'exception', actor: systemActor(),
      correlationId: 'ledger-second-guard-issue'
    }));
    const [secondIssue] = await databaseClient.db.select().from(financialReconciliationIssues)
      .where(eq(financialReconciliationIssues.safeCode, 'classification_fork'));
    let crossIssueError: unknown;
    try {
      await workerDatabaseClient.db.transaction(async (tx) => {
        await resolveFinancialIssueAfterRecompute(tx, {
          resourceType: 'balance_transaction', resourceId: staged.balanceTransactionId,
          safeCode: 'immutable_mismatch',
          proof: {
            status: 'resolved', resourceType: 'balance_transaction', resourceId: staged.balanceTransactionId,
            safeCode: 'immutable_mismatch'
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
    await workerDatabaseClient.db.transaction((tx) => resolveFinancialIssueAfterRecompute(tx, {
      resourceType: 'balance_transaction', resourceId: staged.balanceTransactionId,
      safeCode: 'immutable_mismatch',
      proof: {
        status: 'resolved', resourceType: 'balance_transaction', resourceId: staged.balanceTransactionId,
        safeCode: 'immutable_mismatch'
      },
      actor: systemActor(), correlationId: 'ledger-guard-resolution'
    }));
    await expectHistoryGuard(
      'update financial_reconciliation_issues set resolved_at = resolved_at + interval \'1 second\' where id = $1',
      [issue!.id]
    );
  });

  it('rejects a legal issue pair with the wrong impact', async () => {
    const staged = await stageBalanceTransaction(databaseClient.db, snapshot(), {
      correlationId: 'ledger-invalid-impact-stage'
    });

    await expect(databaseClient.pool.query(
      `insert into financial_reconciliation_issues
         (resource_type, resource_id, safe_code, impact, correlation_id)
       values ('balance_transaction', $1, 'immutable_mismatch', 'pending', $2)`,
      [staged.balanceTransactionId, 'ledger-invalid-impact']
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an issue whose polymorphic resource does not exist', async () => {
    await expect(databaseClient.pool.query(
      `insert into financial_reconciliation_issues
         (resource_type, resource_id, safe_code, impact, correlation_id)
       values ('payment', $1, 'missing_source', 'pending', $2)`,
      [randomUUID(), 'ledger-orphan-issue']
    )).rejects.toMatchObject({ code: '23503' });
  });

  it.each(['payment', 'refund', 'dispute'] as const)(
    'keeps a referenced %s issue subject from being deleted or reidentified',
    async (resourceType) => {
      const resourceId = await seedMutableIssueSubject(resourceType);
      await databaseClient.pool.query(
        `insert into financial_reconciliation_issues
           (resource_type, resource_id, safe_code, impact, correlation_id)
         values ($1, $2, 'missing_source', 'pending', $3)`,
        [resourceType, resourceId, `ledger-${resourceType}-subject-guard`]
      );

      await expect(ownerDatabaseClient.pool.query(
        `update ${resourceType === 'payment' ? 'payments' : `${resourceType}s`}
         set id = $1 where id = $2`,
        [randomUUID(), resourceId]
      )).rejects.toMatchObject({ code: '55000' });
      await expect(ownerDatabaseClient.pool.query(
        `delete from ${resourceType === 'payment' ? 'payments' : `${resourceType}s`}
         where id = $1`,
        [resourceId]
      )).rejects.toMatchObject({ code: '55000' });
    }
  );

  it('rejects an unsupported-category issue for a known classification', async () => {
    await stageBalanceTransaction(databaseClient.db, snapshot(), {
      correlationId: 'ledger-known-classification-stage'
    });
    const [known] = await databaseClient.db.select().from(financialClassificationVersions)
      .where(eq(financialClassificationVersions.subjectType, 'balance_transaction'));

    await expect(databaseClient.pool.query(
      `insert into financial_reconciliation_issues
         (resource_type, resource_id, safe_code, impact, correlation_id)
       values ('financial_classification', $1, 'unsupported_category', 'exception', $2)`,
      [known!.id, 'ledger-known-classification-issue']
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('requires every unknown classification to gain its permanent issue before commit', async () => {
    const staged = await stageBalanceTransaction(databaseClient.db, snapshot(), {
      correlationId: 'ledger-missing-unknown-issue-stage'
    });
    const [parent] = await databaseClient.db.select().from(stripeBalanceTransactions)
      .where(eq(stripeBalanceTransactions.id, staged.balanceTransactionId));
    const client = await databaseClient.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into financial_classification_versions
           (subject_type, subject_id, classifier_version, classification, source_fingerprint_sha256)
         values ('balance_transaction', $1, 2, 'unknown', $2)`,
        [staged.balanceTransactionId, parent!.fingerprintSha256]
      );
      await expect(client.query('commit')).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('rollback');
      client.release();
    }
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
      safeCode: 'immutable_mismatch' as const, impact: 'exception' as const,
      actor: systemActor(), correlationId: 'ledger-issue-open'
    };
    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, open));
    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, { ...open, correlationId: 'ledger-issue-repeat' }));
    const proof = { status: 'resolved' as const, resourceType: open.resourceType, resourceId: open.resourceId, safeCode: open.safeCode };
    const resolution = {
      resourceType: open.resourceType, resourceId: open.resourceId, safeCode: open.safeCode,
      actor: open.actor, proof
    };
    await workerDatabaseClient.db.transaction((tx) => resolveFinancialIssueAfterRecompute(tx, { ...resolution, correlationId: 'ledger-issue-resolve' }));
    await workerDatabaseClient.db.transaction((tx) => resolveFinancialIssueAfterRecompute(tx, { ...resolution, correlationId: 'ledger-issue-resolve-repeat' }));
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

  it('makes the worker role the sole audited transition and rejects runtime-role bypasses', async () => {
    const staged = await stageBalanceTransaction(databaseClient.db, snapshot(), {
      correlationId: 'ledger-direct-resolver-stage'
    });
    const resourceId = staged.balanceTransactionId;
    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, {
      resourceType: 'balance_transaction', resourceId, safeCode: 'immutable_mismatch',
      impact: 'exception',
      actor: systemActor(), correlationId: 'ledger-direct-resolver-open'
    }));
    const [issue] = await databaseClient.db.select().from(financialReconciliationIssues)
      .where(eq(financialReconciliationIssues.resourceId, resourceId));

    await expect(workerDatabaseClient.pool.query(
      `select * from "public"."resolve_financial_issue_after_worker_recompute"($1, $2)`,
      [issue!.id, '']
    )).rejects.toMatchObject({ code: '22023' });

    const client = await ownerDatabaseClient.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role "pale_orbit_runtime"');
      await client.query('savepoint rejected_runtime_resolver');
      await expect(client.query(
        `select * from "public"."resolve_financial_issue_after_worker_recompute"($1, $2)`,
        [issue!.id, 'ledger-runtime-resolver']
      )).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback to savepoint rejected_runtime_resolver');
      await client.query(
        `select set_config('pale_orbit.financial_worker_issue_resolution', $1, true)`,
        [issue!.id]
      );
      await expect(client.query(
       `update financial_reconciliation_issues
         set state = 'resolved', resolved_at = clock_timestamp()
         where id = $1`,
        [issue!.id]
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('rollback');
      client.release();
    }
    expect(await databaseClient.db.select().from(financialReconciliationIssues)
      .where(eq(financialReconciliationIssues.id, issue!.id)))
      .toEqual([expect.objectContaining({ state: 'open' })]);

    const worker = await workerDatabaseClient.pool.connect();
    let resolved: { rows: Array<{ id: string; state: string; resolved_by_admin_id: string | null }> };
    try {
      await worker.query('begin');
      resolved = await worker.query(
        `select * from "public"."resolve_financial_issue_after_worker_recompute"($1, $2)`,
        [issue!.id, 'ledger-worker-resolver']
      );
      await worker.query('commit');
    } finally {
      worker.release();
    }
    expect(resolved!.rows).toEqual([
      expect.objectContaining({ id: issue!.id, state: 'resolved', resolved_by_admin_id: null })
    ]);
    expect(await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'financial.issue.resolved'))).toEqual([
      expect.objectContaining({
        actorType: 'system', actorId: 'financial-worker', resourceType: 'financial_issue',
        resourceId: issue!.id, correlationId: 'ledger-worker-resolver',
        after: {
          resourceType: 'balance_transaction', resourceId, safeCode: 'immutable_mismatch',
          impact: 'exception', state: 'resolved', occurrenceCount: 1
        }
      })
    ]);
    const oldResolver = await databaseClient.pool.query<{ resolver: string | null }>(
      `select to_regprocedure(
        'public.resolve_financial_reconciliation_issue(uuid,uuid,audit_actor_type,text,text)'
      )::text as resolver`
    );
    expect(oldResolver.rows[0]?.resolver).toBeNull();
    await expect(databaseClient.pool.query(
      `insert into financial_reconciliation_issues
       (resource_type, resource_id, safe_code, state, impact, occurrence_count,
        correlation_id, resolved_at)
       values ('payment', $1, 'missing_source', 'resolved', 'pending', 1, $2,
         clock_timestamp())`,
      [randomUUID(), 'ledger-resolved-insert-bypass']
    )).rejects.toMatchObject({ code: '55000' });
  });

  it('does not prime resolution authorization for an absent or immutable issue', async () => {
    const unknown = snapshot({
      sourceFamily: 'unknown', sourceId: null, rawType: 'future_authorization_probe',
      reportingCategory: 'future_authorization_probe', feeMinor: 0, netMinor: 1_403,
      feeDetails: []
    });
    await stageBalanceTransaction(databaseClient.db, unknown, {
      correlationId: 'ledger-authorization-probe-stage'
    });
    const [immutableIssue] = await databaseClient.db.select().from(financialReconciliationIssues);
    const client = await workerDatabaseClient.pool.connect();
    try {
      await client.query('begin');
      const absent = await client.query(
        `select * from "public"."resolve_financial_issue_after_worker_recompute"($1, $2)`,
        [randomUUID(), 'ledger-absent-resolver']
      );
      expect(absent.rows).toEqual([]);
      const absentAuthorization = await client.query<{ authorization: string | null }>(
        `select nullif(current_setting('pale_orbit.financial_worker_issue_resolution', true), '')
           as authorization`
      );
      expect(absentAuthorization.rows[0]?.authorization).toBeNull();

      await client.query('savepoint immutable_resolution');
      await expect(client.query(
        `select * from "public"."resolve_financial_issue_after_worker_recompute"($1, $2)`,
        [immutableIssue!.id, 'ledger-immutable-resolver']
      )).rejects.toMatchObject({ code: '55000' });
      await client.query('rollback to savepoint immutable_resolution');
      const immutableAuthorization = await client.query<{ authorization: string | null }>(
        `select nullif(current_setting('pale_orbit.financial_worker_issue_resolution', true), '')
           as authorization`
      );
      expect(immutableAuthorization.rows[0]?.authorization).toBeNull();
      await client.query('commit');
    } finally {
      client.release();
    }
    expect(await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'financial.issue.resolved'))).toHaveLength(0);
  });

  it('rolls back classification and issue writes when an audit trigger rejects the enclosing transaction', async () => {
    const staged = await stageBalanceTransaction(databaseClient.db, snapshot(), { correlationId: 'ledger-audit-rollback-base' });
    const [parent] = await databaseClient.db.select().from(stripeBalanceTransactions);
    const triggerName = `ledger_audit_fail_${randomUUID().replaceAll('-', '')}`;
    const functionName = `${triggerName}_fn`;
    await installRejectingAuditTrigger(functionName, triggerName);
    try {
      await expect(databaseClient.db.transaction((tx) => appendClassificationDecisionLocked(tx, {
        subjectType: 'balance_transaction', subjectId: staged.balanceTransactionId, classifierVersion: 2,
        sourceFingerprint: parent!.fingerprintSha256,
        decision: { status: 'classified', classification: 'charge', impact: 'informational' }, correlationId: 'ledger-audit-rollback-classification'
      }))).rejects.toThrow();
    } finally {
      await removeRejectingAuditTrigger(functionName, triggerName);
    }
    expect((await databaseClient.db.select().from(financialClassificationVersions)).filter((entry) => entry.classifierVersion === 2)).toHaveLength(0);

    const resourceId = staged.balanceTransactionId;
    await installRejectingAuditTrigger(functionName, triggerName);
    try {
      await expect(databaseClient.db.transaction((tx) => observeFinancialIssue(tx, {
        resourceType: 'balance_transaction', resourceId, safeCode: 'immutable_mismatch',
        impact: 'exception',
        actor: systemActor(), correlationId: 'ledger-audit-rollback-issue'
      }))).rejects.toThrow();
    } finally {
      await removeRejectingAuditTrigger(functionName, triggerName);
    }
    expect(await databaseClient.db.select().from(financialReconciliationIssues)
      .where(eq(financialReconciliationIssues.resourceId, resourceId))).toHaveLength(0);

    const resolutionResourceId = staged.balanceTransactionId;
    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, {
      resourceType: 'balance_transaction', resourceId: resolutionResourceId,
      safeCode: 'classification_fork', impact: 'exception', actor: systemActor(),
      correlationId: 'ledger-audit-rollback-resolution-open'
    }));
    const [resolutionIssue] = await databaseClient.db.select().from(financialReconciliationIssues)
      .where(eq(financialReconciliationIssues.safeCode, 'classification_fork'));
    await installRejectingAuditTrigger(functionName, triggerName);
    const client = await workerDatabaseClient.pool.connect();
    try {
      await client.query('begin');
      await client.query('savepoint rejected_resolution');
      await expect(client.query(
        `select * from "public"."resolve_financial_issue_after_worker_recompute"($1, $2)`,
        [resolutionIssue!.id, 'ledger-audit-rollback-resolution']
      )).rejects.toThrow('forced audit failure');
      await client.query('rollback to savepoint rejected_resolution');
      const authorization = await client.query<{ authorization: string | null }>(
        `select nullif(current_setting('pale_orbit.financial_worker_issue_resolution', true), '')
           as authorization`
      );
      expect(authorization.rows[0]?.authorization).toBeNull();
      await client.query('commit');
    } finally {
      client.release();
      await removeRejectingAuditTrigger(functionName, triggerName);
    }
    expect(await databaseClient.db.select().from(financialReconciliationIssues)
      .where(eq(financialReconciliationIssues.id, resolutionIssue!.id)))
      .toEqual([expect.objectContaining({ state: 'open', resolvedAt: null })]);
    expect(await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'financial.issue.resolved'))).toHaveLength(0);
  });

  it('retains a novel fee detail and records its bounded unknown issue', async () => {
    const input = snapshot({ feeDetails: [{ ordinal: 0, rawType: 'future_fee', amountMinor: 71, currency: 'USD' }] });
    await stageBalanceTransaction(databaseClient.db, input, { correlationId: 'ledger-unknown-fee' });
    const details = await databaseClient.db.select().from(stripeBalanceTransactionFeeDetails);
    const classifications = await databaseClient.db.select()
      .from(financialClassificationVersions);
    const issues = await databaseClient.db.select().from(financialReconciliationIssues);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ rawType: 'future_fee', amountMinor: 71 });
    const unknown = classifications.find((row) =>
      row.subjectType === 'fee_detail' && row.subjectId === details[0]!.id &&
      row.classification === 'unknown');
    expect(unknown).toBeDefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ resourceType: 'financial_classification',
      resourceId: unknown!.id, safeCode: 'unsupported_category', impact: 'exception' });
    await expect(workerDatabaseClient.db.execute(sql`
      select * from "public"."resolve_financial_issue_after_worker_recompute"(
        ${issues[0]!.id}, 'ledger-unknown-direct-resolve'
      )
    `)).rejects.toMatchObject({ cause: { code: '55000' } });
    const client = await ownerDatabaseClient.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local session_replication_role = replica`);
      await expect(client.query(
        `update financial_reconciliation_issues
         set state = 'resolved', resolved_at = clock_timestamp()
         where id = $1`,
        [issues[0]!.id]
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('rollback');
    } finally {
      client.release();
    }
    await expect(databaseClient.db.select().from(financialReconciliationIssues))
      .resolves.toEqual([expect.objectContaining({ id: issues[0]!.id, state: 'open' })]);
    expect(JSON.stringify(issues)).not.toContain('future_fee');
  });
});
