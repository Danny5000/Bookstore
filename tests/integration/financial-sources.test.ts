import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import { createFixtureStripeGateway } from '$lib/server/commerce/stripe/fixture-gateway';
import { reconcilePaymentFinancialSource } from '$lib/server/commerce/financial/sources/payment';
import { stageBalanceTransaction } from '$lib/server/commerce/financial/ledger';
import { auditEvents, financialAllocationSets, financialItemAllocations, guestIdentities,
  financialReconciliationIssues, entitlementGrants, entitlements, orderItems, orders, outboxMessages, payments,
  payoutImportRunEntries, payoutImportRuns, stripeBalanceTransactions, stripePayoutBalanceTransactions,
  stripePayouts, titles } from '$lib/server/db/schema';
import { paymentSnapshotFixture } from '../fixtures/stripe/payment';
import { chargeSnapshotFixture } from '../fixtures/stripe/charge';
import { balanceTransactionSnapshotFixture } from '../fixtures/stripe/balance-transaction';
import { databaseClient } from './database';
import type { Database } from '$lib/server/db/client';

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
