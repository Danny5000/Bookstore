import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { DatabaseMigrationIdentityConfig } from '../../src/lib/server/db/database-role-provision';
import { migrateDatabase } from '../../src/lib/server/db/migrate';

type PrePlan6BInvalidFixtureKind =
  | 'zero-refund'
  | 'zero-allocation'
  | 'zero-dispute'
  | 'over-allocation'
  | 'currency-conflict'
  | 'partial-facts'
  | 'no-allocation-cumulative-over-capacity'
  | 'no-allocation-mixed-over-capacity'
  | 'no-allocation-missing-item-total'
  | 'no-allocation-zero-item-total'
  | 'no-allocation-item-currency-conflict'
  | 'no-allocation-refund-currency-conflict'
  | 'no-allocation-payment-capacity-mismatch'
  | 'no-allocation-mixed-refund-currency-conflict'
  | 'pending-refund-allocation'
  | 'failed-refund-allocation'
  | 'canceled-refund-allocation';

type PostPlan6BInvalidFixtureKind =
  | 'legacy-payout-membership-currency'
  | 'legacy-source-principal';

type ClaimGrantInvalidFixtureKind =
  | 'legacy-claimed-guest-null-grant'
  | 'legacy-paid-guest-missing-grant';

type ClaimAuthorityInvalidFixtureKind =
  | ClaimGrantInvalidFixtureKind
  | 'legacy-claimed-identity-authority'
  | 'legacy-entitlement-projection';

const invalidRefundStatusByFixture: Partial<
  Record<PrePlan6BInvalidFixtureKind, 'pending' | 'failed' | 'canceled'>
> = {
  'pending-refund-allocation': 'pending',
  'failed-refund-allocation': 'failed',
  'canceled-refund-allocation': 'canceled'
};

interface LegacyFixture {
  userId: string;
  titleIds: string[];
  orderIds: string[];
  orderItemIds: string[];
  paymentIds: Record<string, string>;
  refundIds: Record<string, string>;
  disputeIds: Record<string, string>;
  refundAllocationIds: string[];
  sequentialRefundAllocationIds: string[];
  sequentialRefundOrderItemId: string;
  guestClaimFacts: GuestOrderGraph;
  historyIds: Record<'stripeEvent' | 'job' | 'outbox' | 'audit', string>;
  countsBefore: Record<string, number>;
}

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const expectedMigrationPath = resolve(repositoryRoot, 'drizzle', '0007_plan6b_financial_reconciliation.sql');
const PLAN6B_TABLES = [
  'financial_projection_versions',
  'financial_payout_discovery_state',
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
const STORAGE_CLEANUP_INDEXES = [
  'title_revisions_staging_storage_key_idx',
  'title_revisions_original_storage_key_idx',
  'titles_cover_storage_key_idx',
  'jobs_active_ingest_revision_identity_idx'
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[financial-migration-test] ${message}`);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `[financial-migration-test] ${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    );
  }
}

function unwrapPostgresError(error: unknown): { code: string; message: string } | null {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === 'object' && current !== null) {
    if (seen.has(current)) return null;
    seen.add(current);
    let cause: unknown;
    try {
      cause = Reflect.get(current, 'cause');
    } catch {
      return null;
    }
    if (cause === undefined) break;
    current = cause;
  }
  if (typeof current !== 'object' || current === null) return null;
  const code = Reflect.get(current, 'code');
  const message = Reflect.get(current, 'message');
  return typeof code === 'string' && typeof message === 'string' ? { code, message } : null;
}

function observableErrorText(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join('\n');
}

function assertExpectedMigrationFailure(
  error: unknown,
  expectedReason: RegExp,
  fixture:
    | PrePlan6BInvalidFixtureKind
    | PostPlan6BInvalidFixtureKind
    | ClaimAuthorityInvalidFixtureKind
): void {
  const postgresError = unwrapPostgresError(error);
  assert(postgresError !== null, `${fixture} rollback must expose an underlying PostgreSQL error`);
  equal(postgresError.code, '23514', `${fixture} rollback must use PostgreSQL check-violation code`);
  assert(
    expectedReason.test(postgresError.message),
    `${fixture} rollback must identify its safe invariant in the underlying PostgreSQL message`
  );
}

function assertMigrationFailureMatcherRejectsWrapperSql(): void {
  const wrapperMessage = 'Failed query: DO $$ RAISE EXCEPTION MESSAGE = Plan 6B over-allocation/capacity violation $$';
  for (const postgresError of [
    Object.assign(new Error('relation does not exist'), { code: '42P01' }),
    Object.assign(new Error('unrelated check violation'), { code: '23514' })
  ]) {
    let rejected = false;
    try {
      assertExpectedMigrationFailure(
        new Error(wrapperMessage, { cause: postgresError }),
        /(?:over[-_ ]allocation|capacity)/iu,
        'over-allocation'
      );
    } catch {
      rejected = true;
    }
    assert(rejected, 'wrapper SQL text cannot validate an unrelated PostgreSQL failure');
  }
}

async function one<T extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: unknown[] = []
): Promise<T> {
  const result = await client.query<T>(text, values);
  assert(result.rows.length === 1, `expected one row for ${text.slice(0, 80)}`);
  return result.rows[0]!;
}

function databasePool(): Pool {
  const required = [
    'DATABASE_HOST',
    'DATABASE_PORT',
    'DATABASE_NAME',
    'DATABASE_USER',
    'DATABASE_PASSWORD'
  ] as const;
  for (const name of required) assert(process.env[name], `${name} is required`);
  assert(process.env.PLAN6B_UPGRADE_PHASE === 'legacy', 'harness must expose the legacy phase');
  assert(
    process.env.PLAN6B_UPGRADE_OWNED_DATABASE === 'true',
    'refusing to run outside an owned disposable upgrade database'
  );
  assert(
    resolve(process.env.PLAN6B_UPGRADE_MIGRATION_0007 ?? '') === expectedMigrationPath,
    'harness migration path is not the repository 0007 migration'
  );
  return new Pool({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    max: 2,
    connectionTimeoutMillis: 5_000
  });
}

async function createMigrationFolderThrough(
  maxMigrationIndex: 8 | 9 | 10 | 11 | 12 | 13 | 14
): Promise<string> {
  const runId = process.env.PLAN6B_UPGRADE_RUN_ID;
  assert(runId && /^[a-f0-9]{16}$/u.test(runId), 'owned run ID is missing or invalid');
  const folder = join(
    dirname(process.env.PLAN6B_UPGRADE_MANIFEST!),
    `migrations-through-${maxMigrationIndex}`
  );
  await mkdir(join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(
    await readFile(join(repositoryRoot, 'drizzle', 'meta', '_journal.json'), 'utf8')
  ) as { version: string; dialect: string; entries: Array<Record<string, unknown> & { idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= maxMigrationIndex);
  for (const entry of entries) {
    const source = join(repositoryRoot, 'drizzle', `${entry.tag}.sql`);
    await writeFile(join(folder, `${entry.tag}.sql`), await readFile(source));
  }
  await writeFile(
    join(folder, 'meta', '_journal.json'),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
    'utf8'
  );
  return folder;
}

async function insertUserAndTitles(client: PoolClient, count: number): Promise<{
  userId: string;
  titleIds: string[];
}> {
  const userId = randomUUID();
  await client.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Legacy Financial User', $2, true)`,
    [userId, `legacy-${userId}@example.com`]
  );
  await client.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [userId]
  );
  const titleIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    titleIds.push(id);
    await client.query(
      `insert into titles
         (id, slug, title, description, creator_name, format, price_minor, currency)
       values ($1, $2, $3, 'Description', 'Creator', 'prose', 1000, 'USD')`,
      [id, `legacy-${index}-${id}`, `Legacy ${index}`]
    );
  }
  return { userId, titleIds };
}

type PaymentSchemaPhase = 'legacy' | 'plan6b';

async function insertOrderGraph(
  client: PoolClient,
  userId: string,
  titleIds: string[],
  options: {
    key: string;
    orderCurrency?: string;
    itemCurrencies?: string[];
    orderSubtotal?: number;
    orderTax?: number;
    paymentAmount?: number;
    paymentCurrency?: string;
    paymentReconciliation?: 'pending' | 'reconciled' | 'exception';
    paymentSchemaPhase?: PaymentSchemaPhase;
    itemSubtotals?: number[];
    itemTaxes?: number[];
  }
): Promise<{ orderId: string; orderItemIds: string[]; paymentId: string }> {
  const orderId = randomUUID();
  const orderSubtotal = options.orderSubtotal ?? titleIds.length * 1000;
  const orderTax = options.orderTax ?? titleIds.length * 100;
  await client.query(
    `insert into orders
       (id, status, initiating_user_id, purchase_email, currency, subtotal_minor,
        tax_minor, total_minor, client_checkout_attempt_id, quote_fingerprint_sha256,
        status_token_sha256, paid_at)
     values ($1, 'paid', $2, $3, $4, $5, $6, $7, $8, repeat('a', 64),
             repeat('b', 64), clock_timestamp())`,
    [
      orderId,
      userId,
      `${options.key}@example.com`,
      options.orderCurrency ?? 'USD',
      orderSubtotal,
      orderTax,
      orderSubtotal + orderTax,
      randomUUID()
    ]
  );
  const orderItemIds: string[] = [];
  for (const [index, titleId] of titleIds.entries()) {
    const itemId = randomUUID();
    const itemSubtotal = options.itemSubtotals?.[index] ?? 1000;
    const itemTax = options.itemTaxes?.[index] ?? 100;
    orderItemIds.push(itemId);
    await client.query(
      `insert into order_items
         (id, order_id, title_id, title_snapshot, creator_name_snapshot, format,
          currency, unit_subtotal_minor, tax_minor, total_minor)
       values ($1, $2, $3, $4, 'Creator', 'prose', $5, $6, $7, $8)`,
      [
        itemId,
        orderId,
        titleId,
        `Legacy ${options.key} ${index}`,
        options.itemCurrencies?.[index] ?? 'USD',
        itemSubtotal,
        itemTax,
        itemSubtotal + itemTax
      ]
    );
    await client.query(
      `insert into entitlement_grants
         (title_id, user_id, source, order_item_id, state, state_reason)
       values ($1, $2, 'purchase', $3, 'active', 'paid')`,
      [titleId, userId, itemId]
    );
    await client.query(
      `insert into entitlements (user_id, title_id)
       values ($1, $2)
       on conflict (user_id, title_id) do nothing`,
      [userId, titleId]
    );
  }
  const paymentId = randomUUID();
  const paymentParameters = [
    paymentId,
    orderId,
    `pi_${options.key}_${paymentId}`,
    `ch_${options.key}_${paymentId}`,
    options.paymentAmount ?? orderSubtotal + orderTax,
    options.paymentCurrency ?? 'USD'
  ];
  if ((options.paymentSchemaPhase ?? 'legacy') === 'legacy') {
    await client.query(
      `insert into payments
         (id, order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
          amount_minor, currency, paid_at, reconciliation_status)
       values ($1, $2, $3, $4, 'succeeded', $5, $6, clock_timestamp(), $7)`,
      [...paymentParameters, options.paymentReconciliation ?? 'pending']
    );
  } else {
    await client.query(
      `insert into payments
         (id, order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
          amount_minor, currency, paid_at)
       values ($1, $2, $3, $4, 'succeeded', $5, $6, clock_timestamp())`,
      paymentParameters
    );
  }
  return { orderId, orderItemIds, paymentId };
}

interface GuestOrderGraph {
  identityId: string;
  orderId: string;
  orderItemId: string;
  paymentId: string;
  grantId: string | null;
}

async function insertGuestOrderGraph(
  client: PoolClient,
  input: {
    key: string;
    email: string;
    titleId: string;
    claimedByUserId?: string;
    grantUserId?: string;
    includeGrant: boolean;
    paymentSchemaPhase?: PaymentSchemaPhase;
  }
): Promise<GuestOrderGraph> {
  const identityId = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const paymentId = randomUUID();
  const grantId = input.includeGrant ? randomUUID() : null;
  await client.query(
    `insert into guest_identities
       (id, email, claimed_by_user_id, claimed_at)
     values ($1, $2, $3, case when $3::uuid is null then null else clock_timestamp() end)`,
    [identityId, input.email, input.claimedByUserId ?? null]
  );
  await client.query(
    `insert into orders
       (id, status, initiating_user_id, guest_identity_id, purchase_email,
        currency, subtotal_minor, tax_minor, total_minor,
        client_checkout_attempt_id, quote_fingerprint_sha256,
        status_token_sha256, paid_at)
     values ($1, 'paid', null, $2, $3, 'USD', 1000, 100, 1100,
       $4, repeat('c', 64), repeat('d', 64), clock_timestamp())`,
    [orderId, identityId, input.email, randomUUID()]
  );
  await client.query(
    `insert into order_items
       (id, order_id, title_id, title_snapshot, creator_name_snapshot,
        format, currency, unit_subtotal_minor, tax_minor, total_minor)
     values ($1, $2, $3, $4, 'Legacy Guest Creator', 'prose',
       'USD', 1000, 100, 1100)`,
    [orderItemId, orderId, input.titleId, `Legacy guest ${input.key}`]
  );
  const paymentParameters = [
    paymentId,
    orderId,
    `pi_guest_${input.key}_${paymentId}`,
    `ch_guest_${input.key}_${paymentId}`
  ];
  if ((input.paymentSchemaPhase ?? 'legacy') === 'legacy') {
    await client.query(
      `insert into payments
         (id, order_id, stripe_payment_intent_id, stripe_latest_charge_id,
          status, amount_minor, currency, paid_at, reconciliation_status)
       values ($1, $2, $3, $4, 'succeeded', 1100, 'USD',
         clock_timestamp(), 'pending')`,
      paymentParameters
    );
  } else {
    await client.query(
      `insert into payments
         (id, order_id, stripe_payment_intent_id, stripe_latest_charge_id,
          status, amount_minor, currency, paid_at)
       values ($1, $2, $3, $4, 'succeeded', 1100, 'USD', clock_timestamp())`,
      paymentParameters
    );
  }
  if (grantId) {
    await client.query(
      `insert into entitlement_grants
         (id, title_id, user_id, source, order_item_id, state, state_reason)
       values ($1, $2, $3, 'purchase', $4,
         case when $3::uuid is null then 'unclaimed'::entitlement_grant_status
              else 'active'::entitlement_grant_status end,
         'payment_succeeded')`,
      [grantId, input.titleId, input.grantUserId ?? null, orderItemId]
    );
    if (input.grantUserId) {
      await client.query(
        `insert into entitlements (user_id, title_id)
         values ($1, $2)`,
        [input.grantUserId, input.titleId]
      );
    }
  }
  return { identityId, orderId, orderItemId, paymentId, grantId };
}

async function insertRefund(
  client: PoolClient,
  paymentId: string,
  options: {
    key: string;
    refundId?: string;
    providerRefundId?: string;
    status: 'pending' | 'succeeded' | 'failed' | 'canceled';
    amountMinor: number;
    currency?: string;
    reconciliation: 'pending' | 'reconciled' | 'exception';
    providerCreatedAt?: string;
  }
): Promise<string> {
  const refundId = options.refundId ?? randomUUID();
  await client.query(
    `insert into refunds
       (id, payment_id, stripe_refund_id, status, amount_minor, currency,
        provider_created_at, reconciliation_status)
     values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, clock_timestamp()), $8)`,
    [
      refundId,
      paymentId,
      options.providerRefundId ?? `re_${options.key}_${refundId}`,
      options.status,
      options.amountMinor,
      options.currency ?? 'USD',
      options.providerCreatedAt ?? null,
      options.reconciliation
    ]
  );
  return refundId;
}

async function insertDispute(
  client: PoolClient,
  paymentId: string,
  options: {
    key: string;
    amountMinor: number;
    currency?: string;
    reconciliation: 'pending' | 'reconciled' | 'exception';
  }
): Promise<string> {
  const disputeId = randomUUID();
  await client.query(
    `insert into disputes
       (id, payment_id, stripe_dispute_id, status, amount_minor, currency,
        provider_created_at, provider_updated_at, reconciliation_status)
     values ($1, $2, $3, 'open', $4, $5, clock_timestamp(), clock_timestamp(), $6)`,
    [
      disputeId,
      paymentId,
      `dp_${options.key}_${disputeId}`,
      options.amountMinor,
      options.currency ?? 'USD',
      options.reconciliation
    ]
  );
  return disputeId;
}

async function tableCounts(client: Pool | PoolClient, tableNames: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const tableName of tableNames) {
    assert(/^[a-z_]+$/u.test(tableName), 'unsafe table name in count fixture');
    const row = await one<{ count: string }>(client, `select count(*)::text as count from ${tableName}`);
    result[tableName] = Number(row.count);
  }
  return result;
}

async function seedValidLegacyFixture(client: PoolClient): Promise<LegacyFixture> {
  const { userId, titleIds } = await insertUserAndTitles(client, 12);
  const paymentIds: Record<string, string> = {};
  const refundIds: Record<string, string> = {};
  const disputeIds: Record<string, string> = {};
  const orderIds: string[] = [];
  const orderItemIds: string[] = [];
  const refundAllocationIds: string[] = [];
  const sequentialRefundAllocationIds: string[] = [];

  const full = await insertOrderGraph(client, userId, [titleIds[0]!], {
    key: 'full',
    paymentReconciliation: 'reconciled'
  });
  orderIds.push(full.orderId);
  orderItemIds.push(...full.orderItemIds);
  paymentIds.reconciled = full.paymentId;
  const fullRefundId = await insertRefund(client, full.paymentId, {
    key: 'full',
    status: 'succeeded',
    amountMinor: 1100,
    reconciliation: 'reconciled'
  });
  refundIds.full = fullRefundId;
  const allocationId = randomUUID();
  refundAllocationIds.push(allocationId);
  await client.query(
    `insert into refund_allocations (id, refund_id, order_item_id, amount_minor, source)
     values ($1, $2, $3, 1100, 'automatic')`,
    [allocationId, fullRefundId, full.orderItemIds[0]]
  );

  const ambiguous = await insertOrderGraph(client, userId, [titleIds[1]!, titleIds[2]!], {
    key: 'ambiguous',
    paymentReconciliation: 'pending'
  });
  orderIds.push(ambiguous.orderId);
  orderItemIds.push(...ambiguous.orderItemIds);
  paymentIds.pending = ambiguous.paymentId;
  refundIds.ambiguous = await insertRefund(client, ambiguous.paymentId, {
    key: 'ambiguous',
    status: 'succeeded',
    amountMinor: 500,
    reconciliation: 'exception'
  });

  const failed = await insertOrderGraph(client, userId, [titleIds[3]!], {
    key: 'failed-refund',
    paymentReconciliation: 'pending'
  });
  orderIds.push(failed.orderId);
  orderItemIds.push(...failed.orderItemIds);
  refundIds.failed = await insertRefund(client, failed.paymentId, {
    key: 'failed',
    status: 'failed',
    amountMinor: 300,
    reconciliation: 'exception'
  });

  const paymentExceptionPending = await insertOrderGraph(client, userId, [titleIds[4]!], {
    key: 'payment-exception-pending',
    paymentReconciliation: 'exception'
  });
  orderIds.push(paymentExceptionPending.orderId);
  orderItemIds.push(...paymentExceptionPending.orderItemIds);
  paymentIds.exceptionPending = paymentExceptionPending.paymentId;

  const paymentExceptionDurable = await insertOrderGraph(client, userId, [titleIds[5]!], {
    key: 'payment-exception-durable',
    paymentAmount: 999,
    paymentReconciliation: 'exception'
  });
  orderIds.push(paymentExceptionDurable.orderId);
  orderItemIds.push(...paymentExceptionDurable.orderItemIds);
  paymentIds.exceptionDurable = paymentExceptionDurable.paymentId;

  const disputePendingGraph = await insertOrderGraph(client, userId, [titleIds[6]!], {
    key: 'dispute-pending',
    paymentReconciliation: 'pending'
  });
  orderIds.push(disputePendingGraph.orderId);
  orderItemIds.push(...disputePendingGraph.orderItemIds);
  disputeIds.exceptionPending = await insertDispute(client, disputePendingGraph.paymentId, {
    key: 'exception-pending',
    amountMinor: 1100,
    reconciliation: 'exception'
  });

  const disputeDurableGraph = await insertOrderGraph(client, userId, [titleIds[7]!], {
    key: 'dispute-durable',
    paymentReconciliation: 'pending'
  });
  orderIds.push(disputeDurableGraph.orderId);
  orderItemIds.push(...disputeDurableGraph.orderItemIds);
  disputeIds.exceptionDurable = await insertDispute(client, disputeDurableGraph.paymentId, {
    key: 'exception-durable',
    amountMinor: 1200,
    reconciliation: 'exception'
  });

  const disputeReconciledGraph = await insertOrderGraph(client, userId, [titleIds[8]!], {
    key: 'dispute-reconciled',
    paymentReconciliation: 'pending'
  });
  orderIds.push(disputeReconciledGraph.orderId);
  orderItemIds.push(...disputeReconciledGraph.orderItemIds);
  disputeIds.reconciled = await insertDispute(client, disputeReconciledGraph.paymentId, {
    key: 'reconciled',
    amountMinor: 1100,
    reconciliation: 'reconciled'
  });

  const refundDurableGraph = await insertOrderGraph(client, userId, [titleIds[9]!], {
    key: 'refund-durable',
    paymentReconciliation: 'pending'
  });
  orderIds.push(refundDurableGraph.orderId);
  orderItemIds.push(...refundDurableGraph.orderItemIds);
  refundIds.exceptionDurable = await insertRefund(client, refundDurableGraph.paymentId, {
    key: 'exception-durable',
    status: 'failed',
    amountMinor: 1200,
    reconciliation: 'exception'
  });

  const zeroPayment = await insertOrderGraph(client, userId, [titleIds[11]!], {
    key: 'zero-payment',
    orderSubtotal: 0,
    orderTax: 0,
    paymentAmount: 0,
    paymentReconciliation: 'pending',
    itemSubtotals: [0],
    itemTaxes: [0]
  });
  orderIds.push(zeroPayment.orderId);
  orderItemIds.push(...zeroPayment.orderItemIds);
  paymentIds.zero = zeroPayment.paymentId;

  const sequential = await insertOrderGraph(client, userId, [titleIds[10]!], {
    key: 'sequential-partial',
    orderSubtotal: 2,
    orderTax: 1,
    paymentAmount: 3,
    paymentReconciliation: 'pending',
    itemSubtotals: [2],
    itemTaxes: [1]
  });
  orderIds.push(sequential.orderId);
  orderItemIds.push(...sequential.orderItemIds);
  paymentIds.sequential = sequential.paymentId;
  const sequentialChronology = [
    {
      key: 'sequentialFirst',
      refundId: 'ffffffff-ffff-4fff-bfff-fffffffffff4',
      providerRefundId: 're_sequential_a'
    },
    {
      key: 'sequentialSecond',
      refundId: '00000000-0000-4000-8000-000000000004',
      providerRefundId: 're_sequential_b'
    },
    {
      key: 'sequentialThird',
      refundId: '77777777-7777-4777-a777-777777777774',
      providerRefundId: 're_sequential_c'
    }
  ] as const;
  for (const chronology of sequentialChronology) {
    const refundId = await insertRefund(client, sequential.paymentId, {
      ...chronology,
      status: 'succeeded',
      amountMinor: 1,
      reconciliation: 'pending',
      providerCreatedAt: '2026-08-01T00:00:00.000Z'
    });
    refundIds[chronology.key] = refundId;
    const sequentialAllocationId = randomUUID();
    refundAllocationIds.push(sequentialAllocationId);
    sequentialRefundAllocationIds.push(sequentialAllocationId);
    await client.query(
      `insert into refund_allocations (id, refund_id, order_item_id, amount_minor, source)
       values ($1, $2, $3, 1, 'automatic')`,
      [sequentialAllocationId, refundId, sequential.orderItemIds[0]]
    );
  }

  const guestClaimFacts = await insertGuestOrderGraph(client, {
    key: 'valid-unclaimed',
    email: 'legacy-unclaimed-guest@example.com',
    titleId: titleIds[0]!,
    includeGrant: true,
    paymentSchemaPhase: 'legacy'
  });
  orderIds.push(guestClaimFacts.orderId);
  orderItemIds.push(guestClaimFacts.orderItemId);
  paymentIds.guestClaim = guestClaimFacts.paymentId;

  const historyIds = {
    stripeEvent: randomUUID(),
    job: randomUUID(),
    outbox: randomUUID(),
    audit: randomUUID()
  };
  await client.query(
    `insert into stripe_events
       (id, provider_event_id, event_type, object_id, live_mode, provider_created_at,
        raw_body_sha256)
     values ($1, $2, 'charge.succeeded', $3, false, clock_timestamp(), repeat('c', 64))`,
    [historyIds.stripeEvent, `evt_${historyIds.stripeEvent}`, `pi_${full.paymentId}`]
  );
  await client.query(
    `insert into jobs (id, type, payload, deduplication_key)
     values ($1, 'email.send', '{"fixture":true}'::jsonb, $2)`,
    [historyIds.job, `legacy-job-${historyIds.job}`]
  );
  await client.query(
    `insert into outbox_messages (id, topic, payload, dispatch_job_id, deduplication_key)
     values ($1, 'email.receipt', '{"fixture":true}'::jsonb, $2, $3)`,
    [historyIds.outbox, historyIds.job, `legacy-outbox-${historyIds.outbox}`]
  );
  await client.query(
    `insert into audit_events
       (id, actor_type, actor_id, action, outcome, resource_type, resource_id, correlation_id)
     values ($1, 'system', 'upgrade-fixture', 'commerce.fixture', 'succeeded',
             'order', $2, $3)`,
    [historyIds.audit, full.orderId, randomUUID()]
  );

  const preservedTables = [
    'orders',
    'order_items',
    'payments',
    'refunds',
    'refund_allocations',
    'disputes',
    'entitlement_grants',
    'entitlements',
    'guest_identities',
    'stripe_events',
    'jobs',
    'outbox_messages',
    'audit_events'
  ];
  return {
    userId,
    titleIds,
    orderIds,
    orderItemIds,
    paymentIds,
    refundIds,
    disputeIds,
    refundAllocationIds,
    sequentialRefundAllocationIds,
    sequentialRefundOrderItemId: sequential.orderItemIds[0]!,
    guestClaimFacts,
    historyIds,
    countsBefore: await tableCounts(client, preservedTables)
  };
}

