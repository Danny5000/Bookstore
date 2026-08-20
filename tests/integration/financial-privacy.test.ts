import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createFinancialPayoutHandler } from '$lib/server/commerce/financial/handlers/payout';
import { createFinancialScanHandler } from '$lib/server/commerce/financial/handlers/scan';
import { createFinancialSourceHandler } from '$lib/server/commerce/financial/handlers/source';
import {
  createFinancialPayoutEventJob,
  createFinancialSourceEventJob,
  createFinancialSourceScanJob,
  FINANCIAL_PAYOUT_JOB,
  FINANCIAL_SCAN_JOB,
  FINANCIAL_SOURCE_JOB,
  parseFinancialJobIdentity,
  type FinancialPayoutJobSpec,
  type FinancialSourceJobSpec
} from '$lib/server/commerce/financial/jobs';
import { stagePayoutSnapshot } from '$lib/server/commerce/financial/payouts/repository';
import { createFixtureStripeGateway } from '$lib/server/commerce/stripe/fixture-gateway';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import {
  auditEvents,
  financialAllocationSets,
  financialClassificationVersions,
  financialItemAllocations,
  financialReconciliationIssues,
  guestIdentities,
  jobs,
  orderItems,
  orders,
  outboxMessages,
  payments,
  stripeBalanceTransactionFeeDetails,
  stripeBalanceTransactions,
  stripePayouts,
  titles,
  type JsonObject
} from '$lib/server/db/schema';
import {
  createPostgresJobRepository,
  enqueueActiveEntityJob
} from '$lib/server/jobs/repository';
import { runWorker } from '$lib/server/jobs/runner';
import type { JobHandler } from '$lib/server/jobs/types';
import { balanceTransactionSnapshotFixture } from '../fixtures/stripe/balance-transaction';
import { chargeSnapshotFixture } from '../fixtures/stripe/charge';
import { disputeSnapshotFixture } from '../fixtures/stripe/dispute';
import { paymentSnapshotFixture } from '../fixtures/stripe/payment';
import { payoutSnapshotFixture } from '../fixtures/stripe/payout';
import { refundSnapshotFixture } from '../fixtures/stripe/refund';
import {
  applicationConfig,
  ownerDatabaseClient,
  workerDatabaseClient as databaseClient
} from './database';

const FINANCIAL_TABLES = [
  'stripe_balance_transactions',
  'stripe_balance_transaction_fee_details',
  'financial_classification_versions',
  'financial_projection_versions',
  'financial_payout_discovery_state',
  'stripe_payouts',
  'payout_import_runs',
  'payout_import_run_entries',
  'stripe_payout_balance_transactions',
  'financial_scan_runs',
  'financial_allocation_sets',
  'financial_item_allocations',
  'financial_reconciliation_issues',
  'refund_allocation_components',
  'dispute_item_allocations',
  'refund_allocation_drafts',
  'refund_allocation_draft_items',
  'refund_reporting_correction_sets',
  'refund_reporting_correction_items',
  'refund_allocation_finalization_effects'
] as const;

const FORBIDDEN_KEYS = new Set([
  'email',
  'customer',
  'card',
  'paymentmethod',
  'billingdetails',
  'address',
  'receipturl',
  'description',
  'destination',
  'metadata',
  'clientsecret',
  'rawobject',
  'providermessage'
]);

const FORBIDDEN_TEXT = /(?:\bemail\b|\bcustomer\b|\bcard\b|payment_method|billing_details|\baddress\b|receipt_url|\bdescription\b|\bdestination\b|\bmetadata\b|client_secret|raw_object|provider_message|(?:sk|rk)_(?:test|live)(?:_|\b)|whsec_|BEGIN PRIVATE KEY)/iu;
const PROVIDER_OBJECT_ID = /^(?:acct|ba|card|ch|cs|cus|dp|evt|li|pi|pm|po|re|src|tok|tr|txn)_[A-Za-z0-9_-]+$/u;
const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');

