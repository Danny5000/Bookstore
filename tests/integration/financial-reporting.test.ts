import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import type {
  FinancialClassification,
  FinancialComponent
} from '$lib/server/commerce/financial/types';
import {
  parseSalesOverviewFilters,
  type SalesOverviewFilters
} from '$lib/server/commerce/reporting/filters';
import { listSalesOverview } from '$lib/server/commerce/reporting/overview';
import {
  SALES_CURRENCY_SUMMARY_DTO_KEYS,
  SOLD_AS_TITLE_VARIANT_DTO_KEYS,
  TITLE_SALES_ROW_DTO_KEYS,
  type TitleFormat
} from '$lib/types/financial-reporting';
import { databaseClient, ownerDatabaseClient } from './database';

const NOW = new Date('2026-08-22T12:00:00.000Z');
const ADMIN: Actor = {
  type: 'user',
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  roles: ['admin']
};
const OVERVIEW_KEYS = [
  'filters',
  'rows',
  'summaries',
  'nextCursor',
  'dataThroughAt',
  'stripeEnabled',
  'missingSourceCount',
  'needsReviewCount'
] as const;
const PUBLIC_FILTER_KEYS = [
  'range',
  'from',
  'to',
  'titleId',
  'format',
  'presentmentCurrency',
  'settlementCurrency',
  'state',
  'sort'
] as const;
const SETTLEMENT_KEYS = [
  'grossSettlementMinor',
  'refundImpactMinor',
  'disputeImpactMinor',
  'processingFeeImpactMinor',
  'refundFeeImpactMinor',
  'disputeFeeImpactMinor',
  'otherFeeImpactMinor',
  'estimatedPayoutMinor'
] as const;

type TitleVisibility = 'private' | 'public' | 'archived';
type FinancialSourceKind = 'payment' | 'refund' | 'dispute';
type ProviderSourceFamily = 'charge' | 'refund' | 'dispute';
type AllocationScope = 'title' | 'account';

interface TitleFixture {
  readonly id: string;
  readonly title: string;
  readonly creatorName: string;
  readonly format: TitleFormat;
  readonly visibility: TitleVisibility;
}

interface PurchaseItemInput {
  readonly title: TitleFixture;
  readonly titleSnapshot: string;
  readonly creatorNameSnapshot: string;
  readonly format: TitleFormat;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
}

interface PurchaseItemFixture extends PurchaseItemInput {
  readonly id: string;
}

interface PurchaseFixture {
  readonly orderId: string;
  readonly paymentId: string;
  readonly chargeProviderId: string;
  readonly paymentIntentProviderId: string;
  readonly buyerId: string;
  readonly buyerEmail: string;
  readonly items: readonly PurchaseItemFixture[];
}

interface AllocationItemInput {
  readonly orderItemId: string;
  readonly component: FinancialComponent;
  readonly effectMinor: number;
}

interface FeeDetailInput {
  readonly rawType: string;
  readonly amountMinor: number;
  readonly classification: FinancialClassification;
}

interface BalanceEvidenceInput {
  readonly sourceKind: FinancialSourceKind;
  readonly sourceInternalId: string;
  readonly sourceFamily: ProviderSourceFamily;
  readonly providerSourceId: string;
  readonly parentClassification: FinancialClassification;
  readonly amountMinor: number;
  readonly feeMinor: number;
  readonly currency: string;
  readonly grossItems: readonly AllocationItemInput[] | null;
  readonly feeItems: readonly AllocationItemInput[] | null;
  readonly grossScope?: AllocationScope;
  readonly feeScope?: AllocationScope;
  readonly grossExpectedEffectMinor?: number;
  readonly feeExpectedEffectMinor?: number;
  readonly grossReversalOfSetId?: string;
  readonly feeReversalOfSetId?: string;
  readonly feeDetails?: readonly FeeDetailInput[];
  readonly exchangeRate?: string;
  readonly exchangeSourceCurrency?: string;
  readonly algorithmVersion?: 1 | 2;
}

interface BalanceEvidenceFixture {
  readonly balanceTransactionId: string;
  readonly grossAllocationSetId: string | null;
  readonly feeAllocationSetId: string | null;
  readonly providerId: string;
}

let sequence = 0;

function token(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}_${randomUUID().replaceAll('-', '')}`;
}

function filters(query = 'range=all'): SalesOverviewFilters {
  return parseSalesOverviewFilters(
    new URL(`https://books.example.test/admin/sales?${query}`),
    NOW
  );
}

function customDayFilters(extra = ''): SalesOverviewFilters {
  const suffix = extra.length === 0 ? '' : `&${extra}`;
  return filters(`range=custom&from=2026-08-01&to=2026-08-01${suffix}`);
}

async function createTitle(
  label: string,
  input: {
    readonly id?: string;
    readonly title?: string;
    readonly creatorName?: string;
    readonly format?: TitleFormat;
    readonly visibility?: TitleVisibility;
  } = {}
): Promise<TitleFixture> {
  const id = input.id ?? randomUUID();
  const slug = `reporting-${sequence + 1}-${randomUUID().replaceAll('-', '')}`;
  const title = input.title ?? `Reporting ${label}`;
  const creatorName = input.creatorName ?? `Creator ${label}`;
  const format = input.format ?? 'prose';
  const visibility = input.visibility ?? 'private';
  const result = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into titles
       (id, slug, title, description, creator_name, format, price_minor, currency, visibility)
     values ($1, $2, $3, 'Reporting fixture', $4, $5, 100, 'USD', $6)
     returning id`,
    [id, slug, title, creatorName, format, visibility]
  );
  return { id: result.rows[0]!.id, title, creatorName, format, visibility };
}

async function createPurchase(
  label: string,
  input: {
    readonly paidAt: Date;
    readonly currency: string;
    readonly items: readonly PurchaseItemInput[];
    readonly financialEvidenceStatus?: 'pending' | 'fee_reconciled' | 'exception';
  }
): Promise<PurchaseFixture> {
  const buyerEmail = `${token(`${label}_buyer`).toLowerCase()}@example.test`;
  const buyer = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into "user" (name, email, email_verified)
     values ($1, $2, true)
     returning id`,
    [`Buyer ${label}`, buyerEmail]
  );
  const buyerId = buyer.rows[0]!.id;
  const subtotalMinor = input.items.reduce((sum, item) => sum + item.subtotalMinor, 0);
  const taxMinor = input.items.reduce((sum, item) => sum + item.taxMinor, 0);
  const order = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into orders
       (status, initiating_user_id, purchase_email, currency, subtotal_minor, tax_minor,
        total_minor, client_checkout_attempt_id, quote_fingerprint_sha256,
        status_token_sha256, paid_at)
     values ('paid', $1, $2, $3, $4, $5, $6, $7, repeat('a', 64), repeat('b', 64), $8)
     returning id`,
    [
      buyerId,
      buyerEmail,
      input.currency,
      subtotalMinor,
      taxMinor,
      subtotalMinor + taxMinor,
      randomUUID(),
      input.paidAt
    ]
  );
  const orderId = order.rows[0]!.id;
  const items: PurchaseItemFixture[] = [];
  for (const [index, item] of input.items.entries()) {
    const stored = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into order_items
         (order_id, title_id, title_snapshot, creator_name_snapshot, format, currency,
          unit_subtotal_minor, tax_minor, total_minor, stripe_line_item_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        orderId,
        item.title.id,
        item.titleSnapshot,
        item.creatorNameSnapshot,
        item.format,
        input.currency,
        item.subtotalMinor,
        item.taxMinor,
        item.subtotalMinor + item.taxMinor,
        token(`${label}_line_${index}`)
      ]
    );
    items.push({ ...item, id: stored.rows[0]!.id });
  }
  const chargeProviderId = token(`${label}_private_charge`);
  const paymentIntentProviderId = token(`${label}_private_intent`);
  const payment = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into payments
       (order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
        amount_minor, currency, payment_method_category, paid_at, financial_evidence_status)
     values ($1, $2, $3, 'succeeded', $4, $5, 'card', $6, $7)
     returning id`,
    [
      orderId,
      paymentIntentProviderId,
      chargeProviderId,
      subtotalMinor + taxMinor,
      input.currency,
      input.paidAt,
      input.financialEvidenceStatus ?? 'pending'
    ]
  );
  return {
    orderId,
    paymentId: payment.rows[0]!.id,
    chargeProviderId,
    paymentIntentProviderId,
    buyerId,
    buyerEmail,
    items
  };
}

async function insertAllocationSet(
  evidence: {
    readonly balanceTransactionId: string;
    readonly sourceKind: FinancialSourceKind;
    readonly sourceInternalId: string;
    readonly currency: string;
    readonly fingerprint: string;
  },
  basis: 'gross_amount' | 'fee',
  expectedEffectMinor: number,
  items: readonly AllocationItemInput[],
  scope: AllocationScope = 'title',
  reversalOfSetId: string | null = null,
  algorithmVersion: 1 | 2 = 2
): Promise<string> {
  const allocation = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into financial_allocation_sets
       (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
         basis, scope, expected_effect_minor, currency, algorithm_version,
         classifier_version, source_fingerprint_sha256, reversal_of_set_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11)
     returning id`,
    [
      token(`reporting_${basis}`),
      evidence.balanceTransactionId,
      evidence.sourceKind,
      evidence.sourceInternalId,
      basis,
      scope,
      expectedEffectMinor,
      evidence.currency,
      algorithmVersion,
      evidence.fingerprint,
      reversalOfSetId
    ]
  );
  const allocationSetId = allocation.rows[0]!.id;
  for (const item of items) {
    await ownerDatabaseClient.pool.query(
      `insert into financial_item_allocations
         (allocation_set_id, order_item_id, component, effect_minor, currency, tie_break_key)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        allocationSetId,
        item.orderItemId,
        item.component,
        item.effectMinor,
        evidence.currency,
        token('reporting_tie')
      ]
    );
  }
  return allocationSetId;
}