async function seedInvalidLegacyFixture(
  client: PoolClient,
  kind: PrePlan6BInvalidFixtureKind
): Promise<void> {
  const { userId, titleIds } = await insertUserAndTitles(client, 2);
  const invalidRefundStatus = invalidRefundStatusByFixture[kind];
  const graph = await insertOrderGraph(client, userId, titleIds, {
    key: kind,
    ...(kind === 'currency-conflict' || kind === 'no-allocation-item-currency-conflict'
      ? { itemCurrencies: ['USD', 'EUR'] }
      : {}),
    ...(kind === 'no-allocation-zero-item-total'
      ? { itemSubtotals: [0, 1000], itemTaxes: [0, 100] }
      : {}),
    ...(kind === 'no-allocation-payment-capacity-mismatch' ? { paymentAmount: 2100 } : {})
  });
  if (kind === 'no-allocation-missing-item-total') {
    await client.query(
      `update order_items set tax_minor = null, total_minor = null where id = $1`,
      [graph.orderItemIds[0]]
    );
  }
  if (kind === 'zero-dispute') {
    await insertDispute(client, graph.paymentId, {
      key: kind,
      amountMinor: 0,
      reconciliation: 'exception'
    });
    return;
  }
  if (kind.startsWith('no-allocation-')) {
    const firstAmount = kind === 'no-allocation-cumulative-over-capacity' ? 1200 : 500;
    const firstRefundId = await insertRefund(client, graph.paymentId, {
      key: `${kind}-first`,
      status: 'succeeded',
      amountMinor: firstAmount,
      currency: kind === 'no-allocation-refund-currency-conflict' ? 'EUR' : 'USD',
      reconciliation: 'exception',
      providerCreatedAt: '2026-08-01T00:00:00.000Z'
    });
    if (kind === 'no-allocation-cumulative-over-capacity') {
      await insertRefund(client, graph.paymentId, {
        key: `${kind}-second`,
        status: 'succeeded',
        amountMinor: 1200,
        reconciliation: 'exception',
        providerCreatedAt: '2026-08-02T00:00:00.000Z'
      });
    } else if (kind === 'no-allocation-mixed-over-capacity') {
      await client.query(
        `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
         values ($1, $2, 500, 'automatic')`,
        [firstRefundId, graph.orderItemIds[0]]
      );
      await insertRefund(client, graph.paymentId, {
        key: `${kind}-second`,
        status: 'succeeded',
        amountMinor: 1800,
        reconciliation: 'exception',
        providerCreatedAt: '2026-08-02T00:00:00.000Z'
      });
    } else if (kind === 'no-allocation-mixed-refund-currency-conflict') {
      await insertRefund(client, graph.paymentId, {
        key: `${kind}-failed`,
        status: 'failed',
        amountMinor: 300,
        currency: 'EUR',
        reconciliation: 'exception',
        providerCreatedAt: '2026-08-02T00:00:00.000Z'
      });
    }
    return;
  }
  const refundId = await insertRefund(client, graph.paymentId, {
    key: kind,
    status: invalidRefundStatus ?? 'succeeded',
    amountMinor: kind === 'zero-refund' ? 0 : kind === 'over-allocation' ? 1100 : 500,
    reconciliation: invalidRefundStatus === undefined ? 'exception' : 'pending'
  });
  if (kind === 'zero-refund') return;
  if (invalidRefundStatus !== undefined) {
    await client.query(
      `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
       values ($1, $2, 250, 'automatic'), ($1, $3, 250, 'automatic')`,
      [refundId, graph.orderItemIds[0], graph.orderItemIds[1]]
    );
  } else if (kind === 'zero-allocation') {
    await client.query(
      `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
       values ($1, $2, 500, 'automatic'), ($1, $3, 0, 'automatic')`,
      [refundId, graph.orderItemIds[0], graph.orderItemIds[1]]
    );
  } else if (kind === 'over-allocation') {
    await client.query(
      `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
       values ($1, $2, 700, 'automatic'), ($1, $3, 700, 'automatic')`,
      [refundId, graph.orderItemIds[0], graph.orderItemIds[1]]
    );
  } else if (kind === 'currency-conflict') {
    await client.query(
      `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
       values ($1, $2, 250, 'automatic'), ($1, $3, 250, 'automatic')`,
      [refundId, graph.orderItemIds[0], graph.orderItemIds[1]]
    );
  } else {
    await client.query(
      `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
       values ($1, $2, 200, 'automatic')`,
      [refundId, graph.orderItemIds[0]]
    );
  }
}

async function migrationCount(pool: Pool | PoolClient): Promise<number> {
  const row = await one<{ count: string }>(
    pool,
    `select count(*)::text as count from drizzle.__drizzle_migrations`
  );
  return Number(row.count);
}

interface LegacySourcePrincipalConflict {
  readonly paymentBalanceId: string;
  readonly paymentAmountMinor: number;
  readonly refundBalanceId: string;
  readonly refundAmountMinor: number;
  readonly disputePresentmentId: string;
  readonly disputeAmountMinor: number;
  readonly disputeSubtotalMinor: number;
  readonly disputeTaxMinor: number;
}

async function seedLegacyPayoutMembershipCurrencyConflict(pool: Pool): Promise<string> {
  const payoutId = randomUUID();
  const balanceId = randomUUID();
  const runId = randomUUID();
  await pool.query(
    `insert into stripe_payouts (
       id, provider_id, live_mode, amount_minor, currency, automatic, method, status,
       reconciliation_status, provider_created_at, arrival_at, retrieved_at,
       fingerprint_sha256
     ) values (
       $1, $2, false, 100, 'USD', true, 'standard', 'paid', 'not_applicable',
       clock_timestamp(), clock_timestamp(), clock_timestamp(), repeat('a', 64)
     )`,
    [payoutId, `po_legacy_currency_${payoutId}`]
  );
  await pool.query(
    `insert into stripe_balance_transactions (
       id, provider_id, live_mode, raw_type, reporting_category, balance_type,
       amount_minor, fee_minor, net_minor, currency, status, provider_created_at,
       available_at, fingerprint_sha256
     ) values (
       $1, $2, false, 'adjustment', 'adjustment', 'payments', 100, 0, 100,
       'EUR', 'available', clock_timestamp(), clock_timestamp(), repeat('b', 64)
     )`,
    [balanceId, `bt_legacy_currency_${balanceId}`]
  );
  await pool.query(
    `insert into payout_import_runs (
       id, payout_id, generation, state, candidate_count, page_count, safe_outcome,
       completed_at
     ) values ($1, $2, 0, 'published', 1, 1, 'published', clock_timestamp())`,
    [runId, payoutId]
  );
  await pool.query(
    `insert into stripe_payout_balance_transactions (
       payout_id, balance_transaction_id, published_from_run_id
     ) values ($1, $2, $3)`,
    [payoutId, balanceId, runId]
  );
  return balanceId;
}

async function seedLegacySourcePrincipalConflict(
  pool: Pool,
  fixture: LegacyFixture
): Promise<LegacySourcePrincipalConflict> {
  const payment = await one<{
    amount_minor: number;
    currency: string;
    stripe_latest_charge_id: string;
    order_item_id: string;
    item_subtotal_minor: number;
    item_tax_minor: number;
  }>(
    pool,
    `select payment.amount_minor, payment.currency, payment.stripe_latest_charge_id,
       order_item.id as order_item_id,
       order_item.unit_subtotal_minor as item_subtotal_minor,
       order_item.tax_minor as item_tax_minor
     from payments payment
     join order_items order_item on order_item.order_id = payment.order_id
     where payment.id = $1
     order by order_item.id
     limit 1`,
    [fixture.paymentIds.reconciled]
  );
  const refund = await one<{
    amount_minor: number;
    currency: string;
    stripe_refund_id: string;
  }>(
    pool,
    `select amount_minor, currency, stripe_refund_id from refunds where id = $1`,
    [fixture.refundIds.full]
  );
  const dispute = await one<{
    amount_minor: number;
    currency: string;
    stripe_dispute_id: string;
    order_item_id: string;
    item_subtotal_minor: number;
    item_tax_minor: number;
  }>(
    pool,
    `select dispute.amount_minor, dispute.currency, dispute.stripe_dispute_id,
       order_item.id as order_item_id,
       order_item.unit_subtotal_minor as item_subtotal_minor,
       order_item.tax_minor as item_tax_minor
     from disputes dispute
     join payments payment on payment.id = dispute.payment_id
     join order_items order_item on order_item.order_id = payment.order_id
     where dispute.id = $1
     order by order_item.id
     limit 1`,
    [fixture.disputeIds.reconciled]
  );
  const statusClient = await pool.connect();
  try {
    await statusClient.query('begin');
    await statusClient.query('set local session_replication_role = replica');
    await statusClient.query(
      `update payments set financial_evidence_status = 'fee_reconciled' where id = $1`,
      [fixture.paymentIds.reconciled]
    );
    await statusClient.query(
      `update refunds set financial_evidence_status = 'fee_reconciled' where id = $1`,
      [fixture.refundIds.full]
    );
    await statusClient.query(
      `update disputes set financial_evidence_status = 'fee_reconciled' where id = $1`,
      [fixture.disputeIds.reconciled]
    );
    await statusClient.query('commit');
  } catch (error) {
    await statusClient.query('rollback');
    throw error;
  } finally {
    statusClient.release();
  }
  const statuses = await pool.query<{ source_type: string; evidence_status: string }>(
    `select 'payment'::text as source_type, financial_evidence_status::text as evidence_status
       from payments where id = $1
     union all
     select 'refund', financial_evidence_status::text from refunds where id = $2
     union all
     select 'dispute', financial_evidence_status::text from disputes where id = $3
     order by source_type`,
    [fixture.paymentIds.reconciled, fixture.refundIds.full, fixture.disputeIds.reconciled]
  );
  equal(
    statuses.rows,
    [
      { source_type: 'dispute', evidence_status: 'fee_reconciled' },
      { source_type: 'payment', evidence_status: 'fee_reconciled' },
      { source_type: 'refund', evidence_status: 'fee_reconciled' }
    ],
    'late-upgrade source-principal witnesses start fee-reconciled'
  );

  const paymentBalanceId = randomUUID();
  const refundBalanceId = randomUUID();
  const disputeBalanceId = randomUUID();
  const paymentGrossSetId = randomUUID();
  const paymentFeeSetId = randomUUID();
  const refundGrossSetId = randomUUID();
  const refundFeeSetId = randomUUID();
  const disputeSetId = randomUUID();
  const disputeFeeSetId = randomUUID();
  const disputePresentmentId = randomUUID();
  await pool.query(
    `insert into stripe_balance_transactions (
       id, provider_id, live_mode, source_family, source_id, raw_type,
       reporting_category, balance_type, amount_minor, fee_minor, net_minor,
       currency, status, provider_created_at, available_at, fingerprint_sha256
     ) values
       ($1, $2, false, 'charge', $3, 'charge', 'charge', 'payments', $4, 0, $4,
         $5, 'available', '2026-08-01T00:00:00.000Z',
         '2026-08-01T00:00:00.000Z', repeat('c', 64)),
       ($6, $7, false, 'refund', $8, 'refund', 'refund', 'payments', $9, 0, $9,
         $10, 'available', '2026-08-02T00:00:00.000Z',
         '2026-08-02T00:00:00.000Z', repeat('d', 64)),
       ($11, $12, false, 'dispute', $13, 'adjustment', 'dispute', 'payments',
         $14, 0, $14, $15, 'available', '2026-08-03T00:00:00.000Z',
         '2026-08-03T00:00:00.000Z', repeat('e', 64))`,
    [
      paymentBalanceId,
      `bt_legacy_payment_${paymentBalanceId}`,
      payment.stripe_latest_charge_id,
      payment.amount_minor,
      payment.currency,
      refundBalanceId,
      `bt_legacy_refund_${refundBalanceId}`,
      refund.stripe_refund_id,
      -refund.amount_minor,
      refund.currency,
      disputeBalanceId,
      `bt_legacy_dispute_${disputeBalanceId}`,
      dispute.stripe_dispute_id,
      -dispute.amount_minor,
      dispute.currency
    ]
  );
  await pool.query(
    `insert into financial_classification_versions (
       subject_type, subject_id, classifier_version, classification,
       source_fingerprint_sha256
     ) values
       ('balance_transaction', $1, 1, 'charge', repeat('c', 64)),
       ('balance_transaction', $2, 1, 'refund', repeat('d', 64)),
       ('balance_transaction', $3, 1, 'dispute_withdrawal', repeat('e', 64))`,
    [paymentBalanceId, refundBalanceId, disputeBalanceId]
  );
  await pool.query(
    `insert into financial_allocation_sets (
       id, allocation_identity, balance_transaction_id, source_kind,
       source_internal_id, basis, scope, expected_effect_minor, currency,
       algorithm_version, classifier_version, source_fingerprint_sha256
     ) values
       ($1, $2, $3, 'payment', $4, 'gross_amount', 'title', $5, $6, 1, 1,
         repeat('c', 64)),
       ($7, $8, $3, 'payment', $4, 'fee', 'title', 0, $6, 1, 1,
         repeat('c', 64)),
       ($9, $10, $11, 'refund', $12, 'gross_amount', 'title', $13, $14, 1, 1,
         repeat('d', 64)),
       ($15, $16, $11, 'refund', $12, 'fee', 'title', 0, $14, 1, 1,
         repeat('d', 64)),
       ($17, $18, $19, 'dispute', $20, 'gross_amount', 'title', $21, $22, 1, 1,
         repeat('e', 64)),
       ($23, $24, $19, 'dispute', $20, 'fee', 'title', 0, $22, 1, 1,
         repeat('e', 64))`,
    [
      paymentGrossSetId,
      `legacy-payment-principal:${paymentGrossSetId}`,
      paymentBalanceId,
      fixture.paymentIds.reconciled,
      payment.amount_minor,
      payment.currency,
      paymentFeeSetId,
      `legacy-payment-fee:${paymentFeeSetId}`,
      refundGrossSetId,
      `legacy-refund-principal:${refundGrossSetId}`,
      refundBalanceId,
      fixture.refundIds.full,
      -refund.amount_minor,
      refund.currency,
      refundFeeSetId,
      `legacy-refund-fee:${refundFeeSetId}`,
      disputeSetId,
      `legacy-dispute-principal:${disputeSetId}`,
      disputeBalanceId,
      fixture.disputeIds.reconciled,
      -dispute.amount_minor,
      dispute.currency,
      disputeFeeSetId,
      `legacy-dispute-fee:${disputeFeeSetId}`
    ]
  );
  await pool.query(
    `insert into financial_item_allocations (
       allocation_set_id, order_item_id, component, effect_minor, currency,
       tie_break_key
     ) values
       ($1, $2, 'sale_subtotal', $3, $4, $5),
       ($1, $2, 'sale_tax', $6, $4, $7),
       ($8, $2, 'refund_subtotal', $9, $4, $10),
       ($8, $2, 'refund_tax', $11, $4, $12),
       ($13, $14, 'dispute_subtotal', $15, $16, $17),
       ($13, $14, 'dispute_tax', $18, $16, $19)`,
    [
      paymentGrossSetId,
      payment.order_item_id,
      payment.item_subtotal_minor,
      payment.currency,
      `legacy-payment-subtotal:${paymentGrossSetId}`,
      payment.item_tax_minor,
      `legacy-payment-tax:${paymentGrossSetId}`,
      refundGrossSetId,
      -payment.item_subtotal_minor,
      `legacy-refund-subtotal:${refundGrossSetId}`,
      -payment.item_tax_minor,
      `legacy-refund-tax:${refundGrossSetId}`,
      disputeSetId,
      dispute.order_item_id,
      -dispute.item_subtotal_minor,
      dispute.currency,
      `legacy-dispute-subtotal:${disputeSetId}`,
      -dispute.item_tax_minor,
      `legacy-dispute-tax:${disputeSetId}`
    ]
  );
  await pool.query(
    `insert into dispute_item_allocations (
       id, allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
       effect, subtotal_effect_minor, tax_effect_minor, total_effect_minor, currency
     ) values ($1, $2, $3, $4, $5, 'withdrawal', $6, $7, $8, $9)`,
    [
      disputePresentmentId,
      `legacy-dispute-presentment:${disputePresentmentId}`,
      fixture.disputeIds.reconciled,
      disputeSetId,
      dispute.order_item_id,
      -dispute.item_subtotal_minor,
      -dispute.item_tax_minor,
      -dispute.amount_minor,
      dispute.currency
    ]
  );
  return {
    paymentBalanceId,
    paymentAmountMinor: payment.amount_minor,
    refundBalanceId,
    refundAmountMinor: refund.amount_minor,
    disputePresentmentId,
    disputeAmountMinor: dispute.amount_minor,
    disputeSubtotalMinor: dispute.item_subtotal_minor,
    disputeTaxMinor: dispute.item_tax_minor
  };
}

