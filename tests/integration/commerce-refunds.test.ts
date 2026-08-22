import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createCommerceMessageEnqueuer } from '$lib/server/commerce/email/enqueue';
import { parseCommerceEmailPayload } from '$lib/server/commerce/email/payload';
import { PermanentCommerceError } from '$lib/server/commerce/errors';
import {
  FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
  FINANCIAL_CLASSIFIER_VERSION,
  FINANCIAL_REPLAY_ID
} from '$lib/server/commerce/financial/constants';
import {
  FINANCIAL_CLASSIFICATION_JOB,
  FINANCIAL_SOURCE_JOB,
  createFinancialClassificationSubjectJob,
  parseFinancialJobIdentity
} from '$lib/server/commerce/financial/jobs';
import { createFinancialClassificationHandler } from '$lib/server/commerce/financial/handlers/classification';
import { createFinancialSourceHandler } from '$lib/server/commerce/financial/handlers/source';
import { stageBalanceTransaction } from '$lib/server/commerce/financial/ledger';
import { replayFinancialClassificationLocked } from '$lib/server/commerce/financial/rebase';
import { loadCurrentEffectiveAllocationProjection } from '$lib/server/commerce/financial/allocations/repository';
import { projectEffectiveEntitlement } from '$lib/server/commerce/grants';
import { createFixtureStripeGateway } from '$lib/server/commerce/stripe/fixture-gateway';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import {
  fulfillRefundEvent,
  type RefundFulfillmentDependencies
} from '$lib/server/commerce/refunds';
import {
  auditEvents,
  disputes,
  entitlementGrants,
  entitlements,
  guestIdentities,
  jobs,
  orderItems,
  orders,
  outboxMessages,
  payments,
  refundAllocations,
  refundAllocationComponents,
  refunds,
  stripeBalanceTransactions,
  stripeEvents,
  titles,
  user
} from '$lib/server/db/schema';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import type { JobHandler } from '$lib/server/jobs/types';
import { OUTBOX_DISPATCH_JOB } from '$lib/server/outbox/repository';
import { balanceTransactionSnapshotFixture } from '../fixtures/stripe/balance-transaction';
import { chargeSnapshotFixture } from '../fixtures/stripe/charge';
import { paymentSnapshotFixture } from '../fixtures/stripe/payment';
import { refundSnapshotFixture } from '../fixtures/stripe/refund';
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  workerDatabaseClient
} from './database';

const now = new Date('2026-08-10T14:00:00.000Z');
const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');

interface PurchaseFixture {
  orderId: string;
  paymentId: string;
  paymentIntentId: string;
  userId: string | null;
  email: string;
  items: Array<{ id: string; titleId: string; totalMinor: number }>;
}

async function createPurchase(
  totals: readonly number[],
  owner: 'account' | 'guest' = 'account',
  taxes: readonly number[] = totals.map(() => 0)
): Promise<PurchaseFixture> {
  if (taxes.length !== totals.length || taxes.some((tax, index) =>
    !Number.isSafeInteger(tax) || tax < 0 || tax > totals[index]!)) {
    throw new Error('Invalid refund fixture tax split');
  }
  const orderId = randomUUID();
  const email = `${owner}-${orderId}@example.com`;
  let userId: string | null = null;
  let guestIdentityId: string | null = null;
  if (owner === 'account') {
    userId = randomUUID();
    await ownerDatabaseClient.db.insert(user).values({
      id: userId,
      name: 'Refund reader',
      email,
      emailVerified: true
    });
  } else {
    const [identity] = await ownerDatabaseClient.db.insert(guestIdentities)
      .values({ email })
      .returning();
    if (!identity) throw new Error('Expected identity');
    guestIdentityId = identity.id;
  }

  const totalMinor = totals.reduce((sum, value) => sum + value, 0);
  const taxMinor = taxes.reduce((sum, value) => sum + value, 0);
  await ownerDatabaseClient.db.insert(orders).values({
    id: orderId,
    status: 'paid',
    initiatingUserId: userId,
    guestIdentityId,
    purchaseEmail: email,
    currency: 'USD',
    subtotalMinor: totalMinor - taxMinor,
    taxMinor,
    totalMinor,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: `cs_test_${orderId}`,
    statusTokenSha256: 'b'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
    paidAt: new Date('2026-08-10T12:05:00.000Z')
  });

  const items: PurchaseFixture['items'] = [];
  for (const [index, itemTotal] of totals.entries()) {
    const itemTax = taxes[index]!;
    const titleId = randomUUID();
    const itemId = randomUUID();
    await ownerDatabaseClient.db.insert(titles).values({
      id: titleId,
      slug: `refund-title-${titleId}`,
      title: `Private refund title ${index}`,
      description: 'Private refund fixture',
      creatorName: 'Private creator',
      format: 'prose',
      priceMinor: itemTotal,
      currency: 'USD',
      visibility: 'private'
    });
    await ownerDatabaseClient.db.insert(orderItems).values({
      id: itemId,
      orderId,
      titleId,
      titleSnapshot: `Private refund title ${index}`,
      creatorNameSnapshot: 'Private creator',
      format: 'prose',
      currency: 'USD',
      unitSubtotalMinor: itemTotal - itemTax,
      taxMinor: itemTax,
      totalMinor: itemTotal,
      stripeLineItemId: `li_test_${itemId}`
    });
    await ownerDatabaseClient.db.insert(entitlementGrants).values({
      titleId,
      userId,
      source: 'purchase',
      orderItemId: itemId,
      state: userId ? 'active' : 'unclaimed',
      stateReason: 'payment_succeeded',
      grantedAt: new Date('2026-08-10T12:05:00.000Z')
    });
    items.push({ id: itemId, titleId, totalMinor: itemTotal });
  }

  const paymentIntentId = `pi_test_${orderId}`;
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
    orderId,
    stripePaymentIntentId: paymentIntentId,
    stripeLatestChargeId: `ch_test_${orderId}`,
    status: 'succeeded',
    amountMinor: totalMinor,
    currency: 'USD',
    paymentMethodCategory: 'card',
    paidAt: new Date('2026-08-10T12:05:00.000Z')
  }).returning();
  if (!payment) throw new Error('Expected payment');
  if (userId) {
    await workerDatabaseClient.db.transaction(async (transaction) => {
      for (const item of items) {
        await projectEffectiveEntitlement(transaction, userId!, item.titleId, now);
      }
    });
  }
  return { orderId, paymentId: payment.id, paymentIntentId, userId, email, items };
}