interface PrivacyFixture {
  readonly orderId: string;
  readonly paymentId: string;
  readonly privateEmail: string;
  readonly privateSecret: string;
  readonly provider: {
    readonly checkoutSessionId: string;
    readonly paymentIntentId: string;
    readonly chargeId: string;
    readonly balanceTransactionId: string;
    readonly payoutId: string;
    readonly sourceEventId: string;
    readonly payoutEventId: string;
  };
  readonly stripe: ReturnType<typeof createFixtureStripeGateway>;
  readonly payoutSnapshot: ReturnType<typeof payoutSnapshotFixture>;
  readonly sourceSpec: FinancialSourceJobSpec;
  readonly payoutSpec: FinancialPayoutJobSpec;
}

function suffix(): string {
  return randomUUID().replaceAll('-', '');
}

function normalizedKey(value: string): string {
  return value.replaceAll(/[_-]/gu, '').toLowerCase();
}

function collectForbidden(value: unknown, path = '$', visited = new WeakSet<object>()): string[] {
  if (path === '$.paymentMethodCategory') return value === 'card' ? [] : [path];
  if (typeof value === 'string') return FORBIDDEN_TEXT.test(value) ? [path] : [];
  if (value === null || typeof value !== 'object') return [];
  if (visited.has(value)) return [];
  visited.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectForbidden(entry, `${path}[${index}]`, visited));
  }
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(FORBIDDEN_KEYS.has(normalizedKey(key)) ? [`${path}.${key}`] : []),
    ...collectForbidden(entry, `${path}.${key}`, visited)
  ]);
}

function expectPrivacySafe(value: unknown): void {
  expect(collectForbidden(value)).toEqual([]);
}

function collectProviderIdPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return PROVIDER_OBJECT_ID.test(value) ? [path] : [];
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectProviderIdPaths(entry, `${path}[${index}]`));
  }
  return Object.entries(value).flatMap(([key, entry]) =>
    collectProviderIdPaths(entry, `${path}.${key}`));
}

function collectSnapshotKeyPaths(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectSnapshotKeyPaths(entry, `${path}[${index}]`));
  }
  return Object.entries(value).flatMap(([key, entry]) => {
    const entryPath = `${path}.${key}`;
    return [entryPath, ...collectSnapshotKeyPaths(entry, entryPath)];
  });
}

function expectCanonicalSnapshotPrivacySafe(input: {
  readonly label: string;
  readonly snapshot: unknown;
  readonly allowedProviderIdPaths: readonly string[];
  readonly allowedSnapshotKeyPaths: readonly string[];
}): void {
  expectPrivacySafe(input.snapshot);
  expect(
    collectSnapshotKeyPaths(input.snapshot).sort(),
    `${input.label} escaped the minimized snapshot DTO allowlist`
  ).toEqual([...input.allowedSnapshotKeyPaths].sort());
  expect(
    collectProviderIdPaths(input.snapshot).sort(),
    `${input.label} provider IDs escaped the minimized snapshot linkage allowlist`
  ).toEqual([...input.allowedProviderIdPaths].sort());
}

function labelsContaining(
  locations: Readonly<Record<string, unknown>>,
  privateValue: string
): string[] {
  return Object.entries(locations)
    .filter(([, value]) => JSON.stringify(value).includes(privateValue))
    .map(([label]) => label)
    .sort();
}

async function enqueueSource(spec: FinancialSourceJobSpec): Promise<void> {
  await databaseClient.db.transaction((transaction) => enqueueActiveEntityJob(transaction, {
    type: spec.type,
    payload: spec.payload as JsonObject,
    deduplicationKey: spec.deduplicationKey,
    maxAttempts: spec.maxAttempts,
    activeEntity: {
      sourceKind: spec.payload.sourceKind,
      sourceId: spec.payload.sourceId
    }
  }));
}

