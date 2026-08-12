import { describe, expect, it } from 'vitest';
import {
  PermanentCommerceError,
  RetryableProviderError
} from '$lib/server/commerce/errors';
import { balanceTransactionSnapshotFixture } from '../../../../../tests/fixtures/stripe/balance-transaction';
import { chargeSnapshotFixture } from '../../../../../tests/fixtures/stripe/charge';
import { payoutSnapshotFixture } from '../../../../../tests/fixtures/stripe/payout';
import { createFixtureStripeGateway } from './fixture-gateway';

describe('fixture Stripe financial evidence', () => {
  it('validates point snapshots and clones nested input and output', async () => {
    const fixture = createFixtureStripeGateway();
    const charge = chargeSnapshotFixture();
    const transaction = balanceTransactionSnapshotFixture();
    const payout = payoutSnapshotFixture();
    fixture.harness.setCharge(charge);
    fixture.harness.setBalanceTransaction(transaction);
    fixture.harness.setPayout(payout);

    (transaction.feeDetails as unknown as Array<{ amountMinor: number }>)[0]!.amountMinor = 999;
    const first = await fixture.gateway.retrieveBalanceTransaction(transaction.id);
    (first.feeDetails as unknown as Array<{ amountMinor: number }>)[0]!.amountMinor = 500;

    await expect(fixture.gateway.retrieveCharge(charge.id)).resolves.toEqual(charge);
    await expect(fixture.gateway.retrieveBalanceTransaction(transaction.id)).resolves
      .toEqual(balanceTransactionSnapshotFixture());
    await expect(fixture.gateway.retrievePayout(payout.id)).resolves.toEqual(payout);
    expect(() => fixture.harness.setCharge({ ...charge, metadata: { private: true } }))
      .toThrow(PermanentCommerceError);
  });

  it('returns safe empty terminal pages before list fixtures are configured', async () => {
    const fixture = createFixtureStripeGateway();
    const empty = { data: [], hasMore: false, nextStartingAfter: null };

    await expect(fixture.gateway.listBalanceTransactionsForSource('ch_source', { limit: 100 }))
      .resolves.toEqual(empty);
    await expect(fixture.gateway.listBalanceTransactionsForPayout('po_source', { limit: 100 }))
      .resolves.toEqual(empty);
    await expect(fixture.gateway.listPayouts({ limit: 100 })).resolves.toEqual(empty);
  });

  it('paginates stable registered source evidence with opaque last-ID cursors', async () => {
    const fixture = createFixtureStripeGateway();
    const sourceId = 'ch_test_source_101';
    const values = [
      balanceTransactionSnapshotFixture({
        id: 'txn_source_1', sourceId, createdAt: new Date('2026-08-10T12:00:00.000Z')
      }),
      balanceTransactionSnapshotFixture({
        id: 'txn_source_2', sourceId, createdAt: new Date('2026-08-10T12:01:00.000Z')
      }),
      balanceTransactionSnapshotFixture({
        id: 'txn_source_3', sourceId, createdAt: new Date('2026-08-10T12:02:00.000Z')
      })
    ];
    fixture.harness.setBalanceTransactionsForSource(sourceId, values);
    values.reverse();

    const first = await fixture.gateway.listBalanceTransactionsForSource(sourceId, { limit: 2 });
    expect(first).toEqual({
      data: expect.arrayContaining([
        expect.objectContaining({ id: 'txn_source_1' }),
        expect.objectContaining({ id: 'txn_source_2' })
      ]),
      hasMore: true,
      nextStartingAfter: 'txn_source_2'
    });
    expect(first.data.map((row) => row.id)).toEqual(['txn_source_1', 'txn_source_2']);
    (first.data[0]!.feeDetails as unknown as Array<{ amountMinor: number }>)[0]!.amountMinor = 999;
    const repeated = await fixture.gateway.listBalanceTransactionsForSource(sourceId, { limit: 2 });
    expect(repeated.data[0]).toMatchObject({
      id: 'txn_source_1',
      feeDetails: [expect.objectContaining({ amountMinor: 71 })]
    });
    await expect(fixture.gateway.listBalanceTransactionsForSource(sourceId, {
      limit: 2,
      startingAfter: first.nextStartingAfter!,
      createdGte: Math.floor(new Date('2026-08-10T12:00:00.000Z').getTime() / 1000),
      createdLt: Math.floor(new Date('2026-08-10T12:03:00.000Z').getTime() / 1000)
    })).resolves.toMatchObject({
      data: [expect.objectContaining({ id: 'txn_source_3' })],
      hasMore: false,
      nextStartingAfter: null
    });
    await expect(fixture.gateway.listBalanceTransactionsForSource(sourceId, {
      limit: 2,
      startingAfter: 'txn_missing'
    })).rejects.toBeInstanceOf(PermanentCommerceError);
  });

  it('supports independent payout-membership pages and bounded payout date pages', async () => {
    const fixture = createFixtureStripeGateway();
    const payoutId = 'po_test_fixture_101';
    fixture.harness.setBalanceTransactionsForPayout(payoutId, [
      balanceTransactionSnapshotFixture({ id: 'txn_payout_1' }),
      balanceTransactionSnapshotFixture({ id: 'txn_payout_2' })
    ]);
    fixture.harness.setPayouts([
      payoutSnapshotFixture({ id: 'po_1', createdAt: new Date('2026-08-10T12:00:00.000Z') }),
      payoutSnapshotFixture({ id: 'po_2', createdAt: new Date('2026-08-12T12:00:00.000Z') })
    ]);

    await expect(fixture.gateway.listBalanceTransactionsForPayout(payoutId, { limit: 1 }))
      .resolves.toMatchObject({ hasMore: true, nextStartingAfter: 'txn_payout_1' });
    await expect(fixture.gateway.listPayouts({
      limit: 10,
      createdGte: Math.floor(new Date('2026-08-11T00:00:00.000Z').getTime() / 1000)
    })).resolves.toMatchObject({
      data: [expect.objectContaining({ id: 'po_2' })],
      hasMore: false,
      nextStartingAfter: null
    });
  });

  it.each([
    ['retrieveCharge', (fixture: ReturnType<typeof createFixtureStripeGateway>) =>
      fixture.gateway.retrieveCharge('ch_test_fixture_101')],
    ['retrieveBalanceTransaction', (fixture: ReturnType<typeof createFixtureStripeGateway>) =>
      fixture.gateway.retrieveBalanceTransaction('txn_test_charge_101')],
    ['retrievePayout', (fixture: ReturnType<typeof createFixtureStripeGateway>) =>
      fixture.gateway.retrievePayout('po_test_fixture_101')],
    ['listBalanceTransactionsForSource', (fixture: ReturnType<typeof createFixtureStripeGateway>) =>
      fixture.gateway.listBalanceTransactionsForSource('ch_source', { limit: 1 })],
    ['listBalanceTransactionsForPayout', (fixture: ReturnType<typeof createFixtureStripeGateway>) =>
      fixture.gateway.listBalanceTransactionsForPayout('po_source', { limit: 1 })],
    ['listPayouts', (fixture: ReturnType<typeof createFixtureStripeGateway>) =>
      fixture.gateway.listPayouts({ limit: 1 })]
  ] as const)('injects one-shot safe failures for %s', async (operation, invoke) => {
    const fixture = createFixtureStripeGateway();
    fixture.harness.setCharge(chargeSnapshotFixture());
    fixture.harness.setBalanceTransaction(balanceTransactionSnapshotFixture());
    fixture.harness.setPayout(payoutSnapshotFixture());
    fixture.harness.failNextFinancialOperation(operation, 'retryable');
    await expect(invoke(fixture)).rejects.toBeInstanceOf(RetryableProviderError);
    await expect(invoke(fixture)).resolves.toBeDefined();
    fixture.harness.failNextFinancialOperation(operation, 'permanent');
    await expect(invoke(fixture)).rejects.toBeInstanceOf(PermanentCommerceError);
    await expect(invoke(fixture)).resolves.toBeDefined();
  });

  it('fails safely for missing point evidence and reset clears every financial fixture', async () => {
    const fixture = createFixtureStripeGateway();
    fixture.harness.setCharge(chargeSnapshotFixture());
    fixture.harness.setPayouts([payoutSnapshotFixture()]);
    fixture.harness.failNextFinancialOperation('listPayouts', 'retryable');
    fixture.harness.reset();

    await expect(fixture.gateway.retrieveCharge('ch_test_fixture_101'))
      .rejects.toBeInstanceOf(PermanentCommerceError);
    await expect(fixture.gateway.listPayouts({ limit: 10 })).resolves.toEqual({
      data: [], hasMore: false, nextStartingAfter: null
    });
  });
});