async function createRefundEvent(providerRefundId: string, sequence = 1) {
  const [event] = await ownerDatabaseClient.db.insert(stripeEvents).values({
    providerEventId: `evt_refund_${sequence}_${randomUUID()}`,
    eventType: 'refund.updated',
    objectId: providerRefundId,
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt: new Date(`2026-08-10T13:0${sequence}:00.000Z`),
    rawBodySha256: sequence.toString(16).padStart(64, '0')
  }).returning();
  if (!event) throw new Error('Expected event');
  return event;
}

function snapshots(
  fixture: PurchaseFixture,
  event: { id: string; objectId: string },
  amountMinor: number,
  state: 'pending' | 'succeeded' | 'failed' | 'canceled' = 'succeeded',
  sequence = 1
) {
  return {
    stripeEventId: event.id,
    refund: {
      providerRefundId: event.objectId,
      paymentIntentId: fixture.paymentIntentId,
      liveMode: false,
      state,
      amountMinor,
      currency: 'usd',
      reason: 'requested_by_customer' as const,
      providerCreatedAt: new Date(`2026-08-10T13:0${sequence}:00.000Z`),
      balanceTransactionId: null,
      failureBalanceTransactionId: null
    },
    payment: {
      paymentIntentId: fixture.paymentIntentId,
      metadataVersion: '1' as const,
      metadataOrderId: fixture.orderId,
      latestChargeId: `ch_test_${fixture.orderId}`,
      liveMode: false,
      state: 'succeeded' as const,
      amountMinor: fixture.items.reduce((sum, item) => sum + item.totalMinor, 0),
      currency: 'usd',
      paidAt: new Date('2026-08-10T12:05:00.000Z'),
      paymentMethodCategory: 'card'
    }
  };
}

function dependencies(
  overrides: Partial<RefundFulfillmentDependencies> = {}
): RefundFulfillmentDependencies {
  return {
    messages: createCommerceMessageEnqueuer(applicationConfig.origin),
    now: () => now,
    ...overrides
  };
}

async function drainRefundFinancialJobs(gateway: StripeCommerceGateway): Promise<void> {
  const repository = createPostgresJobRepository(
    workerDatabaseClient.db,
    applicationConfig.jobs,
    () => FAR_FUTURE
  );
  const handlers = new Map<string, JobHandler>([
    [FINANCIAL_SOURCE_JOB, createFinancialSourceHandler({
      database: workerDatabaseClient.db,
      gateway
    })],
    [FINANCIAL_CLASSIFICATION_JOB, createFinancialClassificationHandler({
      database: workerDatabaseClient.db,
      targetClassifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      targetAllocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    })],
    [OUTBOX_DISPATCH_JOB, async () => {}]
  ]);
  for (let index = 0; index < 24; index += 1) {
    const workerId = `refund-convergence-${index}`;
    const job = await repository.claimNext(workerId);
    if (!job) return;
    const handler = handlers.get(job.type);
    if (!handler) throw new Error(`Unexpected refund convergence job: ${job.type}`);
    await handler(job, new AbortController().signal);
    expect(await repository.complete(job.id, workerId)).toBe(true);
  }
  throw new Error('Refund convergence exceeded its bounded job count.');
}