async function enqueuePayout(spec: FinancialPayoutJobSpec): Promise<void> {
  await databaseClient.db.transaction((transaction) => enqueueActiveEntityJob(transaction, {
    type: spec.type,
    payload: spec.payload as JsonObject,
    deduplicationKey: spec.deduplicationKey,
    maxAttempts: spec.maxAttempts,
    activeEntity: { providerPayoutId: spec.payload.providerPayoutId }
  }));
}

function handlers(gateway: StripeCommerceGateway): ReadonlyMap<string, JobHandler> {
  return new Map([
    [FINANCIAL_SOURCE_JOB, createFinancialSourceHandler({
      database: databaseClient.db,
      gateway
    })],
    [FINANCIAL_PAYOUT_JOB, createFinancialPayoutHandler({
      database: databaseClient.db,
      gateway
    })],
    [FINANCIAL_SCAN_JOB, createFinancialScanHandler({
      database: databaseClient.db,
      gateway,
      runtimeMode: 'stripe'
    })]
  ]);
}

async function drain(gateway: StripeCommerceGateway): Promise<void> {
  const repository = createPostgresJobRepository(
    databaseClient.db,
    applicationConfig.jobs,
    () => FAR_FUTURE
  );
  const registered = handlers(gateway);
  for (let index = 0; index < 20; index += 1) {
    const workerId = `financial-privacy-${index}`;
    const job = await repository.claimNext(workerId);
    if (!job) return;
    const handler = registered.get(job.type);
    if (!handler) throw new Error(`Unexpected privacy job type: ${job.type}`);
    await handler(job, new AbortController().signal);
    expect(await repository.complete(job.id, workerId)).toBe(true);
  }
  throw new Error('Financial privacy fixture exceeded its bounded job count.');
}

