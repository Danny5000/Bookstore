import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { databaseClient } from './database';

const FINANCIAL_TABLES = [
  'stripe_balance_transactions',
  'stripe_balance_transaction_fee_details',
  'financial_classification_versions',
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

type ConstraintCode = '23001' | '23503' | '23505' | '23514';

interface CommerceGraph {
  adminId: string;
  userId: string;
  titleId: string;
  orderId: string;
  orderItemId: string;
  paymentId: string;
  refundId: string;
  refundAllocationId: string;
  purchaseGrantId: string;
}

interface BalanceTransactionInput {
  sourceFamily?: 'charge' | 'refund' | 'dispute' | 'payout' | 'adjustment' | 'unknown' | null;
  sourceId?: string | null;
  amountMinor?: number;
  feeMinor?: number;
  netMinor?: number;
  currency?: string;
  exchangeRate?: string | null;
  exchangeSourceCurrency?: string | null;
  exchangeTargetCurrency?: string | null;
}

interface AllocationSetInput {
  balanceTransactionId: string;
  sourceInternalId: string;
  basis?: 'gross_amount' | 'fee';
  scope?: 'title' | 'account' | 'unresolved';
  expectedEffectMinor: number;
  currency?: string;
  sourceFingerprintSha256?: string;
  supersedesSetId?: string | null;
}

let sequence = 0;

function nextToken(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}_${randomUUID().replaceAll('-', '')}`;
}

function expectConstraint(
  promise: Promise<unknown>,
  code: ConstraintCode,
  label: string
): Promise<void> {
  return expect(promise, label).rejects.toMatchObject({ code });
}

async function expectSingleRow<T>(
  promise: Promise<{ rows: T[] }>,
  label: string
): Promise<T> {
  await expect(promise, label).resolves.toMatchObject({ rows: expect.any(Array) });
  const result = await promise;
  expect(result.rows, label).toHaveLength(1);
  return result.rows[0]!;
}

async function expectFinancialSchemaPresent(label: string): Promise<void> {
  await expect(
    databaseClient.pool.query(`select id from stripe_balance_transactions limit 0`),
    label
  ).resolves.toBeDefined();
}

async function createUser(label: string): Promise<string> {
  const result = await databaseClient.pool.query<{ id: string }>(
    `insert into "user" (name, email, email_verified)
     values ($1, $2, true)
     returning id`,
    [`Financial ${label}`, `${nextToken(label)}@example.com`]
  );
  return result.rows[0]!.id;
}

async function createTitle(label: string): Promise<string> {
  const token = nextToken(label).toLowerCase().replaceAll('_', '-');
  const result = await databaseClient.pool.query<{ id: string }>(
    `insert into titles
       (slug, title, description, creator_name, format, price_minor, currency)
     values ($1, $2, 'Description', 'Creator', 'prose', 1000, 'USD')
     returning id`,
    [token, `Financial ${label}`]
  );
  return result.rows[0]!.id;
}

async function createCommerceGraph(
  label: string,
  allocationSource: 'automatic' | 'administrative' = 'administrative'
): Promise<CommerceGraph> {
  const adminId = await createUser(`${label}-admin`);
  const userId = await createUser(`${label}-reader`);
  const titleId = await createTitle(`${label}-title`);
  const order = await databaseClient.pool.query<{ id: string }>(
    `insert into orders
       (status, initiating_user_id, purchase_email, currency, subtotal_minor, tax_minor,
        total_minor, client_checkout_attempt_id, quote_fingerprint_sha256,
        status_token_sha256, paid_at)
     values ('paid', $1, $2, 'USD', 1000, 100, 1100, $3, repeat('a', 64),
             repeat('b', 64), clock_timestamp())
     returning id`,
    [userId, `${nextToken(label)}@example.com`, randomUUID()]
  );
  const orderId = order.rows[0]!.id;
  const item = await databaseClient.pool.query<{ id: string }>(
    `insert into order_items
       (order_id, title_id, title_snapshot, creator_name_snapshot, format, currency,
        unit_subtotal_minor, tax_minor, total_minor)
     values ($1, $2, 'Title snapshot', 'Creator snapshot', 'prose', 'USD', 1000, 100, 1100)
     returning id`,
    [orderId, titleId]
  );
  const orderItemId = item.rows[0]!.id;
  const payment = await databaseClient.pool.query<{ id: string }>(
    `insert into payments
       (order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
        amount_minor, currency, paid_at)
     values ($1, $2, $3, 'succeeded', 1100, 'USD', clock_timestamp())
     returning id`,
    [orderId, nextToken('pi'), nextToken('ch')]
  );
  const paymentId = payment.rows[0]!.id;
  const refund = await databaseClient.pool.query<{ id: string }>(
    `insert into refunds
       (payment_id, stripe_refund_id, status, amount_minor, currency, provider_created_at)
     values ($1, $2, 'succeeded', 100, 'USD', clock_timestamp())
     returning id`,
    [paymentId, nextToken('re')]
  );
  const refundId = refund.rows[0]!.id;
  const allocation = await databaseClient.pool.query<{ id: string }>(
    `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
     values ($1, $2, 100, $3)
     returning id`,
    [refundId, orderItemId, allocationSource]
  );
  const refundAllocationId = allocation.rows[0]!.id;
  const grant = await databaseClient.pool.query<{ id: string }>(
    `insert into entitlement_grants
       (title_id, user_id, source, order_item_id, state, state_reason)
     values ($1, $2, 'purchase', $3, 'active', 'paid')
     returning id`,
    [titleId, userId, orderItemId]
  );

  return {
    adminId,
    userId,
    titleId,
    orderId,
    orderItemId,
    paymentId,
    refundId,
    refundAllocationId,
    purchaseGrantId: grant.rows[0]!.id
  };
}

function insertBalanceTransaction(input: BalanceTransactionInput = {}) {
  const amountMinor = input.amountMinor ?? 100;
  const feeMinor = input.feeMinor ?? 0;
  const netMinor = input.netMinor ?? amountMinor - feeMinor;
  return databaseClient.pool.query<{ id: string }>(
    `insert into stripe_balance_transactions
       (provider_id, live_mode, source_family, source_id, raw_type, reporting_category,
        balance_type, amount_minor, fee_minor, net_minor, currency, status,
        provider_created_at, available_at, exchange_rate, exchange_source_currency,
        exchange_target_currency, fingerprint_sha256)
     values ($1, false, $2, $3, 'charge', 'charge', 'payments', $4, $5, $6, $7,
             'available', clock_timestamp(), clock_timestamp(), $8, $9, $10, repeat('c', 64))
     returning id`,
    [
      nextToken('txn'),
      input.sourceFamily === undefined ? 'charge' : input.sourceFamily,
      input.sourceId === undefined ? nextToken('ch') : input.sourceId,
      amountMinor,
      feeMinor,
      netMinor,
      input.currency ?? 'USD',
      input.exchangeRate ?? null,
      input.exchangeSourceCurrency ?? null,
      input.exchangeTargetCurrency ?? null
    ]
  );
}

function insertAllocationSet(input: AllocationSetInput) {
  return databaseClient.pool.query<{ id: string }>(
    `insert into financial_allocation_sets
       (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
        basis, scope, expected_effect_minor, currency, algorithm_version,
        classifier_version, source_fingerprint_sha256, supersedes_set_id)
     values ($1, $2, 'refund', $3, $4, $5, $6, $7, 1, 1, $8, $9)
     returning id`,
    [
      nextToken('allocation'),
      input.balanceTransactionId,
      input.sourceInternalId,
      input.basis ?? 'gross_amount',
      input.scope ?? 'title',
      input.expectedEffectMinor,
      input.currency ?? 'USD',
      input.sourceFingerprintSha256 ?? 'd'.repeat(64),
      input.supersedesSetId ?? null
    ]
  );
}

function insertAllocationItem(
  allocationSetId: string,
  orderItemId: string,
  effectMinor: number,
  component: 'refund_subtotal' | 'refund_tax' | 'refund_fee' = 'refund_subtotal'
) {
  return databaseClient.pool.query<{ id: string }>(
    `insert into financial_item_allocations
       (allocation_set_id, order_item_id, component, effect_minor, currency, tie_break_key)
     values ($1, $2, $3, $4, 'USD', $5)
     returning id`,
    [allocationSetId, orderItemId, component, effectMinor, nextToken('tie')]
  );
}

describe('Plan 6B financial schema', () => {
  it('installs every financial table, current-projection view, and new state enum', async () => {
    const relations = await databaseClient.db.execute<{ name: string; kind: string }>(sql`
      select c.relname as name, c.relkind::text as kind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in (
          'stripe_balance_transactions',
          'stripe_balance_transaction_fee_details',
          'financial_classification_versions',
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
          'refund_allocation_finalization_effects',
          'current_financial_projection_heads',
          'current_financial_projection_items'
        )
      order by c.relname
    `);
    expect(relations.rows.filter((row) => row.kind === 'r').map((row) => row.name)).toEqual(
      [...FINANCIAL_TABLES].sort()
    );
    expect(relations.rows.filter((row) => row.kind === 'v').map((row) => row.name)).toEqual([
      'current_financial_projection_heads',
      'current_financial_projection_items'
    ]);

    const enumValues = await databaseClient.db.execute<{ enum_name: string; value: string }>(sql`
      select t.typname as enum_name, e.enumlabel as value
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      where t.typname in ('financial_evidence_status', 'refund_allocation_status')
      order by t.typname, e.enumsortorder
    `);
    expect(enumValues.rows).toEqual([
      { enum_name: 'financial_evidence_status', value: 'pending' },
      { enum_name: 'financial_evidence_status', value: 'fee_reconciled' },
      { enum_name: 'financial_evidence_status', value: 'exception' },
      { enum_name: 'refund_allocation_status', value: 'not_applicable' },
      { enum_name: 'refund_allocation_status', value: 'needs_review' },
      { enum_name: 'refund_allocation_status', value: 'draft' },
      { enum_name: 'refund_allocation_status', value: 'finalized' },
      { enum_name: 'refund_allocation_status', value: 'exception' }
    ]);
  });

  it('uses restrictive foreign keys throughout financial history', async () => {
    const foreignKeys = await databaseClient.db.execute<{
      table_name: string;
      constraint_name: string;
      delete_action: string;
    }>(sql`
      select c.relname as table_name, con.conname as constraint_name,
        con.confdeltype::text as delete_action
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and con.contype = 'f'
        and c.relname = any(${sql.raw(`array[${FINANCIAL_TABLES.map((name) => `'${name}'`).join(',')}]::text[]`)})
      order by c.relname, con.conname
    `);
    expect(foreignKeys.rows.length).toBeGreaterThan(0);
    expect(foreignKeys.rows.every((row) => row.delete_action === 'r')).toBe(true);
  });

  it('enforces the three entitlement-grant source shapes and recovery uniqueness', async () => {
    await expectFinancialSchemaPresent(
      'migration 0007 must exist before exercising the new entitlement-grant shapes'
    );
    const graph = await createCommerceGraph('grant-shapes');
    const preservedTitleId = await createTitle('preserved-grant');
    await databaseClient.pool.query(
      `insert into entitlement_grants
         (title_id, user_id, source, state, state_reason)
       values ($1, $2, 'preserved', 'active', 'pre_commerce_entitlement')`,
      [preservedTitleId, graph.userId]
    );

    const administrativeGrant = await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `insert into entitlement_grants
           (title_id, user_id, source, recovery_refund_allocation_id, state, state_reason)
         values ($1, $2, 'administrative', $3, 'active', 'refund_allocation_recovery')
         returning id`,
        [graph.titleId, graph.userId, graph.refundAllocationId]
      ),
      'the administrative recovery shape is accepted after migration 0007 exists'
    );
    expect(administrativeGrant.id).toMatch(/^[0-9a-f-]{36}$/u);

    const unusedTitleId = await createTitle('unused-purchase-source');
    const unusedItem = await databaseClient.pool.query<{ id: string }>(
      `insert into order_items
         (order_id, title_id, title_snapshot, creator_name_snapshot, format, currency,
          unit_subtotal_minor, tax_minor, total_minor)
       values ($1, $2, 'Unused title', 'Creator', 'prose', 'USD', 1000, 100, 1100)
       returning id`,
      [graph.orderId, unusedTitleId]
    );
    const unusedOrderItemId = unusedItem.rows[0]!.id;
    const unusedRecovery = await createCommerceGraph('unused-recovery');

    const invalidShapes = [
      {
        label: 'purchase grants cannot use the reserved recovery reason',
        query: () =>
          databaseClient.pool.query(
            `insert into entitlement_grants
               (title_id, user_id, source, order_item_id, state, state_reason)
             values ($1, $2, 'purchase', $3, 'active', 'refund_allocation_recovery')`,
            [unusedTitleId, graph.userId, unusedOrderItemId]
          )
      },
      {
        label: 'purchase grants cannot carry a recovery allocation reference',
        query: () =>
          databaseClient.pool.query(
            `insert into entitlement_grants
               (title_id, user_id, source, order_item_id, recovery_refund_allocation_id,
                state, state_reason)
             values ($1, $2, 'purchase', $3, $4, 'active', 'paid')`,
            [
              unusedTitleId,
              graph.userId,
              unusedOrderItemId,
              unusedRecovery.refundAllocationId
            ]
          )
      },
      {
        label: 'preserved grants cannot use the reserved recovery reason',
        query: () =>
          databaseClient.pool.query(
            `insert into entitlement_grants
               (title_id, user_id, source, state, state_reason)
             values ($1, $2, 'preserved', 'active', 'refund_allocation_recovery')`,
            [unusedTitleId, unusedRecovery.userId]
          )
      },
      {
        label: 'preserved grants cannot carry a recovery allocation reference',
        query: () =>
          databaseClient.pool.query(
            `insert into entitlement_grants
               (title_id, user_id, source, recovery_refund_allocation_id, state, state_reason)
             values ($1, $2, 'preserved', $3, 'active', 'pre_commerce_entitlement')`,
            [unusedTitleId, unusedRecovery.userId, unusedRecovery.refundAllocationId]
          )
      },
      {
        label: 'administrative grants require a user',
        query: () =>
          databaseClient.pool.query(
            `insert into entitlement_grants
               (title_id, source, recovery_refund_allocation_id, state, state_reason, revoked_at)
             values ($1, 'administrative', $2, 'revoked', 'refund_allocation_recovery',
                     clock_timestamp())`,
            [unusedRecovery.titleId, unusedRecovery.refundAllocationId]
          )
      },
      {
        label: 'administrative grants cannot carry an order item',
        query: () =>
          databaseClient.pool.query(
            `insert into entitlement_grants
               (title_id, user_id, source, order_item_id, recovery_refund_allocation_id,
                state, state_reason)
             values ($1, $2, 'administrative', $3, $4, 'active',
                     'refund_allocation_recovery')`,
            [
              unusedRecovery.titleId,
              unusedRecovery.userId,
              unusedRecovery.orderItemId,
              unusedRecovery.refundAllocationId
            ]
          )
      },
      {
        label: 'administrative grants require the exact reserved reason',
        query: () =>
          databaseClient.pool.query(
            `insert into entitlement_grants
               (title_id, user_id, source, recovery_refund_allocation_id, state, state_reason)
             values ($1, $2, 'administrative', $3, 'active', 'manual_override')`,
            [unusedRecovery.titleId, unusedRecovery.userId, unusedRecovery.refundAllocationId]
          )
      },
      {
        label: 'administrative grants require a recovery allocation reference',
        query: () =>
          databaseClient.pool.query(
            `insert into entitlement_grants
               (title_id, user_id, source, state, state_reason)
             values ($1, $2, 'administrative', 'active', 'refund_allocation_recovery')`,
            [unusedRecovery.titleId, unusedRecovery.userId]
          )
      },
      {
        label: 'administrative grants cannot be suspended',
        query: () =>
          databaseClient.pool.query(
            `insert into entitlement_grants
               (title_id, user_id, source, recovery_refund_allocation_id, state, state_reason,
                suspended_at)
             values ($1, $2, 'administrative', $3, 'suspended',
                     'refund_allocation_recovery', clock_timestamp())`,
            [unusedRecovery.titleId, unusedRecovery.userId, unusedRecovery.refundAllocationId]
          )
      }
    ];

    for (const invalid of invalidShapes) {
      await expectConstraint(invalid.query(), '23514', invalid.label);
    }

    await expectConstraint(
      databaseClient.pool.query(
        `insert into entitlement_grants
           (title_id, user_id, source, recovery_refund_allocation_id, state, state_reason)
         values ($1, $2, 'administrative', $3, 'active', 'refund_allocation_recovery')`,
        [graph.titleId, unusedRecovery.userId, graph.refundAllocationId]
      ),
      '23505',
      'one administratively finalized allocation authorizes at most one recovery grant'
    );
  });
  it('enforces provider source, money, FX, replay, and payout-run invariants', async () => {
    const sourceLess = await expectSingleRow(
      insertBalanceTransaction({ sourceFamily: null, sourceId: null }),
      'migration 0007 accepts a provider transaction whose source evidence is absent'
    );
    const knownFamilyWithoutId = await expectSingleRow(
      insertBalanceTransaction({ sourceFamily: 'charge', sourceId: null }),
      'source family and source ID are independently nullable'
    );
    await expectSingleRow(
      insertBalanceTransaction({
        sourceFamily: 'charge',
        sourceId: nextToken('ch_fx'),
        exchangeRate: '1.250000000000000000',
        exchangeSourceCurrency: 'EUR',
        exchangeTargetCurrency: 'USD'
      }),
      'complete positive FX evidence is accepted'
    );

    const invalidBalanceTransactions: Array<{
      label: string;
      input: BalanceTransactionInput;
    }> = [
      {
        label: 'a source ID cannot claim no source family',
        input: { sourceFamily: null, sourceId: nextToken('orphan_source') }
      },
      {
        label: 'empty source IDs are rejected',
        input: { sourceFamily: 'charge', sourceId: '' }
      },
      {
        label: 'net amount must equal gross amount minus fee',
        input: { amountMinor: 100, feeMinor: 10, netMinor: 100 }
      },
      {
        label: 'provider fees cannot be negative',
        input: { amountMinor: 100, feeMinor: -1, netMinor: 101 }
      },
      {
        label: 'money cannot exceed the project safe bound',
        input: { amountMinor: 100_000_000, feeMinor: 0, netMinor: 100_000_000 }
      },
      {
        label: 'settlement currency must be uppercase ISO-shaped',
        input: { currency: 'usd' }
      },
      {
        label: 'an exchange rate requires both exchange currencies',
        input: { exchangeRate: '1.25' }
      },
      {
        label: 'exchange currencies require an exchange rate',
        input: { exchangeSourceCurrency: 'EUR', exchangeTargetCurrency: 'USD' }
      },
      {
        label: 'partial exchange-currency evidence is rejected',
        input: { exchangeSourceCurrency: 'EUR' }
      },
      {
        label: 'exchange rates must be positive',
        input: {
          exchangeRate: '0',
          exchangeSourceCurrency: 'EUR',
          exchangeTargetCurrency: 'USD'
        }
      },
      {
        label: 'exchange source and target currencies must differ',
        input: {
          exchangeRate: '1',
          exchangeSourceCurrency: 'USD',
          exchangeTargetCurrency: 'USD'
        }
      },
      {
        label: 'exchange target currency must equal settlement currency',
        input: {
          exchangeRate: '1.25',
          exchangeSourceCurrency: 'EUR',
          exchangeTargetCurrency: 'GBP'
        }
      },
      {
        label: 'exchange currencies must be uppercase ISO-shaped',
        input: {
          exchangeRate: '1.25',
          exchangeSourceCurrency: 'eur',
          exchangeTargetCurrency: 'USD'
        }
      }
    ];

    for (const invalid of invalidBalanceTransactions) {
      await expectConstraint(insertBalanceTransaction(invalid.input), '23514', invalid.label);
    }

    const insertScanRun = (
      classifierVersion: number | null,
      allocationAlgorithmVersion: number | null,
      replayId: string | null
    ) =>
      databaseClient.pool.query<{ id: string }>(
        `insert into financial_scan_runs
           (root_key, kind, phase, classifier_version, allocation_algorithm_version, replay_id)
         values ($1, 'hourly', 'classification', $2, $3, $4)
         returning id`,
        [nextToken('scan'), classifierVersion, allocationAlgorithmVersion, replayId]
      );

    await expectSingleRow(
      insertScanRun(null, null, null),
      'non-replay scans omit the complete replay identity'
    );
    await expectSingleRow(
      insertScanRun(2, 3, 'c2-a3'),
      'replay scans persist the composite classifier/allocation identity'
    );

    const invalidReplayIdentities = [
      {
        label: 'classifier-only replay identity is rejected',
        values: [1, null, null] as const
      },
      {
        label: 'algorithm-only replay identity is rejected',
        values: [null, 1, null] as const
      },
      {
        label: 'versions without a replay ID are rejected',
        values: [1, 1, null] as const
      },
      {
        label: 'a replay ID without versions is rejected',
        values: [null, null, 'c1-a1'] as const
      },
      {
        label: 'a replay ID must encode both exact versions',
        values: [1, 2, 'c1-a1'] as const
      },
      {
        label: 'replay versions must be positive',
        values: [-1, 1, 'c-1-a1'] as const
      }
    ];
    for (const invalid of invalidReplayIdentities) {
      await expectConstraint(
        insertScanRun(invalid.values[0], invalid.values[1], invalid.values[2]),
        '23514',
        invalid.label
      );
    }

    const insertPayout = (label: string) =>
      databaseClient.pool.query<{ id: string }>(
        `insert into stripe_payouts
           (provider_id, live_mode, amount_minor, currency, automatic, method, status,
            reconciliation_status, provider_created_at, arrival_at, retrieved_at,
            fingerprint_sha256)
         values ($1, false, 100, 'USD', true, 'standard', 'paid', 'completed',
                 clock_timestamp(), clock_timestamp(), clock_timestamp(), repeat('e', 64))
         returning id`,
        [nextToken(label)]
      );
    const firstPayout = await expectSingleRow(insertPayout('po_first'), 'first payout');
    const secondPayout = await expectSingleRow(insertPayout('po_second'), 'second payout');

    const insertPublishedRun = (payoutId: string, generation: number) =>
      databaseClient.pool.query<{ id: string }>(
        `insert into payout_import_runs
           (payout_id, generation, state, candidate_count, page_count, completed_at)
         values ($1, $2, 'published', 1, 1, clock_timestamp())
         returning id`,
        [payoutId, generation]
      );
    const firstRun = await expectSingleRow(
      insertPublishedRun(firstPayout.id, 0),
      'published import run for first payout'
    );
    await databaseClient.pool.query(
      `insert into payout_import_run_entries (run_id, balance_transaction_id)
       values ($1, $2)`,
      [firstRun.id, sourceLess.id]
    );

    await expectConstraint(
      databaseClient.pool.query(
        `insert into stripe_payout_balance_transactions
           (payout_id, balance_transaction_id, published_from_run_id)
         values ($1, $2, $3)`,
        [secondPayout.id, sourceLess.id, firstRun.id]
      ),
      '23503',
      'published payout membership must belong to the same payout as its import run'
    );

    await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `insert into stripe_payout_balance_transactions
           (payout_id, balance_transaction_id, published_from_run_id)
         values ($1, $2, $3)
         returning id`,
        [firstPayout.id, sourceLess.id, firstRun.id]
      ),
      'matching payout/run membership is accepted'
    );

    const secondRun = await expectSingleRow(
      insertPublishedRun(secondPayout.id, 0),
      'published import run for second payout'
    );
    await databaseClient.pool.query(
      `insert into payout_import_run_entries (run_id, balance_transaction_id)
       values ($1, $2)`,
      [secondRun.id, sourceLess.id]
    );
    await expectConstraint(
      databaseClient.pool.query(
        `insert into stripe_payout_balance_transactions
           (payout_id, balance_transaction_id, published_from_run_id)
         values ($1, $2, $3)`,
        [secondPayout.id, sourceLess.id, secondRun.id]
      ),
      '23505',
      'one balance transaction cannot be published into two supported payouts'
    );

    expect(knownFamilyWithoutId.id).not.toBe(sourceLess.id);
  });
  it('projects base, successor, fork, unresolved, and stale-correction states', async () => {
    await expectFinancialSchemaPresent(
      'migration 0007 must exist before exercising the current-projection views'
    );
    const graph = await createCommerceGraph('allocation-view');
    const transaction = await expectSingleRow(
      insertBalanceTransaction({
        sourceFamily: 'refund',
        sourceId: nextToken('re_source'),
        amountMinor: 100,
        feeMinor: 0,
        netMinor: 100
      }),
      'migration 0007 installs the allocation source relation'
    );
    const base = await expectSingleRow(
      insertAllocationSet({
        balanceTransactionId: transaction.id,
        sourceInternalId: graph.refundId,
        expectedEffectMinor: 100,
        sourceFingerprintSha256: 'c'.repeat(64)
      }),
      'base allocation set'
    );
    await expectSingleRow(
      insertAllocationItem(base.id, graph.orderItemId, 100),
      'base allocation item'
    );

    interface ProjectionHead {
      base_set_id: string | null;
      compatible_correction_tip_id: string | null;
      scope: string | null;
      is_complete: boolean;
      missing_source_count: number;
      proposed_issue_code: string | null;
    }
    const readGrossHead = async (balanceTransactionId: string): Promise<ProjectionHead> => {
      const result = await databaseClient.pool.query<ProjectionHead>(
        `select base_set_id, compatible_correction_tip_id, scope, is_complete,
                missing_source_count, proposed_issue_code
         from current_financial_projection_heads
         where balance_transaction_id = $1 and basis = 'gross_amount'`,
        [balanceTransactionId]
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0]!;
    };
    const readProjectionItems = (balanceTransactionId: string) =>
      databaseClient.pool.query<{
        base_set_id: string;
        order_item_id: string;
        component: string;
        effect_minor: number;
      }>(
        `select base_set_id, order_item_id, component, effect_minor
         from current_financial_projection_items
         where balance_transaction_id = $1 and basis = 'gross_amount'
         order by order_item_id, component`,
        [balanceTransactionId]
      );

    expect(await readGrossHead(transaction.id)).toEqual({
      base_set_id: base.id,
      compatible_correction_tip_id: null,
      scope: 'title',
      is_complete: true,
      missing_source_count: 0,
      proposed_issue_code: null
    });
    expect((await readProjectionItems(transaction.id)).rows).toEqual([
      {
        base_set_id: base.id,
        order_item_id: graph.orderItemId,
        component: 'refund_subtotal',
        effect_minor: 100
      }
    ]);

    const successor = await expectSingleRow(
      insertAllocationSet({
        balanceTransactionId: transaction.id,
        sourceInternalId: graph.refundId,
        expectedEffectMinor: 100,
        sourceFingerprintSha256: 'c'.repeat(64),
        supersedesSetId: base.id
      }),
      'one allocation successor'
    );
    await expectSingleRow(
      insertAllocationItem(successor.id, graph.orderItemId, 100),
      'successor allocation item'
    );
    expect(await readGrossHead(transaction.id)).toMatchObject({
      base_set_id: successor.id,
      is_complete: true,
      proposed_issue_code: null
    });
    expect((await readProjectionItems(transaction.id)).rows.map((row) => row.base_set_id)).toEqual([
      successor.id
    ]);

    await expectConstraint(
      insertAllocationSet({
        balanceTransactionId: transaction.id,
        sourceInternalId: graph.refundId,
        expectedEffectMinor: 100,
        sourceFingerprintSha256: '3'.repeat(64),
        supersedesSetId: base.id
      }),
      '23505',
      'an allocation set cannot have two direct successors'
    );

    const fork = await expectSingleRow(
      insertAllocationSet({
        balanceTransactionId: transaction.id,
        sourceInternalId: graph.refundId,
        expectedEffectMinor: 100,
        sourceFingerprintSha256: '4'.repeat(64)
      }),
      'independent roots remain visible as an explicit fork'
    );
    await expectSingleRow(
      insertAllocationItem(fork.id, graph.orderItemId, 100),
      'fork allocation item'
    );
    expect(await readGrossHead(transaction.id)).toEqual({
      base_set_id: null,
      compatible_correction_tip_id: null,
      scope: null,
      is_complete: false,
      missing_source_count: 1,
      proposed_issue_code: 'allocation_fork'
    });
    expect((await readProjectionItems(transaction.id)).rows).toEqual([]);

    const unresolvedTransaction = await expectSingleRow(
      insertBalanceTransaction({
        sourceFamily: 'adjustment',
        sourceId: nextToken('adj'),
        amountMinor: 25,
        netMinor: 25
      }),
      'unresolved transaction'
    );
    const unresolved = await expectSingleRow(
      insertAllocationSet({
        balanceTransactionId: unresolvedTransaction.id,
        sourceInternalId: randomUUID(),
        scope: 'unresolved',
        expectedEffectMinor: 25,
        sourceFingerprintSha256: 'c'.repeat(64)
      }),
      'unresolved allocation set'
    );
    expect(await readGrossHead(unresolvedTransaction.id)).toEqual({
      base_set_id: unresolved.id,
      compatible_correction_tip_id: null,
      scope: 'unresolved',
      is_complete: false,
      missing_source_count: 1,
      proposed_issue_code: 'allocation_incomplete'
    });

    const staleGraph = await createCommerceGraph('stale-correction');
    const staleTransaction = await expectSingleRow(
      insertBalanceTransaction({
        sourceFamily: 'refund',
        sourceId: nextToken('re_stale'),
        amountMinor: 70,
        netMinor: 70
      }),
      'stale-correction transaction'
    );
    const staleBase = await expectSingleRow(
      insertAllocationSet({
        balanceTransactionId: staleTransaction.id,
        sourceInternalId: staleGraph.refundId,
        expectedEffectMinor: 70,
        sourceFingerprintSha256: 'c'.repeat(64)
      }),
      'stale-correction original base'
    );
    await expectSingleRow(
      insertAllocationItem(staleBase.id, staleGraph.orderItemId, 70),
      'stale-correction original item'
    );
    const oldCorrection = await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `insert into refund_reporting_correction_sets
           (refund_id, correction_version, kind, base_allocation_set_id,
            source_fingerprint_sha256, approved_by_admin_id, created_by_admin_id,
            correlation_id)
         values ($1, 1, 'allocation_attribution_correction', $2, repeat('c', 64),
                 $3, $3, $4)
         returning id`,
        [staleGraph.refundId, staleBase.id, staleGraph.adminId, nextToken('corr')]
      ),
      'correction against original base'
    );
    await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `insert into refund_reporting_correction_items
           (correction_set_id, domain, source_allocation_set_id, order_item_id, component,
            currency, approved_absolute_minor, delta_minor, stable_tie_break_key)
         values ($1, 'settlement', $2, $3, 'refund_subtotal', 'USD', 70, 0, $4)
         returning id`,
        [oldCorrection.id, staleBase.id, staleGraph.orderItemId, nextToken('corr_item')]
      ),
      'correction item against original base'
    );
    const staleSuccessor = await expectSingleRow(
      insertAllocationSet({
        balanceTransactionId: staleTransaction.id,
        sourceInternalId: staleGraph.refundId,
        expectedEffectMinor: 70,
        sourceFingerprintSha256: 'c'.repeat(64),
        supersedesSetId: staleBase.id
      }),
      'superseding base that still requires correction rebase'
    );
    await expectSingleRow(
      insertAllocationItem(staleSuccessor.id, staleGraph.orderItemId, 70),
      'superseding base item'
    );
    expect(await readGrossHead(staleTransaction.id)).toEqual({
      base_set_id: staleSuccessor.id,
      compatible_correction_tip_id: null,
      scope: 'title',
      is_complete: false,
      missing_source_count: 1,
      proposed_issue_code: 'correction_rebase_required'
    });
    expect((await readProjectionItems(staleTransaction.id)).rows).toEqual([]);
  });

  it('enforces immutable draft, correction, and finalization provenance graphs', async () => {
    await expectFinancialSchemaPresent(
      'migration 0007 must exist before exercising draft and provenance relations'
    );
    const graph = await createCommerceGraph('provenance');
    const otherGraph = await createCommerceGraph('other-provenance');
    const transaction = await expectSingleRow(
      insertBalanceTransaction({
        sourceFamily: 'refund',
        sourceId: nextToken('re_graph'),
        amountMinor: 100,
        netMinor: 100
      }),
      'migration 0007 installs draft and provenance relations'
    );
    const base = await expectSingleRow(
      insertAllocationSet({
        balanceTransactionId: transaction.id,
        sourceInternalId: graph.refundId,
        expectedEffectMinor: 100,
        sourceFingerprintSha256: '7'.repeat(64)
      }),
      'provenance base allocation'
    );
    await expectSingleRow(
      insertAllocationItem(base.id, graph.orderItemId, 100),
      'provenance base item'
    );

    const activeDraft = await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `insert into refund_allocation_drafts
           (refund_id, state, version, created_by_admin_id, updated_by_admin_id,
            created_correlation_id, updated_correlation_id)
         values ($1, 'active', 1, $2, $2, $3, $3)
         returning id`,
        [graph.refundId, graph.adminId, nextToken('draft')]
      ),
      'one active refund allocation draft'
    );
    await expectConstraint(
      databaseClient.pool.query(
        `insert into refund_allocation_drafts
           (refund_id, state, version, created_by_admin_id, updated_by_admin_id,
            created_correlation_id, updated_correlation_id)
         values ($1, 'active', 2, $2, $2, $3, $3)`,
        [graph.refundId, graph.adminId, nextToken('draft_duplicate')]
      ),
      '23505',
      'a refund has at most one shared active draft'
    );
    await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `insert into refund_allocation_draft_items
           (draft_id, order_item_id, proposed_total_presentment_minor)
         values ($1, $2, 100)
         returning id`,
        [activeDraft.id, graph.orderItemId]
      ),
      'active draft item'
    );
    await expectConstraint(
      databaseClient.pool.query(
        `insert into refund_allocation_draft_items
           (draft_id, order_item_id, proposed_total_presentment_minor)
         values ($1, $2, 90)`,
        [activeDraft.id, graph.orderItemId]
      ),
      '23505',
      'a draft contains at most one row per order item'
    );

    const finalizedDraft = await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `update refund_allocation_drafts
         set state = 'finalized', version = 2, updated_at = clock_timestamp(),
             finalized_at = clock_timestamp()
         where id = $1 and state = 'active' and version = 1
         returning id`,
        [activeDraft.id]
      ),
      'active draft with items transitions to finalized version 2'
    );

    const rootCorrection = await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `insert into refund_reporting_correction_sets
           (refund_id, correction_version, kind, base_allocation_set_id,
            source_fingerprint_sha256, approved_by_admin_id, created_by_admin_id,
            correlation_id)
         values ($1, 1, 'allocation_attribution_correction', $2, repeat('7', 64),
                 $3, $3, $4)
         returning id`,
        [graph.refundId, base.id, graph.adminId, nextToken('root_correction')]
      ),
      'root correction'
    );

    const otherTransaction = await expectSingleRow(
      insertBalanceTransaction({
        sourceFamily: 'refund',
        sourceId: nextToken('re_other_graph'),
        amountMinor: 100,
        netMinor: 100
      }),
      'other correction transaction'
    );
    const otherBase = await expectSingleRow(
      insertAllocationSet({
        balanceTransactionId: otherTransaction.id,
        sourceInternalId: otherGraph.refundId,
        expectedEffectMinor: 100,
        sourceFingerprintSha256: '8'.repeat(64)
      }),
      'other correction base'
    );
    const otherRootCorrection = await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `insert into refund_reporting_correction_sets
           (refund_id, correction_version, kind, base_allocation_set_id,
            source_fingerprint_sha256, approved_by_admin_id, created_by_admin_id,
            correlation_id)
         values ($1, 1, 'allocation_attribution_correction', $2, repeat('8', 64),
                 $3, $3, $4)
         returning id`,
        [otherGraph.refundId, otherBase.id, otherGraph.adminId, nextToken('other_correction')]
      ),
      'other refund correction root'
    );

    await expectConstraint(
      databaseClient.pool.query(
        `insert into refund_reporting_correction_sets
           (refund_id, correction_version, kind, base_allocation_set_id,
            predecessor_correction_set_id, source_fingerprint_sha256,
            approved_by_admin_id, created_by_admin_id, correlation_id)
         values ($1, 2, 'allocation_attribution_correction', $2, $3, repeat('7', 64),
                 $4, $4, $5)`,
        [
          graph.refundId,
          base.id,
          otherRootCorrection.id,
          graph.adminId,
          nextToken('cross_refund_correction')
        ]
      ),
      '23503',
      'a correction predecessor must belong to the same refund graph'
    );

    const correctionSuccessor = await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `insert into refund_reporting_correction_sets
           (refund_id, correction_version, kind, base_allocation_set_id,
            predecessor_correction_set_id, source_fingerprint_sha256,
            approved_by_admin_id, created_by_admin_id, correlation_id)
         values ($1, 2, 'allocation_attribution_correction', $2, $3, repeat('7', 64),
                 $4, $4, $5)
         returning id`,
        [graph.refundId, base.id, rootCorrection.id, graph.adminId, nextToken('correction_2')]
      ),
      'correction successor'
    );
    await expectConstraint(
      databaseClient.pool.query(
        `insert into refund_reporting_correction_sets
           (refund_id, correction_version, kind, base_allocation_set_id,
            predecessor_correction_set_id, source_fingerprint_sha256,
            approved_by_admin_id, created_by_admin_id, correlation_id)
         values ($1, 3, 'allocation_attribution_correction', $2, $3, repeat('7', 64),
                 $4, $4, $5)`,
        [graph.refundId, base.id, rootCorrection.id, graph.adminId, nextToken('correction_fork')]
      ),
      '23505',
      'a correction cannot fork into two direct successors'
    );

    const correctionTieKey = nextToken('correction_tie');
    await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `insert into refund_reporting_correction_items
           (correction_set_id, domain, source_allocation_set_id, order_item_id, component,
            currency, approved_absolute_minor, delta_minor, stable_tie_break_key)
         values ($1, 'settlement', $2, $3, 'refund_subtotal', 'USD', 100, 0, $4)
         returning id`,
        [correctionSuccessor.id, base.id, graph.orderItemId, correctionTieKey]
      ),
      'valid settlement correction item'
    );

    const invalidCorrectionItems = [
      {
        label: 'presentment corrections cannot name a settlement allocation set',
        values: ['presentment', base.id, 'refund_tax'] as const
      },
      {
        label: 'settlement corrections require a source allocation set',
        values: ['settlement', null, 'refund_tax'] as const
      },
      {
        label: 'presentment corrections cannot redistribute provider fees',
        values: ['presentment', null, 'processing_fee'] as const
      },
      {
        label: 'settlement corrections cannot rewrite original sale components',
        values: ['settlement', base.id, 'sale_subtotal'] as const
      }
    ];
    for (const invalid of invalidCorrectionItems) {
      await expectConstraint(
        databaseClient.pool.query(
          `insert into refund_reporting_correction_items
             (correction_set_id, domain, source_allocation_set_id, order_item_id, component,
              currency, approved_absolute_minor, delta_minor, stable_tie_break_key)
           values ($1, $2, $3, $4, $5, 'USD', 0, 0, $6)`,
          [
            correctionSuccessor.id,
            invalid.values[0],
            invalid.values[1],
            graph.orderItemId,
            invalid.values[2],
            nextToken('invalid_correction_item')
          ]
        ),
        '23514',
        invalid.label
      );
    }
    await expectConstraint(
      databaseClient.pool.query(
        `insert into refund_reporting_correction_items
           (correction_set_id, domain, source_allocation_set_id, order_item_id, component,
            currency, approved_absolute_minor, delta_minor, stable_tie_break_key)
         values ($1, 'settlement', $2, $3, 'refund_tax', 'USD', 0, 0, $4)`,
        [correctionSuccessor.id, base.id, otherGraph.orderItemId, correctionTieKey]
      ),
      '23505',
      'stable correction tie keys are unique within a correction set'
    );

    interface FinalizationEffectInput {
      refundId?: string;
      refundAllocationId?: string;
      draftId?: string;
      draftVersion?: number;
      orderItemId?: string;
      purchaseGrantId?: string;
      beforePurchaseGrantState?: 'active' | 'revoked';
      afterPurchaseGrantState?: 'active' | 'revoked';
      beforeEffectiveAccess?: boolean;
      afterEffectiveAccess?: boolean;
      transition?: 'unchanged' | 'revoked_by_finalization';
    }
    const insertFinalizationEffect = (input: FinalizationEffectInput = {}) =>
      databaseClient.pool.query<{ id: string }>(
        `insert into refund_allocation_finalization_effects
           (refund_id, refund_allocation_id, draft_id, draft_version, order_item_id,
            purchase_grant_id, before_purchase_grant_state, after_purchase_grant_state,
            before_effective_access, after_effective_access, transition, correlation_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         returning id`,
        [
          input.refundId ?? graph.refundId,
          input.refundAllocationId ?? graph.refundAllocationId,
          input.draftId ?? finalizedDraft.id,
          input.draftVersion ?? 2,
          input.orderItemId ?? graph.orderItemId,
          input.purchaseGrantId ?? graph.purchaseGrantId,
          input.beforePurchaseGrantState ?? 'active',
          input.afterPurchaseGrantState ?? 'revoked',
          input.beforeEffectiveAccess ?? true,
          input.afterEffectiveAccess ?? true,
          input.transition ?? 'revoked_by_finalization',
          nextToken('finalization')
        ]
      );

    const graphViolations = [
      {
        label: 'the allocation/refund/item triple must identify one exact allocation row',
        input: { refundId: otherGraph.refundId }
      },
      {
        label: 'the draft/refund/version triple must identify one exact draft version',
        input: { draftVersion: 99 }
      },
      {
        label: 'the purchase grant must belong to the exact affected order item',
        input: { purchaseGrantId: otherGraph.purchaseGrantId }
      }
    ];
    for (const invalid of graphViolations) {
      await expectConstraint(insertFinalizationEffect(invalid.input), '23503', invalid.label);
    }

    const alternateTitleId = await createTitle('alternate-draft-item');
    const alternateItem = await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `insert into order_items
           (order_id, title_id, title_snapshot, creator_name_snapshot, format, currency,
            unit_subtotal_minor, tax_minor, total_minor)
         values ($1, $2, 'Alternate title', 'Creator', 'prose', 'USD', 1000, 100, 1100)
         returning id`,
        [graph.orderId, alternateTitleId]
      ),
      'alternate order item for the draft-item provenance check'
    );
    const mismatchedDraft = await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `insert into refund_allocation_drafts
           (refund_id, state, version, created_by_admin_id, updated_by_admin_id,
            created_correlation_id, updated_correlation_id)
         values ($1, 'active', 1, $2, $2, $3, $3)
         returning id`,
        [graph.refundId, graph.adminId, nextToken('mismatched_draft')]
      ),
      'second active draft after the first is finalized'
    );
    await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `insert into refund_allocation_draft_items
           (draft_id, order_item_id, proposed_total_presentment_minor)
         values ($1, $2, 100)
         returning id`,
        [mismatchedDraft.id, alternateItem.id]
      ),
      'mismatched draft contains only the alternate item'
    );
    const finalizedMismatchedDraft = await expectSingleRow(
      databaseClient.pool.query<{ id: string }>(
        `update refund_allocation_drafts
         set state = 'finalized', version = 2, updated_at = clock_timestamp(),
             finalized_at = clock_timestamp()
         where id = $1 and state = 'active' and version = 1
         returning id`,
        [mismatchedDraft.id]
      ),
      'mismatched draft transitions to finalized'
    );
    await expectConstraint(
      insertFinalizationEffect({ draftId: finalizedMismatchedDraft.id, draftVersion: 2 }),
      '23503',
      'finalization provenance requires the exact affected draft item'
    );

    const invalidTransitions = [
      {
        label: 'a revocation transition cannot claim the purchase grant was already revoked',
        input: { beforePurchaseGrantState: 'revoked' as const }
      },
      {
        label: 'a revocation transition must end with the purchase grant revoked',
        input: { afterPurchaseGrantState: 'active' as const }
      }
    ];
    for (const invalid of invalidTransitions) {
      await expectConstraint(insertFinalizationEffect(invalid.input), '23514', invalid.label);
    }

    await databaseClient.pool.query(
      `insert into entitlement_grants
         (title_id, user_id, source, state, state_reason)
       values ($1, $2, 'preserved', 'active', 'pre_commerce_entitlement')`,
      [graph.titleId, graph.userId]
    );
    await databaseClient.pool.query(
      `update entitlement_grants
       set state = 'revoked', state_reason = 'refunded', revoked_at = clock_timestamp(),
           updated_at = clock_timestamp()
       where id = $1`,
      [graph.purchaseGrantId]
    );

    const effect = await expectSingleRow(
      insertFinalizationEffect(),
      'valid finalization provenance can preserve effective access through another grant'
    );
    expect(effect.id).toMatch(/^[0-9a-f-]{36}$/u);
    await expectConstraint(
      insertFinalizationEffect(),
      '23505',
      'replay cannot manufacture a second causal effect for one allocation and grant'
    );
  });
});