describe('canonical refund fulfillment', () => {
  it('atomically hands one canonical terminal refund to financial reconciliation', async () => {
    const fixture = await createPurchase([1403]);
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, event, 500),
      dependencies()
    );

    const [refund] = await databaseClient.db.select().from(refunds);
    const queued = await ownerDatabaseClient.db.select().from(jobs).where(eq(
      jobs.type,
      FINANCIAL_SOURCE_JOB
    ));
    expect(refund).toMatchObject({ status: 'succeeded', financialEvidenceStatus: 'pending' });
    expect((await databaseClient.db.select().from(stripeEvents))[0]).toMatchObject({
      status: 'processed',
      processedAt: expect.any(Date)
    });
    expect(queued).toEqual([expect.objectContaining({
      payload: {
        sourceKind: 'refund',
        sourceId: refund!.id,
        trigger: { kind: 'event', providerEventId: event.providerEventId }
      },
      deduplicationKey: `stripe:financial-source:event:${event.providerEventId}`,
      status: 'pending'
    })]);
    expect(() => parseFinancialJobIdentity({
      type: queued[0]!.type,
      payload: queued[0]!.payload,
      deduplicationKey: queued[0]!.deduplicationKey,
      maxAttempts: queued[0]!.maxAttempts
    })).not.toThrow();
  });

  it('allocates cumulative single-title refunds and revokes only at the full paid total', async () => {
    const fixture = await createPurchase([1403]);
    const first = await createRefundEvent(`re_test_${randomUUID()}`, 1);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, first, 500, 'succeeded', 1),
      dependencies()
    );
    expect(await databaseClient.db.select().from(refundAllocations)).toEqual([
      expect.objectContaining({ orderItemId: fixture.items[0]!.id, amountMinor: 500 })
    ]);
    expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('active');
    expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt).toBeNull();
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(0);

    const second = await createRefundEvent(`re_test_${randomUUID()}`, 2);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, second, 903, 'succeeded', 2),
      dependencies()
    );
    expect((await databaseClient.db.select().from(refundAllocations))
      .reduce((sum, allocation) => sum + allocation.amountMinor, 0)).toBe(1403);
    expect((await databaseClient.db.select().from(entitlementGrants))[0]).toMatchObject({
      state: 'revoked',
      stateReason: 'refund_fully_allocated',
      revokedAt: expect.any(Date)
    });
    expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt)
      .toEqual(expect.any(Date));
    const mail = await ownerDatabaseClient.db.select().from(outboxMessages);
    expect(mail).toHaveLength(1);
    expect(parseCommerceEmailPayload(mail[0]?.payload, applicationConfig.origin)).toMatchObject({
      template: 'commerce.refund-access-changed',
      affectedTitleCount: 1
    });

    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, second, 903, 'succeeded', 2),
      dependencies()
    );
    expect(await databaseClient.db.select().from(refundAllocations)).toHaveLength(2);
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(1);
  });

  it('revokes only the purchase grant and preserves an explicit administrative grant', async () => {
    const fixture = await createPurchase([1403]);
    const first = await createRefundEvent(`re_test_${randomUUID()}`, 1);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, first, 500, 'succeeded', 1),
      dependencies()
    );
    const [allocation] = await ownerDatabaseClient.db
      .select({ id: refundAllocations.id })
      .from(refundAllocations);
    if (!allocation || !fixture.userId) throw new Error('Expected recovery fixture facts');
    const administrativeGrantId = randomUUID();
    const client = await ownerDatabaseClient.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local session_replication_role = replica`);
      await client.query(`
        insert into entitlement_grants (
          id, title_id, user_id, source, recovery_refund_allocation_id, state,
          state_reason, granted_at, created_at, updated_at
        ) values (
          $1, $2, $3, 'administrative', $4, 'active',
          'refund_allocation_recovery', $5, $5, $5
        )
      `, [
        administrativeGrantId,
        fixture.items[0]!.titleId,
        fixture.userId,
        allocation.id,
        new Date('2026-08-10T13:30:00.000Z')
      ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    const snapshot = async () => (await ownerDatabaseClient.pool.query<{ value: string }>(`
      select jsonb_build_array(
        id, title_id, user_id, source, order_item_id,
        recovery_refund_allocation_id, state, state_reason, granted_at,
        suspended_at, revoked_at, created_at, updated_at
      )::text as value from entitlement_grants where id = $1
    `, [administrativeGrantId])).rows[0]!.value;
    const before = await snapshot();

    const second = await createRefundEvent(`re_test_${randomUUID()}`, 2);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, second, 903, 'succeeded', 2),
      dependencies()
    );

    expect(await snapshot()).toBe(before);
    const grants = await ownerDatabaseClient.db
      .select({ source: entitlementGrants.source, state: entitlementGrants.state })
      .from(entitlementGrants);
    expect(grants).toEqual(expect.arrayContaining([
      { source: 'purchase', state: 'revoked' },
      { source: 'administrative', state: 'active' }
    ]));
    expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt).toBeNull();
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(0);
  });

  it('keeps both reconciled refunds current on a distinct exact no-op event', async () => {
    const fixture = await createPurchase([1403]);
    const firstProviderId = `re_test_${randomUUID()}`;
    const secondProviderId = `re_test_${randomUUID()}`;
    const first = await createRefundEvent(firstProviderId, 1);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, first, 500, 'succeeded', 1),
      dependencies()
    );
    const second = await createRefundEvent(secondProviderId, 2);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, second, 903, 'succeeded', 2),
      dependencies()
    );
    await ownerDatabaseClient.db.update(refunds).set({
      financialEvidenceStatus: 'fee_reconciled'
    });

    const distinctNoop = await createRefundEvent(secondProviderId, 3);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, distinctNoop, 903, 'succeeded', 2),
      dependencies()
    );

    const persisted = await databaseClient.db.select().from(refunds);
    expect(persisted).toHaveLength(2);
    expect(persisted.every((refund) =>
      refund.allocationStatus === 'finalized' &&
      refund.financialEvidenceStatus === 'fee_reconciled'
    )).toBe(true);
    expect((await databaseClient.db.select().from(stripeEvents).where(
      eq(stripeEvents.id, distinctNoop.id)
    ))[0]).toMatchObject({ status: 'processed', processedAt: expect.any(Date) });
  });

  it('deterministically allocates one full multi-title refund and sends one aggregate change', async () => {
    const fixture = await createPurchase([1000, 1500]);
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    await fulfillRefundEvent(workerDatabaseClient.db, snapshots(fixture, event, 2500), dependencies());
    expect((await databaseClient.db.select().from(refundAllocations))
      .map((allocation) => allocation.amountMinor).sort((a, b) => a - b))
      .toEqual([1000, 1500]);
    expect((await databaseClient.db.select().from(entitlementGrants))
      .every((grant) => grant.state === 'revoked')).toBe(true);
    expect(parseCommerceEmailPayload(
      (await ownerDatabaseClient.db.select().from(outboxMessages))[0]?.payload,
      applicationConfig.origin
    )).toMatchObject({ affectedTitleCount: 2 });
  });

  it('stores ambiguous partial multi-title refunds as inspectable exceptions without guessing', async () => {
    const fixture = await createPurchase([1000, 1500]);
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    await fulfillRefundEvent(workerDatabaseClient.db, snapshots(fixture, event, 800), dependencies());
    expect(await databaseClient.db.select().from(refundAllocations)).toHaveLength(0);
    expect((await databaseClient.db.select().from(refunds))[0]).toMatchObject({
      status: 'succeeded',
      allocationStatus: 'needs_review',
      financialEvidenceStatus: 'pending'
    });
    expect((await databaseClient.db.select().from(stripeEvents))[0]).toMatchObject({
      status: 'exception',
      processedAt: expect.any(Date)
    });
    const [refund] = await databaseClient.db.select().from(refunds);
    expect(await ownerDatabaseClient.db.select().from(jobs).where(eq(
      jobs.type,
      FINANCIAL_SOURCE_JOB
    ))).toEqual([expect.objectContaining({
      payload: {
        sourceKind: 'refund',
        sourceId: refund!.id,
        trigger: { kind: 'event', providerEventId: event.providerEventId }
      },
      deduplicationKey: `stripe:financial-source:event:${event.providerEventId}`
    })]);
    expect((await databaseClient.db.select().from(entitlementGrants))
      .every((grant) => grant.state === 'active')).toBe(true);
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(0);
  });

  it('persists deterministic subtotal and tax components that financial replay can consume', async () => {
    const fixture = await createPurchase([100], 'account', [20]);
    const event = await createRefundEvent(`re_test_${randomUUID()}`, 1);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, event, 50, 'succeeded', 1),
      dependencies()
    );
    const [refund] = await databaseClient.db.select().from(refunds);
    expect(await databaseClient.db.select().from(refundAllocationComponents)).toEqual([
      expect.objectContaining({
        refundId: refund!.id, orderItemId: fixture.items[0]!.id,
        subtotalMinor: 40, taxMinor: 10, totalMinor: 50, currency: 'USD'
      })
    ]);

    const staged = await stageBalanceTransaction(workerDatabaseClient.db, {
      id: `txn_refund_components_${randomUUID()}`, livemode: false,
      sourceFamily: 'refund', sourceId: refund!.stripeRefundId,
      rawType: 'refund', reportingCategory: 'refund', balanceType: 'payments',
      amountMinor: -50, feeMinor: 0, netMinor: -50, currency: 'USD',
      status: 'available', createdAt: refund!.providerCreatedAt,
      availableAt: refund!.providerCreatedAt, exchangeRate: null,
      exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
    }, { correlationId: 'refund-components-stage' });
    const [balance] = await databaseClient.pool.query<{ fingerprint_sha256: string }>(
      'select fingerprint_sha256 from stripe_balance_transactions where id=$1',
      [staged.balanceTransactionId]
    ).then((result) => result.rows);
    await expect(workerDatabaseClient.db.transaction((tx) =>
      replayFinancialClassificationLocked(tx, {
        subjectType: 'balance_transaction', subjectId: staged.balanceTransactionId,
        sourceFingerprintSha256: balance!.fingerprint_sha256,
        classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
        allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
        replayId: FINANCIAL_REPLAY_ID,
        correlationId: 'refund-components-replay'
      }))).resolves.toMatchObject({ status: 'replayed' });
    await expect(loadCurrentEffectiveAllocationProjection(workerDatabaseClient.db, {
      balanceTransactionIds: [staged.balanceTransactionId]
    })).resolves.toEqual([
      expect.objectContaining({
        status: 'complete', basis: 'gross_amount', scope: 'title',
        items: expect.arrayContaining([
          expect.objectContaining({ component: 'refund_subtotal', effectMinor: -40 }),
          expect.objectContaining({ component: 'refund_tax', effectMinor: -10 })
        ])
      }),
      expect.objectContaining({ status: 'complete', basis: 'fee', scope: 'title' })
    ]);
  });

  it('assigns same-time immutable components in provider-refund-ID order, not local UUID order', async () => {
    const fixture = await createPurchase([2], 'account', [1]);
    const providerCreatedAt = new Date('2026-08-10T13:01:00.000Z');
    const providerFirst = {
      id: 'ffffffff-ffff-4fff-bfff-fffffffffff1',
      providerId: `re_a_${randomUUID()}`
    };
    const providerSecond = {
      id: '00000000-0000-4000-8000-000000000001',
      providerId: `re_z_${randomUUID()}`
    };
    await ownerDatabaseClient.db.insert(refunds).values([
      {
        id: providerFirst.id,
        paymentId: fixture.paymentId,
        stripeRefundId: providerFirst.providerId,
        status: 'succeeded',
        amountMinor: 1,
        currency: 'USD',
        reason: 'requested_by_customer',
        providerCreatedAt,
        allocationStatus: 'needs_review'
      },
      {
        id: providerSecond.id,
        paymentId: fixture.paymentId,
        stripeRefundId: providerSecond.providerId,
        status: 'succeeded',
        amountMinor: 1,
        currency: 'USD',
        reason: 'requested_by_customer',
        providerCreatedAt,
        allocationStatus: 'needs_review'
      }
    ]);
    const event = await createRefundEvent(providerSecond.providerId, 1);

    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, event, 1, 'succeeded', 1),
      dependencies()
    );

    const components = await databaseClient.db.select().from(refundAllocationComponents);
    const componentByRefundId = new Map(components.map((component) => [
      component.refundId,
      component
    ]));
    expect(componentByRefundId.get(providerFirst.id)).toMatchObject({
      subtotalMinor: 1,
      taxMinor: 0,
      totalMinor: 1
    });
    expect(componentByRefundId.get(providerSecond.id)).toMatchObject({
      subtotalMinor: 0,
      taxMinor: 1,
      totalMinor: 1
    });
  });

  it('commits an exception instead of rewriting immutable component chronology', async () => {
    const fixture = await createPurchase([2], 'account', [1]);
    const later = await createRefundEvent(`re_test_${randomUUID()}`, 2);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, later, 1, 'succeeded', 2),
      dependencies()
    );
    const beforeAllocations = await databaseClient.db.select().from(refundAllocations);
    const beforeComponents = await databaseClient.db.select().from(refundAllocationComponents);
    expect(beforeComponents).toEqual([expect.objectContaining({
      subtotalMinor: 1, taxMinor: 0, totalMinor: 1
    })]);

    const earlier = await createRefundEvent(`re_test_${randomUUID()}`, 1);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, earlier, 1, 'succeeded', 1),
      dependencies()
    );

    expect(await databaseClient.db.select().from(refundAllocations)).toEqual(beforeAllocations);
    expect(await databaseClient.db.select().from(refundAllocationComponents)).toEqual(beforeComponents);
    expect((await databaseClient.db.select().from(refunds)).every((refund) =>
      refund.status === 'succeeded' &&
      refund.allocationStatus === 'exception' &&
      refund.financialEvidenceStatus === 'exception'
    )).toBe(true);
    expect((await databaseClient.db.select().from(stripeEvents).where(
      eq(stripeEvents.id, earlier.id)
    ))[0]).toMatchObject({ status: 'exception', processedAt: expect.any(Date) });
  });

  it('fails closed when a same-time provider-earlier refund follows a component-backed refund', async () => {
    const fixture = await createPurchase([2], 'account', [1]);
    const providerCreatedAt = new Date('2026-08-10T13:01:00.000Z');
    const providerEarlier = {
      id: 'ffffffff-ffff-4fff-bfff-fffffffffff2',
      providerId: `re_a_${randomUUID()}`
    };
    const providerLater = {
      id: '00000000-0000-4000-8000-000000000002',
      providerId: `re_z_${randomUUID()}`
    };
    await ownerDatabaseClient.db.insert(refunds).values([
      {
        id: providerEarlier.id,
        paymentId: fixture.paymentId,
        stripeRefundId: providerEarlier.providerId,
        status: 'succeeded',
        amountMinor: 1,
        currency: 'USD',
        reason: 'requested_by_customer',
        providerCreatedAt,
        allocationStatus: 'needs_review'
      },
      {
        id: providerLater.id,
        paymentId: fixture.paymentId,
        stripeRefundId: providerLater.providerId,
        status: 'succeeded',
        amountMinor: 1,
        currency: 'USD',
        reason: 'requested_by_customer',
        providerCreatedAt,
        allocationStatus: 'finalized'
      }
    ]);
    const [laterAllocation] = await ownerDatabaseClient.db.insert(refundAllocations).values({
      refundId: providerLater.id,
      orderItemId: fixture.items[0]!.id,
      amountMinor: 1,
      source: 'automatic',
      createdAt: now
    }).returning();
    await ownerDatabaseClient.db.insert(refundAllocationComponents).values({
      refundAllocationId: laterAllocation!.id,
      refundId: providerLater.id,
      orderItemId: fixture.items[0]!.id,
      subtotalMinor: 1,
      taxMinor: 0,
      totalMinor: 1,
      currency: 'USD',
      createdAt: now
    });
    const event = await createRefundEvent(providerEarlier.providerId, 1);
    const allocationsBefore = await databaseClient.db.select().from(refundAllocations);
    const componentsBefore = await databaseClient.db.select().from(refundAllocationComponents);

    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, event, 1, 'succeeded', 1),
      dependencies()
    );

    expect(await databaseClient.db.select().from(refundAllocations)).toEqual(allocationsBefore);
    expect(await databaseClient.db.select().from(refundAllocationComponents)).toEqual(componentsBefore);
    expect((await databaseClient.db.select().from(refunds)).every((refund) =>
      refund.allocationStatus === 'exception' &&
      refund.financialEvidenceStatus === 'exception'
    )).toBe(true);
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, event.id)))[0])
      .toMatchObject({ status: 'exception', processedAt: expect.any(Date) });
  });

  it('marks every succeeded refund as an allocation exception when a complete legacy graph exceeds item capacity', async () => {
    const fixture = await createPurchase([1000, 1500]);
    const firstProviderRefundId = `re_test_${randomUUID()}`;
    const secondProviderRefundId = `re_test_${randomUUID()}`;
    const seededRefunds = await ownerDatabaseClient.db.insert(refunds).values([
      {
        paymentId: fixture.paymentId,
        stripeRefundId: firstProviderRefundId,
        status: 'succeeded',
        amountMinor: 800,
        currency: 'USD',
        reason: 'requested_by_customer',
        providerCreatedAt: new Date('2026-08-10T13:01:00.000Z'),
        allocationStatus: 'finalized'
      },
      {
        paymentId: fixture.paymentId,
        stripeRefundId: secondProviderRefundId,
        status: 'succeeded',
        amountMinor: 800,
        currency: 'USD',
        reason: 'requested_by_customer',
        providerCreatedAt: new Date('2026-08-10T13:02:00.000Z'),
        allocationStatus: 'finalized'
      }
    ]).returning();
    const refundsByProviderId = new Map(
      seededRefunds.map((refund) => [refund.stripeRefundId, refund])
    );
    await ownerDatabaseClient.db.insert(refundAllocations).values([
      {
        refundId: refundsByProviderId.get(firstProviderRefundId)!.id,
        orderItemId: fixture.items[0]!.id,
        amountMinor: 800,
        source: 'automatic'
      },
      {
        refundId: refundsByProviderId.get(secondProviderRefundId)!.id,
        orderItemId: fixture.items[0]!.id,
        amountMinor: 800,
        source: 'automatic'
      }
    ]);
    const event = await createRefundEvent(firstProviderRefundId, 1);

    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, event, 800, 'succeeded', 1),
      dependencies()
    );

    const persistedRefunds = await databaseClient.db.select().from(refunds);
    expect(persistedRefunds).toHaveLength(2);
    for (const refund of persistedRefunds) {
      expect(refund).toMatchObject({
        status: 'succeeded',
        allocationStatus: 'exception',
        financialEvidenceStatus: 'exception'
      });
    }
    expect((await databaseClient.db.select().from(stripeEvents))[0]).toMatchObject({
      status: 'exception',
      processedAt: expect.any(Date)
    });
  });

  it('recomputes prior ambiguous rows when cumulative refunds prove the whole order', async () => {
    const totals = [500, 1000, 1500] as const;
    const taxes = [101, 333, 499] as const;
    const fixture = await createPurchase(totals, 'account', taxes);
    const stable = await createRefundEvent(`re_test_${randomUUID()}`, 1);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, stable, 500, 'succeeded', 1),
      dependencies()
    );
    const [stableRefund] = await databaseClient.db.select().from(refunds).where(
      eq(refunds.stripeRefundId, stable.objectId)
    );
    if (!stableRefund) throw new Error('Expected stable refund');
    const [stableAllocation] = await ownerDatabaseClient.db.insert(refundAllocations).values({
      refundId: stableRefund.id,
      orderItemId: fixture.items[0]!.id,
      amountMinor: 500,
      source: 'administrative',
      createdAt: now
    }).returning();
    if (!stableAllocation) throw new Error('Expected stable allocation');
    await ownerDatabaseClient.db.insert(refundAllocationComponents).values({
      refundAllocationId: stableAllocation.id,
      refundId: stableRefund.id,
      orderItemId: fixture.items[0]!.id,
      subtotalMinor: 399,
      taxMinor: 101,
      totalMinor: 500,
      currency: 'USD',
      createdAt: now
    });
    await ownerDatabaseClient.db.update(refunds).set({
      allocationStatus: 'finalized',
      financialEvidenceStatus: 'fee_reconciled'
    })
      .where(eq(refunds.id, stableRefund.id));

    const ambiguous = await createRefundEvent(`re_test_${randomUUID()}`, 2);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, ambiguous, 800, 'succeeded', 2),
      dependencies()
    );
    const [ambiguousRefund] = await databaseClient.db.select().from(refunds).where(
      eq(refunds.stripeRefundId, ambiguous.objectId)
    );
    if (!ambiguousRefund) throw new Error('Expected ambiguous refund');
    const priorBalanceProviderId = `txn_prior_refund_rearm_${randomUUID()}`;
    const staged = await stageBalanceTransaction(workerDatabaseClient.db, {
      id: priorBalanceProviderId, livemode: false,
      sourceFamily: 'refund', sourceId: ambiguousRefund.stripeRefundId,
      rawType: 'refund', reportingCategory: 'refund', balanceType: 'payments',
      amountMinor: -800, feeMinor: 0, netMinor: -800, currency: 'USD',
      status: 'available', createdAt: ambiguousRefund.providerCreatedAt,
      availableAt: ambiguousRefund.providerCreatedAt, exchangeRate: null,
      exchangeSourceCurrency: null, exchangeTargetCurrency: null, feeDetails: []
    }, { correlationId: 'prior-refund-rearm-stage' });
    const [balance] = await databaseClient.db.select().from(stripeBalanceTransactions).where(
      eq(stripeBalanceTransactions.id, staged.balanceTransactionId)
    );
    const projectionSpec = createFinancialClassificationSubjectJob({
      subjectType: 'balance_transaction', subjectId: staged.balanceTransactionId,
      sourceFingerprintSha256: balance!.fingerprintSha256,
      classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
      allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
    });
    const [existingProjectionJob] = (await ownerDatabaseClient.db.select().from(jobs)).filter((job) =>
      job.type === projectionSpec.type && job.deduplicationKey === projectionSpec.deduplicationKey
    );
    const projectionJobId = existingProjectionJob?.id ?? (await ownerDatabaseClient.db.insert(jobs)
      .values({
        type: projectionSpec.type, payload: projectionSpec.payload as never,
        deduplicationKey: projectionSpec.deduplicationKey, maxAttempts: projectionSpec.maxAttempts
      }).returning({ id: jobs.id }))[0]!.id;
    await workerDatabaseClient.db.update(jobs).set({
      status: 'succeeded', attempts: 1, completedAt: now, lastError: null
    }).where(eq(jobs.id, projectionJobId));
    for (const sourceId of [stableRefund.id, ambiguousRefund.id]) {
      const [sourceJob] = (await ownerDatabaseClient.db.select().from(jobs)).filter((job) =>
        job.type === FINANCIAL_SOURCE_JOB &&
        (job.payload as { sourceId?: unknown }).sourceId === sourceId
      );
      if (!sourceJob) throw new Error('Expected prior source job');
      await workerDatabaseClient.db.update(jobs).set({
        status: 'succeeded', attempts: 1, completedAt: now, lastError: null
      }).where(eq(jobs.id, sourceJob.id));
    }

    const current = await createRefundEvent(`re_test_${randomUUID()}`, 3);
    const currentInput = snapshots(fixture, current, 1700, 'succeeded', 3);
    await fulfillRefundEvent(workerDatabaseClient.db, currentInput, dependencies());
    const beforeDrain = await databaseClient.db.select().from(refunds);
    const [currentRefund] = beforeDrain.filter((refund) =>
      refund.stripeRefundId === current.objectId
    );
    if (!currentRefund) throw new Error('Expected current refund');
    const allocations = await databaseClient.db.select().from(refundAllocations);
    const components = await databaseClient.db.select().from(refundAllocationComponents);
    expect(allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0)).toBe(3000);
    expect(components).toHaveLength(allocations.length);
    const refundById = new Map(beforeDrain.map((refund) => [refund.id, refund]));
    const componentByAllocationId = new Map(
      components.map((component) => [component.refundAllocationId, component])
    );
    const capacityByItemId = new Map(fixture.items.map((item, index) => [item.id, {
      subtotalMinor: BigInt(totals[index]! - taxes[index]!),
      taxMinor: BigInt(taxes[index]!)
    }]));
    for (const item of fixture.items) {
      const remaining = capacityByItemId.get(item.id)!;
      const chronological = allocations.filter((allocation) => allocation.orderItemId === item.id)
        .sort((left, right) => {
          const leftRefund = refundById.get(left.refundId)!;
          const rightRefund = refundById.get(right.refundId)!;
          return leftRefund.providerCreatedAt.getTime() - rightRefund.providerCreatedAt.getTime() ||
            (leftRefund.stripeRefundId < rightRefund.stripeRefundId ? -1
              : leftRefund.stripeRefundId > rightRefund.stripeRefundId ? 1 : 0) ||
            leftRefund.id.localeCompare(rightRefund.id) || left.id.localeCompare(right.id);
        });
      for (const allocation of chronological) {
        const component = componentByAllocationId.get(allocation.id);
        const amount = BigInt(allocation.amountMinor);
        const remainingTotal = remaining.subtotalMinor + remaining.taxMinor;
        let expectedSubtotal = amount * remaining.subtotalMinor / remainingTotal;
        let expectedTax = amount * remaining.taxMinor / remainingTotal;
        const subtotalRemainder = amount * remaining.subtotalMinor % remainingTotal;
        const taxRemainder = amount * remaining.taxMinor % remainingTotal;
        if (amount - expectedSubtotal - expectedTax === 1n) {
          if (subtotalRemainder >= taxRemainder) expectedSubtotal += 1n;
          else expectedTax += 1n;
        }
        expect(component).toMatchObject({
          refundId: allocation.refundId, orderItemId: allocation.orderItemId,
          subtotalMinor: Number(expectedSubtotal), taxMinor: Number(expectedTax),
          totalMinor: allocation.amountMinor, currency: 'USD'
        });
        remaining.subtotalMinor -= expectedSubtotal;
        remaining.taxMinor -= expectedTax;
      }
      expect(remaining).toEqual({ subtotalMinor: 0n, taxMinor: 0n });
    }
    expect((await ownerDatabaseClient.db.select().from(jobs).where(eq(jobs.id, projectionJobId)))[0])
      .toMatchObject({ status: 'pending', attempts: 0, lastError: null });
    expect(beforeDrain).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: stableRefund.id,
        allocationStatus: 'finalized',
        financialEvidenceStatus: 'fee_reconciled'
      }),
      expect.objectContaining({
        id: ambiguousRefund.id,
        allocationStatus: 'finalized',
        financialEvidenceStatus: 'pending'
      }),
      expect.objectContaining({
        id: currentRefund.id,
        allocationStatus: 'finalized',
        financialEvidenceStatus: 'pending'
      })
    ]));
    const sourceJobsBeforeDrain = (await ownerDatabaseClient.db.select().from(jobs)).filter((job) =>
      job.type === FINANCIAL_SOURCE_JOB
    );
    const graphJobs = sourceJobsBeforeDrain.filter((job) =>
      (job.payload as { trigger?: { kind?: unknown } }).trigger?.kind === 'graph'
    );
    expect(graphJobs).toEqual([expect.objectContaining({
      payload: {
        sourceKind: 'refund',
        sourceId: ambiguousRefund.id,
        trigger: { kind: 'graph', providerEventId: current.providerEventId }
      },
      deduplicationKey:
        `financial:source:graph:${current.providerEventId}:refund:${ambiguousRefund.id}`,
      status: 'pending'
    })]);

    const stripe = createFixtureStripeGateway();
    stripe.harness.setPayment(paymentSnapshotFixture({
      paymentIntentId: fixture.paymentIntentId,
      metadataOrderId: fixture.orderId,
      latestChargeId: `ch_test_${fixture.orderId}`,
      amountMinor: 3000,
      currency: 'usd',
      paidAt: new Date('2026-08-10T12:05:00.000Z')
    }));
    stripe.harness.setCharge(chargeSnapshotFixture({
      id: `ch_test_${fixture.orderId}`,
      paymentIntentId: fixture.paymentIntentId,
      amountMinor: 3000,
      amountRefundedMinor: 3000,
      currency: 'USD',
      createdAt: new Date('2026-08-10T12:05:00.000Z')
    }));
    const currentBalanceProviderId = `txn_current_refund_rearm_${randomUUID()}`;
    for (const evidence of [
      {
        refund: ambiguousRefund,
        amountMinor: 800,
        balanceTransactionId: priorBalanceProviderId
      },
      {
        refund: currentRefund,
        amountMinor: 1700,
        balanceTransactionId: currentBalanceProviderId
      }
    ]) {
      stripe.harness.setRefund(refundSnapshotFixture({
        providerRefundId: evidence.refund.stripeRefundId,
        paymentIntentId: fixture.paymentIntentId,
        amountMinor: evidence.amountMinor,
        providerCreatedAt: evidence.refund.providerCreatedAt,
        balanceTransactionId: evidence.balanceTransactionId
      }));
      stripe.harness.setBalanceTransaction(balanceTransactionSnapshotFixture({
        id: evidence.balanceTransactionId,
        sourceId: evidence.refund.stripeRefundId,
        sourceFamily: 'refund',
        rawType: 'refund',
        reportingCategory: 'refund',
        amountMinor: -evidence.amountMinor,
        feeMinor: 0,
        netMinor: -evidence.amountMinor,
        currency: 'USD',
        createdAt: evidence.refund.providerCreatedAt,
        availableAt: evidence.refund.providerCreatedAt,
        feeDetails: []
      }));
    }
    await drainRefundFinancialJobs(stripe.gateway);
    const convergedRefunds = await databaseClient.db.select().from(refunds);
    expect(convergedRefunds.every((refund) =>
      refund.allocationStatus === 'finalized' &&
      refund.financialEvidenceStatus === 'fee_reconciled'
    )).toBe(true);
    expect((await ownerDatabaseClient.db.select().from(jobs)).every((job) =>
      job.status === 'succeeded'
    )).toBe(true);

    const jobsBeforeExactReplay = await ownerDatabaseClient.db.select().from(jobs);
    await fulfillRefundEvent(workerDatabaseClient.db, currentInput, dependencies());
    expect(await ownerDatabaseClient.db.select().from(jobs)).toEqual(jobsBeforeExactReplay);
    expect((await databaseClient.db.select().from(entitlementGrants))
      .every((grant) => grant.state === 'revoked')).toBe(true);
  });

  it.each(['pending', 'failed', 'canceled'] as const)(
    'persists a %s refund without allocating or changing access',
    async (state) => {
      const fixture = await createPurchase([1403]);
      const event = await createRefundEvent(`re_test_${randomUUID()}`);
      await fulfillRefundEvent(
        workerDatabaseClient.db,
        snapshots(fixture, event, 1403, state),
        dependencies()
      );
      expect((await databaseClient.db.select().from(refunds))[0]).toMatchObject({
        status: state,
        allocationStatus: 'not_applicable',
        financialEvidenceStatus: 'pending'
      });
      expect(await databaseClient.db.select().from(refundAllocations)).toHaveLength(0);
      expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('active');
      expect((await databaseClient.db.select().from(stripeEvents))[0]?.status).toBe('processed');
    }
  );

  it('revokes an unclaimed guest grant without creating access or sending mail', async () => {
    const fixture = await createPurchase([1403], 'guest');
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    await fulfillRefundEvent(workerDatabaseClient.db, snapshots(fixture, event, 1403), dependencies());
    expect((await databaseClient.db.select().from(entitlementGrants))[0]).toMatchObject({
      userId: null,
      state: 'revoked'
    });
    expect(await databaseClient.db.select().from(entitlements)).toHaveLength(0);
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(0);
  });

  it('keeps effective access when another preserved grant remains active', async () => {
    const fixture = await createPurchase([1403]);
    await ownerDatabaseClient.db.insert(entitlementGrants).values({
      userId: fixture.userId!,
      titleId: fixture.items[0]!.titleId,
      source: 'preserved',
      state: 'active',
      stateReason: 'administrative_preservation',
      grantedAt: now
    });
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    await fulfillRefundEvent(workerDatabaseClient.db, snapshots(fixture, event, 1403), dependencies());
    expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt).toBeNull();
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(0);
  });

  it('preserves succeeded refund state against an out-of-order canonical regression', async () => {
    const fixture = await createPurchase([1403]);
    const providerRefundId = `re_test_${randomUUID()}`;
    const first = await createRefundEvent(providerRefundId, 1);
    await fulfillRefundEvent(workerDatabaseClient.db, snapshots(fixture, first, 1403), dependencies());
    const replay = await createRefundEvent(providerRefundId, 2);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, replay, 1403, 'pending', 1),
      dependencies()
    );
    expect((await databaseClient.db.select().from(refunds))[0]?.status).toBe('succeeded');
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, replay.id)))[0]?.status).toBe('processed');
    expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(1);
  });

  it.each(['failed', 'canceled'] as const)(
    'preserves terminal %s refund state against a delayed pending snapshot',
    async (terminalState) => {
      const fixture = await createPurchase([1403]);
      const providerRefundId = `re_test_${randomUUID()}`;
      const terminal = await createRefundEvent(providerRefundId, 1);
      await fulfillRefundEvent(
        workerDatabaseClient.db,
        snapshots(fixture, terminal, 1403, terminalState, 1),
        dependencies()
      );
      const delayed = await createRefundEvent(providerRefundId, 2);
      await fulfillRefundEvent(
        workerDatabaseClient.db,
        snapshots(fixture, delayed, 1403, 'pending', 1),
        dependencies()
      );

      expect((await databaseClient.db.select().from(refunds))[0]?.status).toBe(terminalState);
      expect((await databaseClient.db.select().from(stripeEvents)
        .where(eq(stripeEvents.id, delayed.id)))[0]?.status).toBe('processed');
    }
  );

  it('rejects incompatible terminal refund states without overwriting stored evidence', async () => {
    const fixture = await createPurchase([1403]);
    const providerRefundId = `re_test_${randomUUID()}`;
    const failed = await createRefundEvent(providerRefundId, 1);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, failed, 1403, 'failed', 1),
      dependencies()
    );
    const canceled = await createRefundEvent(providerRefundId, 2);

    await expect(fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, canceled, 1403, 'canceled', 1),
      dependencies()
    )).rejects.toBeInstanceOf(PermanentCommerceError);

    expect((await databaseClient.db.select().from(refunds))[0]?.status).toBe('failed');
    expect((await databaseClient.db.select().from(stripeEvents)
      .where(eq(stripeEvents.id, canceled.id)))[0]?.status).toBe('pending');
  });

  it('serializes concurrent over-refunds without exceeding the item total', async () => {
    const fixture = await createPurchase([1403]);
    const first = await createRefundEvent(`re_test_${randomUUID()}`, 1);
    const second = await createRefundEvent(`re_test_${randomUUID()}`, 2);
    await Promise.all([
      fulfillRefundEvent(workerDatabaseClient.db, snapshots(fixture, first, 800, 'succeeded', 1), dependencies()),
      fulfillRefundEvent(workerDatabaseClient.db, snapshots(fixture, second, 800, 'succeeded', 2), dependencies())
    ]);
    expect((await databaseClient.db.select().from(refundAllocations))
      .reduce((sum, allocation) => sum + allocation.amountMinor, 0)).toBe(800);
    expect((await databaseClient.db.select().from(stripeEvents))
      .filter((event) => event.status === 'exception')).toHaveLength(1);
  });

  it('rejects a paid order whose item aggregate no longer matches canonical payment evidence', async () => {
    const fixture = await createPurchase([1403]);
    await ownerDatabaseClient.db.update(orderItems)
      .set({ unitSubtotalMinor: 1300, totalMinor: 1300 })
      .where(eq(orderItems.id, fixture.items[0]!.id));
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    await expect(fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, event, 500),
      dependencies()
    )).rejects.toBeInstanceOf(PermanentCommerceError);
    expect(await databaseClient.db.select().from(refunds)).toHaveLength(0);
    expect((await databaseClient.db.select().from(stripeEvents))[0]?.status).toBe('pending');
  });

  it('rejects a purchase grant that does not belong to its immutable order item title', async () => {
    const fixture = await createPurchase([1403]);
    const otherTitleId = randomUUID();
    await ownerDatabaseClient.db.insert(titles).values({
      id: otherTitleId,
      slug: `refund-mismatch-${otherTitleId}`,
      title: 'Mismatched title',
      description: 'Mismatch fixture',
      creatorName: 'Mismatch creator',
      format: 'prose',
      priceMinor: 1403,
      currency: 'USD',
      visibility: 'private'
    });
    await ownerDatabaseClient.db.update(entitlementGrants)
      .set({ titleId: otherTitleId })
      .where(eq(entitlementGrants.orderItemId, fixture.items[0]!.id));
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    await expect(fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, event, 1403),
      dependencies()
    )).rejects.toBeInstanceOf(PermanentCommerceError);
    expect(await databaseClient.db.select().from(refunds)).toHaveLength(0);
    expect((await databaseClient.db.select().from(stripeEvents))[0]?.status).toBe('pending');
  });

  it.each(['allocation', 'projection', 'email', 'audit', 'handoff', 'event'] as const)(
    'rolls every refund write back when %s persistence fails',
    async (failure) => {
      const fixture = await createPurchase([1403]);
      const event = await createRefundEvent(`re_test_${randomUUID()}`);
      const base = dependencies();
      const overrides: RefundFulfillmentDependencies = {
        ...base,
        ...(failure === 'allocation'
          ? { createAllocation: async () => { throw new Error('forced allocation failure'); } }
          : {}),
        ...(failure === 'projection'
          ? { projectEntitlement: async () => { throw new Error('forced projection failure'); } }
          : {}),
        ...(failure === 'email'
          ? {
              messages: {
                enqueueAccessChange: async () => { throw new Error('forced email failure'); }
              }
            }
          : {}),
        ...(failure === 'audit'
          ? { appendAuditEvent: async () => { throw new Error('forced audit failure'); } }
          : {}),
        ...(failure === 'handoff'
          ? { queueFinancialSource: async () => { throw new Error('forced handoff failure'); } }
          : {}),
        ...(failure === 'event'
          ? { completeEvent: async () => { throw new Error('forced event failure'); } }
          : {})
      };
      await expect(fulfillRefundEvent(
        workerDatabaseClient.db,
        snapshots(fixture, event, 1403),
        overrides
      )).rejects.toThrow(`forced ${failure} failure`);
      expect(await databaseClient.db.select().from(refunds)).toHaveLength(0);
      expect(await databaseClient.db.select().from(refundAllocations)).toHaveLength(0);
      expect(await databaseClient.db.select().from(refundAllocationComponents)).toHaveLength(0);
      expect((await databaseClient.db.select().from(entitlementGrants))[0]?.state).toBe('active');
      expect((await databaseClient.db.select().from(entitlements))[0]?.revokedAt).toBeNull();
      expect((await databaseClient.db.select().from(stripeEvents))[0]?.status).toBe('pending');
      expect(await databaseClient.db.select().from(auditEvents)).toHaveLength(0);
      expect(await ownerDatabaseClient.db.select().from(outboxMessages)).toHaveLength(0);
      expect(await ownerDatabaseClient.db.select().from(jobs).where(eq(
        jobs.type,
        FINANCIAL_SOURCE_JOB
      ))).toHaveLength(0);
    }
  );

  it.each(['running', 'succeeded'] as const)(
    'does not rearm a %s financial refund job on duplicate reducer replay',
    async (status) => {
      const fixture = await createPurchase([1403]);
      const event = await createRefundEvent(`re_test_${randomUUID()}`);
      const input = snapshots(fixture, event, 500);
      await fulfillRefundEvent(workerDatabaseClient.db, input, dependencies());
      const [queued] = await ownerDatabaseClient.db.select().from(jobs).where(eq(
        jobs.type,
        FINANCIAL_SOURCE_JOB
      ));
      if (!queued) throw new Error('Expected financial refund job');
      await workerDatabaseClient.db.update(jobs).set(status === 'running'
        ? {
            status,
            attempts: 1,
            lockedAt: now,
            lockedBy: 'refund-replay-worker',
            completedAt: null,
            updatedAt: now
          }
        : {
            status,
            attempts: 1,
            lockedAt: null,
            lockedBy: null,
            completedAt: now,
            updatedAt: now
          }).where(eq(jobs.id, queued.id));
      const [before] = await ownerDatabaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id));

      await fulfillRefundEvent(workerDatabaseClient.db, input, dependencies());

      expect(await ownerDatabaseClient.db.select().from(jobs).where(eq(
        jobs.type,
        FINANCIAL_SOURCE_JOB
      ))).toEqual([before]);
    }
  );

  it('publishes every same-payment dispute graph edge only when refund exposure changes', async () => {
    const fixture = await createPurchase([1403]);
    const disputeIds = (await ownerDatabaseClient.db.insert(disputes).values(
      Array.from({ length: 101 }, (_, index) => ({
        paymentId: fixture.paymentId,
        stripeDisputeId: `dp_refund_cross_family_${index}_${randomUUID()}`,
        status: 'open' as const,
        amountMinor: 1,
        currency: 'USD',
        reason: 'fraudulent',
        providerCreatedAt: new Date('2026-08-10T12:30:00.000Z'),
        providerUpdatedAt: new Date('2026-08-10T12:30:00.000Z')
      }))
    ).returning({ id: disputes.id })).map((row) => row.id).sort();
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    const input = snapshots(fixture, event, 500);
    const queueFinancialSource = vi.fn(async () => undefined);

    await fulfillRefundEvent(
      workerDatabaseClient.db,
      input,
      dependencies({ queueFinancialSource })
    );

    expect(queueFinancialSource).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKind: 'refund',
        crossFamilyProjectionSources: disputeIds.map((sourceId) => ({
          sourceKind: 'dispute', sourceId
        }))
      })
    );

    queueFinancialSource.mockClear();
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      input,
      dependencies({ queueFinancialSource })
    );
    expect(queueFinancialSource).not.toHaveBeenCalled();
  });

  it('keeps refund audit data aggregate and free of email, provider IDs, titles, and amounts', async () => {
    const fixture = await createPurchase([1403]);
    const event = await createRefundEvent(`re_test_${randomUUID()}`);
    const clock = vi.fn(() => now);
    await fulfillRefundEvent(
      workerDatabaseClient.db,
      snapshots(fixture, event, 500),
      dependencies({ now: clock })
    );
    expect(clock).toHaveBeenCalledOnce();
    const audit = await databaseClient.db.select().from(auditEvents);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after).toEqual({
      allocationState: 'allocated',
      affectedTitleCount: 0
    });
    expect(JSON.stringify(audit)).not.toMatch(/@example|re_test|Private|500|1403/iu);
  });
});