async function createPrivacyFixture(): Promise<PrivacyFixture> {
  const token = suffix();
  const privateEmail = `private-${token}@privacy.invalid`;
  const privateSecret = `sk_test_private_${token}`;
  const provider = {
    checkoutSessionId: `cs_privacy_${token}`,
    paymentIntentId: `pi_privacy_${token}`,
    chargeId: `ch_privacy_${token}`,
    balanceTransactionId: `txn_privacy_${token}`,
    payoutId: `po_privacy_${token}`,
    sourceEventId: `evt_privacy_source_${token}`,
    payoutEventId: `evt_privacy_payout_${token}`
  };
  const orderId = randomUUID();
  const titleId = randomUUID();
  const itemId = randomUUID();
  const paidAt = new Date('2026-08-10T12:01:00.000Z');
  const [guest] = await ownerDatabaseClient.db.insert(guestIdentities).values({
    email: privateEmail
  }).returning();
  if (!guest) throw new Error('Expected a privacy guest fixture.');
  await ownerDatabaseClient.db.insert(titles).values({
    id: titleId,
    slug: `financial-privacy-${token}`,
    title: 'Financial privacy fixture',
    description: 'Private local catalog description',
    creatorName: 'Private fixture creator',
    format: 'prose',
    priceMinor: 1299,
    currency: 'USD',
    visibility: 'private'
  });
  await ownerDatabaseClient.db.insert(orders).values({
    id: orderId,
    status: 'paid',
    guestIdentityId: guest.id,
    purchaseEmail: privateEmail,
    currency: 'USD',
    subtotalMinor: 1299,
    taxMinor: 104,
    totalMinor: 1403,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'a'.repeat(64),
    stripeCheckoutSessionId: provider.checkoutSessionId,
    statusTokenSha256: 'b'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
    paidAt
  });
  await ownerDatabaseClient.db.insert(orderItems).values({
    id: itemId,
    orderId,
    titleId,
    titleSnapshot: 'Financial privacy fixture',
    creatorNameSnapshot: 'Private fixture creator',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: 1299,
    taxMinor: 104,
    totalMinor: 1403,
    stripeLineItemId: `li_privacy_${token}`
  });
  const [payment] = await ownerDatabaseClient.db.insert(payments).values({
    orderId,
    stripePaymentIntentId: provider.paymentIntentId,
    stripeLatestChargeId: provider.chargeId,
    status: 'succeeded',
    amountMinor: 1403,
    currency: 'USD',
    paymentMethodCategory: 'card',
    paidAt
  }).returning();
  if (!payment) throw new Error('Expected a privacy payment fixture.');

  const stripe = createFixtureStripeGateway();
  stripe.harness.setPayment(paymentSnapshotFixture({
    paymentIntentId: provider.paymentIntentId,
    metadataOrderId: orderId,
    latestChargeId: provider.chargeId,
    amountMinor: 1403,
    paidAt
  }));
  stripe.harness.setCharge(chargeSnapshotFixture({
    id: provider.chargeId,
    paymentIntentId: provider.paymentIntentId,
    amountMinor: 1403,
    balanceTransactionId: provider.balanceTransactionId,
    createdAt: paidAt
  }));
  const balanceSnapshot = balanceTransactionSnapshotFixture({
    id: provider.balanceTransactionId,
    sourceId: provider.chargeId,
    amountMinor: 1403,
    feeMinor: 71,
    netMinor: 1332,
    createdAt: paidAt
  });
  stripe.harness.setBalanceTransaction(balanceSnapshot);
  const sourceSpec = createFinancialSourceEventJob({
    sourceKind: 'payment',
    sourceId: payment.id,
    providerEventId: provider.sourceEventId
  });
  await enqueueSource(sourceSpec);
  await drain(stripe.gateway);

  const payoutSnapshot = payoutSnapshotFixture({
    id: provider.payoutId,
    amountMinor: 1332,
    balanceTransactionId: null
  });
  stripe.harness.setPayout(payoutSnapshot);
  stripe.harness.setBalanceTransactionsForPayout(provider.payoutId, [balanceSnapshot]);
  const payoutSpec = createFinancialPayoutEventJob({
    providerPayoutId: provider.payoutId,
    providerEventId: provider.payoutEventId
  });
  await enqueuePayout(payoutSpec);
  await drain(stripe.gateway);

  await expect(stagePayoutSnapshot(databaseClient.db, {
    ...payoutSnapshot,
    amountMinor: payoutSnapshot.amountMinor + 1
  }, { correlationId: `privacy-collision-${token}` })).rejects.toMatchObject({
    name: 'PermanentFinancialError',
    safeCode: 'immutable_mismatch'
  });

  return {
    orderId,
    paymentId: payment.id,
    privateEmail,
    privateSecret,
    provider,
    stripe,
    payoutSnapshot,
    sourceSpec,
    payoutSpec
  };
}

async function runSanitizedFailure(fixture: PrivacyFixture): Promise<{
  readonly failedJob: typeof jobs.$inferSelect;
  readonly logs: readonly unknown[][];
}> {
  const scanSpec = createFinancialSourceScanJob({
    sourceKind: 'payment',
    sourceId: fixture.paymentId,
    scanRunId: randomUUID(),
    scanGenerationHour: '2026-08-12T14:00:00.000Z'
  });
  await enqueueSource(scanSpec);
  const privateCause = new Error(
    `${fixture.privateSecret} ${fixture.privateEmail} provider_message customer card`
  );
  const gateway: StripeCommerceGateway = {
    ...fixture.stripe.gateway,
    async retrievePayment() {
      throw privateCause;
    }
  };
  const controller = new AbortController();
  const logs: unknown[][] = [];
  vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    logs.push(values);
  });
  await runWorker({
    repository: createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => FAR_FUTURE
    ),
    handlers: new Map([[FINANCIAL_SOURCE_JOB, createFinancialSourceHandler({
      database: databaseClient.db,
      gateway
    })]]),
    workerId: 'financial-privacy-runner',
    concurrency: 1,
    pollIntervalMs: 1,
    heartbeatIntervalMs: 1,
    signal: controller.signal,
    sleep: async () => {
      controller.abort();
    },
    heartbeatSleep: async (_milliseconds, signal) => {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  });
  const [failedJob] = await databaseClient.db.select().from(jobs).where(eq(
    jobs.deduplicationKey,
    scanSpec.deduplicationKey
  ));
  if (!failedJob) throw new Error('Expected a sanitized failure job.');
  return { failedJob, logs };
}

