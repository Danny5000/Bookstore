import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

type FixtureKind =
  | 'valid'
  | 'over-allocation'
  | 'currency-conflict'
  | 'partial-facts'
  | 'pending-refund-allocation'
  | 'failed-refund-allocation'
  | 'canceled-refund-allocation';

const invalidRefundStatusByFixture: Partial<
  Record<Exclude<FixtureKind, 'valid'>, 'pending' | 'failed' | 'canceled'>
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
  historyIds: Record<'stripeEvent' | 'job' | 'outbox' | 'audit', string>;
  countsBefore: Record<string, number>;
}

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const expectedMigrationPath = resolve(repositoryRoot, 'drizzle', '0007_plan6b_financial_reconciliation.sql');
const PLAN6B_TABLES = [
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

function assertExpectedMigrationFailure(
  error: unknown,
  expectedReason: RegExp,
  fixture: Exclude<FixtureKind, 'valid'>
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

async function createMigrationFolder(include0007: boolean): Promise<string> {
  const runId = process.env.PLAN6B_UPGRADE_RUN_ID;
  assert(runId && /^[a-f0-9]{16}$/u.test(runId), 'owned run ID is missing or invalid');
  const folder = join(dirname(process.env.PLAN6B_UPGRADE_MANIFEST!), `migrations-${include0007 ? 'full' : 'legacy'}`);
  await mkdir(join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(
    await readFile(join(repositoryRoot, 'drizzle', 'meta', '_journal.json'), 'utf8')
  ) as { version: string; dialect: string; entries: Array<Record<string, unknown> & { idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= (include0007 ? 7 : 6));
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
    orderItemIds.push(itemId);
    await client.query(
      `insert into order_items
         (id, order_id, title_id, title_snapshot, creator_name_snapshot, format,
          currency, unit_subtotal_minor, tax_minor, total_minor)
       values ($1, $2, $3, $4, 'Creator', 'prose', $5, 1000, 100, 1100)`,
      [itemId, orderId, titleId, `Legacy ${options.key} ${index}`, options.itemCurrencies?.[index] ?? 'USD']
    );
    await client.query(
      `insert into entitlement_grants
         (title_id, user_id, source, order_item_id, state, state_reason)
       values ($1, $2, 'purchase', $3, 'active', 'paid')`,
      [titleId, userId, itemId]
    );
  }
  const paymentId = randomUUID();
  await client.query(
    `insert into payments
       (id, order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
        amount_minor, currency, paid_at, reconciliation_status)
     values ($1, $2, $3, $4, 'succeeded', $5, $6, clock_timestamp(), $7)`,
    [
      paymentId,
      orderId,
      `pi_${options.key}_${paymentId}`,
      `ch_${options.key}_${paymentId}`,
      options.paymentAmount ?? orderSubtotal + orderTax,
      options.paymentCurrency ?? 'USD',
      options.paymentReconciliation ?? 'pending'
    ]
  );
  return { orderId, orderItemIds, paymentId };
}

async function insertRefund(
  client: PoolClient,
  paymentId: string,
  options: {
    key: string;
    status: 'pending' | 'succeeded' | 'failed' | 'canceled';
    amountMinor: number;
    currency?: string;
    reconciliation: 'pending' | 'reconciled' | 'exception';
  }
): Promise<string> {
  const refundId = randomUUID();
  await client.query(
    `insert into refunds
       (id, payment_id, stripe_refund_id, status, amount_minor, currency,
        provider_created_at, reconciliation_status)
     values ($1, $2, $3, $4, $5, $6, clock_timestamp(), $7)`,
    [
      refundId,
      paymentId,
      `re_${options.key}_${refundId}`,
      options.status,
      options.amountMinor,
      options.currency ?? 'USD',
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
  const { userId, titleIds } = await insertUserAndTitles(client, 10);
  const paymentIds: Record<string, string> = {};
  const refundIds: Record<string, string> = {};
  const disputeIds: Record<string, string> = {};
  const orderIds: string[] = [];
  const orderItemIds: string[] = [];
  const refundAllocationIds: string[] = [];

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
    historyIds,
    countsBefore: await tableCounts(client, preservedTables)
  };
}

async function seedInvalidLegacyFixture(client: PoolClient, kind: Exclude<FixtureKind, 'valid'>): Promise<void> {
  const { userId, titleIds } = await insertUserAndTitles(client, 2);
  const invalidRefundStatus = invalidRefundStatusByFixture[kind];
  const graph = await insertOrderGraph(client, userId, titleIds, {
    key: kind,
    ...(kind === 'currency-conflict' ? { itemCurrencies: ['USD', 'EUR'] } : {})
  });
  const refundId = await insertRefund(client, graph.paymentId, {
    key: kind,
    status: invalidRefundStatus ?? 'succeeded',
    amountMinor: kind === 'over-allocation' ? 1100 : 500,
    reconciliation: invalidRefundStatus === undefined ? 'exception' : 'pending'
  });
  if (invalidRefundStatus !== undefined) {
    await client.query(
      `insert into refund_allocations (refund_id, order_item_id, amount_minor, source)
       values ($1, $2, 250, 'automatic'), ($1, $3, 250, 'automatic')`,
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

async function migrationCount(pool: Pool): Promise<number> {
  const row = await one<{ count: string }>(
    pool,
    `select count(*)::text as count from drizzle.__drizzle_migrations`
  );
  return Number(row.count);
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
  equal(
    components.rows,
    [
      {
        refund_allocation_id: fixture.refundAllocationIds[0],
        order_item_id: fixture.orderItemIds[0],
        subtotal_minor: 1000,
        tax_minor: 100,
        total_minor: 1100,
        currency: 'USD'
      }
    ],
    'automatic full allocation receives exact deterministic subtotal/tax components'
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
  pool: Pool,
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
  await pool.query(
    `select * from resolve_financial_reconciliation_issue($1, $2)`,
    [ids.issue, fixture.userId]
  );
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
  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolder(true) });
  equal(await migrationCount(pool), 8, 'successful 0007 advances the migration journal once');
  await assertValidBackfill(pool, fixture);
  await assertHistoryGuards(pool, fixture);

  await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolder(true) });
  equal(await migrationCount(pool), 8, 'running the migration runner again is a no-op');
}

async function runInvalidFixture(
  pool: Pool,
  kind: Exclude<FixtureKind, 'valid'>
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
    'over-allocation': /(?:over[-_ ]allocation|capacity)/iu,
    'currency-conflict': /(?:currency|cross[-_ ]currency)/iu,
    'partial-facts': /(?:partial|incomplete)[-_ ](?:allocation|facts?)/iu,
    'pending-refund-allocation': /(?:non[-_ ]succeeded|refund.*status)/iu,
    'failed-refund-allocation': /(?:non[-_ ]succeeded|refund.*status)/iu,
    'canceled-refund-allocation': /(?:non[-_ ]succeeded|refund.*status)/iu
  }[kind];
  try {
    await migrate(drizzle(pool), { migrationsFolder: await createMigrationFolder(true) });
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

async function main(): Promise<void> {
  assertMigrationFailureMatcherRejectsWrapperSql();
  const argumentIndex = process.argv.indexOf('--fixture');
  if (argumentIndex < 0) {
    const harness = join(repositoryRoot, 'scripts', 'with-plan6b-upgrade-database.ts');
    for (const fixture of [
      'valid',
      'over-allocation',
      'currency-conflict',
      'partial-facts',
      'pending-refund-allocation',
      'failed-refund-allocation',
      'canceled-refund-allocation'
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
      rawFixture === 'over-allocation' ||
      rawFixture === 'currency-conflict' ||
      rawFixture === 'partial-facts' ||
      rawFixture === 'pending-refund-allocation' ||
      rawFixture === 'failed-refund-allocation' ||
      rawFixture === 'canceled-refund-allocation',
    `unknown fixture ${rawFixture ?? '<missing>'}`
  );
  const pool = databasePool();
  try {
    if (rawFixture === 'valid') await runValidFixture(pool);
    else await runInvalidFixture(pool, rawFixture);
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
