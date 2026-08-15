import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import { createFixtureStripeGateway } from '$lib/server/commerce/stripe/fixture-gateway';
import { reconcilePaymentFinancialSource } from '$lib/server/commerce/financial/sources/payment';
import { reconcileRefundFinancialSource } from '$lib/server/commerce/financial/sources/refund';
import { reconcileDisputeFinancialSource } from '$lib/server/commerce/financial/sources/dispute';
import { stageBalanceTransaction } from '$lib/server/commerce/financial/ledger';
import {
  observeFinancialIssue,
  resolveFinancialIssueAfterRecompute
} from '$lib/server/commerce/financial/issues';
import { replayFinancialClassification } from '$lib/server/commerce/financial/rebase';
import {
  commitFinancialScanPage,
  finalizeFinancialReplay,
  loadClassificationReplayPage,
  startOrResumeFinancialScan
} from '$lib/server/commerce/financial/scans/repository';
import { createFinancialClassificationSubjectJob } from '$lib/server/commerce/financial/jobs';
import { auditEvents, financialAllocationSets, financialItemAllocations, guestIdentities,
  financialReconciliationIssues, entitlementGrants, entitlements, orderItems, orders, outboxMessages, payments,
  refundAllocations, refundAllocationComponents, refunds, disputeItemAllocations, disputes, user,
  payoutImportRunEntries, payoutImportRuns, stripeBalanceTransactions, stripePayoutBalanceTransactions,
  stripePayouts, titles, jobs } from '$lib/server/db/schema';
import { paymentSnapshotFixture } from '../fixtures/stripe/payment';
import { chargeSnapshotFixture } from '../fixtures/stripe/charge';
import { balanceTransactionSnapshotFixture } from '../fixtures/stripe/balance-transaction';
import { refundSnapshotFixture } from '../fixtures/stripe/refund';
import { disputeSnapshotFixture } from '../fixtures/stripe/dispute';
import { databaseClient } from './database';
import type { Database } from '$lib/server/db/client';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

it('rejects invalid payment source work without reaching PostgreSQL or Stripe', async () => {
  const gateway = { retrievePayment: vi.fn() } as unknown as StripeCommerceGateway;
  await expect(reconcilePaymentFinancialSource(
    databaseClient.db,
    gateway,
    { paymentId: '00000000-0000-4000-8000-000000000101', correlationId: '' },
    new AbortController().signal
  )).rejects.toMatchObject({ name: 'PermanentFinancialError', safeCode: 'invalid_job_payload' });
  expect(gateway.retrievePayment).not.toHaveBeenCalled();
});