describe('financial reconciliation privacy', () => {
  it('rejects Stripe object IDs from canonical snapshot fields that are not linkage keys', () => {
    const misplacedIdFixture = {
      label: 'balance transaction with misplaced customer ID',
      snapshot: balanceTransactionSnapshotFixture({ rawType: 'cus_private_fixture' }),
      allowedProviderIdPaths: ['$.id', '$.sourceId'],
      allowedSnapshotKeyPaths: [
        '$.amountMinor',
        '$.availableAt',
        '$.balanceType',
        '$.createdAt',
        '$.currency',
        '$.exchangeRate',
        '$.exchangeSourceCurrency',
        '$.exchangeTargetCurrency',
        '$.feeDetails',
        '$.feeDetails[0].amountMinor',
        '$.feeDetails[0].currency',
        '$.feeDetails[0].ordinal',
        '$.feeDetails[0].rawType',
        '$.feeMinor',
        '$.id',
        '$.livemode',
        '$.netMinor',
        '$.rawType',
        '$.reportingCategory',
        '$.sourceFamily',
        '$.sourceId',
        '$.status'
      ]
    };

    expect(() => expectCanonicalSnapshotPrivacySafe(misplacedIdFixture)).toThrow();
  });

  it('rejects canonical snapshot fields outside the minimized DTO allowlist', () => {
    const expandedFixture = {
      label: 'expanded charge',
      snapshot: { ...chargeSnapshotFixture(), debugCounter: 1 },
      allowedProviderIdPaths: ['$.balanceTransactionId', '$.id', '$.paymentIntentId'],
      allowedSnapshotKeyPaths: [
        '$.amountMinor',
        '$.amountRefundedMinor',
        '$.balanceTransactionId',
        '$.createdAt',
        '$.currency',
        '$.id',
        '$.livemode',
        '$.paymentIntentId',
        '$.status'
      ]
    };

    expect(() => expectCanonicalSnapshotPrivacySafe(expandedFixture)).toThrow();
  });

  it('allows the bounded card category only at the canonical payment snapshot path', () => {
    expect(() => expectPrivacySafe({ paymentMethodCategory: 'card' })).not.toThrow();
    expect(() => expectPrivacySafe({ paymentMethodCategory: 'customer' })).toThrow();
    expect(() => expectPrivacySafe({ nested: { paymentMethodCategory: 'card' } })).toThrow();
    expect(() => expectPrivacySafe({ providerDetail: 'card' })).toThrow();
  });

  it('limits canonical financial snapshot fixtures to minimized provider linkage IDs', () => {
    const fixtures = [
      {
        label: 'charge',
        snapshot: chargeSnapshotFixture({
          id: 'ch_privacy_fixture',
          paymentIntentId: 'pi_privacy_fixture',
          balanceTransactionId: 'txn_privacy_charge'
        }),
        allowedProviderIdPaths: ['$.balanceTransactionId', '$.id', '$.paymentIntentId'],
        allowedSnapshotKeyPaths: [
          '$.amountMinor',
          '$.amountRefundedMinor',
          '$.balanceTransactionId',
          '$.createdAt',
          '$.currency',
          '$.id',
          '$.livemode',
          '$.paymentIntentId',
          '$.status'
        ]
      },
      {
        label: 'payment',
        snapshot: paymentSnapshotFixture({
          paymentIntentId: 'pi_privacy_fixture',
          latestChargeId: 'ch_privacy_fixture'
        }),
        allowedProviderIdPaths: ['$.latestChargeId', '$.paymentIntentId'],
        allowedSnapshotKeyPaths: [
          '$.amountMinor',
          '$.currency',
          '$.latestChargeId',
          '$.liveMode',
          '$.metadataOrderId',
          '$.metadataVersion',
          '$.paidAt',
          '$.paymentIntentId',
          '$.paymentMethodCategory',
          '$.state'
        ]
      },
      {
        label: 'refund',
        snapshot: refundSnapshotFixture({
          providerRefundId: 're_privacy_fixture',
          paymentIntentId: 'pi_privacy_fixture',
          balanceTransactionId: 'txn_privacy_refund',
          failureBalanceTransactionId: 'txn_privacy_refund_failure'
        }),
        allowedProviderIdPaths: [
          '$.balanceTransactionId',
          '$.failureBalanceTransactionId',
          '$.paymentIntentId',
          '$.providerRefundId'
        ],
        allowedSnapshotKeyPaths: [
          '$.amountMinor',
          '$.balanceTransactionId',
          '$.currency',
          '$.failureBalanceTransactionId',
          '$.liveMode',
          '$.paymentIntentId',
          '$.providerCreatedAt',
          '$.providerRefundId',
          '$.reason',
          '$.state'
        ]
      },
      {
        label: 'dispute',
        snapshot: disputeSnapshotFixture({
          providerDisputeId: 'dp_privacy_fixture',
          paymentIntentId: 'pi_privacy_fixture',
          chargeId: 'ch_privacy_fixture',
          balanceTransactionIds: [
            'txn_privacy_dispute_withdrawal',
            'txn_privacy_dispute_reinstatement'
          ]
        }),
        allowedProviderIdPaths: [
          '$.balanceTransactionIds[0]',
          '$.balanceTransactionIds[1]',
          '$.chargeId',
          '$.paymentIntentId',
          '$.providerDisputeId'
        ],
        allowedSnapshotKeyPaths: [
          '$.amountMinor',
          '$.balanceTransactionIds',
          '$.chargeId',
          '$.currency',
          '$.liveMode',
          '$.paymentIntentId',
          '$.providerCreatedAt',
          '$.providerDisputeId',
          '$.reason',
          '$.state'
        ]
      },
      {
        label: 'balance transaction',
        snapshot: balanceTransactionSnapshotFixture({
          id: 'txn_privacy_fixture',
          sourceId: 'ch_privacy_fixture'
        }),
        allowedProviderIdPaths: ['$.id', '$.sourceId'],
        allowedSnapshotKeyPaths: [
          '$.amountMinor',
          '$.availableAt',
          '$.balanceType',
          '$.createdAt',
          '$.currency',
          '$.exchangeRate',
          '$.exchangeSourceCurrency',
          '$.exchangeTargetCurrency',
          '$.feeDetails',
          '$.feeDetails[0].amountMinor',
          '$.feeDetails[0].currency',
          '$.feeDetails[0].ordinal',
          '$.feeDetails[0].rawType',
          '$.feeMinor',
          '$.id',
          '$.livemode',
          '$.netMinor',
          '$.rawType',
          '$.reportingCategory',
          '$.sourceFamily',
          '$.sourceId',
          '$.status'
        ]
      },
      {
        label: 'payout',
        snapshot: payoutSnapshotFixture({
          id: 'po_privacy_fixture',
          balanceTransactionId: 'txn_privacy_payout',
          failureBalanceTransactionId: 'txn_privacy_payout_failure',
          originalPayoutId: 'po_privacy_original',
          reversedByPayoutId: 'po_privacy_reversal'
        }),
        allowedProviderIdPaths: [
          '$.balanceTransactionId',
          '$.failureBalanceTransactionId',
          '$.id',
          '$.originalPayoutId',
          '$.reversedByPayoutId'
        ],
        allowedSnapshotKeyPaths: [
          '$.amountMinor',
          '$.arrivalAt',
          '$.automatic',
          '$.balanceTransactionId',
          '$.createdAt',
          '$.currency',
          '$.failureBalanceTransactionId',
          '$.id',
          '$.livemode',
          '$.method',
          '$.originalPayoutId',
          '$.reconciliationStatus',
          '$.reversedByPayoutId',
          '$.safeFailureCode',
          '$.status'
        ]
      }
    ] as const;

    for (const fixture of fixtures) expectCanonicalSnapshotPrivacySafe(fixture);
  });

  it('keeps every Plan 6B financial column outside the exact forbidden vocabulary', async () => {
    const columns = ((await databaseClient.db.execute(sql`
      select table_name as "tableName", column_name as "columnName"
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (${sql.join(FINANCIAL_TABLES.map((table) => sql`${table}`), sql`, `)})
      order by table_name, ordinal_position
    `)) as { rows?: Array<{ tableName: string; columnName: string }> }).rows ?? [];
    expect(new Set(columns.map((row) => row.tableName))).toEqual(new Set(FINANCIAL_TABLES));
    expect(columns.filter((row) => FORBIDDEN_KEYS.has(normalizedKey(row.columnName))))
      .toEqual([]);
  });

  it('confines provider IDs to linkage, ledger, and canonical job routing while all other evidence is safe', async () => {
    const fixture = await createPrivacyFixture();
    const workerFailure = await runSanitizedFailure(fixture);

    const [order] = await databaseClient.db.select({
      stripeCheckoutSessionId: orders.stripeCheckoutSessionId
    }).from(orders).where(eq(orders.id, fixture.orderId));
    const [payment] = await databaseClient.db.select({
      stripePaymentIntentId: payments.stripePaymentIntentId,
      stripeLatestChargeId: payments.stripeLatestChargeId
    }).from(payments).where(eq(payments.id, fixture.paymentId));
    const [balance] = await databaseClient.db.select({
      providerId: stripeBalanceTransactions.providerId,
      sourceId: stripeBalanceTransactions.sourceId
    }).from(stripeBalanceTransactions).where(eq(
      stripeBalanceTransactions.providerId,
      fixture.provider.balanceTransactionId
    ));
    const [payout] = await databaseClient.db.select({
      providerId: stripePayouts.providerId,
      originalProviderPayoutId: stripePayouts.originalProviderPayoutId,
      reversedByProviderPayoutId: stripePayouts.reversedByProviderPayoutId
    }).from(stripePayouts).where(eq(stripePayouts.providerId, fixture.provider.payoutId));
    const financialJobs = await databaseClient.db.select().from(jobs).where(sql`
      ${jobs.type} in (${FINANCIAL_SOURCE_JOB}, ${FINANCIAL_PAYOUT_JOB}, ${FINANCIAL_SCAN_JOB},
        'commerce.financial-classification')
    `);
    for (const job of financialJobs) {
      expect(() => parseFinancialJobIdentity({
        type: job.type,
        payload: job.payload,
        deduplicationKey: job.deduplicationKey,
        maxAttempts: job.maxAttempts
      })).not.toThrow();
    }
    const sourceJob = financialJobs.find((job) =>
      job.deduplicationKey === fixture.sourceSpec.deduplicationKey)!;
    const payoutJob = financialJobs.find((job) =>
      job.deduplicationKey === fixture.payoutSpec.deduplicationKey)!;
    const allowedProviderLocations: Record<string, unknown> = {
      'orders.stripeCheckoutSessionId': order?.stripeCheckoutSessionId,
      'payments.stripePaymentIntentId': payment?.stripePaymentIntentId,
      'payments.stripeLatestChargeId': payment?.stripeLatestChargeId,
      'stripeBalanceTransactions.providerId': balance?.providerId,
      'stripeBalanceTransactions.sourceId': balance?.sourceId,
      'stripePayouts.providerId': payout?.providerId,
      'stripePayouts.originalProviderPayoutId': payout?.originalProviderPayoutId,
      'stripePayouts.reversedByProviderPayoutId': payout?.reversedByProviderPayoutId,
      'jobs.sourceEvent.payload': sourceJob.payload,
      'jobs.sourceEvent.deduplicationKey': sourceJob.deduplicationKey,
      'jobs.payoutEvent.payload': payoutJob.payload,
      'jobs.payoutEvent.deduplicationKey': payoutJob.deduplicationKey
    };
    expect(labelsContaining(allowedProviderLocations, fixture.provider.checkoutSessionId))
      .toEqual(['orders.stripeCheckoutSessionId']);
    expect(labelsContaining(allowedProviderLocations, fixture.provider.paymentIntentId))
      .toEqual(['payments.stripePaymentIntentId']);
    expect(labelsContaining(allowedProviderLocations, fixture.provider.chargeId)).toEqual([
      'payments.stripeLatestChargeId',
      'stripeBalanceTransactions.sourceId'
    ]);
    expect(labelsContaining(allowedProviderLocations, fixture.provider.balanceTransactionId))
      .toEqual(['stripeBalanceTransactions.providerId']);
    expect(labelsContaining(allowedProviderLocations, fixture.provider.payoutId)).toEqual([
      'jobs.payoutEvent.payload',
      'stripePayouts.providerId'
    ]);
    expect(labelsContaining(allowedProviderLocations, fixture.provider.sourceEventId)).toEqual([
      'jobs.sourceEvent.deduplicationKey',
      'jobs.sourceEvent.payload'
    ]);
    expect(labelsContaining(allowedProviderLocations, fixture.provider.payoutEventId)).toEqual([
      'jobs.payoutEvent.deduplicationKey',
      'jobs.payoutEvent.payload'
    ]);

    const financialAudits = await databaseClient.db.select({
      actorType: auditEvents.actorType,
      actorId: auditEvents.actorId,
      action: auditEvents.action,
      outcome: auditEvents.outcome,
      resourceType: auditEvents.resourceType,
      resourceId: auditEvents.resourceId,
      correlationId: auditEvents.correlationId,
      requestMetadata: auditEvents.requestMetadata,
      before: auditEvents.before,
      after: auditEvents.after
    }).from(auditEvents).where(sql`${auditEvents.action} like 'financial.%'`);
    expect(financialAudits.length).toBeGreaterThan(0);
    expect(financialAudits.every((audit) => audit.requestMetadata === null)).toBe(true);
    const issues = await databaseClient.db.select().from(financialReconciliationIssues);
    expect(issues).toEqual([
      expect.objectContaining({
        resourceType: 'payout',
        safeCode: 'immutable_mismatch',
        state: 'open',
        impact: 'exception'
      })
    ]);
    const safeEvidence = {
      audits: financialAudits.map(({ requestMetadata: _requestMetadata, ...audit }) => audit),
      issues,
      allocations: await databaseClient.db.select().from(financialAllocationSets),
      allocationItems: await databaseClient.db.select().from(financialItemAllocations),
      classifications: await databaseClient.db.select().from(financialClassificationVersions),
      feeDetails: await databaseClient.db.select().from(stripeBalanceTransactionFeeDetails),
      outbox: await databaseClient.db.select().from(outboxMessages),
      workerErrors: { lastError: workerFailure.failedJob.lastError },
      capturedLogs: workerFailure.logs
    };
    expect(workerFailure.failedJob).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'Transient job handler failure'
    });
    expect(workerFailure.logs).toEqual([]);
    expectPrivacySafe(safeEvidence);
    const serializedSafeEvidence = JSON.stringify(safeEvidence);
    for (const privateValue of [
      fixture.privateEmail,
      fixture.privateSecret,
      fixture.provider.checkoutSessionId,
      fixture.provider.paymentIntentId,
      fixture.provider.chargeId,
      fixture.provider.balanceTransactionId,
      fixture.provider.payoutId,
      fixture.provider.sourceEventId,
      fixture.provider.payoutEventId
    ]) {
      expect(serializedSafeEvidence).not.toContain(privateValue);
    }
    expect(await databaseClient.db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'financial.issue.opened'),
      eq(auditEvents.resourceId, issues[0]!.id)
    ))).toHaveLength(1);
  });
});
