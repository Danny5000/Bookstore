import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { StripeEventRow } from '$lib/server/db/schema';
import type { JobRecord } from '$lib/server/jobs/types';
import {
  checkoutSnapshotFixture
} from '../../../../tests/fixtures/stripe/checkout';
import { paymentSnapshotFixture } from '../../../../tests/fixtures/stripe/payment';
import { refundSnapshotFixture } from '../../../../tests/fixtures/stripe/refund';
import { disputeSnapshotFixture } from '../../../../tests/fixtures/stripe/dispute';
import { PermanentCommerceError, RetryableProviderError } from './errors';
import { STRIPE_EVENT_JOB } from './job';
import { createStripeEventHandler } from './handler';
import { PermanentJobError } from '$lib/server/jobs/runner';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function event(overrides: Partial<StripeEventRow> = {}): StripeEventRow {
  const now = new Date('2026-08-10T12:00:00.000Z');
  return {
    id: randomUUID(),
    providerEventId: 'evt_test_handler_101',
    eventType: 'checkout.session.completed',
    objectId: 'cs_test_fixture_101',
    liveMode: false,
    apiVersion: '2026-07-29.dahlia',
    providerCreatedAt: now,
    rawBodySha256: 'a'.repeat(64),
    status: 'pending',
    processedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function job(stripeEventId: string): JobRecord {
  return {
    id: randomUUID(),
    type: STRIPE_EVENT_JOB,
    payload: { stripeEventId },
    attempts: 1,
    maxAttempts: 8,
    lockedBy: 'test-worker'
  };
}

function harness(row = event()) {
  const load = deferred<StripeEventRow | null>();
  const checkout = deferred<ReturnType<typeof checkoutSnapshotFixture>>();
  const payment = deferred<ReturnType<typeof paymentSnapshotFixture>>();
  const refund = deferred<ReturnType<typeof refundSnapshotFixture>>();
  const dispute = deferred<ReturnType<typeof disputeSnapshotFixture>>();
  const mutation = deferred<void>();
  const gateway = {
    createCheckoutSession: vi.fn(),
    retrieveCheckoutSession: vi.fn(() => checkout.promise),
    retrievePayment: vi.fn(() => payment.promise),
    retrieveRefund: vi.fn(() => refund.promise),
    retrieveDispute: vi.fn(() => dispute.promise),
    verifyWebhook: vi.fn()
  };
  const dependencies = {
    loadStripeEvent: vi.fn(() => load.promise),
    fulfillCheckout: vi.fn(() => mutation.promise),
    fulfillRefund: vi.fn(),
    fulfillDispute: vi.fn(),
    recordException: vi.fn()
  };
  const handler = createStripeEventHandler({} as never, gateway, dependencies);
  return {
    row,
    load,
    checkout,
    payment,
    refund,
    dispute,
    mutation,
    gateway,
    dependencies,
    handler
  };
}

describe('Stripe event handler provider ordering', () => {
  it('loads only the descriptor, performs provider reads, then starts local mutation', async () => {
    const test = harness();
    const running = test.handler(job(test.row.id), new AbortController().signal);
    expect(test.dependencies.loadStripeEvent).toHaveBeenCalledOnce();
    expect(test.gateway.retrieveCheckoutSession).not.toHaveBeenCalled();

    test.load.resolve(test.row);
    await settle();
    expect(test.gateway.retrieveCheckoutSession).toHaveBeenCalledWith(test.row.objectId);
    expect(test.gateway.retrievePayment).not.toHaveBeenCalled();
    expect(test.dependencies.fulfillCheckout).not.toHaveBeenCalled();

    const session = checkoutSnapshotFixture();
    test.checkout.resolve(session);
    await settle();
    expect(test.gateway.retrievePayment).toHaveBeenCalledWith(session.paymentIntentId);
    expect(test.dependencies.fulfillCheckout).not.toHaveBeenCalled();

    const payment = paymentSnapshotFixture();
    test.payment.resolve(payment);
    await settle();
    expect(test.dependencies.fulfillCheckout).toHaveBeenCalledWith(
      expect.anything(),
      { stripeEventId: test.row.id, session, payment }
    );
    test.mutation.resolve();
    await expect(running).resolves.toBeUndefined();
  });

  it('stops before a new provider call but never interrupts a committing mutation', async () => {
    const beforePayment = harness();
    const controller = new AbortController();
    const stopped = beforePayment.handler(job(beforePayment.row.id), controller.signal);
    beforePayment.load.resolve(beforePayment.row);
    await settle();
    controller.abort();
    beforePayment.checkout.resolve(checkoutSnapshotFixture());
    await expect(stopped).rejects.toMatchObject({ name: 'AbortError' });
    expect(beforePayment.gateway.retrievePayment).not.toHaveBeenCalled();
    expect(beforePayment.dependencies.fulfillCheckout).not.toHaveBeenCalled();

    const duringCommit = harness();
    const commitController = new AbortController();
    const committing = duringCommit.handler(job(duringCommit.row.id), commitController.signal);
    duringCommit.load.resolve(duringCommit.row);
    await settle();
    duringCommit.checkout.resolve(checkoutSnapshotFixture());
    await settle();
    duringCommit.payment.resolve(paymentSnapshotFixture());
    await settle();
    expect(duringCommit.dependencies.fulfillCheckout).toHaveBeenCalledOnce();
    commitController.abort();
    duringCommit.mutation.resolve();
    await expect(committing).resolves.toBeUndefined();
  });

  it('does no provider work for an event already completed locally', async () => {
    const test = harness(event({ status: 'processed', processedAt: new Date() }));
    const running = test.handler(job(test.row.id), new AbortController().signal);
    test.load.resolve(test.row);
    await expect(running).resolves.toBeUndefined();
    expect(test.gateway.retrieveCheckoutSession).not.toHaveBeenCalled();
    expect(test.dependencies.fulfillCheckout).not.toHaveBeenCalled();
  });

  it('dispatches refund and dispute snapshots only after their provider reads complete', async () => {
    const refundRow = event({
      eventType: 'refund.updated',
      objectId: 're_test_fixture_101'
    });
    const refund = harness(refundRow);
    const refundSnapshot = refundSnapshotFixture();
    refund.gateway.retrieveRefund.mockResolvedValueOnce(refundSnapshot);
    const refundPayment = paymentSnapshotFixture();
    refund.gateway.retrievePayment.mockResolvedValueOnce(refundPayment);
    refund.dependencies.fulfillRefund.mockResolvedValueOnce(undefined);
    const refundRun = refund.handler(job(refundRow.id), new AbortController().signal);
    refund.load.resolve(refundRow);
    await expect(refundRun).resolves.toBeUndefined();
    expect(refund.dependencies.fulfillRefund).toHaveBeenCalledWith(
      expect.anything(),
      { stripeEventId: refundRow.id, refund: refundSnapshot, payment: refundPayment }
    );

    const disputeRow = event({
      eventType: 'charge.dispute.updated',
      objectId: 'dp_test_fixture_101'
    });
    const dispute = harness(disputeRow);
    const disputeSnapshot = disputeSnapshotFixture();
    dispute.gateway.retrieveDispute.mockResolvedValueOnce(disputeSnapshot);
    const disputePayment = paymentSnapshotFixture();
    dispute.gateway.retrievePayment.mockResolvedValueOnce(disputePayment);
    dispute.dependencies.fulfillDispute.mockResolvedValueOnce(undefined);
    const disputeRun = dispute.handler(job(disputeRow.id), new AbortController().signal);
    dispute.load.resolve(disputeRow);
    await expect(disputeRun).resolves.toBeUndefined();
    expect(dispute.dependencies.fulfillDispute).toHaveBeenCalledWith(
      expect.anything(),
      { stripeEventId: disputeRow.id, dispute: disputeSnapshot, payment: disputePayment }
    );
  });

  it('retrieves a dispute and its linked payment before starting local mutation', async () => {
    const row = event({
      eventType: 'charge.dispute.updated',
      objectId: 'dp_test_fixture_101'
    });
    const test = harness(row);
    test.dependencies.fulfillDispute.mockResolvedValueOnce(undefined);
    const running = test.handler(job(row.id), new AbortController().signal);
    test.load.resolve(row);
    await settle();
    expect(test.gateway.retrieveDispute).toHaveBeenCalledWith(row.objectId);
    expect(test.gateway.retrievePayment).not.toHaveBeenCalled();
    expect(test.dependencies.fulfillDispute).not.toHaveBeenCalled();

    const canonicalDispute = disputeSnapshotFixture();
    test.dispute.resolve(canonicalDispute);
    await settle();
    expect(test.gateway.retrievePayment).toHaveBeenCalledWith(
      canonicalDispute.paymentIntentId
    );
    expect(test.dependencies.fulfillDispute).not.toHaveBeenCalled();

    const canonicalPayment = paymentSnapshotFixture();
    test.payment.resolve(canonicalPayment);
    await expect(running).resolves.toBeUndefined();
    expect(test.dependencies.fulfillDispute).toHaveBeenCalledWith(expect.anything(), {
      stripeEventId: row.id,
      dispute: canonicalDispute,
      payment: canonicalPayment
    });
  });

  it('retrieves a refund and its linked payment before starting local mutation', async () => {
    const row = event({
      eventType: 'refund.updated',
      objectId: 're_test_fixture_101'
    });
    const test = harness(row);
    test.dependencies.fulfillRefund.mockResolvedValueOnce(undefined);
    const running = test.handler(job(row.id), new AbortController().signal);
    test.load.resolve(row);
    await settle();
    expect(test.gateway.retrieveRefund).toHaveBeenCalledWith(row.objectId);
    expect(test.gateway.retrievePayment).not.toHaveBeenCalled();
    expect(test.dependencies.fulfillRefund).not.toHaveBeenCalled();

    const canonicalRefund = refundSnapshotFixture();
    test.refund.resolve(canonicalRefund);
    await settle();
    expect(test.gateway.retrievePayment).toHaveBeenCalledWith(
      canonicalRefund.paymentIntentId
    );
    expect(test.dependencies.fulfillRefund).not.toHaveBeenCalled();

    const canonicalPayment = paymentSnapshotFixture();
    test.payment.resolve(canonicalPayment);
    await expect(running).resolves.toBeUndefined();
    expect(test.dependencies.fulfillRefund).toHaveBeenCalledWith(expect.anything(), {
      stripeEventId: row.id,
      refund: canonicalRefund,
      payment: canonicalPayment
    });
  });

  it('rejects malformed or missing job state permanently without provider work', async () => {
    const invalid = harness();
    await expect(invalid.handler({
      ...job(invalid.row.id),
      payload: { stripeEventId: invalid.row.id, secret: 'not-allowed' }
    }, new AbortController().signal)).rejects.toBeInstanceOf(PermanentJobError);
    expect(invalid.dependencies.loadStripeEvent).not.toHaveBeenCalled();

    const missing = harness();
    const missingRun = missing.handler(job(missing.row.id), new AbortController().signal);
    missing.load.resolve(null);
    await expect(missingRun).rejects.toBeInstanceOf(PermanentJobError);
    expect(missing.gateway.retrieveCheckoutSession).not.toHaveBeenCalled();
  });

  it('records permanent provider failures while preserving retryable failures', async () => {
    const permanent = harness();
    const permanentRun = permanent.handler(job(permanent.row.id), new AbortController().signal);
    permanent.load.resolve(permanent.row);
    await settle();
    permanent.checkout.reject(new PermanentCommerceError());
    await expect(permanentRun).resolves.toBeUndefined();
    expect(permanent.dependencies.recordException).toHaveBeenCalledWith(
      expect.anything(),
      { stripeEventId: permanent.row.id, orderId: null }
    );

    const retryable = harness();
    const retryableRun = retryable.handler(job(retryable.row.id), new AbortController().signal);
    retryable.load.resolve(retryable.row);
    await settle();
    retryable.checkout.reject(new RetryableProviderError());
    await expect(retryableRun).rejects.toBeInstanceOf(RetryableProviderError);
    expect(retryable.dependencies.recordException).not.toHaveBeenCalled();
  });

  it('records a permanent canonical mutation failure against the recovered order', async () => {
    const test = harness();
    const running = test.handler(job(test.row.id), new AbortController().signal);
    test.load.resolve(test.row);
    await settle();
    const session = checkoutSnapshotFixture();
    test.checkout.resolve(session);
    await settle();
    test.payment.resolve(paymentSnapshotFixture());
    await settle();
    test.mutation.reject(new PermanentCommerceError());

    await expect(running).resolves.toBeUndefined();
    expect(test.dependencies.recordException).toHaveBeenCalledWith(
      expect.anything(),
      { stripeEventId: test.row.id, orderId: session.metadataOrderId }
    );
  });
});