async function createBalanceEvidence(
  label: string,
  input: BalanceEvidenceInput
): Promise<BalanceEvidenceFixture> {
  const fingerprint = 'c'.repeat(64);
  const providerId = token(`${label}_private_balance_transaction`);
  const balance = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into stripe_balance_transactions
       (provider_id, live_mode, source_family, source_id, raw_type, reporting_category,
        balance_type, amount_minor, fee_minor, net_minor, currency, status,
        provider_created_at, available_at, exchange_rate, exchange_source_currency,
        exchange_target_currency, fingerprint_sha256)
     values ($1, false, $2, $3, $4, $4, 'payments', $5, $6, $7, $8, 'available',
             '2026-08-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z', $9, $10, $11,
             $12)
     returning id`,
    [
      providerId,
      input.sourceFamily,
      input.providerSourceId,
      input.parentClassification,
      input.amountMinor,
      input.feeMinor,
      input.amountMinor - input.feeMinor,
      input.currency,
      input.exchangeRate ?? null,
      input.exchangeSourceCurrency ?? null,
      input.exchangeRate === undefined ? null : input.currency,
      fingerprint
    ]
  );
  const balanceTransactionId = balance.rows[0]!.id;
  await ownerDatabaseClient.pool.query(
    `insert into financial_classification_versions
       (subject_type, subject_id, classifier_version, classification,
        source_fingerprint_sha256)
     values ('balance_transaction', $1, 1, $2, $3)`,
    [balanceTransactionId, input.parentClassification, fingerprint]
  );
  for (const [ordinal, detail] of (input.feeDetails ?? []).entries()) {
    const detailFingerprint = 'd'.repeat(64);
    const stored = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into stripe_balance_transaction_fee_details
         (balance_transaction_id, ordinal, raw_type, amount_minor, currency,
          fingerprint_sha256)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [
        balanceTransactionId,
        ordinal,
        detail.rawType,
        detail.amountMinor,
        input.currency,
        detailFingerprint
      ]
    );
    await ownerDatabaseClient.pool.query(
      `insert into financial_classification_versions
         (subject_type, subject_id, classifier_version, classification,
          source_fingerprint_sha256)
       values ('fee_detail', $1, 1, $2, $3)`,
      [stored.rows[0]!.id, detail.classification, detailFingerprint]
    );
  }
  const allocationEvidence = {
    balanceTransactionId,
    sourceKind: input.sourceKind,
    sourceInternalId: input.sourceInternalId,
    currency: input.currency,
    fingerprint
  };
  const grossAllocationSetId = input.grossItems === null
    ? null
    : await insertAllocationSet(
        allocationEvidence,
        'gross_amount',
         input.grossExpectedEffectMinor ?? input.amountMinor,
         input.grossItems,
         input.grossScope,
         input.grossReversalOfSetId,
         input.algorithmVersion
      );
  const feeAllocationSetId = input.feeItems === null
    ? null
    : await insertAllocationSet(
        allocationEvidence,
        'fee',
         input.feeExpectedEffectMinor ?? -input.feeMinor,
         input.feeItems,
         input.feeScope,
         input.feeReversalOfSetId,
         input.algorithmVersion
      );
  return {
    balanceTransactionId,
    grossAllocationSetId,
    feeAllocationSetId,
    providerId
  };
}

async function createChargeEvidence(
  label: string,
  purchase: PurchaseFixture,
  input: Omit<
    BalanceEvidenceInput,
    'sourceKind' | 'sourceInternalId' | 'sourceFamily' | 'providerSourceId' |
      'parentClassification'
  >
): Promise<BalanceEvidenceFixture> {
  return createBalanceEvidence(label, {
    ...input,
    sourceKind: 'payment',
    sourceInternalId: purchase.paymentId,
    sourceFamily: 'charge',
    providerSourceId: purchase.chargeProviderId,
    parentClassification: 'charge'
  });
}

async function publishPayoutMembership(
  label: string,
  currency: string,
  balanceTransactionIds: readonly string[]
): Promise<string> {
  const payout = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into stripe_payouts
       (provider_id, live_mode, amount_minor, currency, automatic, method, status,
        reconciliation_status, provider_created_at, arrival_at, retrieved_at,
        financial_generation, fingerprint_sha256)
     values ($1, false, 1, $2, true, 'standard', 'paid', 'completed',
             '2026-08-04T00:00:00.000Z', '2026-08-05T00:00:00.000Z',
             '2026-08-04T01:00:00.000Z', 1, repeat('e', 64))
     returning id`,
    [token(`${label}_private_payout`), currency]
  );
  const payoutId = payout.rows[0]!.id;
  const run = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into payout_import_runs
       (payout_id, generation, state, candidate_count, page_count, safe_outcome,
        completed_at)
     values ($1, 0, 'published', $2, 1, 'published',
             '2026-08-04T02:00:00.000Z')
     returning id`,
    [payoutId, balanceTransactionIds.length]
  );
  const runId = run.rows[0]!.id;
  for (const balanceTransactionId of balanceTransactionIds) {
    await ownerDatabaseClient.pool.query(
      `insert into payout_import_run_entries (run_id, balance_transaction_id)
       values ($1, $2)`,
      [runId, balanceTransactionId]
    );
    await ownerDatabaseClient.pool.query(
      `insert into stripe_payout_balance_transactions
         (payout_id, balance_transaction_id, published_from_run_id)
       values ($1, $2, $3)`,
      [payoutId, balanceTransactionId, runId]
    );
  }
  return payoutId;
}

function expectSettlementNull(value: unknown): void {
  const record = value as Record<string, unknown>;
  for (const key of SETTLEMENT_KEYS) expect(record[key]).toBeNull();
}

async function replaceProjectionAuthorityForTest(
  algorithmVersion: 1 | 2,
  correlationId: string
): Promise<void> {
  await ownerDatabaseClient.pool.query('truncate table financial_projection_versions');
  await ownerDatabaseClient.pool.query(
    `insert into financial_projection_versions
       (singleton, classifier_version, allocation_algorithm_version,
        activation_correlation_id)
     values (true, 1, $1, $2)`,
    [algorithmVersion, correlationId]
  );
}

function allObjectKeys(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(allObjectKeys);
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    ...Object.keys(record),
    ...Object.values(record).flatMap(allObjectKeys)
  ];
}

describe('financial Sales overview reporting', () => {
  it('uses paid-at UTC cohorts, immutable sold-as facts, signed projections, and safe DTOs', async () => {
    const archivedTitle = await createTitle('archived-current', {
      title: 'Current Archived Atlas',
      creatorName: 'Current Creator',
      format: 'comic',
      visibility: 'archived'
    });
    const archivedPurchase = await createPurchase('archived', {
      paidAt: new Date('2026-08-01T00:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title: archivedTitle,
        titleSnapshot: 'Original Atlas',
        creatorNameSnapshot: 'Original Creator',
        format: 'prose',
        subtotalMinor: 1_000,
        taxMinor: 200
      }]
    });
    const archivedItem = archivedPurchase.items[0]!;
    const archivedEvidence = await createChargeEvidence('archived', archivedPurchase, {
      amountMinor: 1_200,
      feeMinor: 60,
      currency: 'USD',
      grossItems: [
        { orderItemId: archivedItem.id, component: 'sale_subtotal', effectMinor: 1_000 },
        { orderItemId: archivedItem.id, component: 'sale_tax', effectMinor: 200 }
      ],
      feeItems: [
        { orderItemId: archivedItem.id, component: 'processing_fee', effectMinor: -50 },
        { orderItemId: archivedItem.id, component: 'provider_fee_tax', effectMinor: -10 }
      ],
      feeDetails: [
        { rawType: 'stripe_fee', amountMinor: 50, classification: 'processing_fee' },
        { rawType: 'tax', amountMinor: 10, classification: 'provider_fee_tax' }
      ]
    });

    const fxTitle = await createTitle('fx', { title: 'Euro Window' });
    const fxPurchase = await createPurchase('fx', {
      paidAt: new Date('2026-08-01T23:59:59.999Z'),
      currency: 'EUR',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title: fxTitle,
        titleSnapshot: 'Euro Window First Edition',
        creatorNameSnapshot: 'FX Creator',
        format: 'prose',
        subtotalMinor: 1_100,
        taxMinor: 200
      }]
    });
    const fxItem = fxPurchase.items[0]!;
    const fxEvidence = await createChargeEvidence('fx', fxPurchase, {
      amountMinor: 1_300,
      feeMinor: 65,
      currency: 'USD',
      exchangeRate: '1.000000000000000000',
      exchangeSourceCurrency: 'EUR',
      grossItems: [
        { orderItemId: fxItem.id, component: 'sale_subtotal', effectMinor: 1_100 },
        { orderItemId: fxItem.id, component: 'sale_tax', effectMinor: 200 }
      ],
      feeItems: [
        { orderItemId: fxItem.id, component: 'processing_fee', effectMinor: -60 },
        { orderItemId: fxItem.id, component: 'provider_fee_tax', effectMinor: -5 }
      ],
      feeDetails: [
        { rawType: 'stripe_fee', amountMinor: 60, classification: 'processing_fee' },
        { rawType: 'tax', amountMinor: 5, classification: 'provider_fee_tax' }
      ]
    });

    const incompleteTitle = await createTitle('incomplete', { title: 'Incomplete Evidence' });
    const incompletePurchase = await createPurchase('incomplete', {
      paidAt: new Date('2026-08-01T12:00:00.000Z'),
      currency: 'USD',
      items: [{
        title: incompleteTitle,
        titleSnapshot: 'Incomplete Evidence',
        creatorNameSnapshot: 'Pending Creator',
        format: 'prose',
        subtotalMinor: 100,
        taxMinor: 0
      }]
    });
    const incompleteItem = incompletePurchase.items[0]!;
    const incompleteEvidence = await createChargeEvidence('incomplete', incompletePurchase, {
      amountMinor: 100,
      feeMinor: 10,
      currency: 'USD',
      grossItems: [
        { orderItemId: incompleteItem.id, component: 'sale_subtotal', effectMinor: 100 }
      ],
      feeItems: null,
      feeDetails: [
        { rawType: 'stripe_fee', amountMinor: 10, classification: 'processing_fee' }
      ]
    });

    const missingTitle = await createTitle('missing-charge', { title: 'Awaiting Charge' });
    const missingPurchase = await createPurchase('missing-charge', {
      paidAt: new Date('2026-08-01T18:00:00.000Z'),
      currency: 'USD',
      items: [{
        title: missingTitle,
        titleSnapshot: 'Awaiting Charge',
        creatorNameSnapshot: 'Pending Creator',
        format: 'prose',
        subtotalMinor: 100,
        taxMinor: 0
      }]
    });

    const outsideTitle = await createTitle('outside-cohort', { title: 'Tomorrow Book' });
    await createPurchase('outside-cohort', {
      paidAt: new Date('2026-08-02T00:00:00.000Z'),
      currency: 'USD',
      items: [{
        title: outsideTitle,
        titleSnapshot: 'Tomorrow Book',
        creatorNameSnapshot: 'Tomorrow Creator',
        format: 'prose',
        subtotalMinor: 9_999,
        taxMinor: 0
      }]
    });

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: true }
    );

    expect(Object.keys(result)).toEqual(OVERVIEW_KEYS);
    expect(Object.keys(result.filters)).toEqual(PUBLIC_FILTER_KEYS);
    expect(result.filters).toEqual({
      range: 'custom',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-02T00:00:00.000Z',
      titleId: null,
      format: null,
      presentmentCurrency: null,
      settlementCurrency: null,
      state: null,
      sort: 'gross_desc'
    });
    expect(result).toMatchObject({
      nextCursor: null,
      dataThroughAt: null,
      stripeEnabled: true,
      missingSourceCount: 2,
      needsReviewCount: 0
    });
    expect(result.rows).toHaveLength(4);
    expect(result.rows.every((row) => Object.keys(row).join('|') === TITLE_SALES_ROW_DTO_KEYS.join('|')))
      .toBe(true);
    expect(result.rows.flatMap((row) => row.soldAsVariants).every(
      (variant) => Object.keys(variant).join('|') === SOLD_AS_TITLE_VARIANT_DTO_KEYS.join('|')
    )).toBe(true);
    expect(result.summaries.every(
      (summary) => Object.keys(summary).join('|') === SALES_CURRENCY_SUMMARY_DTO_KEYS.join('|')
    )).toBe(true);

    const archivedRow = result.rows.find((row) => row.titleId === archivedTitle.id)!;
    expect(archivedRow).toMatchObject({
      currentTitle: 'Current Archived Atlas',
      format: 'comic',
      archived: true,
      soldAsVariants: [{
        title: 'Original Atlas',
        creatorName: 'Original Creator',
        format: 'prose'
      }],
      presentmentCurrency: 'USD',
      settlementCurrency: 'USD',
      soldCopies: 1,
      fullyRefundedCopies: 0,
      netCopies: 1,
      grossPresentmentMinor: 1_000,
      grossSettlementMinor: 1_000,
      processingFeeImpactMinor: -60,
      estimatedPayoutMinor: 940,
      settlementMetricsComplete: true,
      missingSourceCount: 0,
      state: 'fee_reconciled',
      freshnessAt: expect.any(String)
    });
    expect(archivedRow.grossSettlementMinor).not.toBe(1_200);

    const fxRow = result.rows.find((row) => row.titleId === fxTitle.id)!;
    expect(fxRow).toMatchObject({
      presentmentCurrency: 'EUR',
      settlementCurrency: 'USD',
      grossPresentmentMinor: 1_100,
      grossSettlementMinor: 1_100,
      processingFeeImpactMinor: -65,
      estimatedPayoutMinor: 1_035,
      settlementMetricsComplete: true,
      state: 'fee_reconciled'
    });

    const incompleteRow = result.rows.find((row) => row.titleId === incompleteTitle.id)!;
    expectSettlementNull(incompleteRow);
    expect.soft(incompleteRow).toMatchObject({
      presentmentCurrency: 'USD',
      settlementCurrency: 'USD',
      grossPresentmentMinor: 100,
      settlementMetricsComplete: false,
      missingSourceCount: 1,
      state: 'pending'
    });

    const missingRow = result.rows.find((row) => row.titleId === missingTitle.id)!;
    expectSettlementNull(missingRow);
    expect(missingRow).toMatchObject({
      presentmentCurrency: 'USD',
      settlementCurrency: null,
      grossPresentmentMinor: 100,
      settlementMetricsComplete: false,
      missingSourceCount: 1,
      state: 'pending'
    });
    expect(result.rows.some((row) => row.titleId === outsideTitle.id)).toBe(false);

    const usdPair = result.summaries.find((summary) =>
      summary.presentmentCurrency === 'USD' && summary.settlementCurrency === 'USD'
    )!;
    expectSettlementNull(usdPair);
    expect.soft(usdPair).toMatchObject({
      titleCount: 2,
      soldCopies: 2,
      fullyRefundedCopies: 0,
      netCopies: 2,
      grossPresentmentMinor: 1_100,
      settlementMetricsComplete: false,
      missingSourceCount: 1,
      state: 'pending'
    });
    expect.soft(result.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        presentmentCurrency: 'EUR',
        settlementCurrency: 'USD',
        titleCount: 1,
        grossPresentmentMinor: 1_100,
        grossSettlementMinor: 1_100,
        estimatedPayoutMinor: 1_035,
        settlementMetricsComplete: true
      }),
      expect.objectContaining({
        presentmentCurrency: 'USD',
        settlementCurrency: null,
        titleCount: 1,
        grossPresentmentMinor: 100,
        estimatedPayoutMinor: null,
        settlementMetricsComplete: false
      })
    ]));

    const soldAsProse = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters('format=prose'),
      { stripeEnabled: false }
    );
    expect(soldAsProse.filters.format).toBe('prose');
    expect(soldAsProse.rows.some((row) => row.titleId === archivedTitle.id)).toBe(true);

    const serialized = JSON.stringify(result);
    for (const privateValue of [
      archivedPurchase.orderId,
      archivedPurchase.paymentId,
      archivedPurchase.paymentIntentProviderId,
      archivedPurchase.chargeProviderId,
      archivedPurchase.buyerId,
      archivedPurchase.buyerEmail,
      archivedEvidence.balanceTransactionId,
      archivedEvidence.providerId,
      fxEvidence.balanceTransactionId,
      incompleteEvidence.balanceTransactionId,
      missingPurchase.chargeProviderId
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(allObjectKeys(result)).not.toEqual(expect.arrayContaining([
      'orderId',
      'orderItemId',
      'paymentId',
      'purchaseEmail',
      'customerId',
      'providerId',
      'stripeLatestChargeId',
      'balanceTransactionId',
      'sourceFingerprintSha256',
      'taxMinor',
      'privateInput'
    ]));
  });

  it('keeps immutable sold-as variants inside their exact settlement-currency grain', async () => {
    const title = await createTitle('variant-grain', {
      title: 'Current Shared Title',
      creatorName: 'Current Shared Creator'
    });
    const usdPurchase = await createPurchase('variant-grain-usd', {
      paidAt: new Date('2026-08-01T10:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'USD Settlement Edition',
        creatorNameSnapshot: 'USD Edition Creator',
        format: 'prose',
        subtotalMinor: 100,
        taxMinor: 0
      }]
    });
    await createChargeEvidence('variant-grain-usd', usdPurchase, {
      amountMinor: 100,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{
        orderItemId: usdPurchase.items[0]!.id,
        component: 'sale_subtotal',
        effectMinor: 100
      }],
      feeItems: []
    });

    const eurPurchase = await createPurchase('variant-grain-eur', {
      paidAt: new Date('2026-08-01T11:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'EUR Settlement Edition',
        creatorNameSnapshot: 'EUR Edition Creator',
        format: 'comic',
        subtotalMinor: 100,
        taxMinor: 0
      }]
    });
    await createChargeEvidence('variant-grain-eur', eurPurchase, {
      amountMinor: 90,
      feeMinor: 0,
      currency: 'EUR',
      exchangeRate: '0.900000000000000000',
      exchangeSourceCurrency: 'USD',
      grossItems: [{
        orderItemId: eurPurchase.items[0]!.id,
        component: 'sale_subtotal',
        effectMinor: 90
      }],
      feeItems: []
    });

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toHaveLength(2);
    const usdRow = result.rows.find((row) => row.settlementCurrency === 'USD')!;
    const eurRow = result.rows.find((row) => row.settlementCurrency === 'EUR')!;
    expect(usdRow).toMatchObject({
      titleId: title.id,
      presentmentCurrency: 'USD',
      settlementCurrency: 'USD',
      soldCopies: 1,
      grossPresentmentMinor: 100,
      grossSettlementMinor: 100,
      soldAsVariants: [{
        title: 'USD Settlement Edition',
        creatorName: 'USD Edition Creator',
        format: 'prose'
      }]
    });
    expect(eurRow).toMatchObject({
      titleId: title.id,
      presentmentCurrency: 'USD',
      settlementCurrency: 'EUR',
      soldCopies: 1,
      grossPresentmentMinor: 100,
      grossSettlementMinor: 90,
      soldAsVariants: [{
        title: 'EUR Settlement Edition',
        creatorName: 'EUR Edition Creator',
        format: 'comic'
      }]
    });
    expect(JSON.stringify(usdRow)).not.toContain('EUR Settlement Edition');
    expect(JSON.stringify(eurRow)).not.toContain('USD Settlement Edition');
    expect(result.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        presentmentCurrency: 'USD',
        settlementCurrency: 'USD',
        titleCount: 1,
        soldCopies: 1
      }),
      expect.objectContaining({
        presentmentCurrency: 'USD',
        settlementCurrency: 'EUR',
        titleCount: 1,
        soldCopies: 1
      })
    ]));
  });

  it('counts every balance transaction of one source exactly once and requires all payout memberships', async () => {
    const title = await createTitle('multi-balance-source', {
      title: 'Multi Balance Source'
    });
    const purchase = await createPurchase('multi-balance-source', {
      paidAt: new Date('2026-08-01T12:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'Multi Balance Source',
        creatorNameSnapshot: 'Balance Creator',
        format: 'prose',
        subtotalMinor: 200,
        taxMinor: 0
      }]
    });
    const orderItemId = purchase.items[0]!.id;
    const charge = await createChargeEvidence('multi-balance-charge', purchase, {
      amountMinor: 200,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{ orderItemId, component: 'sale_subtotal', effectMinor: 200 }],
      feeItems: []
    });

    const refundProviderId = token('multi_balance_private_refund');
    const refund = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into refunds
         (payment_id, stripe_refund_id, status, amount_minor, currency, provider_created_at,
          allocation_status, financial_evidence_status)
       values ($1, $2, 'succeeded', 100, 'USD', '2026-08-02T00:00:00.000Z',
               'not_applicable', 'fee_reconciled')
       returning id`,
      [purchase.paymentId, refundProviderId]
    );
    const refundId = refund.rows[0]!.id;
    const withdrawal = await createBalanceEvidence('multi-balance-refund', {
      sourceKind: 'refund',
      sourceInternalId: refundId,
      sourceFamily: 'refund',
      providerSourceId: refundProviderId,
      parentClassification: 'refund',
      amountMinor: -100,
      feeMinor: 10,
      currency: 'USD',
      grossItems: [{ orderItemId, component: 'refund_subtotal', effectMinor: -100 }],
      feeItems: [{ orderItemId, component: 'refund_fee', effectMinor: -10 }],
      feeDetails: [{ rawType: 'stripe_fee', amountMinor: 10, classification: 'refund_fee' }]
    });
    const failureReversal = await createBalanceEvidence('multi-balance-reversal', {
      sourceKind: 'refund',
      sourceInternalId: refundId,
      sourceFamily: 'refund',
      providerSourceId: refundProviderId,
      parentClassification: 'refund_failure',
      amountMinor: 100,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{
        orderItemId,
        component: 'refund_failure_reversal',
        effectMinor: 100
      }],
      feeItems: []
    });
    await publishPayoutMembership('multi-balance-partial-payout', 'USD', [
      charge.balanceTransactionId,
      withdrawal.balanceTransactionId
    ]);

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        titleId: title.id,
        grossSettlementMinor: 200,
        refundImpactMinor: 0,
        refundFeeImpactMinor: -10,
        estimatedPayoutMinor: 190,
        settlementMetricsComplete: true,
        missingSourceCount: 0,
        state: 'fee_reconciled'
      })
    ]);
    expect(result.summaries).toEqual([
      expect.objectContaining({
        presentmentCurrency: 'USD',
        settlementCurrency: 'USD',
        grossSettlementMinor: 200,
        refundImpactMinor: 0,
        refundFeeImpactMinor: -10,
        estimatedPayoutMinor: 190,
        settlementMetricsComplete: true,
        state: 'fee_reconciled'
      })
    ]);
    expect(JSON.stringify(result)).not.toContain(failureReversal.balanceTransactionId);
  });

  it('marks a sold title unavailable when a complete payment head has no projection item for it', async () => {
    const allocatedTitle = await createTitle('missing-item-allocated', {
      title: 'Allocated Title'
    });
    const omittedTitle = await createTitle('missing-item-omitted', {
      title: 'Omitted Title'
    });
    const purchase = await createPurchase('missing-projection-item', {
      paidAt: new Date('2026-08-01T12:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [
        {
          title: allocatedTitle,
          titleSnapshot: 'Allocated Title',
          creatorNameSnapshot: 'Projection Creator',
          format: 'prose',
          subtotalMinor: 100,
          taxMinor: 0
        },
        {
          title: omittedTitle,
          titleSnapshot: 'Omitted Title',
          creatorNameSnapshot: 'Projection Creator',
          format: 'prose',
          subtotalMinor: 100,
          taxMinor: 0
        }
      ]
    });
    await createChargeEvidence('missing-projection-item', purchase, {
      amountMinor: 200,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{
        orderItemId: purchase.items[0]!.id,
        component: 'sale_subtotal',
        effectMinor: 200
      }],
      feeItems: []
    });

    const heads = await databaseClient.pool.query<{
      basis: string;
      is_complete: boolean;
    }>(
      `select basis::text, is_complete
       from current_financial_projection_heads
       order by basis`
    );
    expect(heads.rows).toEqual([
      { basis: 'fee', is_complete: true },
      { basis: 'gross_amount', is_complete: true }
    ]);

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toHaveLength(2);
    const allocated = result.rows.find((row) => row.titleId === allocatedTitle.id)!;
    const omitted = result.rows.find((row) => row.titleId === omittedTitle.id)!;
    expect(allocated).toMatchObject({
      grossPresentmentMinor: 100,
      grossSettlementMinor: 200,
      settlementMetricsComplete: true,
      missingSourceCount: 0
    });
    expectSettlementNull(omitted);
    expect(omitted).toMatchObject({
      presentmentCurrency: 'USD',
      settlementCurrency: 'USD',
      grossPresentmentMinor: 100,
      settlementMetricsComplete: false,
      missingSourceCount: 1,
      state: 'pending'
    });
    expect(result.summaries).toEqual([
      expect.objectContaining({
        presentmentCurrency: 'USD',
        settlementCurrency: 'USD',
        titleCount: 2,
        soldCopies: 2,
        grossPresentmentMinor: 200,
        grossSettlementMinor: null,
        settlementMetricsComplete: false,
        missingSourceCount: 1,
        state: 'pending'
      })
    ]);
  });

  it('excludes account-scoped failed-refund principal without hiding its title fee', async () => {
    const title = await createTitle('account-refund', {
      title: 'Account Scoped Refund'
    });
    const purchase = await createPurchase('account-refund', {
      paidAt: new Date('2026-08-01T13:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'Account Scoped Refund',
        creatorNameSnapshot: 'Scope Creator',
        format: 'prose',
        subtotalMinor: 200,
        taxMinor: 0
      }]
    });
    const orderItemId = purchase.items[0]!.id;
    await createChargeEvidence('account-refund-charge', purchase, {
      amountMinor: 200,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{ orderItemId, component: 'sale_subtotal', effectMinor: 200 }],
      feeItems: []
    });

    const refundProviderId = token('account_refund_private_refund');
    const refund = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into refunds
         (payment_id, stripe_refund_id, status, amount_minor, currency, provider_created_at,
          allocation_status, financial_evidence_status)
       values ($1, $2, 'failed', 100, 'USD', '2026-08-02T00:00:00.000Z',
               'not_applicable', 'fee_reconciled')
       returning id`,
      [purchase.paymentId, refundProviderId]
    );
    const refundId = refund.rows[0]!.id;
    const withdrawal = await createBalanceEvidence('account-refund-withdrawal', {
      sourceKind: 'refund',
      sourceInternalId: refundId,
      sourceFamily: 'refund',
      providerSourceId: refundProviderId,
      parentClassification: 'refund',
      amountMinor: -100,
      feeMinor: 10,
      currency: 'USD',
      grossScope: 'account',
      grossItems: [],
      feeItems: [{ orderItemId, component: 'refund_fee', effectMinor: -10 }],
      feeDetails: [{
        rawType: 'stripe_fee',
        amountMinor: 10,
        classification: 'refund_fee'
      }]
    });
    const reversal = await createBalanceEvidence('account-refund-reversal', {
      sourceKind: 'refund',
      sourceInternalId: refundId,
      sourceFamily: 'refund',
      providerSourceId: refundProviderId,
      parentClassification: 'refund_failure',
      amountMinor: 100,
      feeMinor: 0,
      currency: 'USD',
      grossScope: 'account',
      grossItems: [],
      feeItems: []
    });

    const heads = await databaseClient.pool.query<{
      balance_transaction_id: string;
      basis: string;
      scope: string | null;
      is_complete: boolean;
    }>(
      `select balance_transaction_id, basis::text, scope::text, is_complete
       from current_financial_projection_heads
       where balance_transaction_id = any($1::uuid[])`,
      [[withdrawal.balanceTransactionId, reversal.balanceTransactionId]]
    );
    expect(heads.rows).toHaveLength(4);
    expect(heads.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        balance_transaction_id: withdrawal.balanceTransactionId,
        basis: 'gross_amount',
        scope: 'account',
        is_complete: true
      }),
      expect.objectContaining({
        balance_transaction_id: withdrawal.balanceTransactionId,
        basis: 'fee',
        scope: 'title',
        is_complete: true
      }),
      expect.objectContaining({
        balance_transaction_id: reversal.balanceTransactionId,
        basis: 'gross_amount',
        scope: 'account',
        is_complete: true
      })
    ]));

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        titleId: title.id,
        grossSettlementMinor: 200,
        refundImpactMinor: 0,
        refundFeeImpactMinor: -10,
        estimatedPayoutMinor: 190,
        settlementMetricsComplete: true,
        missingSourceCount: 0,
        state: 'fee_reconciled'
      })
    ]);
    expect(result.summaries).toEqual([
      expect.objectContaining({
        grossSettlementMinor: 200,
        refundImpactMinor: 0,
        refundFeeImpactMinor: -10,
        estimatedPayoutMinor: 190,
        settlementMetricsComplete: true,
        missingSourceCount: 0,
        state: 'fee_reconciled'
      })
    ]);
  });

  it('excludes an incomplete account-scoped basis from complete title-scoped effects', async () => {
    const title = await createTitle('incomplete-account-refund', {
      title: 'Incomplete Account Scope'
    });
    const purchase = await createPurchase('incomplete-account-refund', {
      paidAt: new Date('2026-08-01T14:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'Incomplete Account Scope',
        creatorNameSnapshot: 'Mixed Scope Creator',
        format: 'prose',
        subtotalMinor: 100,
        taxMinor: 0
      }]
    });
    const orderItemId = purchase.items[0]!.id;
    await createChargeEvidence('incomplete-account-charge', purchase, {
      amountMinor: 100,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{ orderItemId, component: 'sale_subtotal', effectMinor: 100 }],
      feeItems: []
    });

    const refundProviderId = token('incomplete_account_private_refund');
    const refund = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into refunds
         (payment_id, stripe_refund_id, status, amount_minor, currency, provider_created_at,
          allocation_status, financial_evidence_status)
       values ($1, $2, 'failed', 100, 'USD', '2026-08-02T00:00:00.000Z',
               'not_applicable', 'fee_reconciled')
       returning id`,
      [purchase.paymentId, refundProviderId]
    );
    const evidence = await createBalanceEvidence('incomplete-account-refund', {
      sourceKind: 'refund',
      sourceInternalId: refund.rows[0]!.id,
      sourceFamily: 'refund',
      providerSourceId: refundProviderId,
      parentClassification: 'refund',
      amountMinor: -100,
      feeMinor: 10,
      currency: 'USD',
      grossScope: 'account',
      grossExpectedEffectMinor: -99,
      grossItems: [],
      feeItems: [{ orderItemId, component: 'refund_fee', effectMinor: -10 }],
      feeDetails: [{
        rawType: 'stripe_fee',
        amountMinor: 10,
        classification: 'refund_fee'
      }]
    });

    const heads = await databaseClient.pool.query<{
      basis: string;
      scope: string | null;
      is_complete: boolean;
      missing_source_count: number;
    }>(
      `select basis::text, scope::text, is_complete, missing_source_count
       from current_financial_projection_heads
       where balance_transaction_id = $1
       order by basis`,
      [evidence.balanceTransactionId]
    );
    expect(heads.rows).toEqual([
      {
        basis: 'fee',
        scope: 'title',
        is_complete: true,
        missing_source_count: 0
      },
      {
        basis: 'gross_amount',
        scope: 'account',
        is_complete: false,
        missing_source_count: 1
      }
    ]);

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        titleId: title.id,
        grossSettlementMinor: 100,
        refundImpactMinor: 0,
        refundFeeImpactMinor: -10,
        estimatedPayoutMinor: 90,
        settlementMetricsComplete: true,
        missingSourceCount: 0,
        state: 'fee_reconciled'
      })
    ]);
    expect(result.summaries).toEqual([
      expect.objectContaining({
        grossSettlementMinor: 100,
        refundImpactMinor: 0,
        refundFeeImpactMinor: -10,
        estimatedPayoutMinor: 90,
        settlementMetricsComplete: true,
        missingSourceCount: 0,
        state: 'fee_reconciled'
      })
    ]);
  });

  it('retains a paid item as unavailable when its Charge heads are account-scoped', async () => {
    const title = await createTitle('account-charge', {
      title: 'Account Scoped Charge'
    });
    const purchase = await createPurchase('account-charge', {
      paidAt: new Date('2026-08-01T14:30:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'Account Scoped Charge',
        creatorNameSnapshot: 'Charge Scope Creator',
        format: 'prose',
        subtotalMinor: 100,
        taxMinor: 0
      }]
    });
    const evidence = await createChargeEvidence('account-charge', purchase, {
      amountMinor: 100,
      feeMinor: 0,
      currency: 'USD',
      grossScope: 'account',
      feeScope: 'account',
      grossItems: [],
      feeItems: []
    });
    const heads = await databaseClient.pool.query<{
      basis: string;
      scope: string | null;
      is_complete: boolean;
    }>(
      `select basis::text, scope::text, is_complete
       from current_financial_projection_heads
       where balance_transaction_id = $1
       order by basis`,
      [evidence.balanceTransactionId]
    );
    expect(heads.rows).toEqual([
      { basis: 'fee', scope: 'account', is_complete: true },
      { basis: 'gross_amount', scope: 'account', is_complete: true }
    ]);

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toHaveLength(1);
    expectSettlementNull(result.rows[0]);
    expect(result.rows[0]).toMatchObject({
      titleId: title.id,
      presentmentCurrency: 'USD',
      settlementCurrency: null,
      grossPresentmentMinor: 100,
      settlementMetricsComplete: false,
      missingSourceCount: 1,
      state: 'exception'
    });
    expect(result.summaries).toEqual([
      expect.objectContaining({
        presentmentCurrency: 'USD',
        settlementCurrency: null,
        grossPresentmentMinor: 100,
        grossSettlementMinor: null,
        settlementMetricsComplete: false,
        missingSourceCount: 1,
        state: 'exception'
      })
    ]);
    expect(result.missingSourceCount).toBe(1);
  });

  it('rejects a Charge with account-scoped gross and title-scoped fee evidence', async () => {
    const title = await createTitle('mixed-charge-scope', {
      title: 'Mixed Charge Scope'
    });
    const purchase = await createPurchase('mixed-charge-scope', {
      paidAt: new Date('2026-08-01T14:35:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'Mixed Charge Scope',
        creatorNameSnapshot: 'Mixed Charge Creator',
        format: 'prose',
        subtotalMinor: 100,
        taxMinor: 0
      }]
    });
    const evidence = await createChargeEvidence('mixed-charge-scope', purchase, {
      amountMinor: 100,
      feeMinor: 10,
      currency: 'USD',
      grossScope: 'account',
      grossItems: [],
      feeItems: [{
        orderItemId: purchase.items[0]!.id,
        component: 'processing_fee',
        effectMinor: -10
      }],
      feeDetails: [{
        rawType: 'stripe_fee',
        amountMinor: 10,
        classification: 'processing_fee'
      }]
    });
    const heads = await databaseClient.pool.query<{
      basis: string;
      scope: string | null;
      is_complete: boolean;
    }>(
      `select basis::text, scope::text, is_complete
       from current_financial_projection_heads
       where balance_transaction_id = $1
       order by basis`,
      [evidence.balanceTransactionId]
    );
    expect(heads.rows).toEqual([
      { basis: 'fee', scope: 'title', is_complete: true },
      { basis: 'gross_amount', scope: 'account', is_complete: true }
    ]);

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toHaveLength(1);
    expectSettlementNull(result.rows[0]);
    expect(result.rows[0]).toMatchObject({
      titleId: title.id,
      presentmentCurrency: 'USD',
      settlementCurrency: 'USD',
      grossPresentmentMinor: 100,
      settlementMetricsComplete: false,
      missingSourceCount: 1,
      state: 'exception'
    });
    expect(result.summaries).toEqual([
      expect.objectContaining({
        presentmentCurrency: 'USD',
        settlementCurrency: 'USD',
        grossSettlementMinor: null,
        settlementMetricsComplete: false,
        missingSourceCount: 1,
        state: 'exception'
      })
    ]);
  });

  it('rejects a Charge with title-scoped gross and account-scoped fee evidence', async () => {
    const title = await createTitle('mixed-charge-fee-scope', {
      title: 'Mixed Charge Fee Scope'
    });
    const purchase = await createPurchase('mixed-charge-fee-scope', {
      paidAt: new Date('2026-08-01T14:37:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'Mixed Charge Fee Scope',
        creatorNameSnapshot: 'Mixed Fee Creator',
        format: 'prose',
        subtotalMinor: 100,
        taxMinor: 0
      }]
    });
    const evidence = await createChargeEvidence('mixed-charge-fee-scope', purchase, {
      amountMinor: 100,
      feeMinor: 10,
      currency: 'USD',
      grossItems: [{
        orderItemId: purchase.items[0]!.id,
        component: 'sale_subtotal',
        effectMinor: 100
      }],
      feeScope: 'account',
      feeItems: [],
      feeDetails: [{
        rawType: 'stripe_fee',
        amountMinor: 10,
        classification: 'processing_fee'
      }]
    });
    const heads = await databaseClient.pool.query<{
      basis: string;
      scope: string | null;
      is_complete: boolean;
    }>(
      `select basis::text, scope::text, is_complete
       from current_financial_projection_heads
       where balance_transaction_id = $1
       order by basis`,
      [evidence.balanceTransactionId]
    );
    expect(heads.rows).toEqual([
      { basis: 'fee', scope: 'account', is_complete: true },
      { basis: 'gross_amount', scope: 'title', is_complete: true }
    ]);

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toHaveLength(1);
    expectSettlementNull(result.rows[0]);
    expect(result.rows[0]).toMatchObject({
      titleId: title.id,
      presentmentCurrency: 'USD',
      settlementCurrency: 'USD',
      grossPresentmentMinor: 100,
      settlementMetricsComplete: false,
      missingSourceCount: 1,
      state: 'exception'
    });
    expect(result.summaries).toEqual([
      expect.objectContaining({
        presentmentCurrency: 'USD',
        settlementCurrency: 'USD',
        grossSettlementMinor: null,
        settlementMetricsComplete: false,
        missingSourceCount: 1,
        state: 'exception'
      })
    ]);
    expect(result.missingSourceCount).toBe(1);
  });

  it('fans out a refund with no balance transaction as pending title evidence', async () => {
    const title = await createTitle('missing-refund-balance', {
      title: 'Missing Refund Balance'
    });
    const purchase = await createPurchase('missing-refund-balance', {
      paidAt: new Date('2026-08-01T14:40:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'Missing Refund Balance',
        creatorNameSnapshot: 'Refund Evidence Creator',
        format: 'prose',
        subtotalMinor: 100,
        taxMinor: 0
      }]
    });
    await createChargeEvidence('missing-refund-balance-charge', purchase, {
      amountMinor: 100,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{
        orderItemId: purchase.items[0]!.id,
        component: 'sale_subtotal',
        effectMinor: 100
      }],
      feeItems: []
    });
    const refundProviderId = token('missing_refund_private_refund');
    const refund = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into refunds
         (payment_id, stripe_refund_id, status, amount_minor, currency, provider_created_at,
          allocation_status, financial_evidence_status)
       values ($1, $2, 'succeeded', 50, 'USD', '2026-08-02T00:00:00.000Z',
               'not_applicable', 'pending')
       returning id`,
      [purchase.paymentId, refundProviderId]
    );
    const balanceCount = await databaseClient.pool.query<{ count: number }>(
      `select count(*)::int as count
       from stripe_balance_transactions
       where source_family = 'refund' and source_id = $1`,
      [refundProviderId]
    );
    expect(balanceCount.rows).toEqual([{ count: 0 }]);

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toHaveLength(1);
    expectSettlementNull(result.rows[0]);
    expect(result.rows[0]).toMatchObject({
      titleId: title.id,
      presentmentCurrency: 'USD',
      settlementCurrency: null,
      grossPresentmentMinor: 100,
      settlementMetricsComplete: false,
      missingSourceCount: 1,
      state: 'pending'
    });
    expect(result.summaries).toEqual([
      expect.objectContaining({
        presentmentCurrency: 'USD',
        settlementCurrency: null,
        grossPresentmentMinor: 100,
        grossSettlementMinor: null,
        settlementMetricsComplete: false,
        missingSourceCount: 1,
        state: 'pending'
      })
    ]);
    expect(result.missingSourceCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(refund.rows[0]!.id);
    expect(JSON.stringify(result)).not.toContain(refundProviderId);
  });

  it('rejects conserving Charge effects assigned to the wrong projection bases', async () => {
    const title = await createTitle('wrong-charge-basis', {
      title: 'Wrong Charge Basis'
    });
    const purchase = await createPurchase('wrong-charge-basis', {
      paidAt: new Date('2026-08-01T14:45:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'Wrong Charge Basis',
        creatorNameSnapshot: 'Basis Creator',
        format: 'prose',
        subtotalMinor: 100,
        taxMinor: 0
      }]
    });
    const evidence = await createChargeEvidence('wrong-charge-basis', purchase, {
      amountMinor: 100,
      feeMinor: 10,
      currency: 'USD',
      grossItems: [{
        orderItemId: purchase.items[0]!.id,
        component: 'processing_fee',
        effectMinor: 100
      }],
      feeItems: [{
        orderItemId: purchase.items[0]!.id,
        component: 'sale_subtotal',
        effectMinor: -10
      }],
      feeDetails: [{
        rawType: 'stripe_fee',
        amountMinor: 10,
        classification: 'processing_fee'
      }]
    });
    const heads = await databaseClient.pool.query<{
      basis: string;
      is_complete: boolean;
    }>(
      `select basis::text, is_complete
       from current_financial_projection_heads
       where balance_transaction_id = $1
       order by basis`,
      [evidence.balanceTransactionId]
    );
    expect(heads.rows).toEqual([
      { basis: 'fee', is_complete: true },
      { basis: 'gross_amount', is_complete: true }
    ]);

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toHaveLength(1);
    expectSettlementNull(result.rows[0]);
    expect(result.rows[0]).toMatchObject({
      titleId: title.id,
      presentmentCurrency: 'USD',
      settlementCurrency: 'USD',
      grossPresentmentMinor: 100,
      settlementMetricsComplete: false,
      missingSourceCount: 2,
      state: 'exception'
    });
    expect(result.summaries).toEqual([
      expect.objectContaining({
        grossPresentmentMinor: 100,
        grossSettlementMinor: null,
        settlementMetricsComplete: false,
        missingSourceCount: 2,
        state: 'exception'
      })
    ]);
    expect(result.missingSourceCount).toBe(2);
  });

  it('marks a sold title unavailable when its nonzero Charge fee item is missing', async () => {
    const allocatedTitle = await createTitle('missing-fee-allocated', {
      title: 'Fee Allocated Title'
    });
    const omittedTitle = await createTitle('missing-fee-omitted', {
      title: 'Fee Omitted Title'
    });
    const purchase = await createPurchase('missing-fee-item', {
      paidAt: new Date('2026-08-01T15:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [
        {
          title: allocatedTitle,
          titleSnapshot: 'Fee Allocated Title',
          creatorNameSnapshot: 'Fee Creator',
          format: 'prose',
          subtotalMinor: 100,
          taxMinor: 0
        },
        {
          title: omittedTitle,
          titleSnapshot: 'Fee Omitted Title',
          creatorNameSnapshot: 'Fee Creator',
          format: 'prose',
          subtotalMinor: 100,
          taxMinor: 0
        }
      ]
    });
    await createChargeEvidence('missing-fee-item', purchase, {
      amountMinor: 200,
      feeMinor: 10,
      currency: 'USD',
      grossItems: [
        {
          orderItemId: purchase.items[0]!.id,
          component: 'sale_subtotal',
          effectMinor: 100
        },
        {
          orderItemId: purchase.items[1]!.id,
          component: 'sale_subtotal',
          effectMinor: 100
        }
      ],
      feeItems: [{
        orderItemId: purchase.items[0]!.id,
        component: 'processing_fee',
        effectMinor: -10
      }],
      feeDetails: [{
        rawType: 'stripe_fee',
        amountMinor: 10,
        classification: 'processing_fee'
      }]
    });

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toHaveLength(2);
    const allocated = result.rows.find((row) => row.titleId === allocatedTitle.id)!;
    const omitted = result.rows.find((row) => row.titleId === omittedTitle.id)!;
    expect(allocated).toMatchObject({
      grossSettlementMinor: 100,
      processingFeeImpactMinor: -10,
      estimatedPayoutMinor: 90,
      settlementMetricsComplete: true,
      missingSourceCount: 0
    });
    expectSettlementNull(omitted);
    expect(omitted).toMatchObject({
      grossPresentmentMinor: 100,
      settlementCurrency: 'USD',
      settlementMetricsComplete: false,
      missingSourceCount: 1,
      state: 'pending'
    });
    expect(result.summaries).toEqual([
      expect.objectContaining({
        titleCount: 2,
        grossPresentmentMinor: 200,
        grossSettlementMinor: null,
        settlementMetricsComplete: false,
        missingSourceCount: 1,
        state: 'pending'
      })
    ]);
  });

  it('uses a compatible correction tip for settlement without rewriting finalized copy rules', async () => {
    const firstTitle = await createTitle('correction-first', { title: 'Correction First' });
    const secondTitle = await createTitle('correction-second', { title: 'Correction Second' });
    const purchase = await createPurchase('correction', {
      paidAt: new Date('2026-08-01T12:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [
        {
          title: firstTitle,
          titleSnapshot: 'Correction First Sold As',
          creatorNameSnapshot: 'Correction Creator',
          format: 'prose',
          subtotalMinor: 100,
          taxMinor: 0
        },
        {
          title: secondTitle,
          titleSnapshot: 'Correction Second Sold As',
          creatorNameSnapshot: 'Correction Creator',
          format: 'prose',
          subtotalMinor: 100,
          taxMinor: 0
        }
      ]
    });
    const [firstItem, secondItem] = purchase.items;
    await createChargeEvidence('correction-charge', purchase, {
      amountMinor: 200,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [
        { orderItemId: firstItem!.id, component: 'sale_subtotal', effectMinor: 100 },
        { orderItemId: secondItem!.id, component: 'sale_subtotal', effectMinor: 100 }
      ],
      feeItems: []
    });

    const refundProviderId = token('correction_private_refund');
    const refund = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into refunds
         (payment_id, stripe_refund_id, status, amount_minor, currency, provider_created_at,
          allocation_status, financial_evidence_status)
       values ($1, $2, 'succeeded', 100, 'USD', '2026-08-02T00:00:00.000Z',
               'finalized', 'fee_reconciled')
       returning id`,
      [purchase.paymentId, refundProviderId]
    );
    const refundId = refund.rows[0]!.id;
    const refundAllocation = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
       values ($1, $2, 100, 'administrative')
       returning id`,
      [refundId, firstItem!.id]
    );
    await ownerDatabaseClient.pool.query(
      `insert into refund_allocation_components
         (refund_allocation_id, refund_id, order_item_id, subtotal_minor, tax_minor,
          total_minor, currency)
       values ($1, $2, $3, 100, 0, 100, 'USD')`,
      [refundAllocation.rows[0]!.id, refundId, firstItem!.id]
    );
    const refundEvidence = await createBalanceEvidence('correction-refund', {
      sourceKind: 'refund',
      sourceInternalId: refundId,
      sourceFamily: 'refund',
      providerSourceId: refundProviderId,
      parentClassification: 'refund',
      amountMinor: -100,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [
        { orderItemId: firstItem!.id, component: 'refund_subtotal', effectMinor: -100 }
      ],
      feeItems: []
    });
    const correction = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into refund_reporting_correction_sets
         (refund_id, correction_version, kind, base_allocation_set_id,
          source_fingerprint_sha256, approved_by_admin_id, created_by_admin_id,
          correlation_id)
       values ($1, 1, 'allocation_attribution_correction', $2, repeat('c', 64),
               $3, $3, $4)
       returning id`,
      [
        refundId,
        refundEvidence.grossAllocationSetId,
        purchase.buyerId,
        token('correction_correlation')
      ]
    );
    for (const item of [
      { orderItemId: firstItem!.id, approvedMinor: 0, deltaMinor: 100 },
      { orderItemId: secondItem!.id, approvedMinor: -100, deltaMinor: -100 }
    ]) {
      await ownerDatabaseClient.pool.query(
        `insert into refund_reporting_correction_items
           (correction_set_id, domain, source_allocation_set_id, order_item_id,
            component, currency, approved_absolute_minor, delta_minor,
            stable_tie_break_key)
         values ($1, 'settlement', $2, $3, 'refund_subtotal', 'USD', $4, $5, $6)`,
        [
          correction.rows[0]!.id,
          refundEvidence.grossAllocationSetId,
          item.orderItemId,
          item.approvedMinor,
          item.deltaMinor,
          token('correction_tie')
        ]
      );
    }

    const projection = await databaseClient.pool.query<{
      compatible_correction_tip_id: string | null;
      is_complete: boolean;
    }>(
      `select compatible_correction_tip_id, is_complete
       from current_financial_projection_heads
       where balance_transaction_id = $1 and basis = 'gross_amount'`,
      [refundEvidence.balanceTransactionId]
    );
    expect(projection.rows).toEqual([{
      compatible_correction_tip_id: correction.rows[0]!.id,
      is_complete: true
    }]);

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    const firstRow = result.rows.find((row) => row.titleId === firstTitle.id)!;
    const secondRow = result.rows.find((row) => row.titleId === secondTitle.id)!;
    expect(firstRow).toMatchObject({
      soldCopies: 1,
      fullyRefundedCopies: 1,
      netCopies: 0,
      grossPresentmentMinor: 100,
      finalizedRefundPresentmentMinor: 100,
      grossSettlementMinor: 100,
      refundImpactMinor: 0,
      estimatedPayoutMinor: 100,
      settlementMetricsComplete: true
    });
    expect(secondRow).toMatchObject({
      soldCopies: 1,
      fullyRefundedCopies: 0,
      netCopies: 1,
      grossPresentmentMinor: 100,
      finalizedRefundPresentmentMinor: 0,
      grossSettlementMinor: 100,
      refundImpactMinor: -100,
      estimatedPayoutMinor: 0,
      settlementMetricsComplete: true
    });
    expect(result.summaries).toEqual([
      expect.objectContaining({
        presentmentCurrency: 'USD',
        settlementCurrency: 'USD',
        titleCount: 2,
        soldCopies: 2,
        fullyRefundedCopies: 1,
        netCopies: 1,
        grossPresentmentMinor: 200,
        finalizedRefundPresentmentMinor: 100,
        grossSettlementMinor: 200,
        refundImpactMinor: -100,
        estimatedPayoutMinor: 100,
        settlementMetricsComplete: true
      })
    ]);
    expect(JSON.stringify(result)).not.toContain(refundProviderId);
    expect(JSON.stringify(result)).not.toContain(refundEvidence.balanceTransactionId);
  });

  it('uses only the current dispute allocation tip for presentment effects', async () => {
    const title = await createTitle('dispute-history', {
      title: 'Current Dispute History'
    });
    const purchase = await createPurchase('dispute-history', {
      paidAt: new Date('2026-08-01T17:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'Current Dispute History',
        creatorNameSnapshot: 'Replay Creator',
        format: 'prose',
        subtotalMinor: 200,
        taxMinor: 0
      }]
    });
    const orderItemId = purchase.items[0]!.id;
    await createChargeEvidence('dispute-history-charge', purchase, {
      amountMinor: 200,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{ orderItemId, component: 'sale_subtotal', effectMinor: 200 }],
      feeItems: []
    });

    const disputeProviderId = token('dispute_history_private_dispute');
    const dispute = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into disputes
         (payment_id, stripe_dispute_id, status, amount_minor, currency, reason,
          provider_created_at, provider_updated_at, financial_evidence_status)
       values ($1, $2, 'open', 100, 'USD', 'fraudulent',
               '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
               'fee_reconciled')
       returning id`,
      [purchase.paymentId, disputeProviderId]
    );
    const disputeId = dispute.rows[0]!.id;
    const evidence = await createBalanceEvidence('dispute-history', {
      sourceKind: 'dispute',
      sourceInternalId: disputeId,
      sourceFamily: 'dispute',
      providerSourceId: disputeProviderId,
      parentClassification: 'dispute_withdrawal',
      amountMinor: -100,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{
        orderItemId,
        component: 'dispute_subtotal',
        effectMinor: -100
      }],
      feeItems: []
    });
    const historicalGrossSetId = evidence.grossAllocationSetId!;
    const historicalPresentment = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into dispute_item_allocations
         (allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
          effect, subtotal_effect_minor, tax_effect_minor, total_effect_minor, currency)
       values ($1, $2, $3, $4, 'withdrawal', -100, 0, -100, 'USD')
       returning id`,
      [token('dispute_history_presentment_old'), disputeId, historicalGrossSetId, orderItemId]
    );
    const currentGross = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into financial_allocation_sets
         (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
          basis, scope, expected_effect_minor, currency, algorithm_version,
          classifier_version, source_fingerprint_sha256, supersedes_set_id)
       values ($1, $2, 'dispute', $3, 'gross_amount', 'title', -100, 'USD', 2, 1,
               repeat('c', 64), $4)
       returning id`,
      [
        token('dispute_history_current_gross'),
        evidence.balanceTransactionId,
        disputeId,
        historicalGrossSetId
      ]
    );
    const currentGrossSetId = currentGross.rows[0]!.id;
    await ownerDatabaseClient.pool.query(
      `insert into financial_item_allocations
         (allocation_set_id, order_item_id, component, effect_minor, currency,
          tie_break_key)
       values ($1, $2, 'dispute_subtotal', -100, 'USD', $3)`,
      [currentGrossSetId, orderItemId, token('dispute_history_current_tie')]
    );
    await ownerDatabaseClient.pool.query(
      `insert into dispute_item_allocations
         (allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
          effect, subtotal_effect_minor, tax_effect_minor, total_effect_minor, currency)
       values ($1, $2, $3, $4, 'withdrawal', -100, 0, -100, 'USD')`,
      [token('dispute_history_presentment_current'), disputeId, currentGrossSetId, orderItemId]
    );

    const history = await databaseClient.pool.query<{
      id: string;
      gross_allocation_set_id: string;
    }>(
      `select id, gross_allocation_set_id
       from dispute_item_allocations
       where dispute_id = $1
       order by created_at, id`,
      [disputeId]
    );
    expect(history.rows).toHaveLength(2);
    expect(history.rows).toEqual(expect.arrayContaining([
      {
        id: historicalPresentment.rows[0]!.id,
        gross_allocation_set_id: historicalGrossSetId
      },
      expect.objectContaining({ gross_allocation_set_id: currentGrossSetId })
    ]));
    const currentHead = await databaseClient.pool.query<{
      base_set_id: string | null;
      is_complete: boolean;
    }>(
      `select base_set_id, is_complete
       from current_financial_projection_heads
       where balance_transaction_id = $1 and basis = 'gross_amount'`,
      [evidence.balanceTransactionId]
    );
    expect(currentHead.rows).toEqual([{
      base_set_id: currentGrossSetId,
      is_complete: true
    }]);

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        titleId: title.id,
        grossPresentmentMinor: 200,
        disputeWithdrawalPresentmentMinor: 100,
        grossSettlementMinor: 200,
        disputeImpactMinor: -100,
        estimatedPayoutMinor: 100,
        settlementMetricsComplete: true,
        missingSourceCount: 0,
        state: 'fee_reconciled'
      })
    ]);
    expect(result.summaries).toEqual([
      expect.objectContaining({
        disputeWithdrawalPresentmentMinor: 100,
        grossSettlementMinor: 200,
        disputeImpactMinor: -100,
        estimatedPayoutMinor: 100,
        settlementMetricsComplete: true
      })
    ]);
    expect(JSON.stringify(result)).not.toContain(disputeProviderId);
  });

  it('preserves current dispute presentment when its settlement tip is quarantined', async () => {
    const title = await createTitle('dispute-quarantine', {
      title: 'Quarantined Dispute'
    });
    const purchase = await createPurchase('dispute-quarantine', {
      paidAt: new Date('2026-08-01T17:30:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'Quarantined Dispute',
        creatorNameSnapshot: 'Quarantine Creator',
        format: 'prose',
        subtotalMinor: 200,
        taxMinor: 0
      }]
    });
    const orderItemId = purchase.items[0]!.id;
    await createChargeEvidence('dispute-quarantine-charge', purchase, {
      amountMinor: 200,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{ orderItemId, component: 'sale_subtotal', effectMinor: 200 }],
      feeItems: []
    });

    const disputeProviderId = token('dispute_quarantine_private_dispute');
    const dispute = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into disputes
         (payment_id, stripe_dispute_id, status, amount_minor, currency, reason,
          provider_created_at, provider_updated_at, financial_evidence_status)
       values ($1, $2, 'open', 100, 'USD', 'fraudulent',
               '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
               'fee_reconciled')
       returning id`,
      [purchase.paymentId, disputeProviderId]
    );
    const disputeId = dispute.rows[0]!.id;
    const evidence = await createBalanceEvidence('dispute-quarantine', {
      sourceKind: 'dispute',
      sourceInternalId: disputeId,
      sourceFamily: 'dispute',
      providerSourceId: disputeProviderId,
      parentClassification: 'dispute_withdrawal',
      amountMinor: -100,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{
        orderItemId,
        component: 'dispute_subtotal',
        effectMinor: -100
      }],
      feeItems: []
    });
    const grossSetId = evidence.grossAllocationSetId!;
    await ownerDatabaseClient.pool.query(
      `insert into dispute_item_allocations
         (allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
          effect, subtotal_effect_minor, tax_effect_minor, total_effect_minor, currency)
       values ($1, $2, $3, $4, 'withdrawal', -100, 0, -100, 'USD')`,
      [token('dispute_quarantine_presentment'), disputeId, grossSetId, orderItemId]
    );
    const activeTips = await databaseClient.pool.query<{ count: number }>(
      `select count(*)::int as count
       from financial_allocation_sets allocation
       where allocation.balance_transaction_id = $1
         and allocation.basis = 'gross_amount'
         and not exists (
           select 1 from financial_allocation_sets successor
           where successor.supersedes_set_id = allocation.id
             and successor.classifier_version = allocation.classifier_version
             and successor.algorithm_version = allocation.algorithm_version
         )`,
      [evidence.balanceTransactionId]
    );
    expect(activeTips.rows).toEqual([{ count: 1 }]);
    await ownerDatabaseClient.pool.query(
      `insert into financial_reconciliation_issues
         (resource_type, resource_id, safe_code, impact, correlation_id)
       values ('allocation_set', $1, 'allocation_mismatch', 'exception', $2)`,
      [grossSetId, token('dispute_quarantine_issue')]
    );
    const head = await databaseClient.pool.query<{
      base_set_id: string | null;
      is_complete: boolean;
      proposed_issue_code: string | null;
    }>(
      `select base_set_id, is_complete, proposed_issue_code
       from current_financial_projection_heads
       where balance_transaction_id = $1 and basis = 'gross_amount'`,
      [evidence.balanceTransactionId]
    );
    expect(head.rows).toEqual([{
      base_set_id: null,
      is_complete: false,
      proposed_issue_code: 'allocation_mismatch'
    }]);

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toHaveLength(1);
    expectSettlementNull(result.rows[0]);
    expect(result.rows[0]).toMatchObject({
      titleId: title.id,
      presentmentCurrency: 'USD',
      settlementCurrency: 'USD',
      grossPresentmentMinor: 200,
      disputeWithdrawalPresentmentMinor: 100,
      settlementMetricsComplete: false,
      missingSourceCount: 1,
      state: 'exception'
    });
    expect(result.summaries).toEqual([
      expect.objectContaining({
        disputeWithdrawalPresentmentMinor: 100,
        grossSettlementMinor: null,
        settlementMetricsComplete: false,
        missingSourceCount: 1,
        state: 'exception'
      })
    ]);
    expect(JSON.stringify(result)).not.toContain(disputeProviderId);
    expect(JSON.stringify(result)).not.toContain(evidence.balanceTransactionId);
  });

  it('excludes customer tax from a full dispute withdrawal and reinstatement', async () => {
    const title = await createTitle('taxed-dispute-cycle', {
      title: 'Taxed Dispute Cycle'
    });
    const purchase = await createPurchase('taxed-dispute-cycle', {
      paidAt: new Date('2026-08-01T17:45:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'Taxed Dispute Cycle',
        creatorNameSnapshot: 'Tax Cycle Creator',
        format: 'prose',
        subtotalMinor: 100,
        taxMinor: 10
      }]
    });
    const orderItemId = purchase.items[0]!.id;
    await createChargeEvidence('taxed-dispute-charge', purchase, {
      amountMinor: 110,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [
        { orderItemId, component: 'sale_subtotal', effectMinor: 100 },
        { orderItemId, component: 'sale_tax', effectMinor: 10 }
      ],
      feeItems: []
    });

    const disputeProviderId = token('taxed_dispute_private_dispute');
    const dispute = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into disputes
         (payment_id, stripe_dispute_id, status, amount_minor, currency, reason,
          provider_created_at, provider_updated_at, financial_evidence_status)
       values ($1, $2, 'won', 110, 'USD', 'fraudulent',
               '2026-08-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z',
               'fee_reconciled')
       returning id`,
      [purchase.paymentId, disputeProviderId]
    );
    const disputeId = dispute.rows[0]!.id;
    const withdrawal = await createBalanceEvidence('taxed-dispute-withdrawal', {
      sourceKind: 'dispute',
      sourceInternalId: disputeId,
      sourceFamily: 'dispute',
      providerSourceId: disputeProviderId,
      parentClassification: 'dispute_withdrawal',
      amountMinor: -110,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [
        { orderItemId, component: 'dispute_subtotal', effectMinor: -100 },
        { orderItemId, component: 'dispute_tax', effectMinor: -10 }
      ],
      feeItems: []
    });
    const withdrawalPresentment = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into dispute_item_allocations
         (allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
          effect, subtotal_effect_minor, tax_effect_minor, total_effect_minor, currency)
       values ($1, $2, $3, $4, 'withdrawal', -100, -10, -110, 'USD')
       returning id`,
      [
        token('taxed_dispute_presentment_withdrawal'),
        disputeId,
        withdrawal.grossAllocationSetId,
        orderItemId
      ]
    );
    const reinstatement = await createBalanceEvidence('taxed-dispute-reinstatement', {
      sourceKind: 'dispute',
      sourceInternalId: disputeId,
      sourceFamily: 'dispute',
      providerSourceId: disputeProviderId,
      parentClassification: 'dispute_reinstatement',
      amountMinor: 110,
      feeMinor: 0,
      currency: 'USD',
      grossReversalOfSetId: withdrawal.grossAllocationSetId!,
      grossItems: [
        {
          orderItemId,
          component: 'dispute_reinstatement',
          effectMinor: 100
        },
        { orderItemId, component: 'dispute_tax', effectMinor: 10 }
      ],
      feeItems: []
    });
    await ownerDatabaseClient.pool.query(
      `insert into dispute_item_allocations
         (allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
          effect, reverses_allocation_id, subtotal_effect_minor, tax_effect_minor,
          total_effect_minor, currency)
       values ($1, $2, $3, $4, 'reinstatement', $5, 100, 10, 110, 'USD')`,
      [
        token('taxed_dispute_presentment_reinstatement'),
        disputeId,
        reinstatement.grossAllocationSetId,
        orderItemId,
        withdrawalPresentment.rows[0]!.id
      ]
    );

    const heads = await databaseClient.pool.query<{
      balance_transaction_id: string;
      basis: string;
      is_complete: boolean;
    }>(
      `select balance_transaction_id, basis::text, is_complete
       from current_financial_projection_heads
       where balance_transaction_id = any($1::uuid[])
       order by balance_transaction_id, basis`,
      [[withdrawal.balanceTransactionId, reinstatement.balanceTransactionId]]
    );
    expect(heads.rows).toHaveLength(4);
    expect(heads.rows.every((head) => head.is_complete)).toBe(true);

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        titleId: title.id,
        grossPresentmentMinor: 100,
        disputeWithdrawalPresentmentMinor: 100,
        disputeReinstatementPresentmentMinor: 100,
        grossSettlementMinor: 100,
        disputeImpactMinor: 0,
        estimatedPayoutMinor: 100,
        settlementMetricsComplete: true,
        missingSourceCount: 0,
        state: 'fee_reconciled'
      })
    ]);
    expect(result.summaries).toEqual([
      expect.objectContaining({
        grossPresentmentMinor: 100,
        disputeWithdrawalPresentmentMinor: 100,
        disputeReinstatementPresentmentMinor: 100,
        grossSettlementMinor: 100,
        disputeImpactMinor: 0,
        estimatedPayoutMinor: 100,
        settlementMetricsComplete: true
      })
    ]);
    expect(JSON.stringify(result)).not.toContain(disputeProviderId);
  });

  it('fails closed for a c1-a1 combined dispute reinstatement while allowing safe v1 effects', async () => {
    try {
      await replaceProjectionAuthorityForTest(1, token('legacy_reporting_c1_a1'));
      const authority = await databaseClient.pool.query<{
        classifier_version: number;
        allocation_algorithm_version: number;
      }>(
        `select classifier_version, allocation_algorithm_version
         from financial_projection_versions
         where singleton = true`
      );
      expect(authority.rows).toEqual([{
        classifier_version: 1,
        allocation_algorithm_version: 1
      }]);

      const title = await createTitle('legacy-taxed-dispute-cycle', {
        title: 'Legacy Taxed Dispute Cycle'
      });
      const purchase = await createPurchase('legacy-taxed-dispute-cycle', {
        paidAt: new Date('2026-08-01T17:50:00.000Z'),
        currency: 'USD',
        financialEvidenceStatus: 'fee_reconciled',
        items: [{
          title,
          titleSnapshot: 'Legacy Taxed Dispute Cycle',
          creatorNameSnapshot: 'Legacy Tax Cycle Creator',
          format: 'prose',
          subtotalMinor: 100,
          taxMinor: 10
        }]
      });
      const orderItemId = purchase.items[0]!.id;
      await createChargeEvidence('legacy-taxed-dispute-charge', purchase, {
        amountMinor: 110,
        feeMinor: 0,
        currency: 'USD',
        algorithmVersion: 1,
        grossItems: [
          { orderItemId, component: 'sale_subtotal', effectMinor: 100 },
          { orderItemId, component: 'sale_tax', effectMinor: 10 }
        ],
        feeItems: []
      });

      const disputeProviderId = token('legacy_taxed_dispute_private_dispute');
      const dispute = await ownerDatabaseClient.pool.query<{ id: string }>(
        `insert into disputes
           (payment_id, stripe_dispute_id, status, amount_minor, currency, reason,
            provider_created_at, provider_updated_at, financial_evidence_status)
         values ($1, $2, 'won', 110, 'USD', 'fraudulent',
                 '2026-08-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z',
                 'fee_reconciled')
         returning id`,
        [purchase.paymentId, disputeProviderId]
      );
      const disputeId = dispute.rows[0]!.id;
      const withdrawal = await createBalanceEvidence('legacy-taxed-dispute-withdrawal', {
        sourceKind: 'dispute',
        sourceInternalId: disputeId,
        sourceFamily: 'dispute',
        providerSourceId: disputeProviderId,
        parentClassification: 'dispute_withdrawal',
        amountMinor: -110,
        feeMinor: 0,
        currency: 'USD',
        algorithmVersion: 1,
        grossItems: [
          { orderItemId, component: 'dispute_subtotal', effectMinor: -100 },
          { orderItemId, component: 'dispute_tax', effectMinor: -10 }
        ],
        feeItems: []
      });
      const withdrawalPresentment = await ownerDatabaseClient.pool.query<{ id: string }>(
        `insert into dispute_item_allocations
           (allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
            effect, subtotal_effect_minor, tax_effect_minor, total_effect_minor, currency)
         values ($1, $2, $3, $4, 'withdrawal', -100, -10, -110, 'USD')
         returning id`,
        [
          token('legacy_taxed_dispute_presentment_withdrawal'),
          disputeId,
          withdrawal.grossAllocationSetId,
          orderItemId
        ]
      );

      const safeV1 = await listSalesOverview(
        databaseClient.db,
        ADMIN,
        customDayFilters(),
        { stripeEnabled: false }
      );
      expect(safeV1.rows).toEqual([
        expect.objectContaining({
          titleId: title.id,
          grossPresentmentMinor: 100,
          disputeWithdrawalPresentmentMinor: 100,
          disputeReinstatementPresentmentMinor: 0,
          grossSettlementMinor: 100,
          disputeImpactMinor: -100,
          estimatedPayoutMinor: 0,
          settlementMetricsComplete: true,
          missingSourceCount: 0,
          state: 'fee_reconciled'
        })
      ]);

      const reinstatement = await createBalanceEvidence('legacy-taxed-dispute-reinstatement', {
        sourceKind: 'dispute',
        sourceInternalId: disputeId,
        sourceFamily: 'dispute',
        providerSourceId: disputeProviderId,
        parentClassification: 'dispute_reinstatement',
        amountMinor: 110,
        feeMinor: 0,
        currency: 'USD',
        algorithmVersion: 1,
        grossReversalOfSetId: withdrawal.grossAllocationSetId!,
        grossItems: [{
          orderItemId,
          component: 'dispute_reinstatement',
          effectMinor: 110
        }],
        feeItems: []
      });
      await ownerDatabaseClient.pool.query(
        `insert into dispute_item_allocations
           (allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
            effect, reverses_allocation_id, subtotal_effect_minor, tax_effect_minor,
            total_effect_minor, currency)
         values ($1, $2, $3, $4, 'reinstatement', $5, 100, 10, 110, 'USD')`,
        [
          token('legacy_taxed_dispute_presentment_reinstatement'),
          disputeId,
          reinstatement.grossAllocationSetId,
          orderItemId,
          withdrawalPresentment.rows[0]!.id
        ]
      );

      const heads = await databaseClient.pool.query<{
        balance_transaction_id: string;
        basis: string;
        is_complete: boolean;
      }>(
        `select balance_transaction_id, basis::text, is_complete
         from current_financial_projection_heads
         where balance_transaction_id = any($1::uuid[])
         order by balance_transaction_id, basis`,
        [[withdrawal.balanceTransactionId, reinstatement.balanceTransactionId]]
      );
      expect(heads.rows).toHaveLength(4);
      expect(heads.rows.every((head) => head.is_complete)).toBe(true);

      const result = await listSalesOverview(
        databaseClient.db,
        ADMIN,
        customDayFilters(),
        { stripeEnabled: false }
      );
      expect(result.rows).toHaveLength(1);
      expectSettlementNull(result.rows[0]);
      expect(result.rows[0]).toMatchObject({
        titleId: title.id,
        presentmentCurrency: 'USD',
        settlementCurrency: 'USD',
        grossPresentmentMinor: 100,
        disputeWithdrawalPresentmentMinor: 100,
        disputeReinstatementPresentmentMinor: 100,
        settlementMetricsComplete: false,
        missingSourceCount: 1,
        state: 'exception'
      });
      expect(result.summaries).toEqual([
        expect.objectContaining({
          presentmentCurrency: 'USD',
          settlementCurrency: 'USD',
          grossPresentmentMinor: 100,
          disputeWithdrawalPresentmentMinor: 100,
          disputeReinstatementPresentmentMinor: 100,
          grossSettlementMinor: null,
          settlementMetricsComplete: false,
          missingSourceCount: 1,
          state: 'exception'
        })
      ]);
      expect(result.missingSourceCount).toBe(1);
      expect(JSON.stringify(result)).not.toContain(disputeProviderId);
    } finally {
      await replaceProjectionAuthorityForTest(2, token('legacy_reporting_reset_c1_a2'));
    }
  });

  it('uses only current payout membership and reopens a reconciled row when its payout fails', async () => {
    const title = await createTitle('payout-state', { title: 'Payout State' });
    const purchase = await createPurchase('payout-state', {
      paidAt: new Date('2026-08-01T12:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'Payout State',
        creatorNameSnapshot: 'Payout Creator',
        format: 'prose',
        subtotalMinor: 100,
        taxMinor: 0
      }]
    });
    const evidence = await createChargeEvidence('payout-state', purchase, {
      amountMinor: 100,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{
        orderItemId: purchase.items[0]!.id,
        component: 'sale_subtotal',
        effectMinor: 100
      }],
      feeItems: []
    });
    const payoutId = await publishPayoutMembership(
      'payout-state',
      'USD',
      [evidence.balanceTransactionId]
    );

    const paid = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: true }
    );
    expect(paid.rows).toEqual([
      expect.objectContaining({
        titleId: title.id,
        settlementMetricsComplete: true,
        estimatedPayoutMinor: 100,
        state: 'payout_reconciled'
      })
    ]);

    await ownerDatabaseClient.pool.query(
      `update stripe_payouts
       set status = 'failed', safe_failure_code = 'bank_returned', financial_generation = 2
       where id = $1`,
      [payoutId]
    );
    const reopened = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: true }
    );
    expect(reopened.rows).toEqual([
      expect.objectContaining({
        titleId: title.id,
        settlementMetricsComplete: false,
        estimatedPayoutMinor: null,
        missingSourceCount: 1,
        state: 'exception'
      })
    ]);
  });

  it('treats paid completed payout membership as historical until its exact generation is recertified', async () => {
    const title = await createTitle('payout-generation', { title: 'Payout Generation' });
    const purchase = await createPurchase('payout-generation', {
      paidAt: new Date('2026-08-01T13:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [{
        title,
        titleSnapshot: 'Payout Generation',
        creatorNameSnapshot: 'Payout Creator',
        format: 'prose',
        subtotalMinor: 100,
        taxMinor: 0
      }]
    });
    const evidence = await createChargeEvidence('payout-generation', purchase, {
      amountMinor: 100,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{
        orderItemId: purchase.items[0]!.id,
        component: 'sale_subtotal',
        effectMinor: 100
      }],
      feeItems: []
    });
    const payoutId = await publishPayoutMembership(
      'payout-generation',
      'USD',
      [evidence.balanceTransactionId]
    );

    await ownerDatabaseClient.pool.query(
      `update stripe_payouts
       set arrival_at = arrival_at + interval '1 day', financial_generation = 2
       where id = $1`,
      [payoutId]
    );

    const historical = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: true }
    );
    expect(historical.rows).toEqual([
      expect.objectContaining({
        titleId: title.id,
        settlementMetricsComplete: true,
        estimatedPayoutMinor: 100,
        state: 'fee_reconciled'
      })
    ]);

    const recertification = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into payout_import_runs
         (payout_id, generation, state, candidate_count, page_count, safe_outcome,
          completed_at)
       values ($1, 2, 'published', 1, 1, 'published',
               '2026-08-04T03:00:00.000Z')
       returning id`,
      [payoutId]
    );
    await ownerDatabaseClient.pool.query(
      `insert into payout_import_run_entries (run_id, balance_transaction_id)
       values ($1, $2)`,
      [recertification.rows[0]!.id, evidence.balanceTransactionId]
    );

    const current = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: true }
    );
    expect(current.rows).toEqual([
      expect.objectContaining({
        titleId: title.id,
        settlementMetricsComplete: true,
        estimatedPayoutMinor: 100,
        state: 'payout_reconciled'
      })
    ]);
  });

  it('limits a refund payout exception to titles attributed by that refund', async () => {
    const affectedTitle = await createTitle('payout-scope-affected', {
      title: 'Payout Affected'
    });
    const unaffectedTitle = await createTitle('payout-scope-unaffected', {
      title: 'Payout Unaffected'
    });
    const purchase = await createPurchase('payout-scope', {
      paidAt: new Date('2026-08-01T16:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: [
        {
          title: affectedTitle,
          titleSnapshot: 'Payout Affected',
          creatorNameSnapshot: 'Payout Scope Creator',
          format: 'prose',
          subtotalMinor: 100,
          taxMinor: 0
        },
        {
          title: unaffectedTitle,
          titleSnapshot: 'Payout Unaffected',
          creatorNameSnapshot: 'Payout Scope Creator',
          format: 'prose',
          subtotalMinor: 100,
          taxMinor: 0
        }
      ]
    });
    const affectedItem = purchase.items[0]!;
    const unaffectedItem = purchase.items[1]!;
    await createChargeEvidence('payout-scope-charge', purchase, {
      amountMinor: 200,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [
        {
          orderItemId: affectedItem.id,
          component: 'sale_subtotal',
          effectMinor: 100
        },
        {
          orderItemId: unaffectedItem.id,
          component: 'sale_subtotal',
          effectMinor: 100
        }
      ],
      feeItems: []
    });

    const refundProviderId = token('payout_scope_private_refund');
    const refund = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into refunds
         (payment_id, stripe_refund_id, status, amount_minor, currency, provider_created_at,
          allocation_status, financial_evidence_status)
       values ($1, $2, 'succeeded', 100, 'USD', '2026-08-02T00:00:00.000Z',
               'finalized', 'fee_reconciled')
       returning id`,
      [purchase.paymentId, refundProviderId]
    );
    const refundId = refund.rows[0]!.id;
    const refundAllocation = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
       values ($1, $2, 100, 'administrative')
       returning id`,
      [refundId, affectedItem.id]
    );
    await ownerDatabaseClient.pool.query(
      `insert into refund_allocation_components
         (refund_allocation_id, refund_id, order_item_id, subtotal_minor, tax_minor,
          total_minor, currency)
       values ($1, $2, $3, 100, 0, 100, 'USD')`,
      [refundAllocation.rows[0]!.id, refundId, affectedItem.id]
    );
    const refundEvidence = await createBalanceEvidence('payout-scope-refund', {
      sourceKind: 'refund',
      sourceInternalId: refundId,
      sourceFamily: 'refund',
      providerSourceId: refundProviderId,
      parentClassification: 'refund',
      amountMinor: -100,
      feeMinor: 0,
      currency: 'USD',
      grossItems: [{
        orderItemId: affectedItem.id,
        component: 'refund_subtotal',
        effectMinor: -100
      }],
      feeItems: []
    });
    const payoutId = await publishPayoutMembership(
      'payout-scope',
      'USD',
      [refundEvidence.balanceTransactionId]
    );
    await ownerDatabaseClient.pool.query(
      `update stripe_payouts
       set status = 'failed', safe_failure_code = 'bank_returned', financial_generation = 2
       where id = $1`,
      [payoutId]
    );

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: true }
    );
    const affected = result.rows.find((row) => row.titleId === affectedTitle.id)!;
    const unaffected = result.rows.find((row) => row.titleId === unaffectedTitle.id)!;
    expectSettlementNull(affected);
    expect(affected).toMatchObject({
      grossPresentmentMinor: 100,
      finalizedRefundPresentmentMinor: 100,
      settlementMetricsComplete: false,
      missingSourceCount: 1,
      state: 'exception'
    });
    expect(unaffected).toMatchObject({
      grossPresentmentMinor: 100,
      finalizedRefundPresentmentMinor: 0,
      grossSettlementMinor: 100,
      refundImpactMinor: 0,
      estimatedPayoutMinor: 100,
      settlementMetricsComplete: true,
      missingSourceCount: 0,
      state: 'fee_reconciled'
    });
    expect(result.summaries).toEqual([
      expect.objectContaining({
        titleCount: 2,
        grossPresentmentMinor: 200,
        finalizedRefundPresentmentMinor: 100,
        grossSettlementMinor: null,
        settlementMetricsComplete: false,
        missingSourceCount: 1,
        state: 'exception'
      })
    ]);
  });

  it('paginates pageSize plus one across equal-gross rows without gaps or partial summaries', async () => {
    const expectedTitleIds: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const title = await createTitle(`page-${index}`, {
        title: `Equal Gross ${String(index).padStart(2, '0')}`
      });
      const purchase = await createPurchase(`page-${index}`, {
        paidAt: new Date('2026-08-01T12:00:00.000Z'),
        currency: 'USD',
        financialEvidenceStatus: 'fee_reconciled',
        items: [{
          title,
          titleSnapshot: `Equal Gross ${String(index).padStart(2, '0')}`,
          creatorNameSnapshot: 'Pagination Creator',
          format: 'prose',
          subtotalMinor: 100,
          taxMinor: 0
        }]
      });
      await createChargeEvidence(`page-${index}`, purchase, {
        amountMinor: 100,
        feeMinor: 0,
        currency: 'USD',
        grossItems: [{
          orderItemId: purchase.items[0]!.id,
          component: 'sale_subtotal',
          effectMinor: 100
        }],
        feeItems: []
      });
      expectedTitleIds.push(title.id);
    }

    const first = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      filters('range=all&sort=gross_desc'),
      { stripeEnabled: false }
    );
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.rows.every((row) => row.grossPresentmentMinor === 100)).toBe(true);
    expect(first.rows.map((row) => row.titleId)).toEqual(
      [...first.rows.map((row) => row.titleId)].sort()
    );
    expect(first.summaries).toEqual([
      expect.objectContaining({
        presentmentCurrency: 'USD',
        settlementCurrency: 'USD',
        titleCount: 51,
        soldCopies: 51,
        grossPresentmentMinor: 5_100,
        grossSettlementMinor: 5_100,
        estimatedPayoutMinor: 5_100,
        settlementMetricsComplete: true
      })
    ]);

    const second = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      filters(
        `range=all&sort=gross_desc&cursor=${encodeURIComponent(first.nextCursor!)}`
      ),
      { stripeEnabled: false }
    );
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.summaries).toEqual(first.summaries);
    const pagedIds = [...first.rows, ...second.rows].map((row) => row.titleId);
    expect(new Set(pagedIds).size).toBe(51);
    expect([...pagedIds].sort()).toEqual([...expectedTitleIds].sort());
  });

  it('keeps the currency-pair tail stable across next and back equal-gross traversal', async () => {
    const fillerTitles: TitleFixture[] = [];
    for (let index = 1; index <= 49; index += 1) {
      const suffix = String(index).padStart(12, '0');
      fillerTitles.push(await createTitle(`currency-tail-filler-${index}`, {
        id: `00000000-0000-4000-8000-${suffix}`,
        title: `Currency Tail Filler ${String(index).padStart(2, '0')}`
      }));
    }
    const fillerPurchase = await createPurchase('currency-tail-fillers', {
      paidAt: new Date('2026-08-01T12:00:00.000Z'),
      currency: 'USD',
      financialEvidenceStatus: 'fee_reconciled',
      items: fillerTitles.map((title, index) => ({
        title,
        titleSnapshot: `Currency Tail Filler ${String(index + 1).padStart(2, '0')}`,
        creatorNameSnapshot: 'Currency Tail Creator',
        format: 'prose' as const,
        subtotalMinor: 100,
        taxMinor: 0
      }))
    });
    await createChargeEvidence('currency-tail-fillers', fillerPurchase, {
      amountMinor: 4_900,
      feeMinor: 0,
      currency: 'USD',
      grossItems: fillerPurchase.items.map((item) => ({
        orderItemId: item.id,
        component: 'sale_subtotal' as const,
        effectMinor: 100
      })),
      feeItems: []
    });

    const boundaryTitle = await createTitle('currency-tail-boundary', {
      id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      title: 'Currency Pair Boundary'
    });
    const boundaryPairs = [
      {
        label: 'eur-usd',
        presentmentCurrency: 'EUR',
        settlementCurrency: 'USD'
      },
      {
        label: 'usd-eur',
        presentmentCurrency: 'USD',
        settlementCurrency: 'EUR'
      }
    ] as const;
    for (const pair of boundaryPairs) {
      const purchase = await createPurchase(`currency-tail-${pair.label}`, {
        paidAt: new Date('2026-08-01T12:00:00.000Z'),
        currency: pair.presentmentCurrency,
        financialEvidenceStatus: 'fee_reconciled',
        items: [{
          title: boundaryTitle,
          titleSnapshot: `Currency Pair Boundary ${pair.label}`,
          creatorNameSnapshot: 'Currency Pair Creator',
          format: 'prose',
          subtotalMinor: 100,
          taxMinor: 0
        }]
      });
      await createChargeEvidence(`currency-tail-${pair.label}`, purchase, {
        amountMinor: 100,
        feeMinor: 0,
        currency: pair.settlementCurrency,
        exchangeRate: '1.000000000000000000',
        exchangeSourceCurrency: pair.presentmentCurrency,
        grossItems: [{
          orderItemId: purchase.items[0]!.id,
          component: 'sale_subtotal',
          effectMinor: 100
        }],
        feeItems: []
      });
    }

    const grainKey = (row: {
      readonly titleId: string;
      readonly presentmentCurrency: string;
      readonly settlementCurrency: string | null;
    }): string => [
      row.titleId,
      row.presentmentCurrency,
      row.settlementCurrency ?? 'pending'
    ].join('|');
    const first = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      filters('range=all&sort=gross_desc'),
      { stripeEnabled: false }
    );
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.rows.at(-1)).toMatchObject({
      titleId: boundaryTitle.id,
      presentmentCurrency: 'EUR',
      settlementCurrency: 'USD',
      grossPresentmentMinor: 100,
      grossSettlementMinor: 100
    });
    expect(first.rows.filter((row) => row.titleId === boundaryTitle.id)).toHaveLength(1);

    const second = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      filters(
        `range=all&sort=gross_desc&cursor=${encodeURIComponent(first.nextCursor!)}`
      ),
      { stripeEnabled: false }
    );
    expect(second.rows).toEqual([
      expect.objectContaining({
        titleId: boundaryTitle.id,
        presentmentCurrency: 'USD',
        settlementCurrency: 'EUR',
        grossPresentmentMinor: 100,
        grossSettlementMinor: 100
      })
    ]);
    expect(second.nextCursor).toBeNull();
    expect(second.summaries).toEqual(first.summaries);

    const returnedFirst = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      filters('range=all&sort=gross_desc'),
      { stripeEnabled: false }
    );
    expect(returnedFirst.rows).toEqual(first.rows);
    expect(returnedFirst.nextCursor).toBe(first.nextCursor);
    const returnedSecond = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      filters(
        `range=all&sort=gross_desc&cursor=${encodeURIComponent(returnedFirst.nextCursor!)}`
      ),
      { stripeEnabled: false }
    );
    expect(returnedSecond.rows).toEqual(second.rows);
    expect(returnedSecond.nextCursor).toBeNull();

    const pagedGrains = [...first.rows, ...second.rows].map(grainKey);
    const expectedGrains = [
      ...fillerTitles.map((title) => `${title.id}|USD|USD`),
      `${boundaryTitle.id}|EUR|USD`,
      `${boundaryTitle.id}|USD|EUR`
    ];
    expect(new Set(pagedGrains).size).toBe(51);
    expect([...pagedGrains].sort()).toEqual([...expectedGrains].sort());
    expect(first.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        presentmentCurrency: 'USD',
        settlementCurrency: 'USD',
        titleCount: 49,
        grossPresentmentMinor: 4_900,
        grossSettlementMinor: 4_900
      }),
      expect.objectContaining({
        presentmentCurrency: 'EUR',
        settlementCurrency: 'USD',
        titleCount: 1,
        grossPresentmentMinor: 100,
        grossSettlementMinor: 100
      }),
      expect.objectContaining({
        presentmentCurrency: 'USD',
        settlementCurrency: 'EUR',
        titleCount: 1,
        grossPresentmentMinor: 100,
        grossSettlementMinor: 100
      })
    ]));
  });

  it('counts global current operational issues while excluding inactive classifier history', async () => {
    const fingerprint = 'f'.repeat(64);
    const balance = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into stripe_balance_transactions
         (provider_id, live_mode, source_family, source_id, raw_type, reporting_category,
          balance_type, amount_minor, fee_minor, net_minor, currency, status,
          provider_created_at, available_at, fingerprint_sha256)
       values ($1, false, 'unknown', null, 'future_kind', 'future_kind', 'payments',
               0, 0, 0, 'USD', 'available', '2026-08-01T00:00:00.000Z',
               '2026-08-01T00:00:00.000Z', $2)
       returning id`,
      [token('classifier_history_private_balance'), fingerprint]
    );
    const balanceTransactionId = balance.rows[0]!.id;
    const classifications: string[] = [];
    await ownerDatabaseClient.db.transaction(async (transaction) => {
      for (const classifierVersion of [1, 2]) {
        const classification = await transaction.execute(sql`
          insert into financial_classification_versions
            (subject_type, subject_id, classifier_version, classification,
             source_fingerprint_sha256)
          values ('balance_transaction', ${balanceTransactionId}, ${classifierVersion},
                  'unknown', ${fingerprint})
          returning id
        `);
        const classificationId = (classification.rows[0] as { id: string }).id;
        classifications.push(classificationId);
        await transaction.execute(sql`
          insert into financial_reconciliation_issues
            (resource_type, resource_id, safe_code, impact, correlation_id)
          values ('financial_classification', ${classificationId}, 'unsupported_category',
                  'exception', ${token(`classifier_issue_${classifierVersion}`)})
        `);
      }
    });
    const pendingScanRunId = randomUUID();
    await ownerDatabaseClient.pool.query(
      `update financial_projection_versions
       set pending_classifier_version = 2, pending_allocation_algorithm_version = 2,
           pending_replay_id = 'c2-a2', pending_scan_run_id = $1
       where singleton = true`,
      [pendingScanRunId]
    );
    await ownerDatabaseClient.pool.query(
      `update financial_projection_versions
       set classifier_version = 2, allocation_algorithm_version = 2,
           pending_classifier_version = null, pending_allocation_algorithm_version = null,
           pending_replay_id = null, pending_scan_run_id = null,
           activated_at = clock_timestamp(), activation_correlation_id = $1
       where singleton = true`,
      [token('classifier_activation')]
    );

    const stored = await ownerDatabaseClient.pool.query<{ resource_id: string }>(
      `select resource_id::text from financial_reconciliation_issues
       where resource_type = 'financial_classification' and state = 'open'
       order by resource_id`
    );
    expect(stored.rows.map((row) => row.resource_id).sort()).toEqual(
      [...classifications].sort()
    );

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      customDayFilters(),
      { stripeEnabled: false }
    );
    expect(result.rows).toEqual([]);
    expect(result.needsReviewCount).toBe(1);
    expect(result.missingSourceCount).toBe(0);
  });

  it('lets the runtime read local reporting authority but not mutate financial truth', async () => {
    const readableRelations = [
      'titles',
      'orders',
      'order_items',
      'payments',
      'refunds',
      'refund_allocations',
      'refund_allocation_components',
      'disputes',
      'dispute_item_allocations',
      'stripe_balance_transactions',
      'stripe_balance_transaction_fee_details',
      'financial_classification_versions',
      'financial_projection_versions',
      'financial_allocation_sets',
      'financial_item_allocations',
      'current_financial_projection_heads',
      'current_financial_projection_items',
      'stripe_payouts',
      'payout_import_runs',
      'stripe_payout_balance_transactions',
      'refund_reporting_correction_sets',
      'refund_reporting_correction_items',
      'financial_reconciliation_issues',
      'financial_scan_runs'
    ] as const;
    const privileges = await databaseClient.pool.query<{
      relation: string;
      can_select: boolean;
      can_mutate: boolean;
    }>(
      `select relation,
              has_table_privilege(current_user, relation, 'SELECT') as can_select,
              has_table_privilege(current_user, relation, 'INSERT') or
                has_table_privilege(current_user, relation, 'UPDATE') or
                has_table_privilege(current_user, relation, 'DELETE') as can_mutate
       from unnest($1::text[]) as relation
       order by relation`,
      [[...readableRelations]]
    );
    expect(privileges.rows).toHaveLength(readableRelations.length);
    expect(privileges.rows.every((row) => row.can_select)).toBe(true);
    expect(privileges.rows.filter((row) => row.relation.startsWith('financial_') ||
      row.relation.startsWith('stripe_') || row.relation.startsWith('payout_') ||
      row.relation.startsWith('current_financial_')).every((row) => !row.can_mutate)).toBe(true);

    await expect(databaseClient.db.execute(sql`
      select head.balance_transaction_id, item.order_item_id
      from current_financial_projection_heads head
      left join current_financial_projection_items item
        on item.balance_transaction_id = head.balance_transaction_id
       and item.basis = head.basis
      limit 0
    `)).resolves.toBeDefined();
    await expect(databaseClient.pool.query(
      `update financial_projection_versions
       set classifier_version = classifier_version
       where singleton = true`
    )).rejects.toMatchObject({ code: '42501' });

    const result = await listSalesOverview(
      databaseClient.db,
      ADMIN,
      filters(),
      { stripeEnabled: false }
    );
    expect(Object.keys(result)).toEqual(OVERVIEW_KEYS);
    expect(result).toMatchObject({
      rows: [],
      summaries: [],
      nextCursor: null,
      stripeEnabled: false,
      missingSourceCount: 0,
      needsReviewCount: 0
    });
  });
});