describe('payment financial source', () => {
  async function paidPurchase(currency = 'USD') {
    const suffix = randomUUID();
    const orderId = randomUUID();
    const paidAt = new Date('2026-08-10T12:01:00.000Z');
    const [guest] = await databaseClient.db.insert(guestIdentities)
      .values({ email: `financial-source-${suffix}@example.com` }).returning();
    if (!guest) throw new Error('Expected guest fixture');
    const itemFacts = [
      { id: randomUUID(), subtotal: 800, tax: 80 },
      { id: randomUUID(), subtotal: 450, tax: 70 }
    ];
    const titleIds: string[] = [];
    for (const [index, item] of itemFacts.entries()) {
      const titleId = randomUUID();
      titleIds.push(titleId);
      await databaseClient.db.insert(titles).values({ id: titleId, slug: `financial-source-${index}-${suffix}`,
        title: `Financial title ${index}`, description: 'Financial source title', creatorName: 'Creator',
        format: 'prose', priceMinor: item.subtotal, currency, visibility: 'private' });
      itemFacts[index] = { ...item, titleId } as typeof item & { titleId: string };
    }
    await databaseClient.db.insert(orders).values({ id: orderId, status: 'paid', guestIdentityId: guest.id,
      purchaseEmail: guest.email, currency, subtotalMinor: 1250, taxMinor: 150, totalMinor: 1400,
      clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'a'.repeat(64),
      stripeCheckoutSessionId: `cs_${suffix}`, statusTokenSha256: 'b'.repeat(64),
      checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'), paidAt });
    await databaseClient.db.insert(orderItems).values(itemFacts.map((item, index) => ({ id: item.id, orderId,
      titleId: (item as typeof item & { titleId: string }).titleId, titleSnapshot: `Financial title ${index}`,
      creatorNameSnapshot: 'Creator', format: 'prose' as const, currency,
      unitSubtotalMinor: item.subtotal, taxMinor: item.tax, totalMinor: item.subtotal + item.tax,
      stripeLineItemId: `li_${index}_${suffix}` })));
    const provider = { paymentIntentId: `pi_${suffix}`, chargeId: `ch_${suffix}`, transactionId: `txn_${suffix}` };
    const [payment] = await databaseClient.db.insert(payments).values({ orderId,
      stripePaymentIntentId: provider.paymentIntentId, stripeLatestChargeId: provider.chargeId,
      status: 'succeeded', amountMinor: 1400, currency, paymentMethodCategory: 'card', paidAt }).returning();
    if (!payment) throw new Error('Expected payment fixture');
    return { suffix, orderId, paidAt, purchaseEmail: guest.email, payment, itemFacts, titleIds, provider };
  }

  it('reconciles an FX-settled multi-title charge and exactly replays without duplicate audit', async () => {
    const fixture = await paidPurchase();
    const grantsBefore = await databaseClient.db.select().from(entitlementGrants).where(inArray(
      entitlementGrants.orderItemId, fixture.itemFacts.map((item) => item.id)
    ));
    const entitlementsBefore = await databaseClient.db.select().from(entitlements).where(inArray(
      entitlements.titleId, fixture.titleIds
    ));
    const outboxBefore = await databaseClient.db.select().from(outboxMessages).where(
      sql`${outboxMessages.payload}::text like ${`%${fixture.orderId}%`}`
    );
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({ paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId, latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400, currency: 'usd', paidAt: fixture.paidAt }));
    stripe.harness.setCharge(chargeSnapshotFixture({ id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId, amountMinor: 1400, currency: 'USD',
      balanceTransactionId: fixture.provider.transactionId, createdAt: fixture.paidAt }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({ id: fixture.provider.transactionId,
      sourceId: fixture.provider.chargeId, amountMinor: 1260, feeMinor: 60, netMinor: 1200,
      currency: 'EUR', status: 'pending', createdAt: fixture.paidAt, exchangeRate: '0.9',
      exchangeSourceCurrency: 'USD', exchangeTargetCurrency: 'EUR',
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 60, currency: 'EUR' }] }));
    await databaseClient.db.insert(financialReconciliationIssues).values({ resourceType: 'payment',
      resourceId: fixture.payment.id, safeCode: 'payout_incomplete', impact: 'pending',
      correlationId: `unrelated-${fixture.suffix}` });

    const first = await reconcilePaymentFinancialSource(databaseClient.db, stripe.gateway, {
      paymentId: fixture.payment.id, correlationId: `fx-first-${fixture.suffix}`
    }, new AbortController().signal);
    expect(first).toMatchObject({ status: 'reconciled', financialEvidenceStatus: 'fee_reconciled' });
    expect((await databaseClient.db.select().from(stripeBalanceTransactions).where(eq(
      stripeBalanceTransactions.providerId, fixture.provider.transactionId
    )))[0]?.status).toBe('pending');
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({ id: fixture.provider.transactionId,
      sourceId: fixture.provider.chargeId, amountMinor: 1260, feeMinor: 60, netMinor: 1200,
      currency: 'EUR', status: 'available', createdAt: fixture.paidAt, exchangeRate: '0.9',
      exchangeSourceCurrency: 'USD', exchangeTargetCurrency: 'EUR',
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 60, currency: 'EUR' }] }));
    const second = await reconcilePaymentFinancialSource(databaseClient.db, stripe.gateway, {
      paymentId: fixture.payment.id, correlationId: `fx-replay-${fixture.suffix}`
    }, new AbortController().signal);
    expect(second).toEqual({ status: 'unchanged', sourceKind: 'payment', sourceId: fixture.payment.id,
      financialEvidenceStatus: 'fee_reconciled' });

    const sets = await databaseClient.db.select().from(financialAllocationSets)
      .where(eq(financialAllocationSets.sourceInternalId, fixture.payment.id));
    expect(sets.map((set) => set.allocationIdentity).sort()).toEqual([
      `payment:${fixture.payment.id}:${sets[0]!.balanceTransactionId}:replay:c1-a1:fee`,
      `payment:${fixture.payment.id}:${sets[0]!.balanceTransactionId}:replay:c1-a1:gross`
    ].sort());
    const allocations = await databaseClient.db.select({ effectMinor: financialItemAllocations.effectMinor })
      .from(financialItemAllocations).innerJoin(financialAllocationSets, eq(
        financialAllocationSets.id, financialItemAllocations.allocationSetId
      )).where(eq(financialAllocationSets.sourceInternalId, fixture.payment.id));
    expect(sets).toHaveLength(2);
    expect(allocations.reduce((sum, row) => sum + row.effectMinor, 0)).toBe(1200);
    const transactions = await databaseClient.db.select().from(stripeBalanceTransactions).where(eq(
      stripeBalanceTransactions.providerId, fixture.provider.transactionId
    ));
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.status).toBe('available');
    expect((await databaseClient.db.select().from(payments).where(eq(payments.id, fixture.payment.id)))[0])
      .toMatchObject({ financialEvidenceStatus: 'fee_reconciled', status: 'succeeded' });
    const audits = await databaseClient.db.select().from(auditEvents)
      .where(and(eq(auditEvents.action, 'financial.payment_reconciled'),
        eq(auditEvents.resourceType, 'payment'), eq(auditEvents.resourceId, fixture.payment.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after).toEqual({ paymentId: fixture.payment.id, orderId: fixture.orderId,
      financialEvidenceStatus: 'fee_reconciled', settlementCurrency: 'EUR', amountMinor: 1260,
      feeMinor: 60, netMinor: 1200, grossAllocationCount: 4, feeAllocationCount: 2 });
    const serializedAudit = JSON.stringify(audits[0]?.after);
    expect(serializedAudit).not.toContain(fixture.provider.paymentIntentId);
    expect(serializedAudit).not.toContain(fixture.provider.chargeId);
    expect(serializedAudit).not.toContain(fixture.provider.transactionId);
    expect(serializedAudit).not.toContain(fixture.purchaseEmail);
    expect(await databaseClient.db.select().from(entitlementGrants).where(inArray(
      entitlementGrants.orderItemId, fixture.itemFacts.map((item) => item.id)
    ))).toEqual(grantsBefore);
    expect(await databaseClient.db.select().from(entitlements).where(inArray(
      entitlements.titleId, fixture.titleIds
    ))).toEqual(entitlementsBefore);
    expect(await databaseClient.db.select().from(outboxMessages).where(
      sql`${outboxMessages.payload}::text like ${`%${fixture.orderId}%`}`
    )).toEqual(outboxBefore);
    expect((await databaseClient.db.select().from(orders).where(eq(orders.id, fixture.orderId)))[0])
      .toMatchObject({ status: 'paid', paidAt: fixture.paidAt, purchaseEmail: fixture.purchaseEmail });
    expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(eq(
      financialReconciliationIssues.safeCode, 'payout_incomplete'
    ), eq(financialReconciliationIssues.resourceId, fixture.payment.id))))
      .toEqual([expect.objectContaining({ resourceId: fixture.payment.id, state: 'open' })]);
  });

  it('fails a staged active-version replay closed when the pending version activates before projection', async () => {
    const fixture = await paidPurchase();
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400,
      currency: 'usd',
      paidAt: fixture.paidAt
    }));
    stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400,
      currency: 'USD',
      balanceTransactionId: fixture.provider.transactionId,
      createdAt: fixture.paidAt
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: fixture.provider.transactionId,
      sourceId: fixture.provider.chargeId,
      amountMinor: 1400,
      feeMinor: 50,
      netMinor: 1350,
      currency: 'USD',
      status: 'available',
      createdAt: fixture.paidAt,
      feeDetails: [{
        ordinal: 0,
        rawType: 'stripe_fee',
        amountMinor: 50,
        currency: 'USD'
      }]
    }));
    const signal = new AbortController().signal;
    await expect(reconcilePaymentFinancialSource(databaseClient.db, stripe.gateway, {
      paymentId: fixture.payment.id,
      correlationId: `activation-race-seed-${fixture.suffix}`
    }, signal)).resolves.toMatchObject({
      status: 'reconciled',
      financialEvidenceStatus: 'fee_reconciled'
    });

    const pending = await startOrResumeFinancialScan(databaseClient.db, {
      kind: 'composite_replay',
      classifierVersion: 2,
      allocationAlgorithmVersion: 2,
      replayId: 'c2-a2'
    });
    const page = await loadClassificationReplayPage(databaseClient.db, pending, 100);
    expect(page.hasMore).toBe(false);
    const children = page.data.map((subject) => createFinancialClassificationSubjectJob({
      ...subject,
      classifierVersion: 2,
      allocationAlgorithmVersion: 2,
      scanRunId: pending.id
    }));
    const sealed = await commitFinancialScanPage(databaseClient.db, {
      runId: pending.id,
      expectedPhase: 'classification_replay_page',
      expectedCheckpoint: null,
      expectedPageCount: 0,
      nextPhase: 'classification_replay_page',
      nextCheckpoint: null,
      processedCount: page.data.length,
      children,
      complete: true
    });
    for (const child of children) {
      await replayFinancialClassification({
        database: databaseClient.db,
        targetClassifierVersion: 2,
        targetAllocationAlgorithmVersion: 2
      }, {
        payload: child.payload,
        correlationId: `activation-race-child-${child.payload.subjectType}`,
        signal
      });
      await databaseClient.db.update(jobs).set({
        status: 'succeeded',
        attempts: 1,
        completedAt: new Date(),
        lastError: null
      }).where(eq(jobs.deduplicationKey, child.deduplicationKey));
    }
    await databaseClient.db.transaction(async (tx) => {
      await tx.update(payments).set({ financialEvidenceStatus: 'pending' })
        .where(eq(payments.id, fixture.payment.id));
      await observeFinancialIssue(tx, {
        resourceType: 'payment',
        resourceId: fixture.payment.id,
        safeCode: 'allocation_incomplete',
        impact: 'pending',
        actor: { type: 'system', id: 'activation-race-test' },
        correlationId: `activation-race-open-${fixture.suffix}`
      });
    });
    const issueBefore = (await databaseClient.db.select().from(financialReconciliationIssues)
      .where(and(
        eq(financialReconciliationIssues.resourceId, fixture.payment.id),
        eq(financialReconciliationIssues.safeCode, 'allocation_incomplete')
      )))[0]!;
    const projectionEntered = deferred<void>();
    const releaseProjection = deferred<void>();
    let transactionCount = 0;
    const racingDatabase = new Proxy(databaseClient.db, {
      get(target, property) {
        if (property === 'transaction') {
          return async (work: (tx: never) => Promise<unknown>) => {
            transactionCount += 1;
            if (transactionCount === 2) {
              projectionEntered.resolve();
              await releaseProjection.promise;
            }
            return target.transaction((tx) => work(tx as never));
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as unknown as Database;
    const staleProjection = reconcilePaymentFinancialSource(racingDatabase, stripe.gateway, {
      paymentId: fixture.payment.id,
      correlationId: `activation-race-stale-${fixture.suffix}`
    }, signal);
    await projectionEntered.promise;
    try {
      await expect(finalizeFinancialReplay(databaseClient.db, {
        runId: pending.id,
        expectedCursorDigestSha256: sealed.cursorDigestSha256!,
        expectedPageCount: sealed.pageCount,
        classifierVersion: 2,
        allocationAlgorithmVersion: 2,
        correlationId: `activation-race-finalize-${fixture.suffix}`
      })).resolves.toMatchObject({ state: 'completed' });
    } finally {
      releaseProjection.resolve();
    }
    await expect(staleProjection).rejects.toMatchObject({
      name: 'RetryableFinancialError',
      safeCode: 'state_changed'
    });

    expect((await databaseClient.db.select().from(payments)
      .where(eq(payments.id, fixture.payment.id)))[0])
      .toMatchObject({ financialEvidenceStatus: 'pending' });
    expect((await databaseClient.db.select().from(financialReconciliationIssues)
      .where(eq(financialReconciliationIssues.id, issueBefore.id)))[0])
      .toMatchObject({ state: 'open', occurrenceCount: issueBefore.occurrenceCount });
  }, 15_000);

  it.each(['missing_charge', 'missing_balance_transaction'] as const)(
    'records %s as provider-not-ready with a durable missing_source issue', async (kind) => {
      const fixture = await paidPurchase();
      const stripe = createFixtureStripeGateway();
      stripe.harness.setPayment(paymentSnapshotFixture({ paymentIntentId: fixture.provider.paymentIntentId,
        metadataOrderId: fixture.orderId,
        latestChargeId: kind === 'missing_charge' ? null : fixture.provider.chargeId,
        state: kind === 'missing_charge' ? 'pending' : 'succeeded',
        amountMinor: 1400, currency: 'usd', paidAt: kind === 'missing_charge' ? null : fixture.paidAt }));
      if (kind === 'missing_balance_transaction') stripe.harness.setCharge(chargeSnapshotFixture({
        id: fixture.provider.chargeId, paymentIntentId: fixture.provider.paymentIntentId,
        amountMinor: 1400, currency: 'USD', balanceTransactionId: null, createdAt: fixture.paidAt
      }));

      await expect(reconcilePaymentFinancialSource(databaseClient.db, stripe.gateway, {
        paymentId: fixture.payment.id, correlationId: `${kind}-${fixture.suffix}`
      }, new AbortController().signal)).resolves.toMatchObject({ status: 'pending',
        safeCode: 'provider_not_ready', financialEvidenceStatus: 'pending', issueId: expect.any(String) });
      expect((await databaseClient.db.select().from(financialReconciliationIssues).where(eq(
        financialReconciliationIssues.resourceId, fixture.payment.id
      )))[0]).toMatchObject({ safeCode: 'missing_source', impact: 'pending', state: 'open' });
    }
  );

  it.each([
    ['metadata', { metadataOrderId: randomUUID(), state: 'pending', paidAt: null, latestChargeId: null }, 'source_linkage_mismatch'],
    ['amount', { amountMinor: 1399, state: 'pending', paidAt: null, latestChargeId: null }, 'immutable_mismatch'],
    ['currency', { currency: 'cad', state: 'pending', paidAt: null, latestChargeId: null }, 'currency_mismatch'],
    ['livemode', { liveMode: true }, 'immutable_mismatch']
  ] as const)('records a durable exception for canonical %s mismatch', async (_label, override, safeCode) => {
    const fixture = await paidPurchase();
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({ paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId, latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400, currency: 'usd', paidAt: fixture.paidAt, ...override }));
    stripe.harness.setCharge(chargeSnapshotFixture({ id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId, amountMinor: 1400, currency: 'USD',
      balanceTransactionId: null, createdAt: fixture.paidAt }));

    await expect(reconcilePaymentFinancialSource(databaseClient.db, stripe.gateway, {
      paymentId: fixture.payment.id, correlationId: `mismatch-${_label}-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'exception', safeCode,
      financialEvidenceStatus: 'exception', issueId: expect.any(String) });
  });

  it.each(['payment_intent', 'charge'] as const)('treats terminal failed %s as immutable mismatch', async (kind) => {
    const fixture = await paidPurchase();
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({ paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId, latestChargeId: fixture.provider.chargeId,
      state: kind === 'payment_intent' ? 'failed' : 'succeeded', amountMinor: 1400,
      currency: 'usd', paidAt: kind === 'payment_intent' ? null : fixture.paidAt }));
    if (kind === 'charge') stripe.harness.setCharge(chargeSnapshotFixture({ id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId, amountMinor: 1400, currency: 'USD',
      status: 'failed', balanceTransactionId: null, createdAt: fixture.paidAt }));

    await expect(reconcilePaymentFinancialSource(databaseClient.db, stripe.gateway, {
      paymentId: fixture.payment.id, correlationId: `terminal-${kind}-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'exception',
      safeCode: 'immutable_mismatch', financialEvidenceStatus: 'exception' });
  });

  it('validates pending PaymentIntent identity before recording provider-not-ready', async () => {
    const fixture = await paidPurchase();
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({ paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: randomUUID(), latestChargeId: null, state: 'pending', amountMinor: 1400,
      currency: 'usd', paidAt: null }));

    await expect(reconcilePaymentFinancialSource(databaseClient.db, stripe.gateway, {
      paymentId: fixture.payment.id, correlationId: `pending-linkage-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'exception',
      safeCode: 'source_linkage_mismatch', financialEvidenceStatus: 'exception' });
    expect((await databaseClient.db.select().from(financialReconciliationIssues).where(eq(
      financialReconciliationIssues.resourceId, fixture.payment.id
    )))[0]).toMatchObject({ safeCode: 'source_linkage_mismatch', impact: 'exception', state: 'open' });
  });

  it('does not retain provider error text or causes in durable issue evidence', async () => {
    const fixture = await paidPurchase();
    const privateText = `private-provider-error-${fixture.suffix}`;
    const gateway = { retrievePayment: vi.fn(async () => {
      throw new PermanentCommerceError({ cause: new Error(privateText) });
    }) } as unknown as StripeCommerceGateway;

    const result = await reconcilePaymentFinancialSource(databaseClient.db, gateway, {
      paymentId: fixture.payment.id, correlationId: `private-provider-${fixture.suffix}`
    }, new AbortController().signal);
    expect(result).toMatchObject({ status: 'exception', safeCode: 'immutable_mismatch' });
    expect(result).not.toHaveProperty('cause');
    const issues = await databaseClient.db.select().from(financialReconciliationIssues).where(eq(
      financialReconciliationIssues.resourceId, fixture.payment.id
    ));
    const audits = await databaseClient.db.select().from(auditEvents).where(eq(
      auditEvents.resourceId, issues[0]!.id
    ));
    expect(JSON.stringify({ result, issues, audits })).not.toContain(privateText);
    expect(JSON.stringify({ result, issues, audits })).not.toContain('PermanentCommerceError');
  });

  it('validates Charge linkage before recording a missing Balance Transaction', async () => {
    const fixture = await paidPurchase();
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({ paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId, latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400, currency: 'usd', paidAt: fixture.paidAt }));
    stripe.harness.setCharge(chargeSnapshotFixture({ id: fixture.provider.chargeId,
      paymentIntentId: 'pi_foreign_charge', amountMinor: 1400, currency: 'USD',
      balanceTransactionId: null, createdAt: fixture.paidAt }));

    await expect(reconcilePaymentFinancialSource(databaseClient.db, stripe.gateway, {
      paymentId: fixture.payment.id, correlationId: `missing-bt-linkage-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'exception',
      safeCode: 'source_linkage_mismatch', financialEvidenceStatus: 'exception' });
  });

  it('rolls back a durable issue when local payment facts change before its lock', async () => {
    const fixture = await paidPurchase();
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({ paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId, latestChargeId: null, state: 'pending', amountMinor: 1400,
      currency: 'usd', paidAt: null }));
    let mutated = false;
    const wrapped = new Proxy(databaseClient.db, {
      get(target, property, receiver) {
        if (property === 'transaction') return async (work: Parameters<Database['transaction']>[0]) => {
          if (!mutated) {
            mutated = true;
            await databaseClient.db.update(payments).set({ paymentMethodCategory: 'wallet' })
              .where(eq(payments.id, fixture.payment.id));
          }
          return target.transaction(work);
        };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as Database;

    await expect(reconcilePaymentFinancialSource(wrapped, stripe.gateway, {
      paymentId: fixture.payment.id, correlationId: `locked-mutation-${fixture.suffix}`
    }, new AbortController().signal)).rejects.toMatchObject({ name: 'RetryableFinancialError', safeCode: 'state_changed' });
    expect(await databaseClient.db.select().from(financialReconciliationIssues).where(eq(
      financialReconciliationIssues.resourceId, fixture.payment.id
    ))).toHaveLength(0);
    expect((await databaseClient.db.select().from(payments).where(eq(payments.id, fixture.payment.id)))[0])
      .toMatchObject({ financialEvidenceStatus: 'pending', paymentMethodCategory: 'wallet' });
  });

  it('locks a payout full member closure without letting another unknown member poison the payment source', async () => {
    const fixture = await paidPurchase();
    const sourceSnapshot = balanceTransactionSnapshotFixture({ id: fixture.provider.transactionId,
      sourceId: fixture.provider.chargeId, amountMinor: 1400, feeMinor: 70, netMinor: 1330,
      currency: 'USD', createdAt: fixture.paidAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 70, currency: 'USD' }] });
    const source = await stageBalanceTransaction(databaseClient.db, sourceSnapshot, {
      correlationId: `closure-source-${fixture.suffix}`
    });
    const other = await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
      id: `txn_other_${fixture.suffix}`, sourceId: null, sourceFamily: 'unknown', rawType: 'future_kind',
      reportingCategory: 'future_category', amountMinor: 50, feeMinor: 0, netMinor: 50,
      currency: 'USD', createdAt: fixture.paidAt, feeDetails: []
    }), { correlationId: `closure-other-${fixture.suffix}` });
    const [payout] = await databaseClient.db.insert(stripePayouts).values({
      providerId: `po_${fixture.suffix}`, liveMode: false, amountMinor: 1380, currency: 'USD',
      automatic: true, method: 'standard', status: 'paid', reconciliationStatus: 'completed',
      providerCreatedAt: fixture.paidAt, arrivalAt: fixture.paidAt, retrievedAt: fixture.paidAt,
      financialGeneration: 1, fingerprintSha256: 'd'.repeat(64)
    }).returning();
    if (!payout) throw new Error('Expected payout fixture');
    const [run] = await databaseClient.db.insert(payoutImportRuns).values({ payoutId: payout.id,
      generation: 1, state: 'published', candidateCount: 2, pageCount: 1, safeOutcome: 'published',
      startedAt: fixture.paidAt, updatedAt: fixture.paidAt, completedAt: fixture.paidAt }).returning();
    if (!run) throw new Error('Expected payout run fixture');
    const memberIds = [source.balanceTransactionId, other.balanceTransactionId];
    await databaseClient.db.insert(payoutImportRunEntries).values(memberIds.map((balanceTransactionId) => ({
      runId: run.id, balanceTransactionId
    })));
    await databaseClient.db.insert(stripePayoutBalanceTransactions).values(memberIds.map((balanceTransactionId) => ({
      payoutId: payout.id, balanceTransactionId, publishedFromRunId: run.id, publishedAt: fixture.paidAt
    })));
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({ paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId, latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400, currency: 'usd', paidAt: fixture.paidAt }));
    stripe.harness.setCharge(chargeSnapshotFixture({ id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId, amountMinor: 1400, currency: 'USD',
      balanceTransactionId: fixture.provider.transactionId, createdAt: fixture.paidAt }));
    stripe.harness.setBalanceTransaction(sourceSnapshot);

    await expect(reconcilePaymentFinancialSource(databaseClient.db, stripe.gateway, {
      paymentId: fixture.payment.id, correlationId: `closure-reconcile-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({
      status: 'reconciled', financialEvidenceStatus: 'fee_reconciled'
    });
  });

  it('turns an immutable staged-ledger collision into a durable payment exception', async () => {
    const fixture = await paidPurchase();
    await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
      id: fixture.provider.transactionId, sourceId: fixture.provider.chargeId, rawType: 'payment',
      amountMinor: 1400, feeMinor: 70, netMinor: 1330, currency: 'USD', createdAt: fixture.paidAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 70, currency: 'USD' }]
    }), { correlationId: `collision-existing-${fixture.suffix}` });
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({ paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId, latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400, currency: 'usd', paidAt: fixture.paidAt }));
    stripe.harness.setCharge(chargeSnapshotFixture({ id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId, amountMinor: 1400, currency: 'USD',
      balanceTransactionId: fixture.provider.transactionId, createdAt: fixture.paidAt }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({ id: fixture.provider.transactionId,
      sourceId: fixture.provider.chargeId, rawType: 'charge', amountMinor: 1400, feeMinor: 70,
      netMinor: 1330, currency: 'USD', createdAt: fixture.paidAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 70, currency: 'USD' }] }));

    await expect(reconcilePaymentFinancialSource(databaseClient.db, stripe.gateway, {
      paymentId: fixture.payment.id, correlationId: `collision-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'exception',
      safeCode: 'immutable_mismatch', financialEvidenceStatus: 'exception', issueId: expect.any(String) });
    expect(await databaseClient.db.select().from(financialAllocationSets).where(eq(
      financialAllocationSets.sourceInternalId, fixture.payment.id
    ))).toHaveLength(0);
    expect((await databaseClient.db.select().from(payments).where(eq(payments.id, fixture.payment.id)))[0])
      .toMatchObject({ status: 'succeeded', financialEvidenceStatus: 'exception' });
  });

  it('rolls back a partially inserted allocation pair before committing its durable exception', async () => {
    const fixture = await paidPurchase();
    const snapshot = balanceTransactionSnapshotFixture({ id: fixture.provider.transactionId,
      sourceId: fixture.provider.chargeId, amountMinor: 1400, feeMinor: 70, netMinor: 1330,
      currency: 'USD', createdAt: fixture.paidAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 70, currency: 'USD' }] });
    const staged = await stageBalanceTransaction(databaseClient.db, snapshot, {
      correlationId: `partial-stage-${fixture.suffix}`
    });
    const [stored] = await databaseClient.db.select().from(stripeBalanceTransactions)
      .where(eq(stripeBalanceTransactions.id, staged.balanceTransactionId));
    if (!stored) throw new Error('Expected staged transaction');
    await databaseClient.db.insert(financialAllocationSets).values({
      allocationIdentity: `payment:${fixture.payment.id}:${staged.balanceTransactionId}:fee`,
      balanceTransactionId: staged.balanceTransactionId, sourceKind: 'payment',
      sourceInternalId: fixture.payment.id, basis: 'fee', scope: 'title', expectedEffectMinor: -69,
      currency: 'USD', algorithmVersion: 1, classifierVersion: 1,
      sourceFingerprintSha256: stored.fingerprintSha256
    });
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({ paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId, latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400, currency: 'usd', paidAt: fixture.paidAt }));
    stripe.harness.setCharge(chargeSnapshotFixture({ id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId, amountMinor: 1400, currency: 'USD',
      balanceTransactionId: fixture.provider.transactionId, createdAt: fixture.paidAt }));
    stripe.harness.setBalanceTransaction(snapshot);
    let transactionCount = 0;
    const wrapped = new Proxy(databaseClient.db, {
      get(target, property, receiver) {
        if (property === 'transaction') return async (work: Parameters<Database['transaction']>[0]) => {
          transactionCount += 1;
          return target.transaction(work);
        };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as Database;

    await expect(reconcilePaymentFinancialSource(wrapped, stripe.gateway, {
      paymentId: fixture.payment.id, correlationId: `partial-reconcile-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'exception',
      safeCode: 'source_linkage_mismatch', financialEvidenceStatus: 'exception' });
    const sets = await databaseClient.db.select().from(financialAllocationSets).where(eq(
      financialAllocationSets.sourceInternalId, fixture.payment.id
    ));
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ basis: 'fee', expectedEffectMinor: -69 });
    expect((await databaseClient.db.select().from(financialReconciliationIssues).where(eq(
      financialReconciliationIssues.resourceId, fixture.payment.id
    ))).some((issue) => issue.safeCode === 'source_linkage_mismatch' && issue.state === 'open')).toBe(true);
    expect(transactionCount).toBe(2);
  });

  it('checks abort before committing a durable issue transaction', async () => {
    const fixture = await paidPurchase();
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({ paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: randomUUID(), latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400, currency: 'usd', paidAt: fixture.paidAt }));
    const controller = new AbortController();
    const wrapped = new Proxy(databaseClient.db, {
      get(target, property, receiver) {
        if (property === 'transaction') return async (work: (tx: unknown) => Promise<unknown>) =>
          target.transaction(async (tx) => work(new Proxy(tx, {
            get(transaction, transactionProperty, transactionReceiver) {
              const value = Reflect.get(transaction, transactionProperty, transactionReceiver) as unknown;
              if (transactionProperty === 'update') return (table: unknown) => {
                if (table === payments) controller.abort();
                return tx.update(table as Parameters<typeof tx.update>[0]);
              };
              return typeof value === 'function' ? value.bind(transaction) : value;
            }
          })) as never);
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as Database;

    await expect(reconcilePaymentFinancialSource(wrapped, stripe.gateway, {
      paymentId: fixture.payment.id, correlationId: `issue-abort-${fixture.suffix}`
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await databaseClient.db.select().from(financialReconciliationIssues).where(eq(
      financialReconciliationIssues.resourceId, fixture.payment.id
    ))).toHaveLength(0);
    expect((await databaseClient.db.select().from(payments).where(eq(payments.id, fixture.payment.id)))[0])
      .toMatchObject({ status: 'succeeded', financialEvidenceStatus: 'pending' });
  });

  it('maps a purchase-graph mutation between provider fetch and financial lock to state_changed', async () => {
    const fixture = await paidPurchase();
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({ paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId, latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400, currency: 'usd', paidAt: fixture.paidAt }));
    stripe.harness.setCharge(chargeSnapshotFixture({ id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId, amountMinor: 1400, currency: 'USD',
      balanceTransactionId: fixture.provider.transactionId, createdAt: fixture.paidAt }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({ id: fixture.provider.transactionId,
      sourceId: fixture.provider.chargeId, amountMinor: 1400, feeMinor: 70, netMinor: 1330,
      currency: 'USD', createdAt: fixture.paidAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 70, currency: 'USD' }] }));
    let transactionCount = 0;
    const wrapped = new Proxy(databaseClient.db, {
      get(target, property, receiver) {
        if (property === 'transaction') return async (work: Parameters<Database['transaction']>[0]) => {
          transactionCount += 1;
          if (transactionCount === 2) {
            await databaseClient.db.update(orderItems).set({ unitSubtotalMinor: 801, totalMinor: 881 })
              .where(eq(orderItems.id, fixture.itemFacts[0]!.id));
          }
          return target.transaction(work);
        };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as Database;

    await expect(reconcilePaymentFinancialSource(wrapped, stripe.gateway, {
      paymentId: fixture.payment.id, correlationId: `graph-mutation-${fixture.suffix}`
    }, new AbortController().signal)).rejects.toMatchObject({ name: 'RetryableFinancialError', safeCode: 'state_changed' });
    expect(await databaseClient.db.select().from(financialAllocationSets).where(eq(
      financialAllocationSets.sourceInternalId, fixture.payment.id
    ))).toHaveLength(0);
  });

  it('checks abort before commit and rolls back projections while preserving the staged ledger', async () => {
    const fixture = await paidPurchase();
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({ paymentIntentId: fixture.provider.paymentIntentId,
      metadataOrderId: fixture.orderId, latestChargeId: fixture.provider.chargeId,
      amountMinor: 1400, currency: 'usd', paidAt: fixture.paidAt }));
    stripe.harness.setCharge(chargeSnapshotFixture({ id: fixture.provider.chargeId,
      paymentIntentId: fixture.provider.paymentIntentId, amountMinor: 1400, currency: 'USD',
      balanceTransactionId: fixture.provider.transactionId, createdAt: fixture.paidAt }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({ id: fixture.provider.transactionId,
      sourceId: fixture.provider.chargeId, amountMinor: 1400, feeMinor: 70, netMinor: 1330,
      currency: 'USD', createdAt: fixture.paidAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 70, currency: 'USD' }] }));
    const controller = new AbortController();
    const wrapped = new Proxy(databaseClient.db, {
      get(target, property, receiver) {
        if (property === 'transaction') return async (work: (tx: unknown) => Promise<unknown>) =>
          target.transaction(async (tx) => work(new Proxy(tx, {
            get(transaction, transactionProperty, transactionReceiver) {
              const value = Reflect.get(transaction, transactionProperty, transactionReceiver) as unknown;
              if (transactionProperty === 'insert') return (table: unknown) => {
                if (table === auditEvents) controller.abort();
                return tx.insert(table as Parameters<typeof tx.insert>[0]);
              };
              return typeof value === 'function' ? value.bind(transaction) : value;
            }
          })) as never);
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as Database;

    await expect(reconcilePaymentFinancialSource(wrapped, stripe.gateway, {
      paymentId: fixture.payment.id, correlationId: `abort-commit-${fixture.suffix}`
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await databaseClient.db.select().from(stripeBalanceTransactions).where(eq(
      stripeBalanceTransactions.providerId, fixture.provider.transactionId
    ))).toHaveLength(1);
    expect(await databaseClient.db.select().from(financialAllocationSets)
      .where(eq(financialAllocationSets.sourceInternalId, fixture.payment.id))).toHaveLength(0);
    expect((await databaseClient.db.select().from(payments).where(eq(payments.id, fixture.payment.id)))[0])
      .toMatchObject({ financialEvidenceStatus: 'pending', status: 'succeeded' });
    expect(await databaseClient.db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'financial.payment_reconciled'),
      eq(auditEvents.resourceType, 'payment'), eq(auditEvents.resourceId, fixture.payment.id)
    ))).toHaveLength(0);
  });
});

describe('refund and dispute financial sources', () => {
  async function purchase() {
    const suffix = randomUUID();
    const orderId = randomUUID();
    const paidAt = new Date('2026-08-10T12:05:00.000Z');
    const userId = randomUUID();
    const email = `financial-adjustment-${suffix}@example.com`;
    await databaseClient.db.insert(user).values({
      id: userId, name: 'Financial adjustment reader', email, emailVerified: true
    });
    const itemFacts = [
      { id: randomUUID(), titleId: randomUUID(), subtotal: 800, tax: 80 },
      { id: randomUUID(), titleId: randomUUID(), subtotal: 450, tax: 70 }
    ];
    for (const [index, item] of itemFacts.entries()) {
      await databaseClient.db.insert(titles).values({
        id: item.titleId, slug: `financial-adjustment-${index}-${suffix}`,
        title: `Financial adjustment title ${index}`, description: 'Financial source fixture',
        creatorName: 'Creator', format: 'prose', priceMinor: item.subtotal,
        currency: 'USD', visibility: 'private'
      });
    }
    await databaseClient.db.insert(orders).values({
      id: orderId, status: 'paid', initiatingUserId: userId, purchaseEmail: email,
      currency: 'USD', subtotalMinor: 1250, taxMinor: 150, totalMinor: 1400,
      clientCheckoutAttemptId: randomUUID(), quoteFingerprintSha256: 'a'.repeat(64),
      stripeCheckoutSessionId: `cs_adjustment_${suffix}`, statusTokenSha256: 'b'.repeat(64),
      checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'), paidAt
    });
    await databaseClient.db.insert(orderItems).values(itemFacts.map((item, index) => ({
      id: item.id, orderId, titleId: item.titleId,
      titleSnapshot: `Financial adjustment title ${index}`, creatorNameSnapshot: 'Creator',
      format: 'prose' as const, currency: 'USD', unitSubtotalMinor: item.subtotal,
      taxMinor: item.tax, totalMinor: item.subtotal + item.tax,
      stripeLineItemId: `li_adjustment_${index}_${suffix}`
    })));
    await databaseClient.db.insert(entitlementGrants).values(itemFacts.map((item) => ({
      titleId: item.titleId, userId, source: 'purchase' as const, orderItemId: item.id,
      state: 'active' as const, stateReason: 'payment_succeeded', grantedAt: paidAt
    })));
    await databaseClient.db.insert(entitlements).values(itemFacts.map((item) => ({
      userId, titleId: item.titleId, grantedAt: paidAt
    })));
    const provider = {
      paymentIntentId: `pi_adjustment_${suffix}`,
      chargeId: `ch_adjustment_${suffix}`
    };
    const [payment] = await databaseClient.db.insert(payments).values({
      orderId, stripePaymentIntentId: provider.paymentIntentId,
      stripeLatestChargeId: provider.chargeId, status: 'succeeded', amountMinor: 1400,
      currency: 'USD', paymentMethodCategory: 'card', paidAt
    }).returning();
    if (!payment) throw new Error('Expected payment fixture');
    return { suffix, orderId, paidAt, userId, email, payment, itemFacts, provider };
  }

  async function accessSnapshot(fixture: Awaited<ReturnType<typeof purchase>>) {
    return {
      grants: await databaseClient.db.select().from(entitlementGrants).where(inArray(
        entitlementGrants.orderItemId, fixture.itemFacts.map((item) => item.id)
      )),
      entitlements: await databaseClient.db.select().from(entitlements).where(inArray(
        entitlements.titleId, fixture.itemFacts.map((item) => item.titleId)
      )),
      outbox: await databaseClient.db.select().from(outboxMessages).where(
        sql`${outboxMessages.payload}::text like ${`%${fixture.orderId}%`}`
      )
    };
  }

  async function resolveGlobalClassificationFork(balanceTransactionId: string, correlationId: string) {
    await databaseClient.db.transaction((tx) => resolveFinancialIssueAfterRecompute(tx, {
      resourceType: 'balance_transaction', resourceId: balanceTransactionId,
      safeCode: 'classification_fork',
      proof: {
        status: 'resolved', resourceType: 'balance_transaction',
        resourceId: balanceTransactionId, safeCode: 'classification_fork'
      },
      actor: { type: 'system', id: 'financial-worker' }, correlationId
    }));
  }

  async function markActiveClassificationSucceeded(balanceTransactionId: string) {
    const [balance] = await databaseClient.db.select().from(stripeBalanceTransactions).where(
      eq(stripeBalanceTransactions.id, balanceTransactionId)
    );
    if (!balance) throw new Error('Expected active classification balance');
    const spec = createFinancialClassificationSubjectJob({
      subjectType: 'balance_transaction', subjectId: balance.id,
      sourceFingerprintSha256: balance.fingerprintSha256,
      classifierVersion: 1, allocationAlgorithmVersion: 1
    });
    const updated = await databaseClient.db.update(jobs).set({
      status: 'succeeded', attempts: 1, completedAt: new Date(),
      lockedAt: null, lockedBy: null, lastError: null
    }).where(and(
      eq(jobs.type, spec.type), eq(jobs.deduplicationKey, spec.deduplicationKey)
    )).returning({ id: jobs.id });
    expect(updated).toHaveLength(1);
  }

  it('reconciles a finalized refund idempotently, then fails closed and recovers', async () => {
    const fixture = await purchase();
    const refundCreatedAt = new Date('2026-08-10T13:00:00.000Z');
    const providerRefundId = `re_financial_${fixture.suffix}`;
    const providerBalanceId = `txn_refund_${fixture.suffix}`;
    const [refund] = await databaseClient.db.insert(refunds).values({
      paymentId: fixture.payment.id, stripeRefundId: providerRefundId, status: 'succeeded',
      amountMinor: 500, currency: 'USD', reason: 'requested_by_customer',
      providerCreatedAt: refundCreatedAt, allocationStatus: 'finalized'
    }).returning();
    if (!refund) throw new Error('Expected refund fixture');
    const allocations = await databaseClient.db.insert(refundAllocations).values([
      { refundId: refund.id, orderItemId: fixture.itemFacts[0]!.id, amountMinor: 320, source: 'automatic' },
      { refundId: refund.id, orderItemId: fixture.itemFacts[1]!.id, amountMinor: 180, source: 'automatic' }
    ]).returning();
    await databaseClient.db.insert(refundAllocationComponents).values([
      { refundAllocationId: allocations[0]!.id, refundId: refund.id,
        orderItemId: fixture.itemFacts[0]!.id, subtotalMinor: 290, taxMinor: 30,
        totalMinor: 320, currency: 'USD' },
      { refundAllocationId: allocations[1]!.id, refundId: refund.id,
        orderItemId: fixture.itemFacts[1]!.id, subtotalMinor: 150, taxMinor: 30,
        totalMinor: 180, currency: 'USD' }
    ]);
    const before = await accessSnapshot(fixture);
    const stripe = createFixtureStripeGateway();
    stripe.harness.setRefund(refundSnapshotFixture({
      providerRefundId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 500, providerCreatedAt: refundCreatedAt, balanceTransactionId: providerBalanceId
    }));
    stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId, metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId, amountMinor: 1400, paidAt: fixture.paidAt
    }));
    stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400, amountRefundedMinor: 500, currency: 'USD',
      balanceTransactionId: `txn_charge_${fixture.suffix}`, createdAt: fixture.paidAt
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerBalanceId, sourceId: providerRefundId, sourceFamily: 'refund',
      rawType: 'refund', reportingCategory: 'refund', amountMinor: -500, feeMinor: 10,
      netMinor: -510, currency: 'USD', createdAt: refundCreatedAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 10, currency: 'USD' }]
    }));

    const first = await reconcileRefundFinancialSource(databaseClient.db, stripe.gateway, {
      refundId: refund.id, correlationId: `refund-first-${fixture.suffix}`
    }, new AbortController().signal);
    expect(first).toMatchObject({ status: 'reconciled', financialEvidenceStatus: 'fee_reconciled' });
    const second = await reconcileRefundFinancialSource(databaseClient.db, stripe.gateway, {
      refundId: refund.id, correlationId: `refund-replay-${fixture.suffix}`
    }, new AbortController().signal);
    expect(second).toEqual({ status: 'unchanged', sourceKind: 'refund', sourceId: refund.id,
      financialEvidenceStatus: 'fee_reconciled' });

    const sets = await databaseClient.db.select().from(financialAllocationSets).where(and(
      eq(financialAllocationSets.sourceKind, 'refund'),
      eq(financialAllocationSets.sourceInternalId, refund.id)
    ));
    const refundBalanceTransactionId = sets[0]?.balanceTransactionId;
    if (!refundBalanceTransactionId) throw new Error('Expected refund allocation balance');
    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, {
      resourceType: 'balance_transaction', resourceId: refundBalanceTransactionId,
      safeCode: 'classification_fork', impact: 'exception',
      actor: { type: 'system', id: 'financial-worker' },
      correlationId: `refund-global-fork-${fixture.suffix}`
    }));
    await expect(reconcileRefundFinancialSource(databaseClient.db, stripe.gateway, {
      refundId: refund.id, correlationId: `refund-blocked-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({
      status: 'exception', safeCode: 'classification_fork'
    });
    const blockedSetIssues = await databaseClient.db.select().from(financialReconciliationIssues)
      .where(and(
        eq(financialReconciliationIssues.resourceType, 'allocation_set'),
        inArray(financialReconciliationIssues.resourceId, sets.map((set) => set.id)),
        eq(financialReconciliationIssues.safeCode, 'classification_fork')
      ));
    expect(blockedSetIssues).toHaveLength(2);
    expect(blockedSetIssues.every((issue) => issue.state === 'open')).toBe(true);
    const blockedHeads = await databaseClient.pool.query<{
      is_complete: boolean; proposed_issue_code: string | null;
    }>(`select is_complete, proposed_issue_code
        from current_financial_projection_heads
        where balance_transaction_id=$1
        order by basis`, [refundBalanceTransactionId]);
    expect(blockedHeads.rows).toHaveLength(2);
    expect(blockedHeads.rows.every((head) => !head.is_complete &&
      head.proposed_issue_code === 'classification_fork')).toBe(true);

    await resolveGlobalClassificationFork(
      refundBalanceTransactionId, `refund-resolve-global-${fixture.suffix}`
    );
    await markActiveClassificationSucceeded(refundBalanceTransactionId);
    await expect(reconcileRefundFinancialSource(databaseClient.db, stripe.gateway, {
      refundId: refund.id, correlationId: `refund-recover-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({
      status: 'reconciled', financialEvidenceStatus: 'fee_reconciled'
    });
    expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
      eq(financialReconciliationIssues.resourceType, 'allocation_set'),
      inArray(financialReconciliationIssues.resourceId, sets.map((set) => set.id)),
      eq(financialReconciliationIssues.safeCode, 'classification_fork')
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'resolved' }),
      expect.objectContaining({ state: 'resolved' })
    ]));
    const effects = await databaseClient.db.select({ effectMinor: financialItemAllocations.effectMinor })
      .from(financialItemAllocations).innerJoin(financialAllocationSets, eq(
        financialAllocationSets.id, financialItemAllocations.allocationSetId
      )).where(eq(financialAllocationSets.sourceInternalId, refund.id));
    expect(sets).toHaveLength(2);
    expect(effects.reduce((sum, row) => sum + row.effectMinor, 0)).toBe(-510);
    expect((await databaseClient.db.select().from(refunds).where(eq(refunds.id, refund.id)))[0])
      .toMatchObject({ status: 'succeeded', allocationStatus: 'finalized',
        financialEvidenceStatus: 'fee_reconciled' });
    expect(await databaseClient.db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'financial.refund_reconciled'),
      eq(auditEvents.resourceId, refund.id)
    ))).toHaveLength(2);
    expect(await accessSnapshot(fixture)).toEqual(before);
  });

  it('keeps an ambiguous succeeded refund unresolved and access-neutral on replay', async () => {
    const fixture = await purchase();
    const refundCreatedAt = new Date('2026-08-10T13:00:00.000Z');
    const providerRefundId = `re_ambiguous_${fixture.suffix}`;
    const providerBalanceId = `txn_refund_ambiguous_${fixture.suffix}`;
    const [refund] = await databaseClient.db.insert(refunds).values({
      paymentId: fixture.payment.id, stripeRefundId: providerRefundId, status: 'succeeded',
      amountMinor: 500, currency: 'USD', reason: 'requested_by_customer',
      providerCreatedAt: refundCreatedAt, allocationStatus: 'needs_review'
    }).returning();
    if (!refund) throw new Error('Expected refund fixture');
    const before = await accessSnapshot(fixture);
    const stripe = createFixtureStripeGateway();
    stripe.harness.setRefund(refundSnapshotFixture({
      providerRefundId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 500, providerCreatedAt: refundCreatedAt, balanceTransactionId: providerBalanceId
    }));
    stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId, metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId, amountMinor: 1400, paidAt: fixture.paidAt
    }));
    stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400, amountRefundedMinor: 500, currency: 'USD',
      balanceTransactionId: `txn_charge_${fixture.suffix}`, createdAt: fixture.paidAt
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerBalanceId, sourceId: providerRefundId, sourceFamily: 'refund',
      rawType: 'refund', reportingCategory: 'refund', amountMinor: -500, feeMinor: 10,
      netMinor: -510, currency: 'USD', createdAt: refundCreatedAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 10, currency: 'USD' }]
    }));

    const first = await reconcileRefundFinancialSource(databaseClient.db, stripe.gateway, {
      refundId: refund.id, correlationId: `refund-ambiguous-first-${fixture.suffix}`
    }, new AbortController().signal);
    expect(first).toMatchObject({ status: 'pending', sourceKind: 'refund', sourceId: refund.id,
      financialEvidenceStatus: 'pending', safeCode: 'allocation_incomplete', issueId: expect.any(String) });
    if (first.status !== 'pending') throw new Error('Expected pending refund reconciliation');
    const second = await reconcileRefundFinancialSource(databaseClient.db, stripe.gateway, {
      refundId: refund.id, correlationId: `refund-ambiguous-replay-${fixture.suffix}`
    }, new AbortController().signal);
    expect(second).toMatchObject({ status: 'pending', sourceKind: 'refund', sourceId: refund.id,
      financialEvidenceStatus: 'pending', safeCode: 'allocation_incomplete', issueId: first.issueId });

    const sets = await databaseClient.db.select().from(financialAllocationSets).where(and(
      eq(financialAllocationSets.sourceKind, 'refund'),
      eq(financialAllocationSets.sourceInternalId, refund.id)
    ));
    expect(sets).toHaveLength(2);
    expect(sets.map((set) => ({ basis: set.basis, scope: set.scope, expectedEffectMinor: set.expectedEffectMinor }))
      .sort((left, right) => left.basis === right.basis ? 0 : left.basis === 'gross_amount' ? -1 : 1))
      .toEqual([
        { basis: 'gross_amount', scope: 'unresolved', expectedEffectMinor: -500 },
        { basis: 'fee', scope: 'unresolved', expectedEffectMinor: -10 }
      ]);
    expect(await databaseClient.db.select().from(financialItemAllocations).where(inArray(
      financialItemAllocations.allocationSetId, sets.map((set) => set.id)
    ))).toHaveLength(0);
    expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
      eq(financialReconciliationIssues.resourceType, 'refund'),
      eq(financialReconciliationIssues.resourceId, refund.id)
    ))).toEqual([expect.objectContaining({ safeCode: 'allocation_incomplete', impact: 'pending',
      state: 'open', occurrenceCount: 2 })]);
    expect((await databaseClient.db.select().from(refunds).where(eq(refunds.id, refund.id)))[0])
      .toMatchObject({ status: 'succeeded', allocationStatus: 'needs_review',
        financialEvidenceStatus: 'pending' });
    expect(await accessSnapshot(fixture)).toEqual(before);
  });

  it('records a refund without provider transactions as durable pending evidence', async () => {
    const fixture = await purchase();
    const refundCreatedAt = new Date('2026-08-10T13:10:00.000Z');
    const providerRefundId = `re_pending_${fixture.suffix}`;
    const [refund] = await databaseClient.db.insert(refunds).values({
      paymentId: fixture.payment.id, stripeRefundId: providerRefundId, status: 'pending',
      amountMinor: 500, currency: 'USD', reason: 'requested_by_customer',
      providerCreatedAt: refundCreatedAt, allocationStatus: 'not_applicable'
    }).returning();
    if (!refund) throw new Error('Expected refund fixture');
    const stripe = createFixtureStripeGateway();
    stripe.harness.setRefund(refundSnapshotFixture({
      providerRefundId, paymentIntentId: fixture.provider.paymentIntentId,
      state: 'pending', amountMinor: 500, providerCreatedAt: refundCreatedAt,
      balanceTransactionId: null, failureBalanceTransactionId: null
    }));
    stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId, metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId, amountMinor: 1400, paidAt: fixture.paidAt
    }));
    stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400, currency: 'USD', balanceTransactionId: `txn_charge_${fixture.suffix}`,
      createdAt: fixture.paidAt
    }));

    await expect(reconcileRefundFinancialSource(databaseClient.db, stripe.gateway, {
      refundId: refund.id, correlationId: `refund-pending-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({
      status: 'pending', sourceKind: 'refund', sourceId: refund.id,
      financialEvidenceStatus: 'pending', safeCode: 'missing_source', issueId: expect.any(String)
    });

    expect(await databaseClient.db.select().from(financialAllocationSets).where(eq(
      financialAllocationSets.sourceInternalId, refund.id
    ))).toHaveLength(0);
    expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
      eq(financialReconciliationIssues.resourceType, 'refund'),
      eq(financialReconciliationIssues.resourceId, refund.id)
    ))).toEqual([expect.objectContaining({
      safeCode: 'missing_source', impact: 'pending', state: 'open'
    })]);
  });

  it('preserves the staged ledger collision issue and records a refund exception', async () => {
    const fixture = await purchase();
    const refundCreatedAt = new Date('2026-08-10T13:20:00.000Z');
    const providerRefundId = `re_collision_${fixture.suffix}`;
    const providerBalanceId = `txn_refund_collision_${fixture.suffix}`;
    const [refund] = await databaseClient.db.insert(refunds).values({
      paymentId: fixture.payment.id, stripeRefundId: providerRefundId, status: 'succeeded',
      amountMinor: 500, currency: 'USD', reason: 'requested_by_customer',
      providerCreatedAt: refundCreatedAt, allocationStatus: 'needs_review'
    }).returning();
    if (!refund) throw new Error('Expected refund fixture');
    const original = balanceTransactionSnapshotFixture({
      id: providerBalanceId, sourceId: providerRefundId, sourceFamily: 'refund',
      rawType: 'refund', reportingCategory: 'refund', amountMinor: -499,
      feeMinor: 0, netMinor: -499, currency: 'USD', createdAt: refundCreatedAt,
      feeDetails: []
    });
    const staged = await stageBalanceTransaction(databaseClient.db, original, {
      correlationId: `refund-collision-seed-${fixture.suffix}`
    });
    const stripe = createFixtureStripeGateway();
    stripe.harness.setRefund(refundSnapshotFixture({
      providerRefundId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 500, providerCreatedAt: refundCreatedAt,
      balanceTransactionId: providerBalanceId
    }));
    stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId, metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId, amountMinor: 1400, paidAt: fixture.paidAt
    }));
    stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400, amountRefundedMinor: 500, currency: 'USD',
      balanceTransactionId: `txn_charge_${fixture.suffix}`, createdAt: fixture.paidAt
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      ...original, amountMinor: -500, netMinor: -500
    }));

    await expect(reconcileRefundFinancialSource(databaseClient.db, stripe.gateway, {
      refundId: refund.id, correlationId: `refund-collision-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({
      status: 'exception', sourceKind: 'refund', sourceId: refund.id,
      financialEvidenceStatus: 'exception', safeCode: 'immutable_mismatch', issueId: expect.any(String)
    });

    expect((await databaseClient.db.select().from(refunds).where(eq(refunds.id, refund.id)))[0])
      .toMatchObject({ financialEvidenceStatus: 'exception' });
    expect(await databaseClient.db.select().from(financialReconciliationIssues).where(or(
      and(eq(financialReconciliationIssues.resourceType, 'balance_transaction'),
        eq(financialReconciliationIssues.resourceId, staged.balanceTransactionId)),
      and(eq(financialReconciliationIssues.resourceType, 'refund'),
        eq(financialReconciliationIssues.resourceId, refund.id))
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: 'balance_transaction', resourceId: staged.balanceTransactionId,
        safeCode: 'immutable_mismatch', impact: 'exception', state: 'open' }),
      expect.objectContaining({ resourceType: 'refund', resourceId: refund.id,
        safeCode: 'immutable_mismatch', impact: 'exception', state: 'open' })
    ]));
  });

  it('reconciles a dispute withdrawal idempotently, then fails closed and recovers', async () => {
    const fixture = await purchase();
    const disputeCreatedAt = new Date('2026-08-10T14:00:00.000Z');
    const providerDisputeId = `dp_financial_${fixture.suffix}`;
    const providerBalanceId = `txn_dispute_${fixture.suffix}`;
    const [dispute] = await databaseClient.db.insert(disputes).values({
      paymentId: fixture.payment.id, stripeDisputeId: providerDisputeId, status: 'open',
      amountMinor: 600, currency: 'USD', reason: 'fraudulent', providerCreatedAt: disputeCreatedAt,
      providerUpdatedAt: disputeCreatedAt
    }).returning();
    if (!dispute) throw new Error('Expected dispute fixture');
    const before = await accessSnapshot(fixture);
    const stripe = createFixtureStripeGateway();
    stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId, paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId, amountMinor: 600,
      providerCreatedAt: disputeCreatedAt, balanceTransactionIds: []
    }));
    stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId, metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId, amountMinor: 1400, paidAt: fixture.paidAt
    }));
    stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400, currency: 'USD', balanceTransactionId: `txn_charge_${fixture.suffix}`,
      createdAt: fixture.paidAt
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: providerBalanceId, sourceId: providerDisputeId, sourceFamily: 'dispute',
      rawType: 'adjustment', reportingCategory: 'dispute', amountMinor: -600,
      feeMinor: 15, netMinor: -615, currency: 'USD', createdAt: disputeCreatedAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 15, currency: 'USD' }]
    }));

    const zeroTransaction = await reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: dispute.id, correlationId: `dispute-zero-${fixture.suffix}`
    }, new AbortController().signal);
    expect(zeroTransaction).toMatchObject({
      status: 'pending', safeCode: 'missing_source', issueId: expect.any(String)
    });
    expect(await databaseClient.db.select().from(financialAllocationSets).where(and(
      eq(financialAllocationSets.sourceKind, 'dispute'),
      eq(financialAllocationSets.sourceInternalId, dispute.id)
    ))).toHaveLength(0);
    stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId, paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId, amountMinor: 600,
      providerCreatedAt: disputeCreatedAt, balanceTransactionIds: [providerBalanceId]
    }));
    const first = await reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: dispute.id, correlationId: `dispute-first-${fixture.suffix}`
    }, new AbortController().signal);
    expect(first).toMatchObject({ status: 'reconciled', financialEvidenceStatus: 'fee_reconciled' });
    const second = await reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: dispute.id, correlationId: `dispute-replay-${fixture.suffix}`
    }, new AbortController().signal);
    expect(second).toEqual({ status: 'unchanged', sourceKind: 'dispute', sourceId: dispute.id,
      financialEvidenceStatus: 'fee_reconciled' });
    const resolvedMissingSource = await databaseClient.db.select().from(financialReconciliationIssues)
      .where(and(
        eq(financialReconciliationIssues.resourceType, 'dispute'),
        eq(financialReconciliationIssues.resourceId, dispute.id),
        eq(financialReconciliationIssues.safeCode, 'missing_source')
      ));
    expect(resolvedMissingSource).toEqual([expect.objectContaining({
      id: zeroTransaction.status === 'pending' ? zeroTransaction.issueId : undefined,
      state: 'resolved', occurrenceCount: 1
    })]);
    const sets = await databaseClient.db.select().from(financialAllocationSets).where(and(
      eq(financialAllocationSets.sourceKind, 'dispute'),
      eq(financialAllocationSets.sourceInternalId, dispute.id)
    ));
    expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
      eq(financialReconciliationIssues.resourceType, 'allocation_set'),
      inArray(financialReconciliationIssues.resourceId, sets.map((set) => set.id)),
      eq(financialReconciliationIssues.safeCode, 'missing_source')
    ))).toHaveLength(0);
    const disputeBalanceTransactionId = sets[0]?.balanceTransactionId;
    if (!disputeBalanceTransactionId) throw new Error('Expected dispute allocation balance');
    await databaseClient.db.transaction((tx) => observeFinancialIssue(tx, {
      resourceType: 'balance_transaction', resourceId: disputeBalanceTransactionId,
      safeCode: 'classification_fork', impact: 'exception',
      actor: { type: 'system', id: 'financial-worker' },
      correlationId: `dispute-global-fork-${fixture.suffix}`
    }));
    await expect(reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: dispute.id, correlationId: `dispute-blocked-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({
      status: 'exception', safeCode: 'classification_fork'
    });
    const blockedSetIssues = await databaseClient.db.select().from(financialReconciliationIssues)
      .where(and(
        eq(financialReconciliationIssues.resourceType, 'allocation_set'),
        inArray(financialReconciliationIssues.resourceId, sets.map((set) => set.id)),
        eq(financialReconciliationIssues.safeCode, 'classification_fork')
      ));
    expect(blockedSetIssues).toHaveLength(2);
    expect(blockedSetIssues.every((issue) => issue.state === 'open')).toBe(true);
    const blockedHeads = await databaseClient.pool.query<{
      is_complete: boolean; proposed_issue_code: string | null;
    }>(`select is_complete, proposed_issue_code
        from current_financial_projection_heads
        where balance_transaction_id=$1
        order by basis`, [disputeBalanceTransactionId]);
    expect(blockedHeads.rows).toHaveLength(2);
    expect(blockedHeads.rows.every((head) => !head.is_complete &&
      head.proposed_issue_code === 'classification_fork')).toBe(true);

    await resolveGlobalClassificationFork(
      disputeBalanceTransactionId, `dispute-resolve-global-${fixture.suffix}`
    );
    await markActiveClassificationSucceeded(disputeBalanceTransactionId);
    await expect(reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: dispute.id, correlationId: `dispute-recover-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({
      status: 'reconciled', financialEvidenceStatus: 'fee_reconciled'
    });
    expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
      eq(financialReconciliationIssues.resourceType, 'allocation_set'),
      inArray(financialReconciliationIssues.resourceId, sets.map((set) => set.id)),
      eq(financialReconciliationIssues.safeCode, 'classification_fork')
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'resolved' }),
      expect.objectContaining({ state: 'resolved' })
    ]));
    const effects = await databaseClient.db.select({ effectMinor: financialItemAllocations.effectMinor })
      .from(financialItemAllocations).innerJoin(financialAllocationSets, eq(
        financialAllocationSets.id, financialItemAllocations.allocationSetId
      )).where(eq(financialAllocationSets.sourceInternalId, dispute.id));
    expect(sets).toHaveLength(2);
    expect(effects.reduce((sum, row) => sum + row.effectMinor, 0)).toBe(-615);
    expect(await databaseClient.db.select().from(disputeItemAllocations).where(eq(
      disputeItemAllocations.disputeId, dispute.id
    ))).toHaveLength(2);
    expect((await databaseClient.db.select().from(disputes).where(eq(disputes.id, dispute.id)))[0])
      .toMatchObject({ status: 'open', financialEvidenceStatus: 'fee_reconciled' });
    expect(await databaseClient.db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'financial.dispute_reconciled'),
      eq(auditEvents.resourceId, dispute.id)
    ))).toHaveLength(2);
    expect(await accessSnapshot(fixture)).toEqual(before);
  });

  it('retries when a sibling dispute balance joins the graph before authority enrollment', async () => {
    const fixture = await purchase();
    const primaryAt = new Date('2026-08-10T14:10:00.000Z');
    const siblingAt = new Date('2026-08-10T14:11:00.000Z');
    const primaryProviderDisputeId = `dp_graph_primary_${fixture.suffix}`;
    const siblingProviderDisputeId = `dp_graph_sibling_${fixture.suffix}`;
    const primaryProviderBalanceId = `txn_graph_primary_${fixture.suffix}`;
    const siblingProviderBalanceId = `txn_graph_sibling_${fixture.suffix}`;
    const [primary, sibling] = await databaseClient.db.insert(disputes).values([
      {
        paymentId: fixture.payment.id, stripeDisputeId: primaryProviderDisputeId,
        status: 'open', amountMinor: 100, currency: 'USD', reason: 'fraudulent',
        providerCreatedAt: primaryAt, providerUpdatedAt: primaryAt
      },
      {
        paymentId: fixture.payment.id, stripeDisputeId: siblingProviderDisputeId,
        status: 'open', amountMinor: 100, currency: 'USD', reason: 'fraudulent',
        providerCreatedAt: siblingAt, providerUpdatedAt: siblingAt
      }
    ]).returning();
    if (!primary || !sibling) throw new Error('Expected graph-race disputes');
    const stripe = createFixtureStripeGateway();
    stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId: primaryProviderDisputeId,
      paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId, amountMinor: 100,
      providerCreatedAt: primaryAt, balanceTransactionIds: [primaryProviderBalanceId]
    }));
    stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId, metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId, amountMinor: 1400, paidAt: fixture.paidAt
    }));
    stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400, currency: 'USD', balanceTransactionId: `txn_charge_${fixture.suffix}`,
      createdAt: fixture.paidAt
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: primaryProviderBalanceId, sourceId: primaryProviderDisputeId,
      sourceFamily: 'dispute', rawType: 'adjustment', reportingCategory: 'dispute',
      amountMinor: -100, feeMinor: 0, netMinor: -100, currency: 'USD',
      createdAt: primaryAt, feeDetails: []
    }));

    const mainTransactionEntered = deferred<void>();
    const releaseMainTransaction = deferred<void>();
    let transactionCount = 0;
    const pausedDatabase = new Proxy(databaseClient.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async (work: Parameters<Database['transaction']>[0]) => {
            transactionCount += 1;
            if (transactionCount === 2) {
              mainTransactionEntered.resolve();
              await releaseMainTransaction.promise;
            }
            return target.transaction(work);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }) as Database;
    const running = reconcileDisputeFinancialSource(pausedDatabase, stripe.gateway, {
      disputeId: primary.id, correlationId: `dispute-graph-race-${fixture.suffix}`
    }, new AbortController().signal);

    await mainTransactionEntered.promise;
    try {
      await stageBalanceTransaction(databaseClient.db, balanceTransactionSnapshotFixture({
        id: siblingProviderBalanceId, sourceId: siblingProviderDisputeId,
        sourceFamily: 'dispute', rawType: 'adjustment', reportingCategory: 'dispute',
        amountMinor: -100, feeMinor: 0, netMinor: -100, currency: 'USD',
        createdAt: siblingAt, feeDetails: []
      }), { correlationId: `dispute-graph-sibling-stage-${fixture.suffix}` });
    } finally {
      releaseMainTransaction.resolve();
    }

    await expect(running).rejects.toMatchObject({
      name: 'RetryableFinancialError', safeCode: 'state_changed'
    });
    expect(transactionCount).toBe(2);
    expect(await databaseClient.db.select().from(financialAllocationSets).where(and(
      eq(financialAllocationSets.sourceKind, 'dispute'),
      inArray(financialAllocationSets.sourceInternalId, [primary.id, sibling.id])
    ))).toHaveLength(0);
    expect(await databaseClient.db.select().from(stripeBalanceTransactions).where(inArray(
      stripeBalanceTransactions.providerId, [primaryProviderBalanceId, siblingProviderBalanceId]
    ))).toHaveLength(2);
  });

  it('persists a dispute fee credit as a gross-basis tip without a cross-basis reversal', async () => {
    const fixture = await purchase();
    const withdrawalAt = new Date('2026-08-10T14:00:00.000Z');
    const creditAt = new Date('2026-08-10T14:30:00.000Z');
    const providerDisputeId = `dp_credit_${fixture.suffix}`;
    const withdrawalId = `txn_dispute_credit_base_${fixture.suffix}`;
    const creditId = `txn_dispute_credit_${fixture.suffix}`;
    const [dispute] = await databaseClient.db.insert(disputes).values({
      paymentId: fixture.payment.id, stripeDisputeId: providerDisputeId, status: 'won',
      amountMinor: 500, currency: 'USD', reason: 'fraudulent', providerCreatedAt: withdrawalAt,
      providerUpdatedAt: creditAt
    }).returning();
    if (!dispute) throw new Error('Expected fee-credit dispute fixture');
    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId, metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId, amountMinor: 1400, paidAt: fixture.paidAt
    }));
    stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400, currency: 'USD', balanceTransactionId: `txn_charge_${fixture.suffix}`,
      createdAt: fixture.paidAt
    }));
    stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId, paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId, state: 'won', amountMinor: 500,
      providerCreatedAt: withdrawalAt, balanceTransactionIds: [creditId, withdrawalId]
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: withdrawalId, sourceId: providerDisputeId, sourceFamily: 'dispute',
      rawType: 'adjustment', reportingCategory: 'dispute', amountMinor: -500,
      feeMinor: 15, netMinor: -515, currency: 'USD', createdAt: withdrawalAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 15, currency: 'USD' }]
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: creditId, sourceId: providerDisputeId, sourceFamily: 'dispute',
      rawType: 'stripe_fee', reportingCategory: 'fee', amountMinor: 15,
      feeMinor: 0, netMinor: 15, currency: 'USD', createdAt: creditAt, feeDetails: []
    }));

    await expect(reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: dispute.id, correlationId: `dispute-credit-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'reconciled' });
    const rows = ((await databaseClient.db.execute(sql`
      select allocation_set.reversal_of_set_id as "reversalOfSetId",
        allocation_set.basis, item.component, item.effect_minor as "effectMinor"
      from financial_allocation_sets allocation_set
      join stripe_balance_transactions transaction
        on transaction.id = allocation_set.balance_transaction_id
      left join financial_item_allocations item on item.allocation_set_id = allocation_set.id
      where transaction.provider_id = ${creditId}
      order by allocation_set.basis, item.tie_break_key
    `)) as { rows?: Array<{ reversalOfSetId: string | null; basis: string;
      component: string | null; effectMinor: number | null }> }).rows ?? [];
    expect(rows.filter((row) => row.basis === 'gross_amount')).toEqual(
      expect.arrayContaining([expect.objectContaining({
        reversalOfSetId: null, component: 'fee_credit'
      })])
    );
    expect(rows.filter((row) => row.basis === 'gross_amount').reduce(
      (sum, row) => sum + (row.effectMinor ?? 0), 0
    )).toBe(15);
    await expect(reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: dispute.id, correlationId: `dispute-credit-replay-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toEqual({
      status: 'unchanged', sourceKind: 'dispute', sourceId: dispute.id,
      financialEvidenceStatus: 'fee_reconciled'
    });
  });

  it('reflows later withdrawal and reinstatement tips when older evidence arrives', async () => {
    const fixture = await purchase();
    const earlierAt = new Date('2026-08-10T13:00:00.000Z');
    const laterAt = new Date('2026-08-10T14:00:00.000Z');
    const reinstatementAt = new Date('2026-08-10T15:00:00.000Z');
    const earlierProviderId = `dp_earlier_${fixture.suffix}`;
    const laterProviderId = `dp_later_${fixture.suffix}`;
    const earlierTransactionId = `txn_dispute_earlier_${fixture.suffix}`;
    const laterWithdrawalId = `txn_dispute_later_${fixture.suffix}`;
    const laterReinstatementId = `txn_dispute_restore_${fixture.suffix}`;
    const inserted = await databaseClient.db.insert(disputes).values([
      { paymentId: fixture.payment.id, stripeDisputeId: earlierProviderId, status: 'open',
        amountMinor: 2, currency: 'USD', reason: 'fraudulent', providerCreatedAt: earlierAt,
        providerUpdatedAt: earlierAt },
      { paymentId: fixture.payment.id, stripeDisputeId: laterProviderId, status: 'won',
        amountMinor: 500, currency: 'USD', reason: 'fraudulent', providerCreatedAt: laterAt,
        providerUpdatedAt: reinstatementAt }
    ]).returning();
    const earlier = inserted.find((row) => row.stripeDisputeId === earlierProviderId);
    const later = inserted.find((row) => row.stripeDisputeId === laterProviderId);
    if (!earlier || !later) throw new Error('Expected cross-dispute fixtures');

    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId, metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId, amountMinor: 1400, paidAt: fixture.paidAt
    }));
    stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400, currency: 'USD', balanceTransactionId: `txn_charge_${fixture.suffix}`,
      createdAt: fixture.paidAt
    }));
    stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId: laterProviderId, paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId, state: 'won', amountMinor: 500,
      providerCreatedAt: laterAt,
      balanceTransactionIds: [laterReinstatementId, laterWithdrawalId]
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: laterWithdrawalId, sourceId: laterProviderId, sourceFamily: 'dispute',
      rawType: 'adjustment', reportingCategory: 'dispute', amountMinor: -500,
      feeMinor: 15, netMinor: -515, currency: 'USD', createdAt: laterAt,
      feeDetails: [{ ordinal: 0, rawType: 'stripe_fee', amountMinor: 15, currency: 'USD' }]
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: laterReinstatementId, sourceId: laterProviderId, sourceFamily: 'dispute',
      rawType: 'adjustment', reportingCategory: 'dispute_reversal', amountMinor: 500,
      feeMinor: 0, netMinor: 500, currency: 'USD', createdAt: reinstatementAt,
      feeDetails: []
    }));

    await expect(reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: later.id, correlationId: `dispute-later-first-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'reconciled' });

    let laterIssueId = '';
    let laterProviderIssueId = '';
    await databaseClient.db.transaction(async (tx) => {
      const issue = await observeFinancialIssue(tx, {
        resourceType: 'dispute', resourceId: later.id, safeCode: 'allocation_mismatch',
        impact: 'exception', actor: { type: 'system', id: 'test-worker' },
        correlationId: `dispute-later-exception-${fixture.suffix}`
      });
      laterIssueId = issue.id;
      const providerIssue = await observeFinancialIssue(tx, {
        resourceType: 'dispute', resourceId: later.id, safeCode: 'source_linkage_mismatch',
        impact: 'exception', actor: { type: 'system', id: 'test-worker' },
        correlationId: `dispute-later-provider-exception-${fixture.suffix}`
      });
      laterProviderIssueId = providerIssue.id;
      await tx.update(disputes).set({ financialEvidenceStatus: 'exception' })
        .where(eq(disputes.id, later.id));
    });

    type CurrentEffect = { providerId: string; allocationId: string; orderItemId: string;
      totalMinor: number; reversesAllocationId: string | null };
    const currentEffects = async (): Promise<CurrentEffect[]> => (((await databaseClient.db.execute(sql`
      select transaction.provider_id as "providerId", allocation.id as "allocationId",
        allocation_set.id as "grossSetId",
        allocation.order_item_id as "orderItemId",
        allocation.total_effect_minor as "totalMinor",
        allocation.reverses_allocation_id as "reversesAllocationId"
      from dispute_item_allocations allocation
      join financial_allocation_sets allocation_set
        on allocation_set.id = allocation.gross_allocation_set_id
      join stripe_balance_transactions transaction
        on transaction.id = allocation_set.balance_transaction_id
      where transaction.provider_id in (${laterWithdrawalId}, ${laterReinstatementId})
        and not exists (
          select 1 from financial_allocation_sets successor
          where successor.supersedes_set_id = allocation_set.id
        )
      order by transaction.provider_id, allocation.order_item_id
    `)) as { rows?: Array<CurrentEffect & { grossSetId: string }> }).rows ?? []);
    const before = await currentEffects();

    stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId: earlierProviderId, paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId, state: 'open', amountMinor: 2,
      providerCreatedAt: earlierAt, balanceTransactionIds: [earlierTransactionId]
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: earlierTransactionId, sourceId: earlierProviderId, sourceFamily: 'dispute',
      rawType: 'adjustment', reportingCategory: 'dispute', amountMinor: -2,
      feeMinor: 0, netMinor: -2, currency: 'USD', createdAt: earlierAt, feeDetails: []
    }));
    await expect(reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: earlier.id, correlationId: `dispute-earlier-late-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'reconciled' });

    const after = await currentEffects();
    const distribution = (rows: CurrentEffect[], providerId: string) => rows
      .filter((row) => row.providerId === providerId)
      .map((row) => [row.orderItemId, row.totalMinor]);
    expect(distribution(after, laterWithdrawalId)).not.toEqual(
      distribution(before, laterWithdrawalId)
    );
    const withdrawalById = new Map(after.filter((row) => row.providerId === laterWithdrawalId)
      .map((row) => [row.allocationId, row]));
    for (const restored of after.filter((row) => row.providerId === laterReinstatementId)) {
      const withdrawn = withdrawalById.get(restored.reversesAllocationId!);
      expect(withdrawn).toBeDefined();
      expect(restored.orderItemId).toBe(withdrawn?.orderItemId);
      expect(restored.totalMinor).toBe(-(withdrawn?.totalMinor ?? 0));
    }
    const historyCount = (await databaseClient.db.select().from(disputeItemAllocations).where(
      eq(disputeItemAllocations.disputeId, later.id)
    )).length;
    expect(historyCount).toBeGreaterThan(after.length);
    const affectedDisputes = await databaseClient.db.select({
      id: disputes.id, financialEvidenceStatus: disputes.financialEvidenceStatus
    }).from(disputes).where(inArray(disputes.id, [earlier.id, later.id]));
    expect(affectedDisputes).toEqual(expect.arrayContaining([
      { id: earlier.id, financialEvidenceStatus: 'fee_reconciled' },
      { id: later.id, financialEvidenceStatus: 'exception' }
    ]));
    expect((await databaseClient.db.select().from(financialReconciliationIssues).where(eq(
      financialReconciliationIssues.id, laterIssueId
    )))[0]).toMatchObject({ state: 'resolved', resourceId: later.id });
    expect((await databaseClient.db.select().from(financialReconciliationIssues).where(eq(
      financialReconciliationIssues.id, laterProviderIssueId
    )))[0]).toMatchObject({
      state: 'open', resourceId: later.id, safeCode: 'source_linkage_mismatch'
    });
    await expect(reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: earlier.id, correlationId: `dispute-earlier-replay-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toEqual({
      status: 'unchanged', sourceKind: 'dispute', sourceId: earlier.id,
      financialEvidenceStatus: 'fee_reconciled'
    });
    expect((await databaseClient.db.select().from(disputeItemAllocations).where(
      eq(disputeItemAllocations.disputeId, later.id)
    )).length).toBe(historyCount);
  });

  it('converges an interleaved withdrawal, reinstatement, refund, and later withdrawal in ordinary and replay paths', async () => {
    const fixture = await purchase();
    const withdrawalAt = new Date('2026-08-10T13:00:00.000Z');
    const reinstatementAt = new Date('2026-08-10T14:00:00.000Z');
    const refundAt = new Date('2026-08-10T15:00:00.000Z');
    const laterWithdrawalAt = new Date('2026-08-10T16:00:00.000Z');
    const restoredProviderDisputeId = `dp_restored_${fixture.suffix}`;
    const laterProviderDisputeId = `dp_after_refund_${fixture.suffix}`;
    const withdrawalProviderId = `txn_withdraw_full_${fixture.suffix}`;
    const reinstatementProviderId = `txn_reinstate_full_${fixture.suffix}`;
    const refundProviderId = `re_interleaved_${fixture.suffix}`;
    const refundBalanceProviderId = `txn_refund_interleaved_${fixture.suffix}`;
    const laterWithdrawalProviderId = `txn_withdraw_after_refund_${fixture.suffix}`;
    const [restoredDispute, laterDispute] = await databaseClient.db.insert(disputes).values([
      {
        paymentId: fixture.payment.id, stripeDisputeId: restoredProviderDisputeId,
        status: 'won', amountMinor: 1400, currency: 'USD', reason: 'fraudulent',
        providerCreatedAt: withdrawalAt, providerUpdatedAt: reinstatementAt
      },
      {
        paymentId: fixture.payment.id, stripeDisputeId: laterProviderDisputeId,
        status: 'open', amountMinor: 900, currency: 'USD', reason: 'fraudulent',
        providerCreatedAt: laterWithdrawalAt, providerUpdatedAt: laterWithdrawalAt
      }
    ]).returning();
    if (!restoredDispute || !laterDispute) throw new Error('Expected interleaved disputes');
    const [refund] = await databaseClient.db.insert(refunds).values({
      paymentId: fixture.payment.id, stripeRefundId: refundProviderId, status: 'succeeded',
      amountMinor: 500, currency: 'USD', reason: 'requested_by_customer',
      providerCreatedAt: refundAt, allocationStatus: 'finalized'
    }).returning();
    if (!refund) throw new Error('Expected interleaved refund');
    const [refundAllocation] = await databaseClient.db.insert(refundAllocations).values({
      refundId: refund.id, orderItemId: fixture.itemFacts[0]!.id,
      amountMinor: 500, source: 'automatic'
    }).returning();
    if (!refundAllocation) throw new Error('Expected interleaved refund allocation');
    await databaseClient.db.insert(refundAllocationComponents).values({
      refundAllocationId: refundAllocation.id, refundId: refund.id,
      orderItemId: fixture.itemFacts[0]!.id, subtotalMinor: 455, taxMinor: 45,
      totalMinor: 500, currency: 'USD'
    });

    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId, metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId, amountMinor: 1400, paidAt: fixture.paidAt
    }));
    stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400, amountRefundedMinor: 500, currency: 'USD',
      balanceTransactionId: `txn_charge_${fixture.suffix}`, createdAt: fixture.paidAt
    }));
    stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId: restoredProviderDisputeId,
      paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId, state: 'won', amountMinor: 1400,
      providerCreatedAt: withdrawalAt,
      balanceTransactionIds: [reinstatementProviderId, withdrawalProviderId]
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: withdrawalProviderId, sourceId: restoredProviderDisputeId,
      sourceFamily: 'dispute', rawType: 'adjustment', reportingCategory: 'dispute',
      amountMinor: -1400, feeMinor: 0, netMinor: -1400, currency: 'USD',
      createdAt: withdrawalAt, feeDetails: []
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: reinstatementProviderId, sourceId: restoredProviderDisputeId,
      sourceFamily: 'dispute', rawType: 'adjustment',
      reportingCategory: 'dispute_reversal', amountMinor: 1400, feeMinor: 0,
      netMinor: 1400, currency: 'USD', createdAt: reinstatementAt, feeDetails: []
    }));
    stripe.harness.setRefund(refundSnapshotFixture({
      providerRefundId: refundProviderId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 500, providerCreatedAt: refundAt,
      balanceTransactionId: refundBalanceProviderId
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: refundBalanceProviderId, sourceId: refundProviderId, sourceFamily: 'refund',
      rawType: 'refund', reportingCategory: 'refund', amountMinor: -500,
      feeMinor: 0, netMinor: -500, currency: 'USD', createdAt: refundAt, feeDetails: []
    }));
    stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId: laterProviderDisputeId,
      paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId, state: 'open', amountMinor: 900,
      providerCreatedAt: laterWithdrawalAt,
      balanceTransactionIds: [laterWithdrawalProviderId]
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: laterWithdrawalProviderId, sourceId: laterProviderDisputeId,
      sourceFamily: 'dispute', rawType: 'adjustment', reportingCategory: 'dispute',
      amountMinor: -900, feeMinor: 0, netMinor: -900, currency: 'USD',
      createdAt: laterWithdrawalAt, feeDetails: []
    }));

    await expect(reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: restoredDispute.id, correlationId: `interleaved-restored-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'reconciled' });
    await expect(reconcileRefundFinancialSource(databaseClient.db, stripe.gateway, {
      refundId: refund.id, correlationId: `interleaved-refund-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'reconciled' });
    const [refundBalance] = await databaseClient.db.select().from(stripeBalanceTransactions).where(
      eq(stripeBalanceTransactions.providerId, refundBalanceProviderId)
    );
    if (!refundBalance) throw new Error('Expected interleaved refund balance');
    const refundProjectionSpec = createFinancialClassificationSubjectJob({
      subjectType: 'balance_transaction', subjectId: refundBalance.id,
      sourceFingerprintSha256: refundBalance.fingerprintSha256,
      classifierVersion: 1, allocationAlgorithmVersion: 1
    });
    await databaseClient.db.update(jobs).set({
      status: 'succeeded', attempts: 7, completedAt: refundAt,
      lockedAt: null, lockedBy: null, lastError: null
    }).where(and(
      eq(jobs.type, refundProjectionSpec.type),
      eq(jobs.deduplicationKey, refundProjectionSpec.deduplicationKey)
    ));
    await expect(reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: laterDispute.id, correlationId: `interleaved-later-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'reconciled' });
    const [rearmedRefundProjection] = await databaseClient.db.select().from(jobs).where(and(
      eq(jobs.type, refundProjectionSpec.type),
      eq(jobs.deduplicationKey, refundProjectionSpec.deduplicationKey)
    ));
    expect(rearmedRefundProjection).toMatchObject({
      status: 'pending', attempts: 0, lastError: null, completedAt: null
    });
    await databaseClient.db.update(jobs).set({
      status: 'succeeded', attempts: 7, completedAt: laterWithdrawalAt,
      lockedAt: null, lockedBy: null, lastError: null
    }).where(eq(jobs.id, rearmedRefundProjection!.id));
    await expect(reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: laterDispute.id, correlationId: `interleaved-later-noop-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toEqual({
      status: 'unchanged', sourceKind: 'dispute', sourceId: laterDispute.id,
      financialEvidenceStatus: 'fee_reconciled'
    });
    expect((await databaseClient.db.select().from(jobs).where(
      eq(jobs.id, rearmedRefundProjection!.id)
    ))[0]).toMatchObject({ status: 'succeeded', attempts: 7 });

    const replaySubjects = ((await databaseClient.db.execute(sql`
      select id, fingerprint_sha256 as fingerprint
      from stripe_balance_transactions
      where provider_id in (${refundBalanceProviderId}, ${laterWithdrawalProviderId})
      order by provider_id
    `)) as { rows?: Array<{ id: string; fingerprint: string }> }).rows ?? [];
    expect(replaySubjects).toHaveLength(2);
    for (const subject of replaySubjects) {
      await expect(replayFinancialClassification({
        database: databaseClient.db,
        targetClassifierVersion: 1,
        targetAllocationAlgorithmVersion: 1
      }, {
        payload: {
          subjectType: 'balance_transaction', subjectId: subject.id,
          sourceFingerprintSha256: subject.fingerprint,
          classifierVersion: 1, allocationAlgorithmVersion: 1, replayId: 'c1-a1'
        },
        correlationId: `interleaved-replay-${subject.id}`,
        signal: new AbortController().signal
      })).resolves.toBeUndefined();
    }

    const exposure = ((await databaseClient.db.execute(sql`
      with current_dispute as (
        select allocation.total_effect_minor
        from dispute_item_allocations allocation
        join financial_allocation_sets allocation_set
          on allocation_set.id = allocation.gross_allocation_set_id
        join disputes dispute on dispute.id = allocation.dispute_id
        where dispute.payment_id = ${fixture.payment.id}
          and not exists (
            select 1 from financial_allocation_sets successor
            where successor.supersedes_set_id = allocation_set.id
          )
      )
      select
        (select coalesce(sum(total_effect_minor), 0)::int from current_dispute) as "disputeMinor",
        (select coalesce(sum(component.total_minor), 0)::int
         from refund_allocation_components component
         join refunds refund on refund.id = component.refund_id
         where refund.payment_id = ${fixture.payment.id} and refund.status = 'succeeded')
          as "refundMinor"
    `)) as { rows?: Array<{ disputeMinor: number; refundMinor: number }> }).rows?.[0];
    expect(exposure).toEqual({ disputeMinor: -900, refundMinor: 500 });
  }, 20_000);

  it('refuses a later refund that would double-consume an outstanding dispute withdrawal', async () => {
    const fixture = await purchase();
    const withdrawalAt = new Date('2026-08-10T13:00:00.000Z');
    const refundAt = new Date('2026-08-10T14:00:00.000Z');
    const providerDisputeId = `dp_outstanding_${fixture.suffix}`;
    const withdrawalProviderId = `txn_outstanding_${fixture.suffix}`;
    const refundProviderId = `re_over_capacity_${fixture.suffix}`;
    const refundBalanceProviderId = `txn_refund_over_capacity_${fixture.suffix}`;
    const [dispute] = await databaseClient.db.insert(disputes).values({
      paymentId: fixture.payment.id, stripeDisputeId: providerDisputeId, status: 'open',
      amountMinor: 1400, currency: 'USD', reason: 'fraudulent',
      providerCreatedAt: withdrawalAt, providerUpdatedAt: withdrawalAt
    }).returning();
    if (!dispute) throw new Error('Expected outstanding dispute');
    const [refund] = await databaseClient.db.insert(refunds).values({
      paymentId: fixture.payment.id, stripeRefundId: refundProviderId, status: 'succeeded',
      amountMinor: 1400, currency: 'USD', reason: 'requested_by_customer',
      providerCreatedAt: refundAt, allocationStatus: 'finalized'
    }).returning();
    if (!refund) throw new Error('Expected over-capacity refund');
    const allocations = await databaseClient.db.insert(refundAllocations).values([
      { refundId: refund.id, orderItemId: fixture.itemFacts[0]!.id,
        amountMinor: 880, source: 'automatic' },
      { refundId: refund.id, orderItemId: fixture.itemFacts[1]!.id,
        amountMinor: 520, source: 'automatic' }
    ]).returning();
    await databaseClient.db.insert(refundAllocationComponents).values([
      {
        refundAllocationId: allocations[0]!.id, refundId: refund.id,
        orderItemId: fixture.itemFacts[0]!.id, subtotalMinor: 800, taxMinor: 80,
        totalMinor: 880, currency: 'USD'
      },
      {
        refundAllocationId: allocations[1]!.id, refundId: refund.id,
        orderItemId: fixture.itemFacts[1]!.id, subtotalMinor: 450, taxMinor: 70,
        totalMinor: 520, currency: 'USD'
      }
    ]);

    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId, metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId, amountMinor: 1400, paidAt: fixture.paidAt
    }));
    stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400, amountRefundedMinor: 1400, currency: 'USD',
      balanceTransactionId: `txn_charge_${fixture.suffix}`, createdAt: fixture.paidAt
    }));
    stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId, paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId, state: 'open', amountMinor: 1400,
      providerCreatedAt: withdrawalAt, balanceTransactionIds: [withdrawalProviderId]
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: withdrawalProviderId, sourceId: providerDisputeId, sourceFamily: 'dispute',
      rawType: 'adjustment', reportingCategory: 'dispute', amountMinor: -1400,
      feeMinor: 0, netMinor: -1400, currency: 'USD', createdAt: withdrawalAt,
      feeDetails: []
    }));
    stripe.harness.setRefund(refundSnapshotFixture({
      providerRefundId: refundProviderId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400, providerCreatedAt: refundAt,
      balanceTransactionId: refundBalanceProviderId
    }));
    stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
      id: refundBalanceProviderId, sourceId: refundProviderId, sourceFamily: 'refund',
      rawType: 'refund', reportingCategory: 'refund', amountMinor: -1400,
      feeMinor: 0, netMinor: -1400, currency: 'USD', createdAt: refundAt,
      feeDetails: []
    }));

    await expect(reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: dispute.id, correlationId: `outstanding-dispute-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({ status: 'reconciled' });
    await expect(reconcileRefundFinancialSource(databaseClient.db, stripe.gateway, {
      refundId: refund.id, correlationId: `over-capacity-refund-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({
      status: 'exception', safeCode: 'allocation_mismatch'
    });
    await expect(reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: dispute.id, correlationId: `outstanding-dispute-replay-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toEqual({
      status: 'unchanged', sourceKind: 'dispute', sourceId: dispute.id,
      financialEvidenceStatus: 'fee_reconciled'
    });
    expect(await databaseClient.db.select().from(financialAllocationSets).where(and(
      eq(financialAllocationSets.sourceKind, 'refund'),
      eq(financialAllocationSets.sourceInternalId, refund.id)
    ))).toHaveLength(0);
  }, 20_000);

  it('records a provider dispute without Balance Transactions as durable pending evidence', async () => {
    const fixture = await purchase();
    const disputeCreatedAt = new Date('2026-08-10T14:00:00.000Z');
    const providerDisputeId = `dp_pending_${fixture.suffix}`;
    const [dispute] = await databaseClient.db.insert(disputes).values({
      paymentId: fixture.payment.id, stripeDisputeId: providerDisputeId, status: 'open',
      amountMinor: 600, currency: 'USD', reason: 'fraudulent', providerCreatedAt: disputeCreatedAt,
      providerUpdatedAt: disputeCreatedAt
    }).returning();
    if (!dispute) throw new Error('Expected dispute fixture');
    const stripe = createFixtureStripeGateway();
    stripe.harness.setDispute(disputeSnapshotFixture({
      providerDisputeId, paymentIntentId: fixture.provider.paymentIntentId,
      chargeId: fixture.provider.chargeId, amountMinor: 600,
      providerCreatedAt: disputeCreatedAt, balanceTransactionIds: []
    }));
    stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.provider.paymentIntentId, metadataOrderId: fixture.orderId,
      latestChargeId: fixture.provider.chargeId, amountMinor: 1400, paidAt: fixture.paidAt
    }));
    stripe.harness.setCharge(chargeSnapshotFixture({
      id: fixture.provider.chargeId, paymentIntentId: fixture.provider.paymentIntentId,
      amountMinor: 1400, currency: 'USD', balanceTransactionId: `txn_charge_${fixture.suffix}`,
      createdAt: fixture.paidAt
    }));

    await expect(reconcileDisputeFinancialSource(databaseClient.db, stripe.gateway, {
      disputeId: dispute.id, correlationId: `dispute-pending-${fixture.suffix}`
    }, new AbortController().signal)).resolves.toMatchObject({
      status: 'pending', sourceKind: 'dispute', sourceId: dispute.id,
      financialEvidenceStatus: 'pending', safeCode: 'missing_source', issueId: expect.any(String)
    });
    expect(await databaseClient.db.select().from(financialAllocationSets).where(eq(
      financialAllocationSets.sourceInternalId, dispute.id
    ))).toHaveLength(0);
    expect(await databaseClient.db.select().from(financialReconciliationIssues).where(and(
      eq(financialReconciliationIssues.resourceType, 'dispute'),
      eq(financialReconciliationIssues.resourceId, dispute.id)
    ))).toEqual([expect.objectContaining({ safeCode: 'missing_source', impact: 'pending', state: 'open' })]);
  });
});