async function selectLegacySourcePrincipalConflict(
  pool: Pool,
  fixture: LegacySourcePrincipalConflict,
  active: 'payment' | 'refund' | 'dispute' | null
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const paymentAmount = fixture.paymentAmountMinor - (active === 'payment' ? 1 : 0);
    const refundAmount = -(fixture.refundAmountMinor - (active === 'refund' ? 1 : 0));
    const disputeSubtotal = -fixture.disputeSubtotalMinor +
      (active === 'dispute' ? 1 : 0);
    const disputeTax = -fixture.disputeTaxMinor;
    const disputeAmount = disputeSubtotal + disputeTax;
    await client.query(
      `update stripe_balance_transactions set amount_minor = $1, net_minor = $1
       where id = $2`,
      [paymentAmount, fixture.paymentBalanceId]
    );
    await client.query(
      `update stripe_balance_transactions set amount_minor = $1, net_minor = $1
       where id = $2`,
      [refundAmount, fixture.refundBalanceId]
    );
    await client.query(
      `update dispute_item_allocations
       set subtotal_effect_minor = $1, tax_effect_minor = $2, total_effect_minor = $3
       where id = $4`,
      [disputeSubtotal, disputeTax, disputeAmount, fixture.disputePresentmentId]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function assertValidBackfill(pool: Pool, fixture: LegacyFixture): Promise<void> {
  const disputeAllocationColumn = await one<{
    is_nullable: string;
  }>(
    pool,
    `select is_nullable
     from information_schema.columns
     where table_schema = 'public' and table_name = 'dispute_item_allocations'
       and column_name = 'gross_allocation_set_id'`
  );
  equal(
    disputeAllocationColumn.is_nullable,
    'NO',
    '0006-to-0007 upgrade creates a non-null dispute gross-set identity'
  );
  const disputeAllocationConstraints = await pool.query<{ definition: string }>(
    `select pg_get_constraintdef(oid) as definition
     from pg_constraint
     where conrelid = 'public.dispute_item_allocations'::regclass`
  );
  assert(
    disputeAllocationConstraints.rows.some((row) =>
      /foreign key \(gross_allocation_set_id, dispute_id\) references financial_allocation_sets\(id, source_internal_id\)/iu
        .test(row.definition)
    ),
    '0006-to-0007 upgrade installs the dispute/source-identity graph foreign key'
  );
  const disputeAllocationTrigger = await one<{ function_name: string }>(
    pool,
    `select procedure.proname as function_name
     from pg_trigger trigger
     join pg_proc procedure on procedure.oid = trigger.tgfoid
     where trigger.tgrelid = 'public.dispute_item_allocations'::regclass
       and trigger.tgname = 'dispute_item_allocations_validate_gross_set'
       and not trigger.tgisinternal`
  );
  equal(
    disputeAllocationTrigger.function_name,
    'plan6b_validate_dispute_gross_allocation_set',
    '0006-to-0007 upgrade installs the dispute gross-set validation trigger'
  );

  const paymentRows = await pool.query<{
    id: string;
    financial_evidence_status: string;
  }>(
    `select id, financial_evidence_status
     from payments
     where id = any($1::uuid[])
     order by id`,
    [Object.values(fixture.paymentIds)]
  );
  const paymentStates = Object.fromEntries(
    paymentRows.rows.map((row) => [row.id, row.financial_evidence_status])
  );
  equal(paymentStates[fixture.paymentIds.pending!], 'pending', 'legacy payment pending stays pending');
  equal(
    paymentStates[fixture.paymentIds.reconciled!],
    'pending',
    'legacy payment reconciled maps to pending'
  );
  equal(
    paymentStates[fixture.paymentIds.exceptionPending!],
    'pending',
    'unproven legacy payment exception maps to pending'
  );
  equal(
    paymentStates[fixture.paymentIds.exceptionDurable!],
    'exception',
    'fact-derived payment amount conflict remains exception'
  );
  equal(paymentStates[fixture.paymentIds.zero!], 'pending', 'zero-valued payments remain supported');

  const refundRows = await pool.query<{
    id: string;
    allocation_status: string;
    financial_evidence_status: string;
  }>(
    `select id, allocation_status, financial_evidence_status
     from refunds
     where id = any($1::uuid[])
     order by id`,
    [Object.values(fixture.refundIds)]
  );
  const refundStates = Object.fromEntries(refundRows.rows.map((row) => [row.id, row]));
  equal(
    {
      allocation: refundStates[fixture.refundIds.full!]!.allocation_status,
      evidence: refundStates[fixture.refundIds.full!]!.financial_evidence_status
    },
    { allocation: 'finalized', evidence: 'pending' },
    'complete succeeded allocation is finalized while provider evidence remains pending'
  );
  equal(
    {
      allocation: refundStates[fixture.refundIds.ambiguous!]!.allocation_status,
      evidence: refundStates[fixture.refundIds.ambiguous!]!.financial_evidence_status
    },
    { allocation: 'needs_review', evidence: 'pending' },
    'valid ambiguous legacy exception becomes needs-review pending'
  );
  equal(
    {
      allocation: refundStates[fixture.refundIds.failed!]!.allocation_status,
      evidence: refundStates[fixture.refundIds.failed!]!.financial_evidence_status
    },
    { allocation: 'not_applicable', evidence: 'pending' },
    'non-succeeded refund has no allocation state and no mechanical exception'
  );
  equal(
    {
      allocation: refundStates[fixture.refundIds.exceptionDurable!]!.allocation_status,
      evidence: refundStates[fixture.refundIds.exceptionDurable!]!.financial_evidence_status
    },
    { allocation: 'not_applicable', evidence: 'exception' },
    'failed refund with a locally proven payment over-cap remains an evidence exception'
  );

  const disputeRows = await pool.query<{
    id: string;
    financial_evidence_status: string;
  }>(
    `select id, financial_evidence_status
     from disputes
     where id = any($1::uuid[])
     order by id`,
    [Object.values(fixture.disputeIds)]
  );
  const disputeStates = Object.fromEntries(
    disputeRows.rows.map((row) => [row.id, row.financial_evidence_status])
  );
  equal(
    disputeStates[fixture.disputeIds.reconciled!],
    'pending',
    'legacy dispute reconciled maps to pending'
  );
  equal(
    disputeStates[fixture.disputeIds.exceptionPending!],
    'pending',
    'unproven legacy dispute exception maps to pending'
  );
  equal(
    disputeStates[fixture.disputeIds.exceptionDurable!],
    'exception',
    'fact-derived dispute over-cap remains exception'
  );

  const components = await pool.query<{
    refund_allocation_id: string;
    order_item_id: string;
    subtotal_minor: number;
    tax_minor: number;
    total_minor: number;
    currency: string;
  }>(
    `select refund_allocation_id, order_item_id, subtotal_minor, tax_minor,
            total_minor, currency
     from refund_allocation_components
     order by refund_allocation_id`
  );
  const componentsByAllocationId = Object.fromEntries(
    components.rows.map((component) => [component.refund_allocation_id, component])
  );
  equal(
    componentsByAllocationId[fixture.refundAllocationIds[0]!],
    {
      refund_allocation_id: fixture.refundAllocationIds[0],
      order_item_id: fixture.orderItemIds[0],
      subtotal_minor: 1000,
      tax_minor: 100,
      total_minor: 1100,
      currency: 'USD'
    },
    'automatic full allocation receives exact deterministic subtotal/tax components'
  );
  equal(
    fixture.sequentialRefundAllocationIds.map((id) => componentsByAllocationId[id]),
    [
      {
        refund_allocation_id: fixture.sequentialRefundAllocationIds[0]!,
        order_item_id: fixture.sequentialRefundOrderItemId,
        subtotal_minor: 1,
        tax_minor: 0,
        total_minor: 1,
        currency: 'USD'
      },
      {
        refund_allocation_id: fixture.sequentialRefundAllocationIds[1]!,
        order_item_id: fixture.sequentialRefundOrderItemId,
        subtotal_minor: 1,
        tax_minor: 0,
        total_minor: 1,
        currency: 'USD'
      },
      {
        refund_allocation_id: fixture.sequentialRefundAllocationIds[2]!,
        order_item_id: fixture.sequentialRefundOrderItemId,
        subtotal_minor: 0,
        tax_minor: 1,
        total_minor: 1,
        currency: 'USD'
      }
    ],
    'chronological partial allocations use LRM over remaining capacity through unequal, equal, and exhausted weights'
  );

  const issues = await pool.query<{
    resource_id: string;
    safe_code: string;
    impact: string;
    state: string;
  }>(
    `select resource_id, safe_code, impact, state
     from financial_reconciliation_issues
     where resource_type = 'refund'
     order by resource_id, safe_code`
  );
  assert(
    issues.rows.some(
      (row) =>
        row.resource_id === fixture.refundIds.ambiguous &&
        row.safe_code === 'allocation_incomplete' &&
        row.impact === 'pending' &&
        row.state === 'open'
    ),
    'ambiguous succeeded refund must have one open pending allocation_incomplete issue'
  );

  equal(
    await tableCounts(pool, Object.keys(fixture.countsBefore)),
    fixture.countsBefore,
    'legacy commerce and operational history counts are preserved'
  );
  for (const [tableName, id] of [
    ['stripe_events', fixture.historyIds.stripeEvent],
    ['jobs', fixture.historyIds.job],
    ['outbox_messages', fixture.historyIds.outbox],
    ['audit_events', fixture.historyIds.audit]
  ] as const) {
    const row = await one<{ present: boolean }>(
      pool,
      `select exists(select 1 from ${tableName} where id = $1) as present`,
      [id]
    );
    assert(row.present, `${tableName} fixture ID must survive migration`);
  }
}

async function expectMutationRejected(
  pool: Pool,
  statement: string,
  values: unknown[],
  label: string
): Promise<void> {
  try {
    await pool.query(statement, values);
  } catch (error) {
    const code = (error as { code?: string }).code;
    assert(code === '55000', `${label} must fail with immutable-history SQLSTATE 55000, got ${code}`);
    return;
  }
  throw new Error(`[financial-migration-test] ${label} unexpectedly succeeded`);
}

async function expectConstraintRejected(
  pool: Pool | PoolClient,
  statement: string,
  values: unknown[],
  label: string
): Promise<void> {
  try {
    await pool.query(statement, values);
  } catch (error) {
    const code = (error as { code?: string }).code;
    assert(
      code === '23503' || code === '23514',
      `${label} must fail with a foreign-key or check violation, got ${code ?? '<missing>'}`
    );
    return;
  }
  throw new Error(`[financial-migration-test] ${label} unexpectedly succeeded`);
}

async function expectCheckRejected(
  pool: Pool,
  statement: string,
  values: unknown[],
  label: string
): Promise<void> {
  try {
    await pool.query(statement, values);
  } catch (error) {
    const code = (error as { code?: string }).code;
    assert(code === '23514', `${label} must fail with check-violation SQLSTATE 23514, got ${code ?? '<missing>'}`);
    return;
  }
  throw new Error(`[financial-migration-test] ${label} unexpectedly succeeded`);
}

async function expectSqlStateRejected(
  client: Pool | PoolClient,
  statement: string,
  values: unknown[],
  expectedCode: string,
  label: string
): Promise<void> {
  try {
    await client.query(statement, values);
  } catch (error) {
    const code = (error as { code?: string }).code;
    assert(code === expectedCode, `${label} must fail with SQLSTATE ${expectedCode}, got ${code ?? '<missing>'}`);
    return;
  }
  throw new Error(`[financial-migration-test] ${label} unexpectedly succeeded`);
}

async function assertPositiveAmountConstraints(pool: Pool, fixture: LegacyFixture): Promise<void> {
  const constraints = await pool.query<{ name: string; definition: string }>(
    `select conname as name, pg_get_constraintdef(oid) as definition
     from pg_constraint
     where conname = any($1::text[])
     order by conname`,
    [[
      'payments_amount_nonnegative',
      'refunds_amount_positive',
      'refund_allocations_amount_positive',
      'disputes_amount_positive'
    ]]
  );
  const definitions = Object.fromEntries(
    constraints.rows.map((row) => [row.name, row.definition.replace(/\s+/gu, ' ')])
  );
  assert(
    /amount_minor >= 0/iu.test(definitions.payments_amount_nonnegative ?? ''),
    'upgraded database keeps zero-valued payments schema-valid'
  );
  for (const name of [
    'refunds_amount_positive',
    'refund_allocations_amount_positive',
    'disputes_amount_positive'
  ] as const) {
    assert(
      /amount_minor > 0/iu.test(definitions[name] ?? ''),
      `upgraded database permanently enforces ${name}`
    );
  }

  const zeroPayment = await one<{ amount_minor: number }>(
    pool,
    `select amount_minor from payments where id = $1`,
    [fixture.paymentIds.zero]
  );
  equal(zeroPayment.amount_minor, 0, 'a legacy zero-valued payment survives the upgrade');

  await expectCheckRejected(
    pool,
    `insert into refunds
       (payment_id, stripe_refund_id, status, amount_minor, currency,
        provider_created_at, allocation_status, financial_evidence_status)
     values ($1, $2, 'pending', 0, 'USD', clock_timestamp(), 'not_applicable', 'pending')`,
    [fixture.paymentIds.pending, `re_zero_${randomUUID()}`],
    'post-upgrade zero refund insert'
  );
  await expectCheckRejected(
    pool,
    `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
     values ($1, $2, 0, 'automatic')`,
    [fixture.refundIds.ambiguous, fixture.orderItemIds[1]],
    'post-upgrade zero refund allocation insert'
  );
  await expectCheckRejected(
    pool,
    `insert into disputes
       (payment_id, stripe_dispute_id, status, amount_minor, currency,
        provider_created_at, provider_updated_at, financial_evidence_status)
     values ($1, $2, 'open', 0, 'USD', clock_timestamp(), clock_timestamp(), 'pending')`,
    [fixture.paymentIds.pending, `dp_zero_${randomUUID()}`],
    'post-upgrade zero dispute insert'
  );
}

async function seedGuardRows(pool: Pool, fixture: LegacyFixture): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const transaction = await one<{ id: string }>(
    pool,
    `insert into stripe_balance_transactions
       (provider_id, live_mode, source_family, source_id, raw_type, reporting_category,
        balance_type, amount_minor, fee_minor, net_minor, currency, status,
        provider_created_at, available_at, fingerprint_sha256)
     values ($1, false, 'charge', $2, 'charge', 'charge', 'payments', 100, 10, 90,
             'USD', 'pending', clock_timestamp(), clock_timestamp(), repeat('d', 64))
     returning id`,
    [`txn_${randomUUID()}`, `ch_${randomUUID()}`]
  );
  ids.transaction = transaction.id;
  ids.feeDetail = (
    await one<{ id: string }>(
      pool,
      `insert into stripe_balance_transaction_fee_details
         (balance_transaction_id, ordinal, raw_type, amount_minor, currency,
          fingerprint_sha256)
       values ($1, 0, 'stripe_fee', 10, 'USD', repeat('e', 64))
       returning id`,
      [transaction.id]
    )
  ).id;
  ids.classification = (
    await one<{ id: string }>(
      pool,
      `insert into financial_classification_versions
         (subject_type, subject_id, classifier_version, classification,
          source_fingerprint_sha256)
       values ('balance_transaction', $1, 1, 'charge', repeat('d', 64))
       returning id`,
      [transaction.id]
    )
  ).id;
  const unknownWithIssue = await one<{ classification_id: string; issue_id: string }>(
    pool,
    `with classification as (
       insert into financial_classification_versions
         (subject_type, subject_id, classifier_version, classification,
          source_fingerprint_sha256)
       values ('fee_detail', $1, 1, 'unknown', repeat('e', 64))
       returning id
     ), issue as (
       insert into financial_reconciliation_issues
         (resource_type, resource_id, safe_code, impact, correlation_id)
       select 'financial_classification', classification.id, 'unsupported_category',
         'exception', $2
       from classification
       returning id
     )
     select classification.id as classification_id, issue.id as issue_id
     from classification cross join issue`,
    [ids.feeDetail, randomUUID()]
  );
  ids.unknownClassification = unknownWithIssue.classification_id;
  ids.immutableIssue = unknownWithIssue.issue_id;
  ids.allocationSet = (
    await one<{ id: string }>(
      pool,
      `insert into financial_allocation_sets
         (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
          basis, scope, expected_effect_minor, currency, algorithm_version,
          classifier_version, source_fingerprint_sha256)
       values ($1, $2, 'payment', $3, 'gross_amount', 'title', 100, 'USD', 1, 1,
               repeat('d', 64))
       returning id`,
      [`allocation_${randomUUID()}`, transaction.id, fixture.paymentIds.reconciled]
    )
  ).id;
  ids.allocationItem = (
    await one<{ id: string }>(
      pool,
      `insert into financial_item_allocations
         (allocation_set_id, order_item_id, component, effect_minor, currency, tie_break_key)
       values ($1, $2, 'sale_subtotal', 100, 'USD', $3)
       returning id`,
      [ids.allocationSet, fixture.orderItemIds[0], `tie_${randomUUID()}`]
    )
  ).id;
  ids.disputeTransaction = (
    await one<{ id: string }>(
      pool,
      `insert into stripe_balance_transactions
         (provider_id, live_mode, source_family, source_id, raw_type, reporting_category,
          balance_type, amount_minor, fee_minor, net_minor, currency, status,
          provider_created_at, available_at, fingerprint_sha256)
       values ($1, false, 'dispute', $2, 'adjustment', 'dispute', 'payments', -100, 10,
               -110, 'USD', 'available', clock_timestamp(), clock_timestamp(), repeat('f', 64))
       returning id`,
      [`txn_${randomUUID()}`, `dp_${randomUUID()}`]
    )
  ).id;
  ids.disputeGrossAllocationSet = (
    await one<{ id: string }>(
      pool,
      `insert into financial_allocation_sets
         (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
          basis, scope, expected_effect_minor, currency, algorithm_version,
          classifier_version, source_fingerprint_sha256)
       values ($1, $2, 'dispute', $3, 'gross_amount', 'title', -100, 'USD', 1, 1,
               repeat('f', 64))
       returning id`,
      [`allocation_${randomUUID()}`, ids.disputeTransaction, fixture.disputeIds.reconciled]
    )
  ).id;
  ids.disputeFeeAllocationSet = (
    await one<{ id: string }>(
      pool,
      `insert into financial_allocation_sets
         (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
          basis, scope, expected_effect_minor, currency, algorithm_version,
          classifier_version, source_fingerprint_sha256)
       values ($1, $2, 'dispute', $3, 'fee', 'title', -10, 'USD', 1, 1,
               repeat('f', 64))
       returning id`,
      [`allocation_${randomUUID()}`, ids.disputeTransaction, fixture.disputeIds.reconciled]
    )
  ).id;
  ids.wrongKindTransaction = (
    await one<{ id: string }>(
      pool,
      `insert into stripe_balance_transactions
         (provider_id, live_mode, source_family, source_id, raw_type, reporting_category,
          balance_type, amount_minor, fee_minor, net_minor, currency, status,
          provider_created_at, available_at, fingerprint_sha256)
       values ($1, false, 'dispute', $2, 'adjustment', 'dispute', 'payments', -100, 0,
               -100, 'USD', 'available', clock_timestamp(), clock_timestamp(), repeat('0', 64))
       returning id`,
      [`txn_${randomUUID()}`, `dp_${randomUUID()}`]
    )
  ).id;
  ids.wrongKindGrossAllocationSet = (
    await one<{ id: string }>(
      pool,
      `insert into financial_allocation_sets
         (allocation_identity, balance_transaction_id, source_kind, source_internal_id,
          basis, scope, expected_effect_minor, currency, algorithm_version,
          classifier_version, source_fingerprint_sha256)
       values ($1, $2, 'payment', $3, 'gross_amount', 'title', -100, 'USD', 1, 1,
               repeat('0', 64))
       returning id`,
      [`allocation_${randomUUID()}`, ids.wrongKindTransaction, fixture.disputeIds.reconciled]
    )
  ).id;
  ids.disputeItemAllocation = (
    await one<{ id: string }>(
      pool,
      `insert into dispute_item_allocations
         (allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
          effect, subtotal_effect_minor, tax_effect_minor, total_effect_minor, currency)
       values ($1, $2, $3, $4, 'withdrawal', -100, 0, -100, 'USD')
       returning id`,
      [
        `dispute_allocation_${randomUUID()}`,
        fixture.disputeIds.reconciled,
        ids.disputeGrossAllocationSet,
        fixture.orderItemIds[0]
      ]
    )
  ).id;
  ids.issue = (
    await one<{ id: string }>(
      pool,
      `insert into financial_reconciliation_issues
         (resource_type, resource_id, safe_code, impact, correlation_id)
       values ('payment', $1, 'missing_source', 'pending', $2)
       returning id`,
      [fixture.paymentIds.reconciled, randomUUID()]
    )
  ).id;
  const adminId = fixture.userId;
  ids.draft = (
    await one<{ id: string }>(
      pool,
      `insert into refund_allocation_drafts
         (refund_id, state, version, created_by_admin_id, updated_by_admin_id,
          created_correlation_id, updated_correlation_id)
       values ($1, 'active', 1, $2, $2, $3, $3)
       returning id`,
      [fixture.refundIds.ambiguous, adminId, randomUUID()]
    )
  ).id;
  ids.draftItem = (
    await one<{ id: string }>(
      pool,
      `insert into refund_allocation_draft_items
         (draft_id, order_item_id, proposed_total_presentment_minor)
       values ($1, $2, 250)
       returning id`,
      [ids.draft, fixture.orderItemIds[1]]
    )
  ).id;
  return ids;
}

async function assertHistoryGuards(pool: Pool, fixture: LegacyFixture): Promise<void> {
  const ids = await seedGuardRows(pool, fixture);
  const invalidDisputeSetLinks = [
    {
      label: 'a dispute presentment row cannot reference another source identity',
      allocationSetId: ids.allocationSet
    },
    {
      label: 'a dispute presentment row cannot reference a fee allocation set',
      allocationSetId: ids.disputeFeeAllocationSet
    },
    {
      label: 'a dispute presentment row cannot reference a non-dispute allocation set',
      allocationSetId: ids.wrongKindGrossAllocationSet
    }
  ];
  for (const invalid of invalidDisputeSetLinks) {
    await expectConstraintRejected(
      pool,
      `insert into dispute_item_allocations
         (allocation_identity, dispute_id, gross_allocation_set_id, order_item_id,
          effect, subtotal_effect_minor, tax_effect_minor, total_effect_minor, currency)
       values ($1, $2, $3, $4, 'withdrawal', -1, 0, -1, 'USD')`,
      [
        `invalid_dispute_allocation_${randomUUID()}`,
        fixture.disputeIds.reconciled,
        invalid.allocationSetId,
        fixture.orderItemIds[0]
      ],
      invalid.label
    );
  }
  const forbiddenMutations = [
    {
      label: 'fee details are append-only',
      statement: `update stripe_balance_transaction_fee_details set amount_minor = 9 where id = $1`,
      id: ids.feeDetail
    },
    {
      label: 'classification decisions are append-only',
      statement: `delete from financial_classification_versions where id = $1`,
      id: ids.classification
    },
    {
      label: 'allocation sets are append-only',
      statement: `update financial_allocation_sets set scope = 'account' where id = $1`,
      id: ids.allocationSet
    },
    {
      label: 'allocation items are append-only',
      statement: `delete from financial_item_allocations where id = $1`,
      id: ids.allocationItem
    },
    {
      label: 'versioned dispute presentment rows preserve their gross-set identity',
      statement: `update dispute_item_allocations set subtotal_effect_minor = -99 where id = $1`,
      id: ids.disputeItemAllocation
    },
    {
      label: 'backfilled refund components are append-only',
      statement: `update refund_allocation_components set tax_minor = 0 where refund_allocation_id = $1`,
      id: fixture.refundAllocationIds[0]
    },
    {
      label: 'legacy refund allocations become immutable history',
      statement: `delete from refund_allocations where id = $1`,
      id: fixture.refundAllocationIds[0]
    },
    {
      label: 'balance transaction immutable money cannot change',
      statement: `update stripe_balance_transactions set amount_minor = 101 where id = $1`,
      id: ids.transaction
    }
  ];
  for (const mutation of forbiddenMutations) {
    await expectMutationRejected(pool, mutation.statement, [mutation.id], mutation.label);
  }

  await pool.query(
    `update stripe_balance_transactions
     set status = 'available', last_imported_at = clock_timestamp()
     where id = $1`,
    [ids.transaction]
  );
  const updatedTransaction = await one<{ status: string }>(
    pool,
    `select status from stripe_balance_transactions where id = $1`,
    [ids.transaction]
  );
  equal(updatedTransaction.status, 'available', 'pending-to-available provider transition is allowed');
  await expectMutationRejected(
    pool,
    `update stripe_balance_transactions set status = 'pending' where id = $1`,
    [ids.transaction],
    'available-to-pending provider transition is rejected'
  );

  await pool.query(
    `update refund_allocation_draft_items
     set proposed_total_presentment_minor = 200, updated_at = clock_timestamp()
     where id = $1`,
    [ids.draftItem]
  );
  await pool.query(
    `update refund_allocation_drafts
     set version = 2, state = 'finalized', updated_at = clock_timestamp(),
         finalized_at = clock_timestamp()
     where id = $1`,
    [ids.draft]
  );
  await expectMutationRejected(
    pool,
    `update refund_allocation_drafts set updated_at = clock_timestamp() where id = $1`,
    [ids.draft],
    'finalized draft cannot be mutated'
  );
  await expectMutationRejected(
    pool,
    `update refund_allocation_draft_items
     set proposed_total_presentment_minor = 150 where id = $1`,
    [ids.draftItem],
    'items of a finalized draft cannot be mutated'
  );

  await pool.query(
    `update financial_reconciliation_issues
     set occurrence_count = occurrence_count + 1, last_observed_at = clock_timestamp()
     where id = $1`,
    [ids.issue]
  );
  await expectMutationRejected(
    pool,
    `update financial_reconciliation_issues
     set state = 'resolved', resolved_at = clock_timestamp()
     where id = $1`,
    [ids.issue],
    'issues cannot bypass the guarded resolver'
  );
  const resolverRoles = await pool.query<{ rolname: string; rolcanlogin: boolean }>(
    `select rolname, rolcanlogin
     from pg_roles
     where rolname = any($1::text[])
     order by rolname`,
    [['pale_orbit_financial_worker', 'pale_orbit_runtime']]
  );
  equal(resolverRoles.rows, [
    { rolname: 'pale_orbit_financial_worker', rolcanlogin: false },
    { rolname: 'pale_orbit_runtime', rolcanlogin: false }
  ], 'Plan 6B resolver group roles are non-login roles');
  const resolverAuthority = await one<{
    old_resolver: string | null;
    public_can_execute: boolean;
    runtime_can_execute: boolean;
    worker_can_execute: boolean;
  }>(
    pool,
    `select
       to_regprocedure(
         'public.resolve_financial_reconciliation_issue(uuid,uuid,public.audit_actor_type,text,text)'
       )::text as old_resolver,
       exists (
         select 1
         from pg_proc resolver,
           lateral aclexplode(coalesce(resolver.proacl, acldefault('f', resolver.proowner))) grant_row
         where resolver.oid =
           'public.resolve_financial_issue_after_worker_recompute(uuid,text)'::regprocedure
           and grant_row.grantee = 0
           and grant_row.privilege_type = 'EXECUTE'
       ) as public_can_execute,
       has_function_privilege(
         'pale_orbit_runtime',
         'public.resolve_financial_issue_after_worker_recompute(uuid,text)',
         'EXECUTE'
       ) as runtime_can_execute,
       has_function_privilege(
         'pale_orbit_financial_worker',
         'public.resolve_financial_issue_after_worker_recompute(uuid,text)',
         'EXECUTE'
       ) as worker_can_execute`
  );
  equal(resolverAuthority, {
    old_resolver: null,
    public_can_execute: false,
    runtime_can_execute: false,
    worker_can_execute: true
  }, '0008/0009 replace the generic resolver with worker-only authority');

  const runtime = await pool.connect();
  try {
    await runtime.query('begin');
    await runtime.query('set local role pale_orbit_runtime');
    await expectSqlStateRejected(
      runtime,
      `select * from public.resolve_financial_issue_after_worker_recompute($1, $2)`,
      [ids.issue, 'migration-runtime-resolution'],
      '42501',
      'ordinary runtime role cannot execute the worker resolver'
    );
  } finally {
    await runtime.query('rollback');
    runtime.release();
  }

  const immutableWorker = await pool.connect();
  try {
    await immutableWorker.query('begin');
    await immutableWorker.query('set local role pale_orbit_financial_worker');
    await expectSqlStateRejected(
      immutableWorker,
      `select * from public.resolve_financial_issue_after_worker_recompute($1, $2)`,
      [ids.immutableIssue, 'migration-immutable-resolution'],
      '55000',
      'immutable classification issues cannot use the worker resolver'
    );
  } finally {
    await immutableWorker.query('rollback');
    immutableWorker.release();
  }
  await expectConstraintRejected(
    pool,
    `insert into financial_reconciliation_issues
       (resource_type, resource_id, safe_code, impact, correlation_id)
     values ('payment', $1, 'payout_incomplete', 'pending', $2)`,
    [randomUUID(), 'migration-invalid-issue-pair'],
    'known issue vocabulary still requires an exact semantic resource/code pair'
  );
  await expectMutationRejected(
    pool,
    `insert into financial_reconciliation_issues
       (resource_type, resource_id, safe_code, state, impact, occurrence_count,
        correlation_id, resolved_at)
     values ('payment', $1, 'missing_source', 'resolved', 'pending', 1, $2,
       clock_timestamp())`,
    [randomUUID(), 'migration-resolved-insert'],
    'issues cannot be inserted resolved'
  );
  const replica = await pool.connect();
  try {
    await replica.query('begin');
    await replica.query('set local session_replication_role = replica');
    await expectConstraintRejected(
      replica,
      `update financial_reconciliation_issues
       set state = 'resolved', resolved_at = clock_timestamp()
       where id = $1`,
      [ids.immutableIssue],
      'the immutable classification CHECK survives disabled triggers'
    );
    await replica.query('rollback');
  } finally {
    replica.release();
  }
  const resolutionCorrelationId = 'migration-worker-resolution';
  const worker = await pool.connect();
  try {
    await worker.query('begin');
    await worker.query('set local role pale_orbit_financial_worker');
    await worker.query(
      `select * from public.resolve_financial_issue_after_worker_recompute($1, $2)`,
      [ids.issue, resolutionCorrelationId]
    );
    await worker.query('commit');
  } catch (error) {
    await worker.query('rollback');
    throw error;
  } finally {
    worker.release();
  }
  const resolvedAudit = await one<{
    actor_type: string;
    actor_id: string;
    resource_type: string;
    resource_id: string;
    correlation_id: string;
    after: Record<string, unknown>;
  }>(
    pool,
    `select actor_type, actor_id, resource_type, resource_id, correlation_id, after
     from audit_events
     where action = 'financial.issue.resolved' and resource_id = $1`,
    [ids.issue]
  );
  equal(resolvedAudit.actor_type, 'system', 'worker resolver audit uses the system actor type');
  equal(resolvedAudit.actor_id, 'financial-worker', 'worker resolver audit uses the fixed worker actor');
  equal(resolvedAudit.resource_type, 'financial_issue', 'worker resolver audit uses the canonical resource');
  equal(resolvedAudit.resource_id, ids.issue, 'worker resolver audit names the resolved issue');
  equal(resolvedAudit.correlation_id, resolutionCorrelationId,
    'worker resolver audit preserves the correlation ID');
  equal(resolvedAudit.after, {
    state: 'resolved', impact: 'pending', safeCode: 'missing_source',
    resourceId: fixture.paymentIds.reconciled, resourceType: 'payment', occurrenceCount: 2
  }, 'worker resolver audit contains only canonical safe issue fields');
  await expectMutationRejected(
    pool,
    `delete from financial_reconciliation_issues where id = $1`,
    [ids.issue],
    'issues resolve but are never deleted'
  );
}

async function assertNoPlan6BObjects(pool: Pool): Promise<void> {
  const relations = await pool.query<{ name: string }>(
    `select c.relname as name
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any($1::text[])
     order by c.relname`,
    [[...PLAN6B_TABLES, 'current_financial_projection_heads', 'current_financial_projection_items']]
  );
  equal(relations.rows, [], 'failed 0007 leaves no Plan 6B relation behind');
  const enumRow = await one<{ enum_name: string | null }>(
    pool,
    `select to_regtype('public.financial_evidence_status')::text as enum_name`
  );
  equal(enumRow.enum_name, null, 'failed 0007 leaves no Plan 6B enum behind');
  const addedColumns = await pool.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name
     from information_schema.columns
     where table_schema = 'public'
       and (table_name, column_name) in (
         ('payments', 'financial_evidence_status'),
         ('refunds', 'allocation_status'),
         ('refunds', 'financial_evidence_status'),
         ('disputes', 'financial_evidence_status'),
         ('entitlement_grants', 'recovery_refund_allocation_id')
       )
     order by table_name, column_name`
  );
  equal(addedColumns.rows, [], 'failed 0007 rolls back every Plan 6B column addition');
  const amountConstraints = await pool.query<{ name: string }>(
    `select conname as name
     from pg_constraint
     where conname = any($1::text[])
     order by conname`,
    [[
      'refunds_amount_nonnegative',
      'refund_allocations_amount_nonnegative',
      'disputes_amount_nonnegative',
      'refunds_amount_positive',
      'refund_allocations_amount_positive',
      'disputes_amount_positive'
    ]]
  );
  equal(
    amountConstraints.rows.map((row) => row.name),
    [
      'disputes_amount_nonnegative',
      'refund_allocations_amount_nonnegative',
      'refunds_amount_nonnegative'
    ],
    'failed 0007 restores the legacy amount constraints without target-schema leakage'
  );
}

async function assertClaimAuthorityUpgrade(
  pool: Pool,
  fixture: LegacyFixture
): Promise<void> {
  const claimTable = await one<{ table_name: string | null }>(
    pool,
    `select to_regclass('public.commerce_claim_issuances')::text as table_name`
  );
  equal(
    claimTable.table_name,
    'commerce_claim_issuances',
    '0006-to-0010 upgrade installs the protected claim issuance table'
  );
  const accountGrant = await one<{
    initiating_user_id: string;
    user_id: string;
  }>(
    pool,
    `select purchase_order.initiating_user_id, grant_row.user_id
     from orders purchase_order
     join order_items item on item.order_id = purchase_order.id
     join entitlement_grants grant_row
       on grant_row.order_item_id = item.id and grant_row.source = 'purchase'
     where purchase_order.id = $1`,
    [fixture.orderIds[0]]
  );
  equal(
    accountGrant.user_id,
    accountGrant.initiating_user_id,
    '0010 admits an account purchase grant assigned to its initiating user'
  );
  const guestGrant = await one<{
    claimed_by_user_id: string | null;
    user_id: string | null;
  }>(
    pool,
    `select identity.claimed_by_user_id, grant_row.user_id
     from guest_identities identity
     join orders purchase_order on purchase_order.guest_identity_id = identity.id
     join order_items item on item.order_id = purchase_order.id
     join entitlement_grants grant_row
       on grant_row.order_item_id = item.id and grant_row.source = 'purchase'
     where identity.id = $1`,
    [fixture.guestClaimFacts.identityId]
  );
  equal(
    guestGrant,
    { claimed_by_user_id: null, user_id: null },
    '0010 admits an unclaimed guest purchase with a null-assigned purchase grant'
  );
}

async function assertStorageCleanupAuthorityUpgrade(pool: Pool): Promise<void> {
  const authority = await one<{
    cleanup_function_present: boolean;
    cleanup_group_can_login: boolean | null;
    cleanup_index_count: number;
    fixed_group_connect_count: number;
    grantable_group_connect_count: number;
  }>(
    pool,
    `select
       to_regprocedure('public.storage_cleanup_referenced_keys(text[])') is not null
          as cleanup_function_present,
       (select rolcanlogin from pg_catalog.pg_roles
         where rolname = 'pale_orbit_storage_cleanup') as cleanup_group_can_login,
       (select count(*)::integer
        from pg_catalog.pg_indexes
        where schemaname = 'public' and indexname = any($1::text[])) as cleanup_index_count,
       (select count(*)::integer
        from pg_catalog.pg_database database_row
        cross join lateral pg_catalog.aclexplode(database_row.datacl) acl
        join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
        where database_row.datname = pg_catalog.current_database()
          and grantee_role.rolname = any($2::text[])
          and acl.privilege_type = 'CONNECT'
          and not acl.is_grantable) as fixed_group_connect_count,
       (select count(*)::integer
        from pg_catalog.pg_database database_row
        cross join lateral pg_catalog.aclexplode(database_row.datacl) acl
        join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
        where database_row.datname = pg_catalog.current_database()
          and grantee_role.rolname = any($2::text[])
          and acl.privilege_type = 'CONNECT'
          and acl.is_grantable) as grantable_group_connect_count`,
    [STORAGE_CLEANUP_INDEXES, [
      'pale_orbit_runtime', 'pale_orbit_financial_worker', 'pale_orbit_storage_cleanup'
    ]]
  );
  equal(
    authority,
    {
      cleanup_function_present: true,
      cleanup_group_can_login: false,
      cleanup_index_count: STORAGE_CLEANUP_INDEXES.length,
      fixed_group_connect_count: 3,
      grantable_group_connect_count: 0
    },
    '0006-to-0011 upgrade installs the bounded NOLOGIN storage-cleanup authority'
  );
}

async function runFixedGroupAttributePreflightFixture(pool: Pool): Promise<void> {
  equal(await migrationCount(pool), 7, '0009 group preflight fixture begins at migration 0006');
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(8) });
  equal(await migrationCount(pool), 9, '0009 group preflight fixture applies through migration 0008');

  await pool.query(`
    create role pale_orbit_runtime with login nosuperuser nocreatedb nocreaterole
      noinherit noreplication nobypassrls connection limit 3
      valid until '2030-01-01 00:00:00+00'
  `);
  await pool.query(`
    alter role pale_orbit_runtime set application_name = 'fixed-group-collision-fixture'
  `);

  let rejected = false;
  try {
    await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(9) });
  } catch (error) {
    rejected = true;
    const postgresError = unwrapPostgresError(error);
    assert(postgresError !== null, 'unsafe fixed group must expose its PostgreSQL error');
    equal(postgresError.code, '42501', 'unsafe fixed group must use insufficient privilege');
    assert(
      /preexisting Plan 6B group role has noncanonical attributes/iu.test(postgresError.message),
      'unsafe fixed group must identify the attribute preflight'
    );
    equal(
      await migrationCount(pool),
      9,
      'unsafe fixed group rollback does not advance the 0009 journal'
    );

    const preserved = await one<{
      can_login: boolean;
      inherits: boolean;
      connection_limit: number;
      has_valid_until: boolean;
      has_config: boolean;
    }>(
      pool,
      `select
         role_row.rolcanlogin as can_login,
         role_row.rolinherit as inherits,
         role_row.rolconnlimit as connection_limit,
         role_row.rolvaliduntil is not null as has_valid_until,
         role_row.rolconfig is not null as has_config
       from pg_catalog.pg_roles role_row
       where role_row.rolname = 'pale_orbit_runtime'`
    );
    equal(preserved, {
      can_login: true,
      inherits: false,
      connection_limit: 3,
      has_valid_until: true,
      has_config: true
    }, 'failed 0009 preserves the unsafe fixed group unchanged');

    const partialAuthority = await one<{
      worker_role_count: number;
      resolver_present: boolean;
      positive_constraint_present: boolean;
      legacy_constraint_present: boolean;
    }>(
      pool,
      `select
         (select count(*)::integer from pg_catalog.pg_roles
          where rolname = 'pale_orbit_financial_worker') as worker_role_count,
         pg_catalog.to_regprocedure(
           'public.resolve_financial_issue_after_worker_recompute(uuid,text)'
         ) is not null as resolver_present,
         exists (select 1 from pg_catalog.pg_constraint
          where conname = 'refunds_amount_positive') as positive_constraint_present,
         exists (select 1 from pg_catalog.pg_constraint
          where conname = 'refunds_amount_nonnegative') as legacy_constraint_present`
    );
    equal(partialAuthority, {
      worker_role_count: 0,
      resolver_present: false,
      positive_constraint_present: false,
      legacy_constraint_present: true
    }, 'failed 0009 leaves no partial worker authority');
  }
  assert(rejected, 'unsafe fixed group unexpectedly migrated');

  await pool.query('drop role pale_orbit_runtime');
  await pool.query(`
    create role pale_orbit_runtime with nologin nosuperuser nocreatedb nocreaterole
      inherit noreplication nobypassrls connection limit -1
  `);
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(11) });
  equal(await migrationCount(pool), 12, 'safe preexisting fixed group permits upgrade through 0011');

  const groups = await pool.query<{
    rolname: string;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    rolconnlimit: number;
    has_valid_until: boolean;
    has_config: boolean;
  }>(
    `select
       role_row.rolname, role_row.rolcanlogin, role_row.rolsuper,
       role_row.rolcreatedb, role_row.rolcreaterole, role_row.rolinherit,
       role_row.rolreplication, role_row.rolbypassrls, role_row.rolconnlimit,
       role_row.rolvaliduntil is not null as has_valid_until,
       role_row.rolconfig is not null as has_config
     from pg_catalog.pg_roles role_row
     where role_row.rolname in ('pale_orbit_runtime', 'pale_orbit_financial_worker')
     order by role_row.rolname`
  );
  equal(groups.rows, [
    {
      rolname: 'pale_orbit_financial_worker',
      rolcanlogin: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: true,
      rolreplication: false,
      rolbypassrls: false,
      rolconnlimit: -1,
      has_valid_until: false,
      has_config: false
    },
    {
      rolname: 'pale_orbit_runtime',
      rolcanlogin: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: true,
      rolreplication: false,
      rolbypassrls: false,
      rolconnlimit: -1,
      has_valid_until: false,
      has_config: false
    }
  ], 'safe preexisting fixed group remains canonical through the current migration head');
  await assertStorageCleanupAuthorityUpgrade(pool);
  await runRepairedFixtureThroughPlan6biiHead(pool, 'repaired fixed-group fixture');
}

async function expectUnexpectedNamedAuthorityFailure(
  pool: Pool,
  fixture: string
): Promise<void> {
  let rejected = false;
  try {
    await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(9) });
  } catch (error) {
    rejected = true;
    const postgresError = unwrapPostgresError(error);
    assert(postgresError !== null, `${fixture} must expose its PostgreSQL error`);
    equal(postgresError.code, '42501', `${fixture} must use insufficient privilege`);
    assert(
      /unexpected named Plan 6B database authority/iu.test(postgresError.message),
      `${fixture} must identify the named-authority preflight`
    );
  }
  assert(rejected, `${fixture} unexpectedly migrated`);
  equal(await migrationCount(pool), 9, `${fixture} rollback does not advance the 0009 journal`);
  equal(
    await one<{
      worker_role_count: number;
      resolver_present: boolean;
      positive_constraint_present: boolean;
      legacy_constraint_present: boolean;
    }>(
      pool,
      `select
         (select count(*)::integer from pg_catalog.pg_roles
          where rolname = 'pale_orbit_financial_worker') as worker_role_count,
         pg_catalog.to_regprocedure(
           'public.resolve_financial_issue_after_worker_recompute(uuid,text)'
         ) is not null as resolver_present,
         exists (select 1 from pg_catalog.pg_constraint
          where conname = 'refunds_amount_positive') as positive_constraint_present,
         exists (select 1 from pg_catalog.pg_constraint
          where conname = 'refunds_amount_nonnegative') as legacy_constraint_present`
    ),
    {
      worker_role_count: 0,
      resolver_present: false,
      positive_constraint_present: false,
      legacy_constraint_present: true
    },
    `${fixture} failure leaves no partial 0009 authority or schema mutation`
  );
}

async function runUnexpectedNamedAuthorityPreflightFixture(pool: Pool): Promise<void> {
  equal(await migrationCount(pool), 7, 'named-authority fixture begins at migration 0006');
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(8) });
  equal(await migrationCount(pool), 9, 'named-authority fixture applies through migration 0008');

  await pool.query(`
    create role plan6b_reporting_fixture with nologin nosuperuser nocreatedb nocreaterole
      inherit noreplication nobypassrls connection limit -1
  `);
  await pool.query('grant usage on schema public to plan6b_reporting_fixture');

  await pool.query('grant select on table public.payments to plan6b_reporting_fixture');
  await expectUnexpectedNamedAuthorityFailure(pool, 'direct reporting-role SELECT');
  await pool.query('revoke select on table public.payments from plan6b_reporting_fixture');

  await pool.query('grant select on table public.payments to pg_monitor');
  await expectUnexpectedNamedAuthorityFailure(pool, 'predefined pg_ role direct SELECT');
  await pool.query('revoke select on table public.payments from pg_monitor');

  await pool.query(`
    alter default privileges in schema public
      grant select on tables to plan6b_reporting_fixture
  `);
  await expectUnexpectedNamedAuthorityFailure(pool, 'owner default SELECT');
  await pool.query(`
    alter default privileges in schema public
      revoke select on tables from plan6b_reporting_fixture
  `);

  await pool.query('grant pg_write_all_data to plan6b_reporting_fixture');
  await expectUnexpectedNamedAuthorityFailure(pool, 'inherited pg_write_all_data authority');
  await pool.query('revoke pg_write_all_data from plan6b_reporting_fixture');

  await pool.query('create table public.plan6b_reporting_owned_fixture (id integer)');
  await pool.query(`
    alter table public.plan6b_reporting_owned_fixture owner to plan6b_reporting_fixture
  `);
  await expectUnexpectedNamedAuthorityFailure(pool, 'unexpected public object ownership');
  await pool.query('drop table public.plan6b_reporting_owned_fixture');

  await pool.query('create extension hstore with schema public');
  await pool.query('grant usage on type public.hstore to plan6b_reporting_fixture');
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(11) });
  equal(
    await migrationCount(pool),
    12,
    'public schema USAGE and extension-member ACLs do not block the repaired upgrade'
  );
  await assertStorageCleanupAuthorityUpgrade(pool);
  await pool.query('revoke usage on schema public from plan6b_reporting_fixture');
  await pool.query('revoke usage on type public.hstore from plan6b_reporting_fixture');
  await pool.query('drop extension hstore');
  await pool.query('drop role plan6b_reporting_fixture');
  await runRepairedFixtureThroughPlan6biiHead(pool, 'repaired named-authority fixture');
}

async function assertFailed0011LeftNoPartialAuthority(
  pool: Pool,
  options: {
    fixture:
      | 'unsafe cleanup role'
      | 'unsafe cleanup schema ACL'
      | 'cleanup routine collision';
    code: '42501' | '42723';
    reason: RegExp;
    routinePresent: boolean;
    directSchemaAcl?: boolean;
  }
): Promise<void> {
  try {
    await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(11) });
  } catch (error) {
    const postgresError = unwrapPostgresError(error);
    assert(postgresError !== null, `${options.fixture} must expose its PostgreSQL error`);
    equal(postgresError.code, options.code, `${options.fixture} must use its exact SQLSTATE`);
    assert(
      options.reason.test(postgresError.message),
      `${options.fixture} must identify its exact preflight invariant`
    );
    equal(
      await migrationCount(pool),
      11,
      `${options.fixture} rollback does not advance the 0011 journal`
    );
    const state = await one<{
      cleanup_function_present: boolean;
      cleanup_index_count: number;
      direct_cleanup_schema_acl: boolean;
      direct_cleanup_routine_acl: boolean;
    }>(
      pool,
      `select
         to_regprocedure('public.storage_cleanup_referenced_keys(text[])') is not null
           as cleanup_function_present,
         (select count(*)::integer
          from pg_catalog.pg_indexes
          where schemaname = 'public' and indexname = any($1::text[]))
           as cleanup_index_count,
         exists (
           select 1
           from pg_catalog.pg_namespace namespace_row
           cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) acl
           join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
           where namespace_row.nspname = 'public'
             and grantee.rolname = 'pale_orbit_storage_cleanup'
         ) as direct_cleanup_schema_acl,
         exists (
           select 1
           from pg_catalog.pg_proc routine
           cross join lateral pg_catalog.aclexplode(
             coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
           ) acl
           join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
           where routine.oid = to_regprocedure(
             'public.storage_cleanup_referenced_keys(text[])'
           ) and grantee.rolname = 'pale_orbit_storage_cleanup'
         ) as direct_cleanup_routine_acl`,
      [STORAGE_CLEANUP_INDEXES]
    );
    equal(state, {
      cleanup_function_present: options.routinePresent,
      cleanup_index_count: 0,
      direct_cleanup_schema_acl: options.directSchemaAcl ?? false,
      direct_cleanup_routine_acl: false
    }, `${options.fixture} rollback leaves no partial 0011 indexes or grants`);
    return;
  }
  throw new Error(`[financial-migration-test] ${options.fixture} unexpectedly migrated`);
}

async function runStorageCleanupAuthorityPreflightFixture(pool: Pool): Promise<void> {
  equal(await migrationCount(pool), 7, '0011 preflight fixture begins at migration 0006');
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(10) });
  equal(await migrationCount(pool), 11, '0011 preflight fixture applies through migration 0010');

  await pool.query(`
    create role pale_orbit_storage_cleanup with login nosuperuser nocreatedb
      nocreaterole inherit noreplication nobypassrls connection limit -1
  `);
  await assertFailed0011LeftNoPartialAuthority(pool, {
    fixture: 'unsafe cleanup role',
    code: '42501',
    reason: /preexisting storage cleanup role has authority/iu,
    routinePresent: false
  });

  await pool.query(`
    alter role pale_orbit_storage_cleanup with nologin nosuperuser nocreatedb
      nocreaterole inherit noreplication nobypassrls connection limit -1
  `);
  await pool.query('grant create on schema public to pale_orbit_storage_cleanup');
  await assertFailed0011LeftNoPartialAuthority(pool, {
    fixture: 'unsafe cleanup schema ACL',
    code: '42501',
    reason: /preexisting storage cleanup role has authority/iu,
    routinePresent: false,
    directSchemaAcl: true
  });
  await pool.query('revoke create on schema public from pale_orbit_storage_cleanup');

  await pool.query(`
    create function public.storage_cleanup_referenced_keys(text[])
    returns table (referenced_storage_key text)
    language sql stable
    set search_path = 'pg_catalog'
    as 'select null::text where false'
  `);
  await assertFailed0011LeftNoPartialAuthority(pool, {
    fixture: 'cleanup routine collision',
    code: '42723',
    reason: /storage cleanup authority routine already exists/iu,
    routinePresent: true
  });

  await pool.query('drop function public.storage_cleanup_referenced_keys(text[])');
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(11) });
  equal(await migrationCount(pool), 12, 'safe preexisting cleanup group permits exactly 0011');
  await assertStorageCleanupAuthorityUpgrade(pool);
  await runRepairedFixtureThroughPlan6biiHead(pool, 'repaired storage-cleanup fixture');
}

const PLAN6BII_ROUTINES = [
  'submit_financial_admin_command',
  'financial_admin_command_status',
  'append_financial_issue_view_audit',
  'append_financial_refund_review_view_audit',
  'append_financial_payout_view_audit',
  'append_financial_sales_export_audit',
  'resolve_financial_issue_after_admin_command',
  'transition_administrative_recovery_grant_after_admin_command',
  'plan6bii_assert_financial_admin_job_lease',
  'plan6bii_guard_financial_admin_job_lease',
  'plan6bii_guard_financial_admin_command_update',
  'plan6bii_guard_financial_admin_command_delete',
  'plan6bii_guard_administrative_grant_transition',
  'plan6bii_sync_failed_financial_admin_command'
] as const;

const PLAN6BII_TRIGGERS = [
  'financial_admin_commands_plan6bii_update_guard',
  'financial_admin_commands_plan6bii_delete_guard',
  'jobs_plan6bii_financial_admin_lease_guard',
  'entitlement_grants_plan6bii_administrative_guard',
  'jobs_plan6bii_financial_admin_terminal_sync'
] as const;

interface Plan6biiCatalogState {
  enum_count: number;
  command_table_present: boolean;
  claim_table_present: boolean;
  routine_count: number;
  trigger_count: number;
  nonowner_acl_count: number;
  runtime_jobs_table_select: boolean;
  runtime_job_select_columns: string[];
}

async function plan6biiCatalogState(pool: Pool): Promise<Plan6biiCatalogState> {
  return one<Plan6biiCatalogState>(
    pool,
    `select
       (select count(*)::integer
        from pg_catalog.pg_type type_row
        join pg_catalog.pg_namespace namespace_row
          on namespace_row.oid = type_row.typnamespace
        where namespace_row.nspname = 'public' and type_row.typtype = 'e'
          and type_row.typname = any($1::text[])) as enum_count,
       pg_catalog.to_regclass('public.financial_admin_commands') is not null
         as command_table_present,
       pg_catalog.to_regclass('public.financial_admin_job_claims') is not null
         as claim_table_present,
       (select count(*)::integer
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace_row
          on namespace_row.oid = routine.pronamespace
        where namespace_row.nspname = 'public'
          and routine.proname = any($2::text[])) as routine_count,
       (select count(*)::integer
        from pg_catalog.pg_trigger trigger_row
        where not trigger_row.tgisinternal
          and trigger_row.tgname = any($3::text[])) as trigger_count,
       (select count(*)::integer
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace_row
          on namespace_row.oid = routine.pronamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
        ) acl
        where namespace_row.nspname = 'public'
          and routine.proname = any($2::text[])
          and acl.privilege_type = 'EXECUTE'
          and acl.grantee <> routine.proowner) as nonowner_acl_count,
       has_table_privilege(
         'pale_orbit_runtime', 'public.jobs', 'SELECT'
       ) as runtime_jobs_table_select,
       array(
         select column_row.attname::text
         from pg_catalog.pg_attribute column_row
         where column_row.attrelid = 'public.jobs'::pg_catalog.regclass
           and column_row.attnum > 0 and not column_row.attisdropped
           and has_column_privilege(
             'pale_orbit_runtime', 'public.jobs', column_row.attname, 'SELECT'
           )
         order by column_row.attnum
       ) as runtime_job_select_columns`,
    [
      ['financial_admin_command_kind', 'financial_admin_command_status'],
      [...PLAN6BII_ROUTINES],
      [...PLAN6BII_TRIGGERS]
    ]
  );
}

const PLAN6BII_ATTESTED_IDENTITIES: DatabaseMigrationIdentityConfig = {
  webUser: 'plan6bii_attested_web',
  workerUser: 'plan6bii_attested_worker',
  storageCleanupUser: 'plan6bii_attested_cleanup'
};

const PLAN6BII_ATTESTED_ROLE_EDGES = [
  [PLAN6BII_ATTESTED_IDENTITIES.webUser, 'pale_orbit_runtime'],
  [PLAN6BII_ATTESTED_IDENTITIES.workerUser, 'pale_orbit_financial_worker'],
  [PLAN6BII_ATTESTED_IDENTITIES.storageCleanupUser, 'pale_orbit_storage_cleanup']
] as const;

const PLAN6BII_PUBLIC_ROLE_NAMES = new Set<string>(
  PLAN6BII_ATTESTED_ROLE_EDGES.map(([, groupName]) => groupName)
);

async function dropPlan6biiAttestedRoles(pool: Pool): Promise<void> {
  for (const [roleName] of [...PLAN6BII_ATTESTED_ROLE_EDGES].reverse()) {
    await pool.query(`drop role if exists "${roleName}"`);
  }
}

async function createPlan6biiAttestedRoles(pool: Pool, presentMask: number): Promise<void> {
  await dropPlan6biiAttestedRoles(pool);
  for (const [index, [roleName, groupName]] of PLAN6BII_ATTESTED_ROLE_EDGES.entries()) {
    if ((presentMask & (1 << index)) === 0) continue;
    await pool.query(`
      create role "${roleName}" with login nosuperuser nocreatedb nocreaterole
        inherit noreplication nobypassrls connection limit -1
        password null valid until 'infinity'
    `);
    await pool.query(`
      grant "${groupName}" to "${roleName}"
      with admin false, inherit true, set false
    `);
  }
}

let plan6biiIdentityCaseCounter = 0;

function plan6biiIdentityDatabaseName(kind: 'template' | 'case'): string {
  const runId = process.env.PLAN6B_UPGRADE_RUN_ID;
  assert(runId && /^[a-f0-9]{16}$/u.test(runId), 'owned run ID is missing or invalid');
  const suffix = kind === 'template'
    ? 'template'
    : `case_${String(plan6biiIdentityCaseCounter += 1).padStart(3, '0')}`;
  const name = `plan6bii_${runId}_identity_${suffix}`;
  assert(
    /^plan6bii_[a-f0-9]{16}_identity_(?:template|case_[0-9]{3})$/u.test(name),
    'identity fixture database name is invalid'
  );
  return name;
}

function plan6biiOwnedSourceDatabaseName(): string {
  const runId = process.env.PLAN6B_UPGRADE_RUN_ID;
  const database = process.env.DATABASE_NAME;
  assert(runId && /^[a-f0-9]{16}$/u.test(runId), 'owned run ID is missing or invalid');
  assert(
    database === `plan6b_${runId}` && /^plan6b_[a-f0-9]{16}$/u.test(database),
    'Plan 6B-II source database is not the harness-owned database'
  );
  return database;
}

function plan6biiPool(database: string): Pool {
  return new Pool({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    database,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    max: 2,
    connectionTimeoutMillis: 5_000
  });
}

async function createPlan6biiDatabase(
  pool: Pool,
  database: string,
  template: string
): Promise<void> {
  const owner = (await one<{ owner_name: string }>(
    pool,
    'select current_user as owner_name'
  )).owner_name;
  const statement = await formattedRoleStatement(
    pool,
    'create database %I with owner %I template %I',
    database,
    owner,
    template
  );
  const connectStatement = await formattedRoleStatement(
    pool,
    'grant connect on database %I to %I, %I, %I',
    database,
    'pale_orbit_runtime',
    'pale_orbit_financial_worker',
    'pale_orbit_storage_cleanup'
  );
  let created = false;
  try {
    await pool.query(statement);
    created = true;
    await pool.query(connectStatement);
  } catch (error) {
    if (created) {
      try {
        await dropPlan6biiDatabase(pool, database);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Plan 6B-II database clone finalization and cleanup both failed',
          { cause: cleanupError }
        );
      }
    }
    throw error;
  }
}

async function dropPlan6biiDatabase(pool: Pool, database: string): Promise<void> {
  assert(
    /^plan6bii_[a-f0-9]{16}_identity_(?:template|case_[0-9]{3})$/u.test(database),
    'refusing to drop a database outside the identity fixture namespace'
  );
  const statement = await formattedRoleStatement(pool, 'drop database %I', database);
  await pool.query(statement);
}

async function assertPlan6biiMigrationSettingsCleared(client: PoolClient): Promise<void> {
  const settings = await one<{
    web_login: string | null;
    worker_login: string | null;
    storage_cleanup_login: string | null;
  }>(
    client,
    `select
       pg_catalog.current_setting(
         'pale_orbit.migration_expected_web_login', true
       ) as web_login,
       pg_catalog.current_setting(
         'pale_orbit.migration_expected_worker_login', true
       ) as worker_login,
       pg_catalog.current_setting(
         'pale_orbit.migration_expected_storage_cleanup_login', true
       ) as storage_cleanup_login`
  );
  for (const value of Object.values(settings)) {
    assert(value === null || value === '', 'migration login attestation survived transaction end');
  }
  const persisted = await one<{ persisted_setting_count: number }>(
    client,
    `select pg_catalog.count(*)::integer as persisted_setting_count
     from pg_catalog.pg_db_role_setting setting_row
     cross join lateral pg_catalog.unnest(setting_row.setconfig)
       configured_setting(value)
     where pg_catalog.split_part(configured_setting.value, '=', 1) = any(array[
       'pale_orbit.migration_expected_web_login',
       'pale_orbit.migration_expected_worker_login',
       'pale_orbit.migration_expected_storage_cleanup_login'
     ]::text[])`
  );
  equal(
    persisted.persisted_setting_count,
    0,
    'migration login attestation persisted in role/database settings'
  );
}

async function runCommittedPlan6biiAttestedMigration(
  pool: Pool,
  migrationsFolder: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await migrateDatabase(
      drizzle(client),
      PLAN6BII_ATTESTED_IDENTITIES,
      migrationsFolder
    );
    await assertPlan6biiMigrationSettingsCleared(client);
  } finally {
    client.release();
  }
}

async function runRepairedFixtureThroughPlan6biiHead(
  pool: Pool,
  fixture: string
): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(11) });
  equal(await migrationCount(pool), 12, `${fixture} reaches historical prerequisite 0011`);
  const migrationsThrough12 = await createMigrationFolderThrough(12);
  const migrationsThrough13 = await createMigrationFolderThrough(13);
  const migrationsThrough14 = await createMigrationFolderThrough(14);
  try {
    await createPlan6biiAttestedRoles(pool, 0b111);
    await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough12);
    equal(await migrationCount(pool), 13, `${fixture} reaches migration 0012 exactly once`);
    await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough12);
    equal(
      await migrationCount(pool),
      13,
      `${fixture} second 0012 migration pass is a no-op`
    );
    await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough13);
    equal(await migrationCount(pool), 14, `${fixture} reaches migration 0013 exactly once`);
    await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough13);
    equal(
      await migrationCount(pool),
      14,
      `${fixture} second 0013 migration pass is a no-op`
    );
    await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough14);
    equal(await migrationCount(pool), 15, `${fixture} reaches migration 0014 exactly once`);
    await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough14);
    equal(
      await migrationCount(pool),
      15,
      `${fixture} second 0014 migration pass is a no-op`
    );
  } finally {
    await dropPlan6biiAttestedRoles(pool);
  }
}

const REPORTING_CORRECTION_RESOLVER =
  'public.resolve_financial_issue_after_reporting_correction_command(uuid,uuid)';

interface ReportingCorrectionAuthorityState {
  resolver_present: boolean;
  resolver_name_count: number;
  resolver_owner: string | null;
  security_definer: boolean | null;
  routine_config: string[] | null;
  nonowner_acl: string[];
}

async function reportingCorrectionAuthorityState(
  pool: Pool
): Promise<ReportingCorrectionAuthorityState> {
  return one<ReportingCorrectionAuthorityState>(
    pool,
    `select
       pg_catalog.to_regprocedure($1) is not null as resolver_present,
       (select pg_catalog.count(*)::integer
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace_row
          on namespace_row.oid = routine.pronamespace
        where namespace_row.nspname = 'public'
          and routine.proname =
            'resolve_financial_issue_after_reporting_correction_command')
         as resolver_name_count,
       pg_catalog.pg_get_userbyid(routine.proowner) as resolver_owner,
       routine.prosecdef as security_definer,
       routine.proconfig as routine_config,
       coalesce((
         select pg_catalog.array_agg(
           pg_catalog.concat_ws(':', grantee.rolname, acl.privilege_type,
             acl.is_grantable::text)
           order by grantee.rolname, acl.privilege_type, acl.is_grantable
         )
         from pg_catalog.aclexplode(
           coalesce(routine.proacl,
             pg_catalog.acldefault('f', routine.proowner))
         ) acl
         join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
         where acl.grantee <> routine.proowner
       ), array[]::text[]) as nonowner_acl
     from (values (1)) singleton(value)
     left join pg_catalog.pg_proc routine
       on routine.oid = pg_catalog.to_regprocedure($1)`,
    [REPORTING_CORRECTION_RESOLVER]
  );
}

async function expectReportingCorrectionAuthorityFailure(
  pool: Pool,
  migrationsThrough13: string,
  fixture: string,
  reason: RegExp
): Promise<void> {
  equal(await migrationCount(pool), 13, `${fixture} begins at migration 0012`);
  const before = await reportingCorrectionAuthorityState(pool);
  equal(before.resolver_present, false, `${fixture} begins without the 0013 resolver`);
  let rejected = false;
  try {
    await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough13);
  } catch (error) {
    rejected = true;
    const postgresError = unwrapPostgresError(error);
    assert(postgresError !== null, `${fixture} must expose its PostgreSQL error`);
    equal(postgresError.code, '42501', `${fixture} must use insufficient privilege`);
    assert(reason.test(postgresError.message), `${fixture} must identify its preflight invariant`);
  }
  assert(rejected, `${fixture} unexpectedly migrated`);
  equal(await migrationCount(pool), 13, `${fixture} rollback leaves the journal at 0012`);
  equal(
    await reportingCorrectionAuthorityState(pool),
    before,
    `${fixture} rollback leaves no 0013 resolver or ACL`
  );
}

async function assertReportingCorrectionAuthorityUpgrade(pool: Pool): Promise<void> {
  const migrationsThrough13 = await createMigrationFolderThrough(13);

  await pool.query(`
    create function
      public.resolve_financial_issue_after_reporting_correction_command(uuid,text)
    returns void language plpgsql as 'begin return; end'
  `);
  await expectReportingCorrectionAuthorityFailure(
    pool,
    migrationsThrough13,
    '0013 routine-name collision',
    /reporting-correction authority name is already occupied/iu
  );
  await pool.query(`
    drop function public.resolve_financial_issue_after_reporting_correction_command(uuid,text)
  `);

  await pool.query(`
    alter function public.resolve_financial_issue_after_admin_command(uuid,uuid)
    owner to pale_orbit_storage_cleanup
  `);
  await expectReportingCorrectionAuthorityFailure(
    pool,
    migrationsThrough13,
    '0013 prerequisite owner drift',
    /reporting-correction prerequisite (?:owner|authority) is not canonical/iu
  );
  await pool.query(`
    alter function public.resolve_financial_issue_after_admin_command(uuid,uuid)
    owner to current_user
  `);
  await pool.query(`
    revoke all on function public.resolve_financial_issue_after_admin_command(uuid,uuid)
    from public, pale_orbit_runtime, pale_orbit_financial_worker,
      pale_orbit_storage_cleanup;
    grant execute on function public.resolve_financial_issue_after_admin_command(uuid,uuid)
    to pale_orbit_financial_worker
  `);

  await pool.query(`
    alter function public.resolve_financial_issue_after_admin_command(uuid,uuid)
    security invoker
  `);
  await expectReportingCorrectionAuthorityFailure(
    pool,
    migrationsThrough13,
    '0013 prerequisite security drift',
    /reporting-correction prerequisite authority is not canonical/iu
  );
  await pool.query(`
    alter function public.resolve_financial_issue_after_admin_command(uuid,uuid)
    security definer
  `);

  await pool.query(`
    alter function public.resolve_financial_issue_after_admin_command(uuid,uuid)
    set search_path = 'public'
  `);
  await expectReportingCorrectionAuthorityFailure(
    pool,
    migrationsThrough13,
    '0013 prerequisite search_path drift',
    /reporting-correction prerequisite authority is not canonical/iu
  );
  await pool.query(`
    alter function public.resolve_financial_issue_after_admin_command(uuid,uuid)
    set search_path = 'pg_catalog'
  `);

  await pool.query(`
    grant execute on function
      public.resolve_financial_issue_after_admin_command(uuid,uuid)
    to pale_orbit_runtime
  `);
  await expectReportingCorrectionAuthorityFailure(
    pool,
    migrationsThrough13,
    '0013 prerequisite ACL drift',
    /reporting-correction prerequisite authority is not canonical/iu
  );
  await pool.query(`
    revoke execute on function
      public.resolve_financial_issue_after_admin_command(uuid,uuid)
    from pale_orbit_runtime
  `);

  await pool.query(`
    alter table public.financial_reconciliation_issues
    disable trigger financial_reconciliation_issues_narrow_update
  `);
  await expectReportingCorrectionAuthorityFailure(
    pool,
    migrationsThrough13,
    '0013 issue-trigger drift',
    /reporting-correction prerequisite authority is not canonical/iu
  );
  await pool.query(`
    alter table public.financial_reconciliation_issues
    enable trigger financial_reconciliation_issues_narrow_update
  `);

  await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough13);
  equal(await migrationCount(pool), 14, 'clean migration 0012 applies 0013 exactly once');
  const installed = await reportingCorrectionAuthorityState(pool);
  const databaseOwner = (await one<{ owner_name: string }>(
    pool,
    `select pg_catalog.pg_get_userbyid(database_row.datdba) as owner_name
     from pg_catalog.pg_database database_row
     where database_row.datname = pg_catalog.current_database()`
  )).owner_name;
  equal(installed, {
    resolver_present: true,
    resolver_name_count: 1,
    resolver_owner: databaseOwner,
    security_definer: true,
    routine_config: ['search_path=pg_catalog'],
    nonowner_acl: ['pale_orbit_financial_worker:EXECUTE:false']
  }, '0013 installs one exact database-owner correction resolver with worker-only EXECUTE');
  await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough13);
  equal(await migrationCount(pool), 14, 'a second 0013 migrator pass is a no-op');
}

const ISSUE_TRANSITION_ROUTINE = 'public.plan6b_validate_issue_transition()';
const PLAN6BII_VULNERABLE_ISSUE_TRANSITION_SHA256 =
  '33a6441df520bf0c6ed486f7c3b8585ad719683dfe73835eb62176d5bbf898c8';
const PLAN6BII_FIXED_ISSUE_TRANSITION_SHA256 =
  'a921aec3b466cdcdc47b6583065d171179d816159d25ec634c57521a7e0f2c81';
const PLAN6BII_REPORTING_CORRECTION_RESOLVER_SHA256 =
  'c6e086b30db8e85c5bc38107ceab36f4b41ad5c5a152e75b5e862c607c3a60e8';
const PLAN6BII_AUDIT_INSERT_GUARD_SHA256 =
  'f0373a347c369035f1c8b68d6eb4238a33612b0fa6e82e2ecfaa0ebf10e0696b';

interface IssueTransitionRoutineState {
  routine_definition: string;
  definition_sha256: string;
  owner_name: string;
  database_owner_name: string;
  acl_entries: string[];
}

interface RoutineDefinitionState {
  routine_definition: string;
  definition_sha256: string;
}

interface RoutineMetadataState {
  owner_name: string;
  language_name: string;
  result_type: string;
  argument_types: string;
  routine_kind: string;
  volatility: string;
  parallel_safety: string;
  security_definer: boolean;
  leakproof: boolean;
  strict: boolean;
  returns_set: boolean;
  routine_config: string[] | null;
  acl_entries: string[];
}

interface IssueTransitionTriggerState {
  trigger_oid: string;
  relation_oid: string;
  routine_oid: string;
  trigger_name: string;
  enabled: string;
  trigger_type: number;
  argument_count: number;
  arguments_hex: string;
  attribute_numbers: string;
  when_expression: string | null;
  trigger_definition: string;
}

async function issueTransitionRoutineState(
  pool: Pool | PoolClient
): Promise<IssueTransitionRoutineState> {
  return one<IssueTransitionRoutineState>(
    pool,
    `select
       pg_catalog.pg_get_functiondef(routine.oid) as routine_definition,
       pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
         pg_catalog.replace(pg_catalog.replace(
           pg_catalog.pg_get_functiondef(routine.oid), E'\\r\\n', E'\\n'
         ), E'\\r', E'\\n'), 'UTF8'
       )), 'hex') as definition_sha256,
       pg_catalog.pg_get_userbyid(routine.proowner) as owner_name,
       pg_catalog.pg_get_userbyid(database_row.datdba) as database_owner_name,
       array(
         select pg_catalog.concat_ws(':',
           case when privilege.grantee = routine.proowner
             then 'DATABASE_OWNER' else grantee.rolname::text end,
           case when privilege.grantor = routine.proowner
             then 'DATABASE_OWNER' else grantor.rolname::text end,
           privilege.privilege_type::text,
           privilege.is_grantable::text
         )
         from pg_catalog.aclexplode(coalesce(
           routine.proacl, pg_catalog.acldefault('f', routine.proowner)
         )) privilege
         join pg_catalog.pg_roles grantor on grantor.oid = privilege.grantor
         left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
         order by 1
       ) as acl_entries
     from pg_catalog.pg_proc routine
     cross join pg_catalog.pg_database database_row
     where routine.oid = pg_catalog.to_regprocedure($1)
       and database_row.datname = pg_catalog.current_database()`,
    [ISSUE_TRANSITION_ROUTINE]
  );
}

async function routineDefinitionState(
  pool: Pool,
  signature: string
): Promise<RoutineDefinitionState> {
  return one<RoutineDefinitionState>(
    pool,
    `select
       pg_catalog.pg_get_functiondef(routine.oid) as routine_definition,
       pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
         pg_catalog.replace(pg_catalog.replace(
           pg_catalog.pg_get_functiondef(routine.oid), E'\\r\\n', E'\\n'
         ), E'\\r', E'\\n'), 'UTF8'
       )), 'hex') as definition_sha256
     from pg_catalog.pg_proc routine
     where routine.oid = pg_catalog.to_regprocedure($1)`,
    [signature]
  );
}

async function routineMetadataState(
  pool: Pool,
  signature: string
): Promise<RoutineMetadataState> {
  return one<RoutineMetadataState>(
    pool,
    `select
       pg_catalog.pg_get_userbyid(routine.proowner) as owner_name,
       language_row.lanname::text as language_name,
       pg_catalog.pg_get_function_result(routine.oid) as result_type,
       pg_catalog.pg_get_function_arguments(routine.oid) as argument_types,
       routine.prokind::text as routine_kind,
       routine.provolatile::text as volatility,
       routine.proparallel::text as parallel_safety,
       routine.prosecdef as security_definer,
       routine.proleakproof as leakproof,
       routine.proisstrict as strict,
       routine.proretset as returns_set,
       routine.proconfig as routine_config,
       array(
         select pg_catalog.concat_ws(':',
           case when privilege.grantee = routine.proowner
             then 'ROUTINE_OWNER' else grantee.rolname::text end,
           case when privilege.grantor = routine.proowner
             then 'ROUTINE_OWNER' else grantor.rolname::text end,
           privilege.privilege_type::text,
           privilege.is_grantable::text
         )
         from pg_catalog.aclexplode(coalesce(
           routine.proacl, pg_catalog.acldefault('f', routine.proowner)
         )) privilege
         join pg_catalog.pg_roles grantor on grantor.oid = privilege.grantor
         left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
         order by 1
       ) as acl_entries
     from pg_catalog.pg_proc routine
     join pg_catalog.pg_language language_row on language_row.oid = routine.prolang
     where routine.oid = pg_catalog.to_regprocedure($1)`,
    [signature]
  );
}

async function issueTransitionTriggerState(
  pool: Pool | PoolClient
): Promise<IssueTransitionTriggerState> {
  return one<IssueTransitionTriggerState>(
    pool,
    `select
       trigger_row.oid::text as trigger_oid,
       trigger_row.tgrelid::text as relation_oid,
       trigger_row.tgfoid::text as routine_oid,
       trigger_row.tgname::text as trigger_name,
       trigger_row.tgenabled::text as enabled,
       trigger_row.tgtype::integer as trigger_type,
       trigger_row.tgnargs::integer as argument_count,
       pg_catalog.encode(trigger_row.tgargs, 'hex') as arguments_hex,
       trigger_row.tgattr::text as attribute_numbers,
       pg_catalog.pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid)
         as when_expression,
       pg_catalog.pg_get_triggerdef(trigger_row.oid, false) as trigger_definition
     from pg_catalog.pg_trigger trigger_row
     where trigger_row.tgrelid =
         'public.financial_reconciliation_issues'::pg_catalog.regclass
       and trigger_row.tgname = 'financial_reconciliation_issues_narrow_update'
       and not trigger_row.tgisinternal`
  );
}

async function expectIssueTransitionRepairPreflightFailure(
  pool: Pool,
  migrationsThrough14: string,
  driftedState: IssueTransitionRoutineState
): Promise<void> {
  let rejected = false;
  try {
    await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough14);
  } catch (error) {
    rejected = true;
    const postgresError = unwrapPostgresError(error);
    assert(postgresError !== null, '0014 definition drift must expose its PostgreSQL error');
    equal(postgresError.code, '42501', '0014 definition drift must use insufficient privilege');
    assert(
      /issue-transition repair predecessor definition is not canonical/iu.test(
        postgresError.message
      ),
      '0014 definition drift must identify its exact predecessor-definition preflight'
    );
  }
  assert(rejected, '0014 definition drift unexpectedly migrated');
  equal(await migrationCount(pool), 14, '0014 definition drift rollback leaves the journal at 0013');
  equal(
    await issueTransitionRoutineState(pool),
    driftedState,
    '0014 definition drift rollback leaves the pre-existing routine unchanged'
  );
}

async function expectResolverDefinitionRepairPreflightFailure(
  pool: Pool,
  migrationsThrough14: string,
  driftedDefinition: RoutineDefinitionState,
  unchangedMetadata: RoutineMetadataState
): Promise<void> {
  let rejected = false;
  try {
    await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough14);
  } catch (error) {
    rejected = true;
    const postgresError = unwrapPostgresError(error);
    assert(postgresError !== null, '0014 resolver definition drift must expose its PostgreSQL error');
    equal(
      postgresError.code,
      '42501',
      '0014 resolver definition drift must use insufficient privilege'
    );
    assert(
      /issue-transition repair resolver authority is not canonical/iu.test(
        postgresError.message
      ),
      '0014 resolver definition drift must identify the resolver-authority preflight'
    );
  }
  assert(rejected, '0014 resolver definition drift unexpectedly migrated');
  equal(
    await migrationCount(pool),
    14,
    '0014 resolver definition drift rollback leaves the journal at 0013'
  );
  equal(
    await routineDefinitionState(pool, REPORTING_CORRECTION_RESOLVER),
    driftedDefinition,
    '0014 resolver definition drift rollback leaves the pre-existing body unchanged'
  );
  equal(
    await routineMetadataState(pool, REPORTING_CORRECTION_RESOLVER),
    unchangedMetadata,
    '0014 resolver definition drift rollback leaves all resolver metadata unchanged'
  );
}

async function expectAuditGuardDefinitionRepairPreflightFailure(
  pool: Pool,
  migrationsThrough14: string,
  predecessor: IssueTransitionRoutineState,
  triggerBefore: IssueTransitionTriggerState
): Promise<void> {
  const signature = 'public.plan6b_guard_audit_insert()';
  const cleanDefinition = await routineDefinitionState(pool, signature);
  const cleanMetadata = await routineMetadataState(pool, signature);
  equal(
    cleanDefinition.definition_sha256,
    PLAN6BII_AUDIT_INSERT_GUARD_SHA256,
    '0013 retains the exact normalized audit-insert guard definition'
  );
  await pool.query(`
    create or replace function public.plan6b_guard_audit_insert()
    returns trigger language plpgsql
    set search_path = 'pg_catalog'
    as $plan6bii_0014_audit_guard_definition_drift$
    begin
      return null;
    end;
    $plan6bii_0014_audit_guard_definition_drift$
  `);
  const driftedDefinition = await routineDefinitionState(pool, signature);
  assert(
    driftedDefinition.definition_sha256 !== cleanDefinition.definition_sha256,
    '0014 audit-guard fixture must change the body definition'
  );
  equal(
    await routineMetadataState(pool, signature),
    cleanMetadata,
    '0014 audit-guard fixture changes the body without metadata drift'
  );
  try {
    let rejected = false;
    try {
      await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough14);
    } catch (error) {
      rejected = true;
      const postgresError = unwrapPostgresError(error);
      assert(postgresError !== null, '0014 audit-guard drift must expose PostgreSQL');
      equal(postgresError.code, '42501', '0014 audit-guard drift must use insufficient privilege');
      assert(
        /issue-transition repair guard authority is not canonical/iu.test(
          postgresError.message
        ),
        '0014 audit-guard drift must identify the guard-authority preflight'
      );
    }
    assert(rejected, '0014 audit-guard drift unexpectedly migrated');
    equal(
      await migrationCount(pool),
      14,
      '0014 audit-guard drift rollback leaves the journal at 0013'
    );
    equal(
      await issueTransitionRoutineState(pool),
      predecessor,
      '0014 audit-guard drift rollback occurs before transition-function mutation'
    );
    equal(
      await issueTransitionTriggerState(pool),
      triggerBefore,
      '0014 audit-guard drift rollback leaves the transition trigger unchanged'
    );
    equal(
      await routineDefinitionState(pool, signature),
      driftedDefinition,
      '0014 audit-guard drift rollback preserves the changed body until cleanup'
    );
  } finally {
    await pool.query(cleanDefinition.routine_definition);
  }
  equal(
    await routineDefinitionState(pool, signature),
    cleanDefinition,
    '0014 audit-guard fixture restores the exact normalized 0013 definition'
  );
  equal(
    await routineMetadataState(pool, signature),
    cleanMetadata,
    '0014 audit-guard fixture restores exact clean metadata before continuing'
  );
}

interface ResolutionProvenanceState {
  issue: Record<string, unknown> | null;
  resolution_audits: Array<Record<string, unknown>>;
}

interface RelationIdentityState {
  relation_oid: string;
  namespace_name: string;
  owner_name: string;
  relation_kind: string;
  persistence: string;
  is_partition: boolean;
  row_security: boolean;
  force_row_security: boolean;
}

async function relationIdentityState(
  pool: Pool,
  relationName: string
): Promise<RelationIdentityState> {
  return one<RelationIdentityState>(
    pool,
    `select
       relation_row.oid::text as relation_oid,
       namespace_row.nspname::text as namespace_name,
       pg_catalog.pg_get_userbyid(relation_row.relowner) as owner_name,
       relation_row.relkind::text as relation_kind,
       relation_row.relpersistence::text as persistence,
       relation_row.relispartition as is_partition,
       relation_row.relrowsecurity as row_security,
       relation_row.relforcerowsecurity as force_row_security
     from pg_catalog.pg_class relation_row
     join pg_catalog.pg_namespace namespace_row
       on namespace_row.oid = relation_row.relnamespace
     where relation_row.oid = pg_catalog.to_regclass($1)`,
    [relationName]
  );
}

async function expectRelationIdentityRepairPreflightFailure(
  pool: Pool,
  migrationsThrough14: string,
  predecessor: IssueTransitionRoutineState,
  triggerBefore: IssueTransitionTriggerState
): Promise<void> {
  const relationName = 'public.audit_events';
  const cleanRelation = await relationIdentityState(pool, relationName);
  equal(cleanRelation.namespace_name, 'public', '0014 relation fixture begins in public');
  equal(cleanRelation.relation_kind, 'r', '0014 relation fixture begins as an ordinary table');
  equal(cleanRelation.persistence, 'p', '0014 relation fixture begins as a permanent table');
  equal(cleanRelation.is_partition, false, '0014 relation fixture begins as a non-partition');
  equal(cleanRelation.row_security, false, '0014 relation fixture begins without row security');
  equal(
    cleanRelation.force_row_security,
    false,
    '0014 relation fixture begins without forced row security'
  );
  for (const fixture of [
    {
      label: 'ENABLE-only RLS',
      apply: 'alter table public.audit_events enable row level security',
      cleanup: 'alter table public.audit_events disable row level security',
      expectedRowSecurity: true,
      expectedForceRowSecurity: false
    },
    {
      label: 'FORCE-only RLS',
      apply: 'alter table public.audit_events force row level security',
      cleanup: 'alter table public.audit_events no force row level security',
      expectedRowSecurity: false,
      expectedForceRowSecurity: true
    }
  ] as const) {
    await pool.query(fixture.apply);
    const driftedRelation = await relationIdentityState(pool, relationName);
    equal(
      driftedRelation.row_security,
      fixture.expectedRowSecurity,
      `0014 ${fixture.label} fixture has the exact row-security bit`
    );
    equal(
      driftedRelation.force_row_security,
      fixture.expectedForceRowSecurity,
      `0014 ${fixture.label} fixture has the exact force-row-security bit`
    );
    try {
      let rejected = false;
      try {
        await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough14);
      } catch (error) {
        rejected = true;
        const postgresError = unwrapPostgresError(error);
        assert(postgresError !== null, `0014 ${fixture.label} drift must expose PostgreSQL`);
        equal(
          postgresError.code,
          '42501',
          `0014 ${fixture.label} drift must use insufficient privilege`
        );
        assert(
          /issue-transition repair prerequisite authority is not canonical/iu.test(
            postgresError.message
          ),
          `0014 ${fixture.label} drift must identify the prerequisite-authority preflight`
        );
      }
      assert(rejected, `0014 ${fixture.label} drift unexpectedly migrated`);
      equal(
        await migrationCount(pool),
        14,
        `0014 ${fixture.label} rollback leaves the journal at 0013`
      );
      equal(
        await issueTransitionRoutineState(pool),
        predecessor,
        `0014 ${fixture.label} rollback occurs before transition-function mutation`
      );
      equal(
        await issueTransitionTriggerState(pool),
        triggerBefore,
        `0014 ${fixture.label} rollback leaves the transition trigger unchanged`
      );
      equal(
        await relationIdentityState(pool, relationName),
        driftedRelation,
        `0014 ${fixture.label} rollback preserves the pre-existing metadata drift`
      );
    } finally {
      await pool.query(fixture.cleanup);
    }
    equal(
      await relationIdentityState(pool, relationName),
      cleanRelation,
      `0014 ${fixture.label} fixture restores exact clean table metadata`
    );
  }
}

interface ProtectedCatalogExtensionState {
  trigger_definitions: string[];
  rule_definitions: string[];
  inheritance_edges: string[];
  worker_resolver_signatures: string[];
  fixture_routine_definitions: string[];
}

async function protectedCatalogExtensionState(pool: Pool): Promise<ProtectedCatalogExtensionState> {
  return one<ProtectedCatalogExtensionState>(
    pool,
    `select
       array(
         select pg_catalog.pg_get_triggerdef(trigger_row.oid, false)
         from pg_catalog.pg_trigger trigger_row
         where trigger_row.tgrelid in (
           'public.financial_admin_commands'::pg_catalog.regclass,
           'public.audit_events'::pg_catalog.regclass,
           'public.financial_reconciliation_issues'::pg_catalog.regclass
         ) and not trigger_row.tgisinternal
         order by trigger_row.tgrelid, trigger_row.tgname
       ) as trigger_definitions,
       array(
         select pg_catalog.pg_get_ruledef(rule_row.oid, false)
         from pg_catalog.pg_rewrite rule_row
         where rule_row.ev_class in (
           'public.financial_admin_commands'::pg_catalog.regclass,
           'public.financial_allocation_sets'::pg_catalog.regclass,
           'public.audit_events'::pg_catalog.regclass,
           'public.financial_reconciliation_issues'::pg_catalog.regclass
         )
         order by rule_row.ev_class, rule_row.rulename
       ) as rule_definitions,
       array(
         select pg_catalog.concat_ws('>',
           inheritance_row.inhrelid::pg_catalog.regclass::text,
           inheritance_row.inhparent::pg_catalog.regclass::text,
           inheritance_row.inhseqno::text,
           inheritance_row.inhdetachpending::text
         )
         from pg_catalog.pg_inherits inheritance_row
         where inheritance_row.inhparent in (
           'public.financial_admin_commands'::pg_catalog.regclass,
           'public.financial_allocation_sets'::pg_catalog.regclass,
           'public.audit_events'::pg_catalog.regclass,
           'public.financial_reconciliation_issues'::pg_catalog.regclass
         ) or inheritance_row.inhrelid in (
           'public.financial_admin_commands'::pg_catalog.regclass,
           'public.financial_allocation_sets'::pg_catalog.regclass,
           'public.audit_events'::pg_catalog.regclass,
           'public.financial_reconciliation_issues'::pg_catalog.regclass
         )
         order by inheritance_row.inhrelid, inheritance_row.inhparent,
           inheritance_row.inhseqno
       ) as inheritance_edges,
       array(
         select routine.oid::pg_catalog.regprocedure::text
         from pg_catalog.pg_proc routine
         join pg_catalog.pg_namespace namespace_row
           on namespace_row.oid = routine.pronamespace
         where namespace_row.nspname = 'public'
           and routine.proname = 'resolve_financial_issue_after_worker_recompute'
         order by routine.oid::pg_catalog.regprocedure::text
       ) as worker_resolver_signatures,
       array(
         select pg_catalog.pg_get_functiondef(routine.oid)
         from pg_catalog.pg_proc routine
         join pg_catalog.pg_namespace namespace_row
           on namespace_row.oid = routine.pronamespace
         where namespace_row.nspname = 'public'
           and routine.proname like 'plan6bii_0014_%_fixture'
         order by routine.proname, routine.oid
       ) as fixture_routine_definitions`
  );
}

async function expectProtectedCatalogExtensionFailures(
  pool: Pool,
  migrationsThrough14: string,
  predecessor: IssueTransitionRoutineState,
  triggerBefore: IssueTransitionTriggerState
): Promise<void> {
  const cases = [
    {
      label: 'later issue-update trigger',
      applySql: `
        create function public.plan6bii_0014_issue_shadow_fixture()
        returns trigger language plpgsql
        as $plan6bii_0014_issue_shadow_fixture$
        begin
          return new;
        end;
        $plan6bii_0014_issue_shadow_fixture$;
        create trigger zz_plan6bii_0014_issue_shadow
        before update on public.financial_reconciliation_issues
        for each row execute function public.plan6bii_0014_issue_shadow_fixture()
      `,
      cleanupSql: `
        drop trigger zz_plan6bii_0014_issue_shadow
          on public.financial_reconciliation_issues;
        drop function public.plan6bii_0014_issue_shadow_fixture()
      `,
      reason: /issue-transition repair trigger authority is not canonical/iu
    },
    {
      label: 'audit INSERT suppressor rule',
      applySql: `
        create rule zz_plan6bii_0014_audit_suppressor as
        on insert to public.audit_events do instead nothing
      `,
      cleanupSql: `
        drop rule zz_plan6bii_0014_audit_suppressor on public.audit_events
      `,
      reason: /issue-transition repair trigger authority is not canonical/iu
    },
    {
      label: 'audit INSERT suppressor trigger',
      applySql: `
        create function public.plan6bii_0014_audit_suppressor_fixture()
        returns trigger language plpgsql
        as $plan6bii_0014_audit_suppressor_fixture$
        begin
          return null;
        end;
        $plan6bii_0014_audit_suppressor_fixture$;
        create trigger zz_plan6bii_0014_audit_suppressor
        before insert on public.audit_events
        for each row execute function public.plan6bii_0014_audit_suppressor_fixture()
      `,
      cleanupSql: `
        drop trigger zz_plan6bii_0014_audit_suppressor on public.audit_events;
        drop function public.plan6bii_0014_audit_suppressor_fixture()
      `,
      reason: /issue-transition repair trigger authority is not canonical/iu
    },
    {
      label: 'later command-update shadow trigger',
      applySql: `
        create trigger zz_plan6bii_0014_command_shadow
        before update on public.financial_admin_commands
        for each row execute function
          public.plan6bii_guard_financial_admin_command_update()
      `,
      cleanupSql: `
        drop trigger zz_plan6bii_0014_command_shadow
          on public.financial_admin_commands
      `,
      reason: /issue-transition repair trigger authority is not canonical/iu
    },
    {
      label: 'worker-resolver overload',
      applySql: `
        create function public.resolve_financial_issue_after_worker_recompute(text,text)
        returns void language plpgsql as $plan6bii_0014_resolver_overload$
        begin
          return;
        end;
        $plan6bii_0014_resolver_overload$
      `,
      cleanupSql: `
        drop function public.resolve_financial_issue_after_worker_recompute(text,text)
      `,
      reason: /issue-transition repair resolver authority is not canonical/iu
    },
    {
      label: 'traditional issue-table inheritance child',
      applySql: `
        create table public.plan6bii_0014_issue_inheritance_child ()
        inherits (public.financial_reconciliation_issues)
      `,
      cleanupSql: `drop table public.plan6bii_0014_issue_inheritance_child`,
      reason: /issue-transition repair trigger authority is not canonical/iu
    }
  ] as const;
  for (const fixture of cases) {
    const cleanCatalog = await protectedCatalogExtensionState(pool);
    await pool.query(fixture.applySql);
    const driftedCatalog = await protectedCatalogExtensionState(pool);
    assert(
      JSON.stringify(driftedCatalog) !== JSON.stringify(cleanCatalog),
      `0014 ${fixture.label} fixture must change the protected catalog`
    );
    try {
      let rejected = false;
      try {
        await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough14);
      } catch (error) {
        rejected = true;
        const postgresError = unwrapPostgresError(error);
        assert(postgresError !== null, `0014 ${fixture.label} must expose PostgreSQL`);
        equal(
          postgresError.code,
          '42501',
          `0014 ${fixture.label} must use insufficient privilege`
        );
        assert(
          fixture.reason.test(postgresError.message),
          `0014 ${fixture.label} must identify its authority preflight`
        );
      }
      assert(rejected, `0014 ${fixture.label} unexpectedly migrated`);
      equal(
        await migrationCount(pool),
        14,
        `0014 ${fixture.label} rollback leaves the journal at 0013`
      );
      equal(
        await issueTransitionRoutineState(pool),
        predecessor,
        `0014 ${fixture.label} rollback occurs before transition-function mutation`
      );
      equal(
        await issueTransitionTriggerState(pool),
        triggerBefore,
        `0014 ${fixture.label} rollback leaves the transition trigger unchanged`
      );
      equal(
        await protectedCatalogExtensionState(pool),
        driftedCatalog,
        `0014 ${fixture.label} rollback preserves the catalog drift until cleanup`
      );
    } finally {
      await pool.query(fixture.cleanupSql);
    }
    equal(
      await protectedCatalogExtensionState(pool),
      cleanCatalog,
      `0014 ${fixture.label} fixture restores the exact clean catalog`
    );
  }
}

async function sessionReplicationParameterAclState(pool: Pool): Promise<string[]> {
  const state = await one<{ acl_entries: string[] }>(
    pool,
    `select array(
       select pg_catalog.concat_ws(':',
         grantee.rolname::text,
         grantor.rolname::text,
         privilege.privilege_type::text,
         privilege.is_grantable::text
       )
       from pg_catalog.pg_parameter_acl parameter_acl
       cross join lateral pg_catalog.aclexplode(parameter_acl.paracl) privilege
       join pg_catalog.pg_roles grantor on grantor.oid = privilege.grantor
       left join pg_catalog.pg_roles grantee on grantee.oid = privilege.grantee
       where parameter_acl.parname = 'session_replication_role'
       order by 1
     ) as acl_entries`
  );
  return state.acl_entries;
}

async function expectSessionReplicationParameterAclFailure(
  pool: Pool,
  migrationsThrough14: string,
  predecessor: IssueTransitionRoutineState,
  triggerBefore: IssueTransitionTriggerState
): Promise<void> {
  const cleanAcl = await sessionReplicationParameterAclState(pool);
  await pool.query(`
    grant set on parameter session_replication_role
    to pale_orbit_financial_worker
  `);
  const driftedAcl = await sessionReplicationParameterAclState(pool);
  assert(
    JSON.stringify(driftedAcl) !== JSON.stringify(cleanAcl),
    '0014 parameter-ACL fixture must grant protected SET authority'
  );
  try {
    let rejected = false;
    try {
      await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough14);
    } catch (error) {
      rejected = true;
      const postgresError = unwrapPostgresError(error);
      assert(postgresError !== null, '0014 parameter-ACL fixture must expose PostgreSQL');
      equal(postgresError.code, '42501', '0014 parameter-ACL fixture must use insufficient privilege');
      assert(
        /issue-transition repair parameter ACL is not canonical/iu.test(
          postgresError.message
        ),
        '0014 parameter-ACL fixture must identify its protected-parameter preflight'
      );
    }
    assert(rejected, '0014 parameter-ACL fixture unexpectedly migrated');
    equal(
      await migrationCount(pool),
      14,
      '0014 parameter-ACL rollback leaves the journal at 0013'
    );
    equal(
      await issueTransitionRoutineState(pool),
      predecessor,
      '0014 parameter-ACL rollback occurs before transition-function mutation'
    );
    equal(
      await issueTransitionTriggerState(pool),
      triggerBefore,
      '0014 parameter-ACL rollback leaves the transition trigger unchanged'
    );
    equal(
      await sessionReplicationParameterAclState(pool),
      driftedAcl,
      '0014 parameter-ACL rollback preserves the unsafe grant until cleanup'
    );
  } finally {
    await pool.query(`
      revoke set on parameter session_replication_role
      from pale_orbit_financial_worker
    `);
  }
  equal(
    await sessionReplicationParameterAclState(pool),
    cleanAcl,
    '0014 parameter-ACL fixture restores the exact clean parameter ACL'
  );
}

interface SessionReplicationSettingDefaultState {
  setting_rows: Array<{
    roleName: string;
    databaseName: string;
    settings: string[];
  }>;
}

async function sessionReplicationSettingDefaultState(
  client: Pool | PoolClient
): Promise<SessionReplicationSettingDefaultState> {
  return one<SessionReplicationSettingDefaultState>(
    client,
    `select coalesce(pg_catalog.jsonb_agg(
       pg_catalog.jsonb_build_object(
         'roleName', case when setting_row.setrole = 0 then 'ALL'
           else pg_catalog.pg_get_userbyid(setting_row.setrole)::text end,
         'databaseName', case when setting_row.setdatabase = 0 then 'ALL'
           else database_row.datname::text end,
         'settings', setting_row.setconfig
       ) order by setting_row.setrole, setting_row.setdatabase
     ), '[]'::jsonb) as setting_rows
     from pg_catalog.pg_db_role_setting setting_row
     left join pg_catalog.pg_database database_row
       on database_row.oid = setting_row.setdatabase
     where exists (
       select 1
       from pg_catalog.unnest(setting_row.setconfig) configured(value)
       where pg_catalog.split_part(configured.value, '=', 1) =
         'session_replication_role'
     )`
  );
}

async function expectSessionReplicationSettingDefaultFailures(
  pool: Pool,
  migrationsThrough14: string,
  predecessor: IssueTransitionRoutineState,
  triggerBefore: IssueTransitionTriggerState
): Promise<void> {
  const client = await pool.connect();
  try {
    const identity = await one<{ owner_name: string; database_name: string }>(
      client,
      `select current_user::text as owner_name,
         pg_catalog.current_database()::text as database_name`
    );
    const databaseSet = (await one<{ statement: string }>(
      client,
      `select pg_catalog.format(
         'alter database %I set session_replication_role = replica',
         pg_catalog.current_database()
       ) as statement`
    )).statement;
    const databaseReset = (await one<{ statement: string }>(
      client,
      `select pg_catalog.format(
         'alter database %I reset session_replication_role',
         pg_catalog.current_database()
       ) as statement`
    )).statement;
    for (const fixture of [
      {
        label: 'database/global replica default',
        apply: databaseSet,
        cleanup: databaseReset,
        expectedRole: 'ALL',
        expectedDatabase: identity.database_name
      },
      {
        label: 'database-owner/global replica default',
        apply: 'alter role current_user set session_replication_role = replica',
        cleanup: 'alter role current_user reset session_replication_role',
        expectedRole: identity.owner_name,
        expectedDatabase: 'ALL'
      }
    ] as const) {
      const cleanDefaults = await sessionReplicationSettingDefaultState(client);
      await client.query(fixture.apply);
      const driftedDefaults = await sessionReplicationSettingDefaultState(client);
      assert(
        driftedDefaults.setting_rows.some((row) =>
          row.roleName === fixture.expectedRole &&
          row.databaseName === fixture.expectedDatabase &&
          row.settings.includes('session_replication_role=replica')
        ),
        `0014 ${fixture.label} fixture must persist the exact replica default scope`
      );
      equal(
        (await one<{ replication_role: string }>(
          client,
          `select pg_catalog.current_setting(
             'session_replication_role'
           ) as replication_role`
        )).replication_role,
        'origin',
        `0014 ${fixture.label} fixture keeps the pinned migration session at origin`
      );
      try {
        let rejected = false;
        try {
          await migrateDatabase(
            drizzle(client),
            PLAN6BII_ATTESTED_IDENTITIES,
            migrationsThrough14
          );
        } catch (error) {
          rejected = true;
          const postgresError = unwrapPostgresError(error);
          assert(postgresError !== null, `0014 ${fixture.label} must expose PostgreSQL`);
          equal(
            postgresError.code,
            '42501',
            `0014 ${fixture.label} must use insufficient privilege`
          );
          equal(
            postgresError.message,
            'Plan 6B-II issue-transition repair session-replication default is not canonical',
            `0014 ${fixture.label} must expose the exact setting-default preflight message`
          );
        }
        assert(rejected, `0014 ${fixture.label} unexpectedly migrated`);
        await assertPlan6biiMigrationSettingsCleared(client);
        equal(
          await migrationCount(client),
          14,
          `0014 ${fixture.label} rollback leaves the journal at 0013`
        );
        equal(
          await issueTransitionRoutineState(client),
          predecessor,
          `0014 ${fixture.label} rollback occurs before transition-function mutation`
        );
        equal(
          await issueTransitionTriggerState(client),
          triggerBefore,
          `0014 ${fixture.label} rollback leaves the transition trigger unchanged`
        );
        equal(
          await sessionReplicationSettingDefaultState(client),
          driftedDefaults,
          `0014 ${fixture.label} rollback preserves the unsafe default until cleanup`
        );
      } finally {
        await client.query(fixture.cleanup);
      }
      equal(
        await sessionReplicationSettingDefaultState(client),
        cleanDefaults,
        `0014 ${fixture.label} fixture restores the exact clean setting defaults`
      );
    }
  } finally {
    client.release();
  }
}

async function resolutionProvenanceState(
  pool: Pool,
  issueId: string
): Promise<ResolutionProvenanceState> {
  return one<ResolutionProvenanceState>(
    pool,
    `select
       (select pg_catalog.to_jsonb(issue)
        from public.financial_reconciliation_issues issue
        where issue.id = $1) as issue,
       coalesce((
         select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(audit) order by audit.id)
         from public.audit_events audit
         where audit.action = 'financial.issue.resolved'
           and audit.resource_type = 'financial_issue'
           and audit.resource_id = $1::text
       ), '[]'::jsonb) as resolution_audits`,
    [issueId]
  );
}

async function runReplicaTransaction(
  pool: Pool,
  callback: (client: PoolClient) => Promise<void>
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await callback(client);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function runReplicaIssueMutation(
  pool: Pool,
  statement: string,
  values: unknown[]
): Promise<void> {
  await runReplicaTransaction(pool, async (client) => {
    await client.query(statement, values);
  });
}

async function expectMissingResolutionAuditRepairPreflightFailure(
  pool: Pool,
  migrationsThrough14: string,
  predecessor: IssueTransitionRoutineState,
  triggerBefore: IssueTransitionTriggerState
): Promise<void> {
  const issueId = randomUUID();
  await runReplicaIssueMutation(
    pool,
    `insert into public.financial_reconciliation_issues
       (id, resource_type, resource_id, safe_code, state, impact,
        occurrence_count, correlation_id, resolved_at)
     values ($1, 'payment', $2, 'missing_source', 'resolved', 'pending',
       1, 'migration-0014-missing-resolution-audit', pg_catalog.clock_timestamp())`,
    [issueId, randomUUID()]
  );
  const provenanceBefore = await resolutionProvenanceState(pool, issueId);
  assert(
    provenanceBefore.issue !== null,
    '0014 missing-audit fixture must seed one resolved financial issue'
  );
  equal(
    provenanceBefore.resolution_audits,
    [],
    '0014 missing-audit fixture begins without a resolution audit'
  );
  try {
    let rejected = false;
    try {
      await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough14);
    } catch (error) {
      rejected = true;
      const postgresError = unwrapPostgresError(error);
      assert(postgresError !== null, '0014 missing-audit fixture must expose its PostgreSQL error');
      equal(
        postgresError.code,
        '23514',
        '0014 missing-audit fixture must use check violation'
      );
      assert(
        /issue-transition repair found invalid resolution audit provenance/iu.test(
          postgresError.message
        ),
        '0014 missing-audit fixture must identify its resolution-provenance preflight'
      );
    }
    assert(rejected, '0014 missing-audit fixture unexpectedly migrated');
    equal(
      await migrationCount(pool),
      14,
      '0014 missing-audit rollback leaves the journal at 0013'
    );
    equal(
      await issueTransitionRoutineState(pool),
      predecessor,
      '0014 missing-audit rollback occurs before issue-transition function mutation'
    );
    equal(
      await issueTransitionTriggerState(pool),
      triggerBefore,
      '0014 missing-audit rollback leaves the issue-transition trigger unchanged'
    );
    equal(
      await resolutionProvenanceState(pool, issueId),
      provenanceBefore,
      '0014 missing-audit rollback leaves the invalid resolved-issue state unchanged'
    );
  } finally {
    await runReplicaIssueMutation(
      pool,
      'delete from public.financial_reconciliation_issues where id = $1',
      [issueId]
    );
  }
  equal(
    await resolutionProvenanceState(pool, issueId),
    { issue: null, resolution_audits: [] },
    '0014 missing-audit fixture removes its replica-seeded issue before continuing'
  );
}

interface InvalidAdminResolutionFixture {
  issueId: string;
  auditId: string;
  commandId: string;
}

interface AdminResolutionProvenanceState {
  issue: Record<string, unknown> | null;
  resolution_audits: Array<Record<string, unknown>>;
  command: Record<string, unknown> | null;
}

async function adminResolutionProvenanceState(
  pool: Pool,
  fixture: InvalidAdminResolutionFixture
): Promise<AdminResolutionProvenanceState> {
  return one<AdminResolutionProvenanceState>(
    pool,
    `select
       (select pg_catalog.to_jsonb(issue)
        from public.financial_reconciliation_issues issue
        where issue.id = $1) as issue,
       coalesce((
         select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(audit) order by audit.id)
         from public.audit_events audit
         where audit.action = 'financial.issue.resolved'
           and audit.resource_type = 'financial_issue'
           and audit.resource_id = $1::text
       ), '[]'::jsonb) as resolution_audits,
       (select pg_catalog.to_jsonb(command)
        from public.financial_admin_commands command
        where command.id = $2) as command`,
    [fixture.issueId, fixture.commandId]
  );
}

async function seedInvalidAdminResolutionProvenance(
  pool: Pool
): Promise<InvalidAdminResolutionFixture> {
  const fixture = {
    issueId: randomUUID(),
    auditId: randomUUID(),
    commandId: randomUUID()
  };
  const actorId = randomUUID();
  const issueRefundId = randomUUID();
  const commandRefundId = randomUUID();
  assert(
    commandRefundId !== issueRefundId,
    '0014 wrong-scope command fixture requires distinct refund identities'
  );
  const jobId = randomUUID();
  const correlationId = 'migration-0014-wrong-refund-scope';
  await runReplicaTransaction(pool, async (client) => {
    await client.query(
      `insert into public.financial_admin_commands
         (id, kind, actor_user_id, correlation_id, idempotency_key_sha256,
          input_fingerprint_sha256, private_input, job_id, status,
          safe_result_code, safe_result, completed_at)
       values ($1, 'refund_allocation_finalize', $2, $3,
         pg_catalog.repeat('a', 64), pg_catalog.repeat('b', 64),
         pg_catalog.jsonb_build_object(
           'kind', 'refund_allocation_finalize',
           'refundId', $4::text,
           'expectedActiveDraftVersion', 1,
           'previewFingerprint', pg_catalog.repeat('c', 64),
           'confirmation', 'finalize_refund_allocation'
         ), $5, 'succeeded', 'allocation_finalized',
         pg_catalog.jsonb_build_object(
           'refundId', $4::text,
           'finalizedDraftVersion', 1,
           'accessChanged', false,
           'emailQueued', false
         ), pg_catalog.now())`,
      [fixture.commandId, actorId, correlationId, commandRefundId, jobId]
    );
    await client.query(
      `insert into public.financial_reconciliation_issues
         (id, resource_type, resource_id, safe_code, state, impact,
          occurrence_count, correlation_id, resolved_by_admin_id, resolved_at)
       values ($1, 'refund', $2, 'missing_source', 'resolved', 'pending',
         1, $3, $4, pg_catalog.now())`,
      [fixture.issueId, issueRefundId, correlationId, actorId]
    );
    await client.query(
      `insert into public.audit_events
         (id, actor_type, actor_id, action, outcome, resource_type,
          resource_id, correlation_id, before, after, request_metadata)
       values ($1, 'user', $2::text, 'financial.issue.resolved', 'succeeded',
         'financial_issue', $3::text, $4, null,
         pg_catalog.jsonb_build_object(
           'resourceType', 'refund',
           'resourceId', $5::text,
           'safeCode', 'missing_source',
           'impact', 'pending',
           'state', 'resolved',
           'occurrenceCount', 1
         ) || pg_catalog.jsonb_build_object('commandId', $6::text),
         null)`,
      [
        fixture.auditId,
        actorId,
        fixture.issueId,
        correlationId,
        issueRefundId,
        fixture.commandId
      ]
    );
  });
  return fixture;
}

async function cleanupInvalidAdminResolutionProvenance(
  pool: Pool,
  fixture: InvalidAdminResolutionFixture
): Promise<void> {
  await runReplicaTransaction(pool, async (client) => {
    await client.query('delete from public.audit_events where id = $1', [fixture.auditId]);
    await client.query(
      'delete from public.financial_reconciliation_issues where id = $1',
      [fixture.issueId]
    );
    await client.query('delete from public.financial_admin_commands where id = $1', [
      fixture.commandId
    ]);
  });
}

async function expectInvalidAdminResolutionProvenanceFailures(
  pool: Pool,
  migrationsThrough14: string,
  predecessor: IssueTransitionRoutineState,
  triggerBefore: IssueTransitionTriggerState
): Promise<void> {
  for (const kind of ['wrong-refund-scope'] as const) {
    const fixture = await seedInvalidAdminResolutionProvenance(pool);
    const provenanceBefore = await adminResolutionProvenanceState(pool, fixture);
    assert(provenanceBefore.issue !== null, `0014 ${kind} fixture must seed an issue`);
    equal(
      provenanceBefore.resolution_audits.length,
      1,
      `0014 ${kind} fixture must seed one exact-looking resolution audit`
    );
    equal(
      provenanceBefore.command !== null,
      kind === 'wrong-refund-scope',
      `0014 ${kind} fixture has the intended command presence`
    );
    try {
      let rejected = false;
      try {
        await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough14);
      } catch (error) {
        rejected = true;
        const postgresError = unwrapPostgresError(error);
        assert(postgresError !== null, `0014 ${kind} fixture must expose PostgreSQL`);
        equal(postgresError.code, '23514', `0014 ${kind} fixture must use check violation`);
        assert(
          /issue-transition repair found invalid resolution audit provenance/iu.test(
            postgresError.message
          ),
          `0014 ${kind} fixture must identify invalid resolution provenance`
        );
      }
      assert(rejected, `0014 ${kind} fixture unexpectedly migrated`);
      equal(
        await migrationCount(pool),
        14,
        `0014 ${kind} rollback leaves the journal at 0013`
      );
      equal(
        await issueTransitionRoutineState(pool),
        predecessor,
        `0014 ${kind} rollback occurs before transition-function mutation`
      );
      equal(
        await issueTransitionTriggerState(pool),
        triggerBefore,
        `0014 ${kind} rollback leaves the transition trigger unchanged`
      );
      equal(
        await adminResolutionProvenanceState(pool, fixture),
        provenanceBefore,
        `0014 ${kind} rollback preserves the historical rows exactly`
      );
    } finally {
      await cleanupInvalidAdminResolutionProvenance(pool, fixture);
    }
    equal(
      await adminResolutionProvenanceState(pool, fixture),
      { issue: null, resolution_audits: [], command: null },
      `0014 ${kind} fixture removes every replica-seeded row before continuing`
    );
  }
}

async function assertDirectOwnerMissingGucResolutionRejected(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const context = await one<{
      current_user_name: string;
      database_owner_name: string;
      worker_issue_id: string | null;
      admin_issue_id: string | null;
      admin_command_id: string | null;
      admin_actor_id: string | null;
    }>(
      client,
      `select
         current_user::text as current_user_name,
         pg_catalog.pg_get_userbyid(database_row.datdba) as database_owner_name,
         pg_catalog.current_setting(
           'pale_orbit.financial_worker_issue_resolution', true
         ) as worker_issue_id,
         pg_catalog.current_setting(
           'pale_orbit.plan6bii_financial_admin_issue_resolution_issue_id', true
         ) as admin_issue_id,
         pg_catalog.current_setting(
           'pale_orbit.plan6bii_financial_admin_issue_resolution_command_id', true
         ) as admin_command_id,
         pg_catalog.current_setting(
           'pale_orbit.plan6bii_financial_admin_issue_resolution_actor_id', true
         ) as admin_actor_id
       from pg_catalog.pg_database database_row
       where database_row.datname = pg_catalog.current_database()`
    );
    equal(
      context.current_user_name,
      context.database_owner_name,
      '0014 bypass regression runs as the direct database owner'
    );
    for (const setting of [
      context.worker_issue_id,
      context.admin_issue_id,
      context.admin_command_id,
      context.admin_actor_id
    ]) {
      assert(
        setting === null || setting === '',
        '0014 bypass regression requires all resolver GUCs to be absent'
      );
    }
    const subject = await insertUserAndTitles(client, 1);
    const payment = await insertOrderGraph(client, subject.userId, subject.titleIds, {
      key: 'migration-0014-owner-bypass',
      paymentSchemaPhase: 'plan6b'
    });
    const issueId = randomUUID();
    await client.query(
      `insert into public.financial_reconciliation_issues
         (id, resource_type, resource_id, safe_code, impact, correlation_id)
       values ($1, 'payment', $2, 'missing_source', 'pending', $3)`,
      [issueId, payment.paymentId, 'migration-0014-owner-bypass']
    );
    await expectSqlStateRejected(
      client,
      `update public.financial_reconciliation_issues
       set state = 'resolved', resolved_at = pg_catalog.clock_timestamp()
       where id = $1`,
      [issueId],
      '55000',
      'direct database-owner resolution without resolver GUCs'
    );
  } finally {
    await client.query('rollback');
    client.release();
  }
}

async function assertIssueTransitionFailClosedUpgrade(pool: Pool): Promise<void> {
  equal(await migrationCount(pool), 14, '0014 fixture begins at migration 0013');
  const migrationsThrough14 = await createMigrationFolderThrough(14);
  const predecessor = await issueTransitionRoutineState(pool);
  equal(
    predecessor.definition_sha256,
    PLAN6BII_VULNERABLE_ISSUE_TRANSITION_SHA256,
    '0013 retains the exact historical vulnerable issue-transition definition'
  );
  const triggerBefore = await issueTransitionTriggerState(pool);
  await expectRelationIdentityRepairPreflightFailure(
    pool,
    migrationsThrough14,
    predecessor,
    triggerBefore
  );
  await expectProtectedCatalogExtensionFailures(
    pool,
    migrationsThrough14,
    predecessor,
    triggerBefore
  );
  await expectAuditGuardDefinitionRepairPreflightFailure(
    pool,
    migrationsThrough14,
    predecessor,
    triggerBefore
  );
  await expectSessionReplicationParameterAclFailure(
    pool,
    migrationsThrough14,
    predecessor,
    triggerBefore
  );
  await expectSessionReplicationSettingDefaultFailures(
    pool,
    migrationsThrough14,
    predecessor,
    triggerBefore
  );
  await expectMissingResolutionAuditRepairPreflightFailure(
    pool,
    migrationsThrough14,
    predecessor,
    triggerBefore
  );
  await expectInvalidAdminResolutionProvenanceFailures(
    pool,
    migrationsThrough14,
    predecessor,
    triggerBefore
  );

  const resolverPredecessor = await routineDefinitionState(
    pool,
    REPORTING_CORRECTION_RESOLVER
  );
  equal(
    resolverPredecessor.definition_sha256,
    PLAN6BII_REPORTING_CORRECTION_RESOLVER_SHA256,
    '0013 retains the exact normalized reporting-correction resolver definition'
  );
  const resolverMetadata = await routineMetadataState(
    pool,
    REPORTING_CORRECTION_RESOLVER
  );
  await pool.query(`
    create or replace function
      public.resolve_financial_issue_after_reporting_correction_command(uuid,uuid)
    returns setof public.financial_reconciliation_issues
    language plpgsql
    security definer
    set search_path = 'pg_catalog'
    as $plan6bii_reporting_correction_definition_drift_fixture$
    begin
      return;
    end;
    $plan6bii_reporting_correction_definition_drift_fixture$
  `);
  const driftedResolver = await routineDefinitionState(
    pool,
    REPORTING_CORRECTION_RESOLVER
  );
  assert(
    driftedResolver.definition_sha256 !== resolverPredecessor.definition_sha256,
    '0014 resolver-definition fixture must change the reporting-correction body'
  );
  equal(
    await routineMetadataState(pool, REPORTING_CORRECTION_RESOLVER),
    resolverMetadata,
    '0014 resolver-definition fixture changes the body without changing metadata'
  );
  await expectResolverDefinitionRepairPreflightFailure(
    pool,
    migrationsThrough14,
    driftedResolver,
    resolverMetadata
  );
  await pool.query(resolverPredecessor.routine_definition);
  equal(
    await routineDefinitionState(pool, REPORTING_CORRECTION_RESOLVER),
    resolverPredecessor,
    '0014 fixture restores the exact historical 0013 reporting-correction definition'
  );
  equal(
    await routineMetadataState(pool, REPORTING_CORRECTION_RESOLVER),
    resolverMetadata,
    '0014 fixture restores the reporting-correction resolver without metadata drift'
  );

  await pool.query(`
    create or replace function public.plan6b_validate_issue_transition()
    returns trigger language plpgsql as $plan6bii_issue_transition_drift_fixture$
    begin
      return new;
    end;
    $plan6bii_issue_transition_drift_fixture$
  `);
  const drifted = await issueTransitionRoutineState(pool);
  assert(
    drifted.definition_sha256 !== predecessor.definition_sha256,
    '0014 definition-drift fixture must change the predecessor definition'
  );
  await expectIssueTransitionRepairPreflightFailure(pool, migrationsThrough14, drifted);
  equal(
    await issueTransitionTriggerState(pool),
    triggerBefore,
    '0014 definition-drift preflight does not mutate the issue trigger'
  );

  await pool.query(predecessor.routine_definition);
  equal(
    await issueTransitionRoutineState(pool),
    predecessor,
    '0014 fixture restores the exact historical 0013 predecessor before repair'
  );

  await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough14);
  equal(await migrationCount(pool), 15, 'clean migration 0013 applies 0014 exactly once');
  const installed = await issueTransitionRoutineState(pool);
  equal(
    installed.definition_sha256,
    PLAN6BII_FIXED_ISSUE_TRANSITION_SHA256,
    '0014 installs the exact fail-closed issue-transition definition'
  );
  for (const [predicate, label] of [
    [
      /COALESCE\(\s*pg_catalog\.current_setting\(\s*'pale_orbit\.financial_worker_issue_resolution',\s*true\s*\)\s*=\s*OLD\.id::text,\s*false\s*\)/u,
      'worker issue identity'
    ],
    [
      /COALESCE\(\s*pg_catalog\.current_setting\(\s*'pale_orbit\.plan6bii_financial_admin_issue_resolution_issue_id',\s*true\s*\)\s*=\s*OLD\.id::text,\s*false\s*\)/u,
      'administrator issue identity'
    ],
    [
      /COALESCE\(\s*pg_catalog\.current_setting\(\s*'pale_orbit\.plan6bii_financial_admin_issue_resolution_command_id',\s*true\s*\)\s*~\s*'\^\[0-9a-f-\]\{36\}\$',\s*false\s*\)/u,
      'administrator command identity'
    ],
    [
      /COALESCE\(\s*pg_catalog\.current_setting\(\s*'pale_orbit\.plan6bii_financial_admin_issue_resolution_actor_id',\s*true\s*\)\s*=\s*NEW\.resolved_by_admin_id::text,\s*false\s*\)/u,
      'administrator actor identity'
    ]
  ] as const) {
    assert(
      predicate.test(installed.routine_definition),
      `0014 fail-closed definition COALESCEs the nullable ${label} predicate`
    );
  }
  assert(
    /IF NOT COALESCE\(worker_resolution OR admin_resolution, false\) THEN/u.test(
      installed.routine_definition
    ),
    '0014 fail-closed definition rejects a nullable combined resolver decision'
  );
  equal(
    installed.owner_name,
    installed.database_owner_name,
    '0014 keeps the issue-transition routine owned by the database owner'
  );
  equal(
    installed.acl_entries,
    ['DATABASE_OWNER:DATABASE_OWNER:EXECUTE:false'],
    '0014 leaves the issue-transition routine with owner-only EXECUTE'
  );
  equal(
    await issueTransitionTriggerState(pool),
    triggerBefore,
    '0014 replaces only the issue-transition routine and leaves its trigger unchanged'
  );
  await assertDirectOwnerMissingGucResolutionRejected(pool);

  await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough14);
  equal(await migrationCount(pool), 15, 'a second 0014 migrator pass is a no-op');
  equal(
    await issueTransitionRoutineState(pool),
    installed,
    'a second 0014 migrator pass leaves the fixed routine unchanged'
  );
  equal(
    await issueTransitionTriggerState(pool),
    triggerBefore,
    'a second 0014 migrator pass leaves the issue trigger unchanged'
  );
}

async function runPlan6biiIssueTransitionFailClosedFixture(pool: Pool): Promise<void> {
  equal(await migrationCount(pool), 7, '0014 fixture begins at migration 0006');
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(11) });
  equal(await migrationCount(pool), 12, '0014 fixture applies through historical migration 0011');
  try {
    await createPlan6biiAttestedRoles(pool, 0b111);
    await runCommittedPlan6biiAttestedMigration(
      pool,
      await createMigrationFolderThrough(12)
    );
    equal(await migrationCount(pool), 13, '0014 fixture applies historical migration 0012');
    await runCommittedPlan6biiAttestedMigration(
      pool,
      await createMigrationFolderThrough(13)
    );
    equal(await migrationCount(pool), 14, '0014 fixture applies historical migration 0013');
    await assertIssueTransitionFailClosedUpgrade(pool);
  } finally {
    await dropPlan6biiAttestedRoles(pool);
  }
}

type Plan6biiIdentityPrepare = (context: {
  readonly database: string;
  readonly client: PoolClient;
}) => Promise<(() => Promise<void>) | undefined>;

async function withPlan6biiIdentityCase(
  pool: Pool,
  callback: (casePool: Pool, database: string) => Promise<void>
): Promise<void> {
  const template = plan6biiIdentityDatabaseName('template');
  const database = plan6biiIdentityDatabaseName('case');
  await createPlan6biiDatabase(pool, database, template);
  const casePool = plan6biiPool(database);
  try {
    await callback(casePool, database);
  } finally {
    await casePool.end();
    await dropPlan6biiDatabase(pool, database);
  }
}

async function expectPlan6biiIdentityFailure(
  pool: Pool,
  migrationsFolder: string,
  fixture: string,
  identities: DatabaseMigrationIdentityConfig = PLAN6BII_ATTESTED_IDENTITIES,
  prepare?: Plan6biiIdentityPrepare,
  expectedError: 'postgres' | 'context' = 'postgres'
): Promise<void> {
  await withPlan6biiIdentityCase(pool, async (casePool, database) => {
    const before = await plan6biiCatalogState(casePool);
    const client = await casePool.connect();
    try {
      let cleanup: (() => Promise<void>) | undefined;
      let rejected = false;
      try {
        cleanup = await prepare?.({ database, client });
        await migrateDatabase(drizzle(client), identities, migrationsFolder);
      } catch (error) {
        rejected = true;
        const observable = observableErrorText(error);
        const privateCanaries = [
          ...Object.values(identities).filter((identity) =>
            !PLAN6BII_PUBLIC_ROLE_NAMES.has(identity)
          ),
          process.env.DATABASE_PASSWORD,
          process.env.DATABASE_PASSWORD_FILE
        ].filter((value): value is string => typeof value === 'string' && value.length > 0);
        for (const canary of privateCanaries) {
          assert(!observable.includes(canary), `${fixture} must not expose private identity context`);
        }
        if (expectedError === 'postgres') {
          const postgresError = unwrapPostgresError(error);
          assert(postgresError !== null, `${fixture} must expose its PostgreSQL error`);
          equal(postgresError.code, '42501', `${fixture} must use insufficient privilege`);
          assert(
            /Plan 6B-II migration login identity is not canonical/iu.test(postgresError.message),
            `${fixture} must identify migration login attestation`
          );
        } else {
          assert(
            error instanceof Error && /pre-existing|attestation|migration identity/iu.test(error.message),
            `${fixture} must reject the pre-existing migration context`
          );
        }
      } finally {
        await cleanup?.();
      }
      assert(rejected, `${fixture} unexpectedly passed login attestation`);
      await assertPlan6biiMigrationSettingsCleared(client);
    } finally {
      client.release();
    }
    equal(await migrationCount(casePool), 12, `${fixture} leaves the journal at 0011`);
    equal(
      await plan6biiCatalogState(casePool),
      before,
      `${fixture} leaves no partial enum, table, routine, trigger, or ACL`
    );
  });
}

async function expectPlan6biiNonOriginSessionReplicationFailure(
  pool: Pool,
  migrationsFolder: string
): Promise<void> {
  await withPlan6biiIdentityCase(pool, async (casePool) => {
    const before = await plan6biiCatalogState(casePool);
    const client = await casePool.connect();
    try {
      let rejected = false;
      await client.query(`set session_replication_role = replica`);
      try {
        await migrateDatabase(drizzle(client), PLAN6BII_ATTESTED_IDENTITIES, migrationsFolder);
      } catch (error) {
        rejected = true;
        const postgresError = unwrapPostgresError(error);
        assert(postgresError !== null, 'non-origin session must expose its PostgreSQL error');
        equal(postgresError.code, '42501', 'non-origin session must use insufficient privilege');
        assert(
          /Plan 6B-II migration requires canonical owner authority/iu.test(postgresError.message),
          'non-origin session must fail the absolute owner-authority preflight'
        );
      } finally {
        await client.query(`set session_replication_role = origin`);
      }
      assert(rejected, 'non-origin session unexpectedly passed owner-authority preflight');
      equal(
        (await one<{ replication_role: string }>(
          client,
          `select pg_catalog.current_setting('session_replication_role') as replication_role`
        )).replication_role,
        'origin',
        'non-origin fixture restores the exact canonical replication role'
      );
      await assertPlan6biiMigrationSettingsCleared(client);
    } finally {
      client.release();
    }
    equal(await migrationCount(casePool), 12, 'non-origin session leaves the journal at 0011');
    equal(
      await plan6biiCatalogState(casePool),
      before,
      'non-origin session leaves no partial enum, table, routine, trigger, or ACL'
    );
  });
}

async function expectPlan6biiIdentitySuccess(
  pool: Pool,
  migrationsFolder: string,
  fixture: string
): Promise<void> {
  await withPlan6biiIdentityCase(pool, async (casePool) => {
    const client = await casePool.connect();
    try {
      await migrateDatabase(
        drizzle(client),
        PLAN6BII_ATTESTED_IDENTITIES,
        migrationsFolder
      );
      equal(await migrationCount(casePool), 13, `${fixture} commits 0012 exactly once`);
      const installed = await plan6biiCatalogState(casePool);
      equal(installed.enum_count, 2, `${fixture} installs both command enums`);
      equal(installed.command_table_present, true, `${fixture} installs the command table`);
      equal(installed.claim_table_present, true, `${fixture} installs the claim table`);
      await assertPlan6biiMigrationSettingsCleared(client);
    } finally {
      client.release();
    }
  });
}

async function formattedRoleStatement(
  pool: Pool,
  template: string,
  ...roleNames: string[]
): Promise<string> {
  const placeholders = roleNames.map((_name, index) => `$${index + 2}::text`).join(', ');
  const result = await one<{ statement: string }>(
    pool,
    `select pg_catalog.format($1::text, ${placeholders}) as statement`,
    [template, ...roleNames]
  );
  return result.statement;
}

async function runPlan6biiMigrationIdentityCases(
  pool: Pool,
  migrationsFolder: string
): Promise<void> {
  await createPlan6biiAttestedRoles(pool, 0b111);
  try {
    await expectPlan6biiIdentityFailure(pool, migrationsFolder, 'swapped web and worker identities', {
      webUser: PLAN6BII_ATTESTED_IDENTITIES.workerUser,
      workerUser: PLAN6BII_ATTESTED_IDENTITIES.webUser,
      storageCleanupUser: PLAN6BII_ATTESTED_IDENTITIES.storageCleanupUser
    });
    await expectPlan6biiNonOriginSessionReplicationFailure(pool, migrationsFolder);
  } finally {
    await dropPlan6biiAttestedRoles(pool);
  }

  for (let presentMask = 0; presentMask < 8; presentMask += 1) {
    await createPlan6biiAttestedRoles(pool, presentMask);
    try {
      await expectPlan6biiIdentitySuccess(
        pool,
        migrationsFolder,
        `safe attested-login subset ${presentMask.toString(2).padStart(3, '0')}`
      );
    } finally {
      await dropPlan6biiAttestedRoles(pool);
    }
  }

  await pool.query(`
    create role "${PLAN6BII_ATTESTED_IDENTITIES.webUser}" with login nosuperuser
      nocreatedb nocreaterole inherit noreplication nobypassrls connection limit -1
      password null valid until 'infinity'
  `);
  try {
    await expectPlan6biiIdentityFailure(pool, migrationsFolder, 'attested role without edge');
  } finally {
    await dropPlan6biiAttestedRoles(pool);
  }

  const unexpectedLogin = 'plan6bii_unexpected_runtime_login';
  let unexpectedLoginCreated = false;
  let unexpectedLoginGranted = false;
  try {
    await pool.query(`
      create role "${unexpectedLogin}" with login nosuperuser nocreatedb nocreaterole
        inherit noreplication nobypassrls connection limit -1
        password null valid until 'infinity'
    `);
    unexpectedLoginCreated = true;
    await pool.query(`
      grant "pale_orbit_runtime" to "${unexpectedLogin}"
      with admin false, inherit true, set false
    `);
    unexpectedLoginGranted = true;
    await expectPlan6biiIdentityFailure(pool, migrationsFolder, 'unknown login group member');
  } finally {
    try {
      if (unexpectedLoginGranted) {
        await pool.query(`revoke "pale_orbit_runtime" from "${unexpectedLogin}"`);
      }
    } finally {
      if (unexpectedLoginCreated) await pool.query(`drop role "${unexpectedLogin}"`);
    }
  }

  await expectPlan6biiIdentityFailure(pool, migrationsFolder, 'duplicate attested identity', {
    ...PLAN6BII_ATTESTED_IDENTITIES,
    workerUser: PLAN6BII_ATTESTED_IDENTITIES.webUser
  });
  await expectPlan6biiIdentityFailure(pool, migrationsFolder, 'reserved attested identity', {
    ...PLAN6BII_ATTESTED_IDENTITIES,
    webUser: 'pale_orbit_runtime'
  });
  await expectPlan6biiIdentityFailure(pool, migrationsFolder, 'empty attested identity', {
    ...PLAN6BII_ATTESTED_IDENTITIES,
    webUser: ''
  });

  await createPlan6biiAttestedRoles(pool, 0b001);
  await pool.query(`alter role "${PLAN6BII_ATTESTED_IDENTITIES.webUser}" createdb`);
  try {
    await expectPlan6biiIdentityFailure(pool, migrationsFolder, 'attested role attribute drift');
  } finally {
    await dropPlan6biiAttestedRoles(pool);
  }

  await createPlan6biiAttestedRoles(pool, 0b001);
  await pool.query(`
    alter role "${PLAN6BII_ATTESTED_IDENTITIES.webUser}"
    set application_name = 'plan6bii-role-setting-drift'
  `);
  try {
    await expectPlan6biiIdentityFailure(pool, migrationsFolder, 'attested role setting drift');
  } finally {
    await pool.query(`alter role "${PLAN6BII_ATTESTED_IDENTITIES.webUser}" reset all`);
    await dropPlan6biiAttestedRoles(pool);
  }

  await createPlan6biiAttestedRoles(pool, 0b001);
  await pool.query(`
    grant "pale_orbit_storage_cleanup" to "${PLAN6BII_ATTESTED_IDENTITIES.webUser}"
    with admin false, inherit true, set false
  `);
  try {
    await expectPlan6biiIdentityFailure(pool, migrationsFolder, 'additional login inheritance');
  } finally {
    await dropPlan6biiAttestedRoles(pool);
  }

  await createPlan6biiAttestedRoles(pool, 0b001);
  await pool.query(`
    grant "pale_orbit_runtime" to "${PLAN6BII_ATTESTED_IDENTITIES.webUser}"
    with admin true, inherit true, set false
  `);
  try {
    await expectPlan6biiIdentityFailure(pool, migrationsFolder, 'attested edge option drift');
  } finally {
    await dropPlan6biiAttestedRoles(pool);
  }

  const ownerSetting = 'pale_orbit.migration_expected_web_login';
  await expectPlan6biiIdentityFailure(
    pool,
    migrationsFolder,
    'database-owner role default',
    PLAN6BII_ATTESTED_IDENTITIES,
    async () => {
      await pool.query(`alter role current_user set ${ownerSetting} = 'owner-default-drift'`);
      return async () => {
        await pool.query(`alter role current_user reset ${ownerSetting}`);
      };
    }
  );

  const databaseSetting = 'pale_orbit.migration_expected_worker_login';
  await expectPlan6biiIdentityFailure(
    pool,
    migrationsFolder,
    'database attestation default',
    PLAN6BII_ATTESTED_IDENTITIES,
    async ({ database }) => {
      const setStatement = await formattedRoleStatement(
        pool,
        `alter database %I set ${databaseSetting} = 'database-default-drift'`,
        database
      );
      const resetStatement = await formattedRoleStatement(
        pool,
        `alter database %I reset ${databaseSetting}`,
        database
      );
      await pool.query(setStatement);
      return async () => {
        await pool.query(resetStatement);
      };
    }
  );

  await expectPlan6biiIdentityFailure(
    pool,
    migrationsFolder,
    'pre-existing pinned-session attestation',
    PLAN6BII_ATTESTED_IDENTITIES,
    async ({ client }) => {
      await client.query(
        `select pg_catalog.set_config(
           'pale_orbit.migration_expected_web_login', $1, false
         )`,
        [PLAN6BII_ATTESTED_IDENTITIES.webUser]
      );
      return async () => {
        await client.query(`select pg_catalog.set_config(
          'pale_orbit.migration_expected_web_login', '', false
        )`);
      };
    },
    'context'
  );

  const ownerEdgeRole = 'plan6bii_owner_edge_fixture';
  let ownerEdgeRoleCreated = false;
  let ownerEdgeRoleGranted = false;
  let ownerName: string | undefined;
  try {
    await pool.query(`create role "${ownerEdgeRole}" nologin`);
    ownerEdgeRoleCreated = true;
    ownerName = (await one<{ owner_name: string }>(
      pool,
      'select current_user as owner_name'
    )).owner_name;
    const ownerGrant = await formattedRoleStatement(
      pool,
      'grant %I to %I with admin false, inherit true, set false',
      ownerEdgeRole,
      ownerName
    );
    await pool.query(ownerGrant);
    ownerEdgeRoleGranted = true;
    await expectPlan6biiIdentityFailure(pool, migrationsFolder, 'database-owner membership edge');
  } finally {
    try {
      if (ownerEdgeRoleGranted && ownerName) {
        const ownerRevoke = await formattedRoleStatement(
          pool,
          'revoke %I from %I',
          ownerEdgeRole,
          ownerName
        );
        await pool.query(ownerRevoke);
      }
    } finally {
      if (ownerEdgeRoleCreated) await pool.query(`drop role "${ownerEdgeRole}"`);
    }
  }
}

async function assertPlan6biiMigrationIdentityAttestation(
  pool: Pool,
  migrationsFolder: string
): Promise<void> {
  plan6biiIdentityCaseCounter = 0;
  try {
    await runPlan6biiMigrationIdentityCases(pool, migrationsFolder);
  } finally {
    await dropPlan6biiAttestedRoles(pool);
  }
}

async function expectPlan6biiCollisionFailure(
  pool: Pool,
  fixture: string,
  reason: RegExp = /Plan 6B-II authority object name is already occupied/iu
): Promise<void> {
  const before = await plan6biiCatalogState(pool);
  const client = await pool.connect();
  try {
    let rejected = false;
    try {
      await migrateDatabase(
        drizzle(client),
        PLAN6BII_ATTESTED_IDENTITIES,
        await createMigrationFolderThrough(12)
      );
    } catch (error) {
      rejected = true;
      const postgresError = unwrapPostgresError(error);
      assert(postgresError !== null, `${fixture} must expose its PostgreSQL error`);
      equal(postgresError.code, '42501', `${fixture} must use insufficient privilege`);
      assert(
        reason.test(postgresError.message),
        `${fixture} must identify the absolute-first authority preflight`
      );
    }
    assert(rejected, `${fixture} unexpectedly migrated`);
    await assertPlan6biiMigrationSettingsCleared(client);
  } finally {
    client.release();
  }
  equal(await migrationCount(pool), 12, `${fixture} leaves the journal at 0011`);
  equal(
    await plan6biiCatalogState(pool),
    before,
    `${fixture} leaves no partial enum, table, routine, trigger, or ACL`
  );
}

async function runPlan6biiAdminCommandAuthorityFixture(): Promise<void> {
  const sourceDatabase = plan6biiOwnedSourceDatabaseName();
  const template = plan6biiIdentityDatabaseName('template');
  let sourcePool = databasePool();
  let sourcePoolOpen = true;
  let pool = sourcePool;
  let controlPool: Pool | undefined;
  let templateCreated = false;
  let restoreSourceConnectionsStatement: string | undefined;
  let sourceConnectionsRestorationOwed = false;
  let primaryFailed = false;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  try {
    equal(await migrationCount(pool), 7, '0012 authority fixture begins at migration 0006');
    await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(11) });
    equal(await migrationCount(pool), 12, '0012 authority fixture applies through migration 0011');

    const populationClient = await pool.connect();
    let populated: { userId: string; titleIds: string[] };
    try {
      populated = await insertUserAndTitles(populationClient, 1);
    } finally {
      populationClient.release();
    }
    assert(populated.userId.length > 0 && populated.titleIds.length === 1,
      '0011 fixture must contain durable populated rows');

    const migrationsThrough12 = await createMigrationFolderThrough(12);
    await sourcePool.end();
    sourcePoolOpen = false;

    controlPool = plan6biiPool('postgres');
    const disableSourceConnectionsStatement = await formattedRoleStatement(
      controlPool,
      'alter database %I with allow_connections false',
      sourceDatabase
    );
    restoreSourceConnectionsStatement = await formattedRoleStatement(
      controlPool,
      'alter database %I with allow_connections true',
      sourceDatabase
    );
    sourceConnectionsRestorationOwed = true;
    await controlPool.query(disableSourceConnectionsStatement);

    let sourceSessionsDrained = false;
    for (let drainAttempt = 0; drainAttempt < 20; drainAttempt += 1) {
      await controlPool.query(
        `select pg_catalog.pg_terminate_backend(activity.pid)
         from pg_catalog.pg_stat_activity activity
         where activity.datname = $1
           and activity.pid <> pg_catalog.pg_backend_pid()`,
        [sourceDatabase]
      );
      const remaining = await one<{ session_count: string }>(
        controlPool,
        `select pg_catalog.count(*)::text as session_count
         from pg_catalog.pg_stat_activity activity
         where activity.datname = $1
           and activity.pid <> pg_catalog.pg_backend_pid()`,
        [sourceDatabase]
      );
      if (remaining.session_count === '0') {
        sourceSessionsDrained = true;
        break;
      }
      if (drainAttempt < 19) await controlPool.query('select pg_catalog.pg_sleep(0.05)');
    }
    assert(sourceSessionsDrained, 'Plan 6B-II source database did not quiesce');

    const existingTemplate = await one<{ present: boolean }>(
      controlPool,
      `select exists(
         select 1 from pg_catalog.pg_database where datname = $1
       ) as present`,
      [template]
    );
    assert(!existingTemplate.present, 'identity fixture template database already exists');
    await createPlan6biiDatabase(controlPool, template, sourceDatabase);
    templateCreated = true;
    await controlPool.query(restoreSourceConnectionsStatement);
    sourceConnectionsRestorationOwed = false;

    sourcePool = databasePool();
    sourcePoolOpen = true;
    pool = sourcePool;
    await assertPlan6biiMigrationIdentityAttestation(controlPool, migrationsThrough12);
    await assertPlan6biiAdminCommandAuthorityFixture(
      pool,
      populated,
      migrationsThrough12
    );
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  } finally {
    const preserveFirstCleanupFailure = async (
      cleanup: () => Promise<void>
    ): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        cleanupFailure ??= error;
      }
    };
    if (sourcePoolOpen) {
      await preserveFirstCleanupFailure(async () => {
        await sourcePool.end();
        sourcePoolOpen = false;
      });
    }
    const activeControlPool = controlPool;
    if (activeControlPool) {
      if (sourceConnectionsRestorationOwed) {
        await preserveFirstCleanupFailure(async () => {
          assert(
            restoreSourceConnectionsStatement !== undefined,
            'Plan 6B-II source connection restoration statement is missing'
          );
          await activeControlPool.query(restoreSourceConnectionsStatement);
          sourceConnectionsRestorationOwed = false;
        });
      }
      if (templateCreated) {
        await preserveFirstCleanupFailure(async () => {
          await dropPlan6biiDatabase(activeControlPool, template);
          templateCreated = false;
        });
      }
      await preserveFirstCleanupFailure(async () => {
        await activeControlPool.end();
      });
    }
  }
  if (primaryFailed) {
    throw primaryFailure;
  }
  if (cleanupFailure !== undefined) {
    throw cleanupFailure;
  }
}

async function assertPlan6biiAdminCommandAuthorityFixture(
  pool: Pool,
  populated: { userId: string; titleIds: string[] },
  migrationsThrough12: string
): Promise<void> {
  const originalPublicSchemaOwnership = await one<{
    database_owner: string;
    schema_owner: string;
  }>(
    pool,
    `select pg_catalog.pg_get_userbyid(database_row.datdba) as database_owner,
       pg_catalog.pg_get_userbyid(namespace_row.nspowner) as schema_owner
     from pg_catalog.pg_database database_row
     cross join pg_catalog.pg_namespace namespace_row
     where database_row.datname = pg_catalog.current_database()
       and namespace_row.nspname = 'public'`
  );
  equal(
    originalPublicSchemaOwnership.schema_owner,
    'pg_database_owner',
    'fresh PostgreSQL 18 through-0011 public schema retains its canonical owner'
  );
  const restorePublicSchemaOwnerStatement = await formattedRoleStatement(
    pool,
    'alter schema public owner to %I',
    originalPublicSchemaOwnership.schema_owner
  );
  const publicSchemaAcl = async (): Promise<Array<{
    grantee_name: string;
    grantor_name: string;
    privilege_type: string;
    is_grantable: boolean;
  }>> => (await pool.query(`
    with database_identity as (
      select database_row.datdba as database_owner
      from pg_catalog.pg_database database_row
      where database_row.datname = pg_catalog.current_database()
    )
    select
      case when privilege.grantee = 0 then 'PUBLIC'
        when privilege.grantee in (
          database_identity.database_owner,
          'pg_database_owner'::pg_catalog.regrole
        ) then 'DATABASE_OWNER'
        else grantee_role.rolname::text end as grantee_name,
      case when privilege.grantor in (
          database_identity.database_owner,
          'pg_database_owner'::pg_catalog.regrole
        ) then 'DATABASE_OWNER'
        else grantor_role.rolname::text end as grantor_name,
      privilege.privilege_type::text as privilege_type,
      privilege.is_grantable
    from pg_catalog.pg_namespace namespace_row
    cross join database_identity
    cross join lateral pg_catalog.aclexplode(coalesce(
      namespace_row.nspacl,
      pg_catalog.acldefault('n', namespace_row.nspowner)
    )) privilege
    join pg_catalog.pg_roles grantor_role on grantor_role.oid = privilege.grantor
    left join pg_catalog.pg_roles grantee_role on grantee_role.oid = privilege.grantee
    where namespace_row.nspname = 'public'
    order by 1, 2, 3, 4
  `)).rows;
  const originalPublicSchemaAcl = await publicSchemaAcl();

  await pool.query(`create type public.financial_admin_command_kind as enum ('unsafe')`);
  await expectPlan6biiCollisionFailure(pool, 'unsafe pre-existing command enum');
  await pool.query(`drop type public.financial_admin_command_kind`);

  await pool.query(`create table public.financial_admin_commands (fixture integer)`);
  await expectPlan6biiCollisionFailure(pool, 'unsafe pre-existing command table');
  await pool.query(`drop table public.financial_admin_commands`);

  await pool.query(`create table public.financial_admin_job_claims (fixture integer)`);
  await expectPlan6biiCollisionFailure(pool, 'unsafe pre-existing private claim table');
  await pool.query(`drop table public.financial_admin_job_claims`);

  await pool.query(`
    create function public.submit_financial_admin_command(uuid,text,text,text,text,jsonb)
    returns integer language sql as 'select 1'
  `);
  await expectPlan6biiCollisionFailure(pool, 'unsafe pre-existing command routine');
  await pool.query(`drop function public.submit_financial_admin_command(uuid,text,text,text,text,jsonb)`);

  await pool.query(`
    create function public.plan6bii_assert_financial_admin_job_lease(uuid)
    returns void language plpgsql as 'begin return; end'
  `);
  await expectPlan6biiCollisionFailure(pool, 'unsafe pre-existing private lease helper');
  await pool.query(`drop function public.plan6bii_assert_financial_admin_job_lease(uuid)`);

  await pool.query(`
    create function public.plan6bii_collision_fixture_trigger()
    returns trigger language plpgsql as 'begin return new; end'
  `);
  await pool.query(`
    create trigger jobs_plan6bii_financial_admin_terminal_sync
    before insert on public.jobs
    for each row execute function public.plan6bii_collision_fixture_trigger()
  `);
  await expectPlan6biiCollisionFailure(pool, 'unsafe pre-existing command trigger');
  await pool.query(`drop trigger jobs_plan6bii_financial_admin_terminal_sync on public.jobs`);
  await pool.query(`
    create trigger jobs_plan6bii_financial_admin_lease_guard
    before update on public.jobs
    for each row execute function public.plan6bii_collision_fixture_trigger()
  `);
  await expectPlan6biiCollisionFailure(pool, 'unsafe pre-existing private lease trigger');
  await pool.query(`drop trigger jobs_plan6bii_financial_admin_lease_guard on public.jobs`);
  await pool.query(`drop function public.plan6bii_collision_fixture_trigger()`);

  await pool.query(`grant select on public.jobs to pale_orbit_storage_cleanup`);
  await expectPlan6biiCollisionFailure(
    pool,
    'unsafe prerequisite direct ACL',
    /Plan 6B-II prerequisite direct ACL is not canonical/iu
  );
  await pool.query(`revoke select on public.jobs from pale_orbit_storage_cleanup`);

  await pool.query(`
    do $plan6bii_owner_column_acl_fixture$
    begin
      execute pg_catalog.format(
        'grant update (id) on public.jobs to %I', current_user
      );
    end
    $plan6bii_owner_column_acl_fixture$
  `);
  await expectPlan6biiCollisionFailure(
    pool,
    'unsafe database-owner column ACL',
    /Plan 6B-II prerequisite direct ACL is not canonical/iu
  );
  await pool.query(`
    do $plan6bii_owner_column_acl_fixture$
    begin
      execute pg_catalog.format(
        'revoke update (id) on public.jobs from %I', current_user
      );
    end
    $plan6bii_owner_column_acl_fixture$
  `);

  await pool.query(`
    alter default privileges in schema public
    grant select on tables to current_user
  `);
  await expectPlan6biiCollisionFailure(
    pool,
    'redundant explicit database-owner default ACL',
    /Plan 6B-II database owner default ACL is not canonical/iu
  );
  await pool.query(`
    alter default privileges in schema public
    revoke select on tables from current_user
  `);

  await pool.query(`
    alter default privileges in schema public
    grant insert on tables to pale_orbit_financial_worker
  `);
  await expectPlan6biiCollisionFailure(
    pool,
    'unsafe database-owner default ACL',
    /Plan 6B-II database owner default ACL is not canonical/iu
  );
  await pool.query(`
    alter default privileges in schema public
    revoke insert on tables from pale_orbit_financial_worker
  `);

  await pool.query(`
    alter default privileges for role pale_orbit_storage_cleanup in schema public
    grant select on tables to public
  `);
  await expectPlan6biiCollisionFailure(
    pool,
    'unsafe other-owner default ACL',
    /Plan 6B-II database owner default ACL is not canonical/iu
  );
  await pool.query(`
    alter default privileges for role pale_orbit_storage_cleanup in schema public
    revoke select on tables from public
  `);

  await pool.query(`create schema plan6bii_default_acl_fixture
    authorization pale_orbit_storage_cleanup`);
  await pool.query(`
    alter default privileges for role pale_orbit_storage_cleanup
      in schema plan6bii_default_acl_fixture
    grant select on tables to public
  `);
  await expectPlan6biiCollisionFailure(
    pool,
    'unsafe other-namespace default ACL',
    /Plan 6B-II database owner default ACL is not canonical/iu
  );
  await pool.query(`
    alter default privileges for role pale_orbit_storage_cleanup
      in schema plan6bii_default_acl_fixture
    revoke select on tables from public
  `);
  await pool.query(`drop schema plan6bii_default_acl_fixture`);

  await pool.query(`
    grant pale_orbit_runtime to pale_orbit_financial_worker
    with admin true, inherit true, set false
  `);
  await expectPlan6biiCollisionFailure(
    pool,
    'unsafe fixed-group membership option',
    /Plan 6B-II migration login identity is not canonical/iu
  );
  await pool.query(`
    grant pale_orbit_runtime to pale_orbit_financial_worker
    with admin false, inherit true, set false
  `);

  await pool.query(`alter table public.jobs disable trigger jobs_plan6b_web_insert_guard`);
  await expectPlan6biiCollisionFailure(
    pool,
    'disabled prerequisite job trigger',
    /Plan 6B-II prerequisite trigger is missing, disabled, or displaced/iu
  );
  await pool.query(`alter table public.jobs enable trigger jobs_plan6b_web_insert_guard`);

  await pool.query(`drop trigger jobs_plan6b_web_insert_guard on public.jobs`);
  await pool.query(`
    create trigger jobs_plan6b_web_insert_guard
    before insert on public.jobs
    for each row when (false)
    execute function public.plan6b_guard_job_insert()
  `);
  await expectPlan6biiCollisionFailure(
    pool,
    'suppressed prerequisite job trigger',
    /Plan 6B-II prerequisite trigger is missing, disabled, or displaced/iu
  );
  await pool.query(`drop trigger jobs_plan6b_web_insert_guard on public.jobs`);
  await pool.query(`
    create trigger jobs_plan6b_web_insert_guard
    before insert on public.jobs
    for each row execute function public.plan6b_guard_job_insert()
  `);

  await pool.query(`revoke select on public.jobs from pale_orbit_runtime`);
  await expectPlan6biiCollisionFailure(
    pool,
    'missing canonical runtime jobs select',
    /Plan 6B-II prerequisite direct ACL is not canonical/iu
  );
  await pool.query(`grant select on public.jobs to pale_orbit_runtime`);

  await pool.query(`grant trigger on public.jobs to pale_orbit_financial_worker`);
  await expectPlan6biiCollisionFailure(
    pool,
    'unsafe worker jobs trigger authority',
    /Plan 6B-II prerequisite direct ACL is not canonical/iu
  );
  await pool.query(`revoke trigger on public.jobs from pale_orbit_financial_worker`);

  await pool.query(`
    grant set on parameter session_replication_role to pale_orbit_financial_worker
  `);
  await expectPlan6biiCollisionFailure(
    pool,
    'unsafe worker session-replication parameter authority',
    /Plan 6B-II fixed role parameter ACL is not canonical/iu
  );
  await pool.query(`
    revoke set on parameter session_replication_role from pale_orbit_financial_worker
  `);

  await pool.query(`
    create function public.plan6bii_unexpected_jobs_trigger_fixture()
    returns trigger language plpgsql as 'begin return new; end'
  `);
  await pool.query(`
    create trigger plan6bii_unexpected_jobs_before_update
    before update on public.jobs
    for each row execute function public.plan6bii_unexpected_jobs_trigger_fixture()
  `);
  await expectPlan6biiCollisionFailure(
    pool,
    'unexpected jobs before-update trigger',
    /Plan 6B-II prerequisite trigger is missing, disabled, or displaced/iu
  );
  await pool.query(`drop trigger plan6bii_unexpected_jobs_before_update on public.jobs`);
  await pool.query(`drop function public.plan6bii_unexpected_jobs_trigger_fixture()`);

  await pool.query(`alter table public.audit_events disable trigger audit_events_reject_update`);
  await expectPlan6biiCollisionFailure(
    pool,
    'disabled prerequisite audit trigger',
    /Plan 6B-II prerequisite trigger is missing, disabled, or displaced/iu
  );
  await pool.query(`alter table public.audit_events enable trigger audit_events_reject_update`);

  await pool.query(`alter schema public owner to pale_orbit_financial_worker`);
  await expectPlan6biiCollisionFailure(
    pool,
    'unexpected public schema owner',
    /Plan 6B-II prerequisite owner is not canonical/iu
  );
  await pool.query(restorePublicSchemaOwnerStatement);
  equal(
    await publicSchemaAcl(),
    originalPublicSchemaAcl,
    'public schema direct ACL is restored exactly after the noncanonical-owner fixture'
  );
  equal(
    (await one<{ schema_owner: string }>(
      pool,
      `select pg_catalog.pg_get_userbyid(namespace_row.nspowner) as schema_owner
       from pg_catalog.pg_namespace namespace_row
       where namespace_row.nspname = 'public'`
    )).schema_owner,
    originalPublicSchemaOwnership.schema_owner,
    'public schema owner is restored exactly after the noncanonical-owner fixture'
  );

  for (const routine of [
    'public.reject_audit_event_mutation()',
    'public.plan6b_validate_issue_insert()'
  ]) {
    await pool.query(`grant execute on function ${routine} to pale_orbit_runtime`);
    await expectPlan6biiCollisionFailure(
      pool,
      `unsafe runtime execute on ${routine}`,
      /Plan 6B-II prerequisite direct ACL is not canonical/iu
    );
    await pool.query(`revoke execute on function ${routine} from pale_orbit_runtime`);
  }

  await pool.query(`
    alter function public.reject_audit_event_mutation()
    owner to pale_orbit_storage_cleanup
  `);
  await expectPlan6biiCollisionFailure(
    pool,
    'unexpected audit-mutation trigger-function owner',
    /Plan 6B-II prerequisite owner is not canonical/iu
  );
  await pool.query(`alter function public.reject_audit_event_mutation() owner to current_user`);
  await pool.query(`
    alter function public.plan6b_validate_issue_insert()
    owner to pale_orbit_storage_cleanup
  `);
  await expectPlan6biiCollisionFailure(
    pool,
    'unexpected issue-insert trigger-function owner',
    /Plan 6B-II prerequisite owner is not canonical/iu
  );
  await pool.query(`alter function public.plan6b_validate_issue_insert() owner to current_user`);

  await pool.query(`grant delete on public.stripe_events to pale_orbit_storage_cleanup`);
  await expectPlan6biiCollisionFailure(
    pool,
    'unsafe Stripe-event prerequisite ACL',
    /Plan 6B-II prerequisite direct ACL is not canonical/iu
  );
  await pool.query(`revoke delete on public.stripe_events from pale_orbit_storage_cleanup`);

  await pool.query(`alter table public.title_revisions owner to pale_orbit_storage_cleanup`);
  await expectPlan6biiCollisionFailure(
    pool,
    'unexpected title-revision prerequisite owner',
    /Plan 6B-II prerequisite owner is not canonical/iu
  );
  await pool.query(`alter table public.title_revisions owner to current_user`);

  await pool.query(`
    grant execute on function public.claim_guest_purchases_after_authorization(text,text)
    to pale_orbit_storage_cleanup
  `);
  await expectPlan6biiCollisionFailure(
    pool,
    'unsafe guest-claim prerequisite routine ACL',
    /Plan 6B-II prerequisite direct ACL is not canonical/iu
  );
  await pool.query(`
    revoke execute on function public.claim_guest_purchases_after_authorization(text,text)
    from pale_orbit_storage_cleanup
  `);

  await pool.query(`
    alter function public.resolve_financial_issue_after_worker_recompute(uuid,text)
    owner to pale_orbit_storage_cleanup
  `);
  await expectPlan6biiCollisionFailure(
    pool,
    'unexpected worker-resolver prerequisite owner',
    /Plan 6B-II prerequisite owner is not canonical/iu
  );
  await pool.query(`
    alter function public.resolve_financial_issue_after_worker_recompute(uuid,text)
    owner to current_user
  `);

  await pool.query(`revoke usage on type public.stripe_event_status from public`);
  await expectPlan6biiCollisionFailure(
    pool,
    'missing public Stripe-event-status usage',
    /Plan 6B-II prerequisite direct ACL is not canonical/iu
  );
  await pool.query(`grant usage on type public.stripe_event_status to public`);

  await pool.query(`grant usage on type public.revision_state to pale_orbit_storage_cleanup`);
  await expectPlan6biiCollisionFailure(
    pool,
    'unsafe direct revision-state ACL',
    /Plan 6B-II prerequisite direct ACL is not canonical/iu
  );
  await pool.query(`revoke usage on type public.revision_state from pale_orbit_storage_cleanup`);

  await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough12);
  equal(await migrationCount(pool), 13, 'repaired 0011 database applies 0012 exactly once');
  const installed = await plan6biiCatalogState(pool);
  equal(installed.enum_count, 2, '0012 installs both administrator command enums');
  equal(installed.command_table_present, true, '0012 installs the command table');
  equal(installed.claim_table_present, true, '0012 installs the private job-claim table');
  equal(installed.routine_count, PLAN6BII_ROUTINES.length, '0012 installs exact routines');
  equal(installed.trigger_count, PLAN6BII_TRIGGERS.length, '0012 installs exact triggers');
  equal(installed.runtime_jobs_table_select, false, '0012 revokes runtime full jobs SELECT');
  equal(
    installed.runtime_job_select_columns,
    ['id', 'deduplication_key'],
    '0012 leaves runtime only safe job-reference columns'
  );
  equal(
    await one<{ users: string; titles: string }>(
      pool,
      `select
         (select count(*)::text from public."user" where id = $1) as users,
         (select count(*)::text from public.titles where id = $2) as titles`,
      [populated.userId, populated.titleIds[0]]
    ),
    { users: '1', titles: '1' },
    'clean populated 0011 facts survive the 0012 authority migration'
  );
  await runCommittedPlan6biiAttestedMigration(pool, migrationsThrough12);
  equal(await migrationCount(pool), 13, 'a second 0012 migrator pass is a no-op');
  await assertReportingCorrectionAuthorityUpgrade(pool);
}

async function runValidFixture(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let fixture: LegacyFixture;
  try {
    await client.query('begin');
    fixture = await seedValidLegacyFixture(client);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  const beforeMigrations = await migrationCount(pool);
  equal(beforeMigrations, 7, 'owned database begins with exactly migrations 0000 through 0006');
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(11) });
  equal(await migrationCount(pool), 12, 'successful Plan 6B migrations advance through 0011');
  await assertValidBackfill(pool, fixture);
  await assertPositiveAmountConstraints(pool, fixture);
  await assertHistoryGuards(pool, fixture);
  await assertClaimAuthorityUpgrade(pool, fixture);
  await assertStorageCleanupAuthorityUpgrade(pool);
  await runRepairedFixtureThroughPlan6biiHead(pool, 'valid ordinary upgrade fixture');
}

async function runInvalidFixture(
  pool: Pool,
  kind: PrePlan6BInvalidFixtureKind
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await seedInvalidLegacyFixture(client, kind);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  const beforeMigrations = await migrationCount(pool);
  const expectedReason = {
    'zero-refund': /(?:zero|positive).*refund.*amount|refund.*amount.*(?:zero|positive)/iu,
    'zero-allocation': /(?:zero|positive).*refund.*allocation|refund.*allocation.*(?:zero|positive)/iu,
    'zero-dispute': /(?:zero|positive).*dispute.*amount|dispute.*amount.*(?:zero|positive)/iu,
    'over-allocation': /(?:over[-_ ]allocation|capacity)/iu,
    'currency-conflict': /(?:currency|cross[-_ ]currency)/iu,
    'partial-facts': /(?:partial|incomplete)[-_ ](?:allocation|facts?)/iu,
    'no-allocation-cumulative-over-capacity': /(?:unrecoverable|multi[-_ ]item).*refund.*graph/iu,
    'no-allocation-mixed-over-capacity': /(?:unrecoverable|multi[-_ ]item).*refund.*graph/iu,
    'no-allocation-missing-item-total': /(?:unrecoverable|multi[-_ ]item).*refund.*graph/iu,
    'no-allocation-zero-item-total': /(?:unrecoverable|multi[-_ ]item).*refund.*graph/iu,
    'no-allocation-item-currency-conflict': /(?:unrecoverable|multi[-_ ]item).*refund.*graph/iu,
    'no-allocation-refund-currency-conflict': /(?:unrecoverable|multi[-_ ]item).*refund.*graph/iu,
    'no-allocation-payment-capacity-mismatch': /(?:unrecoverable|multi[-_ ]item).*refund.*graph/iu,
    'no-allocation-mixed-refund-currency-conflict': /(?:unrecoverable|multi[-_ ]item).*refund.*graph/iu,
    'pending-refund-allocation': /(?:non[-_ ]succeeded|refund.*status)/iu,
    'failed-refund-allocation': /(?:non[-_ ]succeeded|refund.*status)/iu,
    'canceled-refund-allocation': /(?:non[-_ ]succeeded|refund.*status)/iu
  }[kind];
  try {
    await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(9) });
  } catch (error) {
    assertExpectedMigrationFailure(error, expectedReason, kind);
    equal(
      await migrationCount(pool),
      beforeMigrations,
      `${kind} rollback does not advance the migration journal`
    );
    await assertNoPlan6BObjects(pool);
    return;
  }
  throw new Error(`[financial-migration-test] ${kind} fixture unexpectedly migrated`);
}

async function expect0009Failure(
  pool: Pool,
  fixture: PostPlan6BInvalidFixtureKind,
  expectedReason: RegExp
): Promise<void> {
  try {
    await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(9) });
  } catch (error) {
    assertExpectedMigrationFailure(error, expectedReason, fixture);
    equal(await migrationCount(pool), 9, `${fixture} rollback does not advance the 0009 journal`);
    return;
  }
  throw new Error(`[financial-migration-test] ${fixture} fixture unexpectedly migrated`);
}

async function runPostPlan6BInvalidFixture(
  pool: Pool,
  kind: PostPlan6BInvalidFixtureKind
): Promise<void> {
  let legacyFixture: LegacyFixture | null = null;
  if (kind === 'legacy-source-principal') {
    const client = await pool.connect();
    try {
      await client.query('begin');
      legacyFixture = await seedValidLegacyFixture(client);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  equal(await migrationCount(pool), 7, 'late-upgrade fixture begins at migration 0006');
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(8) });
  equal(await migrationCount(pool), 9, 'late-upgrade fixture applies migrations 0007 and 0008');

  if (kind === 'legacy-payout-membership-currency') {
    const balanceId = await seedLegacyPayoutMembershipCurrencyConflict(pool);
    await expect0009Failure(pool, kind, /invalid legacy payout membership currency/iu);
    const preserved = await one<{ currency: string }>(
      pool,
      `select currency from stripe_balance_transactions where id = $1`,
      [balanceId]
    );
    equal(preserved.currency, 'EUR', 'failed 0009 leaves legacy payout evidence untouched');
    const repair = await pool.connect();
    try {
      await repair.query('begin');
      await repair.query('set local session_replication_role = replica');
      await repair.query(
        `update stripe_balance_transactions set currency = 'USD' where id = $1`,
        [balanceId]
      );
      await repair.query('commit');
    } catch (error) {
      await repair.query('rollback');
      throw error;
    } finally {
      repair.release();
    }
  } else {
    assert(legacyFixture !== null, 'source-principal fixture graph is missing');
    const conflict = await seedLegacySourcePrincipalConflict(pool, legacyFixture);
    for (const active of ['payment', 'refund', 'dispute'] as const) {
      await selectLegacySourcePrincipalConflict(pool, conflict, active);
      await expect0009Failure(
        pool,
        kind,
        /invalid legacy fee-reconciled source principal parity/iu
      );
    }
    await selectLegacySourcePrincipalConflict(pool, conflict, null);
  }

  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(9) });
  equal(await migrationCount(pool), 10, `${kind} repair permits exactly migration 0009`);
  await runRepairedFixtureThroughPlan6biiHead(pool, `${kind} repaired historical fixture`);
}

async function expect0010Failure(
  pool: Pool,
  fixture: ClaimAuthorityInvalidFixtureKind,
  expectedReason: RegExp
): Promise<void> {
  try {
    await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(10) });
  } catch (error) {
    assertExpectedMigrationFailure(error, expectedReason, fixture);
    equal(await migrationCount(pool), 10, `${fixture} rollback does not advance the 0010 journal`);
    const claimTable = await one<{ table_name: string | null }>(
      pool,
      `select to_regclass('public.commerce_claim_issuances')::text as table_name`
    );
    equal(claimTable.table_name, null, `${fixture} rollback leaves no partial 0010 table`);
    return;
  }
  throw new Error(`[financial-migration-test] ${fixture} fixture unexpectedly migrated`);
}

async function runClaimAuthorityInvalidFixture(
  pool: Pool,
  kind: ClaimGrantInvalidFixtureKind
): Promise<void> {
  equal(await migrationCount(pool), 7, '0010 preflight fixture begins at migration 0006');
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(9) });
  equal(await migrationCount(pool), 10, '0010 preflight fixture applies migrations 0007 through 0009');

  const client = await pool.connect();
  let graph: GuestOrderGraph;
  try {
    await client.query('begin');
    const { userId, titleIds } = await insertUserAndTitles(client, 1);
    graph = await insertGuestOrderGraph(client, {
      key: kind,
      email: `legacy-${userId}@example.com`,
      titleId: titleIds[0]!,
      paymentSchemaPhase: 'plan6b',
      ...(kind === 'legacy-claimed-guest-null-grant'
        ? { claimedByUserId: userId, includeGrant: true }
        : { includeGrant: false })
    });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  const expectedReason = kind === 'legacy-claimed-guest-null-grant'
    ? /purchase grant assignment is not backed by its claimed guest identity/iu
    : /paid guest item is missing its purchase grant/iu;
  await expect0010Failure(pool, kind, expectedReason);
  const preserved = await one<{ present: boolean }>(
    pool,
    `select exists(
       select 1 from orders where id = $1
     ) as present`,
    [graph.orderId]
  );
  assert(preserved.present, `${kind} rollback preserves the malformed legacy facts for repair`);

  if (kind === 'legacy-claimed-guest-null-grant') {
    await pool.query(
      `update guest_identities
       set claimed_by_user_id = null, claimed_at = null
       where id = $1`,
      [graph.identityId]
    );
  } else {
    await pool.query(
      `insert into entitlement_grants
         (title_id, user_id, source, order_item_id, state, state_reason)
       select item.title_id, null, 'purchase', item.id,
         'unclaimed', 'payment_succeeded'
       from order_items item
       where item.id = $1`,
      [graph.orderItemId]
    );
  }
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(10) });
  equal(await migrationCount(pool), 11, `${kind} repair permits exactly migration 0010`);
  await runRepairedFixtureThroughPlan6biiHead(pool, `${kind} repaired historical fixture`);
}

async function runClaimIdentityAuthorityInvalidFixture(pool: Pool): Promise<void> {
  const fixture = 'legacy-claimed-identity-authority' as const;
  equal(await migrationCount(pool), 7, 'claimed-identity preflight begins at migration 0006');
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(9) });
  equal(await migrationCount(pool), 10, 'claimed-identity preflight applies migrations 0007 through 0009');

  const client = await pool.connect();
  let graph: GuestOrderGraph;
  let userId: string;
  let normalizedEmail: string;
  try {
    await client.query('begin');
    const seeded = await insertUserAndTitles(client, 1);
    userId = seeded.userId;
    normalizedEmail = `legacy-${userId}@example.com`;
    graph = await insertGuestOrderGraph(client, {
      key: fixture,
      email: normalizedEmail,
      titleId: seeded.titleIds[0]!,
      claimedByUserId: userId,
      grantUserId: userId,
      includeGrant: true,
      paymentSchemaPhase: 'plan6b'
    });
    await client.query(
      `update "user" set email_verified = false where id = $1`,
      [userId]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  await expect0010Failure(
    pool,
    fixture,
    /guest identity claim is not backed by the verified normalized user email/iu
  );
  const unverified = await one<{
    email: string;
    email_verified: boolean;
    identity_email: string;
    claimed_by_user_id: string;
    grant_user_id: string;
    has_active_entitlement: boolean;
  }>(
    pool,
    `select claimant.email, claimant.email_verified,
       identity.email as identity_email, identity.claimed_by_user_id,
       grant_row.user_id as grant_user_id,
       exists(
         select 1 from entitlements entitlement
         where entitlement.user_id = claimant.id
           and entitlement.title_id = grant_row.title_id
           and entitlement.revoked_at is null
       ) as has_active_entitlement
     from guest_identities identity
     join "user" claimant on claimant.id = identity.claimed_by_user_id
     join orders purchase_order on purchase_order.guest_identity_id = identity.id
     join order_items item on item.order_id = purchase_order.id
     join entitlement_grants grant_row
       on grant_row.order_item_id = item.id and grant_row.source = 'purchase'
     where identity.id = $1`,
    [graph.identityId]
  );
  equal(
    unverified,
    {
      email: normalizedEmail,
      email_verified: false,
      identity_email: normalizedEmail,
      claimed_by_user_id: userId,
      grant_user_id: userId,
      has_active_entitlement: true
    },
    'failed 0010 preserves only the isolated unverified claimed-identity defect'
  );

  const mismatchedEmail = `mismatch-${userId}@example.com`;
  await pool.query(
    `update "user" set email = $2, email_verified = true where id = $1`,
    [userId, mismatchedEmail]
  );
  await expect0010Failure(
    pool,
    fixture,
    /guest identity claim is not backed by the verified normalized user email/iu
  );
  const mismatched = await one<{
    email: string;
    email_verified: boolean;
    identity_email: string;
  }>(
    pool,
    `select claimant.email, claimant.email_verified, identity.email as identity_email
     from guest_identities identity
     join "user" claimant on claimant.id = identity.claimed_by_user_id
     where identity.id = $1`,
    [graph.identityId]
  );
  equal(
    mismatched,
    { email: mismatchedEmail, email_verified: true, identity_email: normalizedEmail },
    'failed 0010 preserves the isolated normalized-email mismatch for repair'
  );

  await pool.query(
    `update "user" set email = $2 where id = $1`,
    [userId, normalizedEmail]
  );
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(10) });
  equal(await migrationCount(pool), 11, `${fixture} repair permits exactly migration 0010`);
  await runRepairedFixtureThroughPlan6biiHead(pool, `${fixture} repaired historical fixture`);
}

async function runEntitlementProjectionInvalidFixture(pool: Pool): Promise<void> {
  const fixture = 'legacy-entitlement-projection' as const;
  equal(await migrationCount(pool), 7, 'entitlement preflight begins at migration 0006');
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(9) });
  equal(await migrationCount(pool), 10, 'entitlement preflight applies migrations 0007 through 0009');

  const client = await pool.connect();
  let userId: string;
  let titleId: string;
  let orderId: string;
  try {
    await client.query('begin');
    const seeded = await insertUserAndTitles(client, 1);
    userId = seeded.userId;
    titleId = seeded.titleIds[0]!;
    const graph = await insertOrderGraph(client, userId, [titleId], {
      key: fixture,
      paymentSchemaPhase: 'plan6b'
    });
    orderId = graph.orderId;
    await client.query(
      `delete from entitlements where user_id = $1 and title_id = $2`,
      [userId, titleId]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  await expect0010Failure(
    pool,
    fixture,
    /effective entitlement projection is inconsistent with grant state/iu
  );
  const preserved = await one<{
    order_present: boolean;
    active_grant_count: string;
    active_entitlement_count: string;
  }>(
    pool,
    `select
       exists(select 1 from orders where id = $1) as order_present,
       (select count(*)::text from entitlement_grants
         where user_id = $2 and title_id = $3 and state = 'active') as active_grant_count,
       (select count(*)::text from entitlements
         where user_id = $2 and title_id = $3 and revoked_at is null) as active_entitlement_count`,
    [orderId, userId, titleId]
  );
  equal(
    preserved,
    { order_present: true, active_grant_count: '1', active_entitlement_count: '0' },
    'failed 0010 preserves the isolated active-grant projection defect for repair'
  );

  await pool.query(
    `insert into entitlements (user_id, title_id) values ($1, $2)`,
    [userId, titleId]
  );
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolderThrough(10) });
  equal(await migrationCount(pool), 11, `${fixture} repair permits exactly migration 0010`);
  await runRepairedFixtureThroughPlan6biiHead(pool, `${fixture} repaired historical fixture`);
}

async function main(): Promise<void> {
  assertMigrationFailureMatcherRejectsWrapperSql();
  const argumentIndex = process.argv.indexOf('--fixture');
  if (argumentIndex < 0) {
    const harness = join(repositoryRoot, 'scripts', 'with-plan6b-upgrade-database.ts');
    for (const fixture of [
      'valid',
      'zero-refund',
      'zero-allocation',
      'zero-dispute',
      'over-allocation',
      'currency-conflict',
      'partial-facts',
      'no-allocation-cumulative-over-capacity',
      'no-allocation-mixed-over-capacity',
      'no-allocation-missing-item-total',
      'no-allocation-zero-item-total',
      'no-allocation-item-currency-conflict',
      'no-allocation-refund-currency-conflict',
      'no-allocation-payment-capacity-mismatch',
      'no-allocation-mixed-refund-currency-conflict',
      'pending-refund-allocation',
      'failed-refund-allocation',
      'canceled-refund-allocation',
      'fixed-group-attribute-preflight',
      'unexpected-named-authority-preflight',
      'legacy-payout-membership-currency',
      'legacy-source-principal',
      'legacy-claimed-guest-null-grant',
      'legacy-paid-guest-missing-grant',
      'legacy-claimed-identity-authority',
      'legacy-entitlement-projection',
      'storage-cleanup-authority-preflight',
      'plan6bii-admin-command-authority',
      'plan6bii-issue-transition-fail-closed'
    ] as const) {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(import.meta.resolve('tsx/cli')),
          harness,
          '--phase-command',
          'tsx',
          fileURLToPath(import.meta.url),
          '--fixture',
          fixture
        ],
        { cwd: repositoryRoot, env: process.env, stdio: 'inherit' }
      );
      assert(result.status === 0, `${fixture} owned upgrade fixture failed`);
    }
    return;
  }
  const rawFixture = process.argv[argumentIndex + 1];
  assert(
    rawFixture === 'valid' ||
      rawFixture === 'zero-refund' ||
      rawFixture === 'zero-allocation' ||
      rawFixture === 'zero-dispute' ||
      rawFixture === 'over-allocation' ||
      rawFixture === 'currency-conflict' ||
      rawFixture === 'partial-facts' ||
      rawFixture === 'no-allocation-cumulative-over-capacity' ||
      rawFixture === 'no-allocation-mixed-over-capacity' ||
      rawFixture === 'no-allocation-missing-item-total' ||
      rawFixture === 'no-allocation-zero-item-total' ||
      rawFixture === 'no-allocation-item-currency-conflict' ||
      rawFixture === 'no-allocation-refund-currency-conflict' ||
      rawFixture === 'no-allocation-payment-capacity-mismatch' ||
      rawFixture === 'no-allocation-mixed-refund-currency-conflict' ||
      rawFixture === 'pending-refund-allocation' ||
      rawFixture === 'failed-refund-allocation' ||
      rawFixture === 'canceled-refund-allocation' ||
      rawFixture === 'fixed-group-attribute-preflight' ||
      rawFixture === 'unexpected-named-authority-preflight' ||
      rawFixture === 'legacy-payout-membership-currency' ||
      rawFixture === 'legacy-source-principal' ||
      rawFixture === 'legacy-claimed-guest-null-grant' ||
      rawFixture === 'legacy-paid-guest-missing-grant' ||
      rawFixture === 'legacy-claimed-identity-authority' ||
      rawFixture === 'legacy-entitlement-projection' ||
      rawFixture === 'storage-cleanup-authority-preflight' ||
      rawFixture === 'plan6bii-admin-command-authority' ||
      rawFixture === 'plan6bii-issue-transition-fail-closed',
    `unknown fixture ${rawFixture ?? '<missing>'}`
  );
  if (rawFixture === 'plan6bii-admin-command-authority') {
    await runPlan6biiAdminCommandAuthorityFixture();
    console.info(`[financial-migration-test] ${rawFixture} fixture passed`);
    return;
  }
  const pool = databasePool();
  try {
    if (rawFixture === 'valid') await runValidFixture(pool);
    else if (rawFixture === 'fixed-group-attribute-preflight') {
      await runFixedGroupAttributePreflightFixture(pool);
    }
    else if (rawFixture === 'unexpected-named-authority-preflight') {
      await runUnexpectedNamedAuthorityPreflightFixture(pool);
    }
    else if (
      rawFixture === 'legacy-payout-membership-currency' ||
      rawFixture === 'legacy-source-principal'
    ) await runPostPlan6BInvalidFixture(pool, rawFixture);
    else if (
      rawFixture === 'legacy-claimed-guest-null-grant' ||
      rawFixture === 'legacy-paid-guest-missing-grant'
    ) await runClaimAuthorityInvalidFixture(pool, rawFixture);
    else if (rawFixture === 'legacy-claimed-identity-authority') {
      await runClaimIdentityAuthorityInvalidFixture(pool);
    } else if (rawFixture === 'legacy-entitlement-projection') {
      await runEntitlementProjectionInvalidFixture(pool);
    } else if (rawFixture === 'storage-cleanup-authority-preflight') {
      await runStorageCleanupAuthorityPreflightFixture(pool);
    } else if (rawFixture === 'plan6bii-issue-transition-fail-closed') {
      await runPlan6biiIssueTransitionFailClosedFixture(pool);
    } else await runInvalidFixture(pool, rawFixture);
    console.info(`[financial-migration-test] ${rawFixture} fixture passed`);
  } finally {
    await pool.end();
  }
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPoint === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
