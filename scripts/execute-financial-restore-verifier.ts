import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`[restore-verifier] ${name} is required`);
  return value;
}

const arguments_ = process.argv.slice(2);
const supportedArguments = new Set([
  '--seed-missing-credential-authority',
  '--exercise-financial-invariant-witnesses'
]);
if (
  arguments_.length > 1 ||
  (arguments_.length === 1 && !supportedArguments.has(arguments_[0]!))
) {
  throw new Error('[restore-verifier] unsupported command-line arguments');
}

const databaseHost = requiredEnvironment('DATABASE_HOST');
const databaseName = requiredEnvironment('DATABASE_NAME');
const databaseUser = requiredEnvironment('DATABASE_USER');
if (
  requiredEnvironment('APP_ENV') !== 'test' ||
  !['127.0.0.1', '::1', 'localhost'].includes(databaseHost.toLowerCase()) ||
  databaseName !== 'pale_orbit_test' ||
  databaseUser !== 'pale_orbit_test'
) {
  throw new Error('[restore-verifier] refusing a non-disposable test database');
}

const databasePort = requiredEnvironment('DATABASE_PORT');
const port = Number(databasePort);
if (!/^\d+$/u.test(databasePort) || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('[restore-verifier] DATABASE_PORT is invalid');
}

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const verifierPath = fileURLToPath(
  new URL('./verify-financial-restore.sql', import.meta.url)
);
const verifier = await readFile(verifierPath, 'utf8');
const verifierLines = verifier.split(/\r?\n/u);
const allowedMetaCommands = ['\\set ON_ERROR_STOP on', '\\set QUIET on'];
const metaCommands = verifierLines
  .filter((line) => /^\s*\\/u.test(line))
  .map((line) => line.trimStart());
if (
  metaCommands.length !== allowedMetaCommands.length ||
  metaCommands.some((command, index) => command !== allowedMetaCommands[index])
) {
  throw new Error('[restore-verifier] unsafe psql meta-command');
}
const executableSql = verifierLines
  .filter((line) => !/^\s*\\/u.test(line))
  .join('\n');
const seedMissingCredentialAuthority = arguments_[0] === '--seed-missing-credential-authority';
const exerciseFinancialInvariantWitnesses =
  arguments_[0] === '--exercise-financial-invariant-witnesses';

const databaseConfiguration = {
  host: databaseHost,
  port,
  database: databaseName,
  user: databaseUser,
  password: requiredEnvironment('DATABASE_PASSWORD'),
  max: 1,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  application_name: 'pale-orbit-restore-verifier-witness'
} as const;
const pool = new Pool(databaseConfiguration);

interface VerifierOutcome {
  readonly error: Error | null;
  readonly rows: readonly Record<string, unknown>[];
}

async function verifierOutcome(): Promise<VerifierOutcome> {
  const verifierPool = new Pool({
    ...databaseConfiguration,
    application_name: 'pale-orbit-restore-verifier-execution'
  });
  try {
    const result = await verifierPool.query(executableSql);
    const results = Array.isArray(result) ? result : [result];
    return {
      error: null,
      rows: results.flatMap((entry) => entry.rows as Record<string, unknown>[])
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      rows: []
    };
  } finally {
    await verifierPool.end();
  }
}

async function exerciseInvariantWitnesses(): Promise<void> {
  const failures: string[] = [];
  const operationalCheckNames = [
    'failed_running_scan_permanent',
    'failed_running_scan_retry_exhausted',
    'pending_replay_child_incomplete',
    'pending_replay_child_permanent',
    'pending_replay_child_retry_exhausted'
  ] as const;
  const validateOperationalShape = (name: string, outcome: VerifierOutcome): boolean => {
    if (outcome.rows.length !== operationalCheckNames.length) {
      failures.push(`${name} returned an invalid operational diagnostic row count`);
      return false;
    }
    for (const [index, checkName] of operationalCheckNames.entries()) {
      const row = outcome.rows[index];
      if (
        row?.check_name !== checkName ||
        !/^(?:0|[1-9][0-9]*)$/u.test(String(row.violation_count))
      ) {
        failures.push(`${name} returned an invalid operational diagnostic contract`);
        return false;
      }
    }
    return true;
  };
  const expectPass = async (name: string, expectAllZero = false) => {
    const outcome = await verifierOutcome();
    if (outcome.error) {
      failures.push(`${name} unexpectedly failed: ${outcome.error.message}`);
      return;
    }
    if (!validateOperationalShape(name, outcome)) return;
    if (expectAllZero && outcome.rows.some((row) => row.violation_count !== '0')) {
      failures.push(`${name} returned a nonzero operational diagnostic`);
    }
  };
  const expectRejection = async (name: string, checkName: string) => {
    const { error } = await verifierOutcome();
    if (!error) failures.push(`${name} unexpectedly passed`);
    else if (!error.message.includes(checkName)) {
      failures.push(`${name} failed without ${checkName}: ${error.message}`);
    }
  };
  const expectDiagnostics = async (name: string, checkNames: readonly string[]) => {
    const outcome = await verifierOutcome();
    if (outcome.error) {
      failures.push(`${name} unexpectedly failed: ${outcome.error.message}`);
      return;
    }
    if (!validateOperationalShape(name, outcome)) return;
    for (const checkName of checkNames) {
      const diagnostic = outcome.rows.find((row) =>
        row.check_name === checkName && Number(row.violation_count) > 0
      );
      if (!diagnostic) failures.push(`${name} did not surface ${checkName}`);
    }
  };

  const payoutId = '10000000-0000-4000-8000-000000000001';
  const priorPayoutRunId = '10000000-0000-4000-8000-000000000002';
  const equalPayoutRunId = '10000000-0000-4000-8000-000000000003';
  const aheadPayoutRunId = '10000000-0000-4000-8000-000000000004';
  await pool.query(`
    insert into stripe_payouts (
      id, provider_id, live_mode, amount_minor, currency, automatic, method, status,
      reconciliation_status, provider_created_at, arrival_at, retrieved_at,
      financial_generation, fingerprint_sha256
    ) values (
      $1, 'po_restore_equal_generation', false, 100, 'USD', true, 'standard', 'paid',
      'completed', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', now(),
      2, repeat('a', 64)
    )
  `, [payoutId]);
  await pool.query(`
    insert into payout_import_runs (
      id, payout_id, generation, state, candidate_count, page_count, safe_outcome, completed_at
    ) values
      ($2, $1, 0, 'published', 0, 1, 'published', now()),
      ($3, $1, 2, 'published', 0, 1, 'published', now())
  `, [payoutId, priorPayoutRunId, equalPayoutRunId]);
  await pool.query(`
    insert into jobs (type, payload, deduplication_key, max_attempts)
    values (
      'commerce.financial-scan',
      jsonb_build_object('kind', 'payout_impact', 'payoutId', $1::uuid, 'payoutGeneration', 2),
      'financial:payout-impact:' || $1::text || ':2', 8
    )
  `, [payoutId]);
  await expectPass('published payout replay at the current generation', true);

  await pool.query(`
    insert into payout_import_runs (
      id, payout_id, generation, state, candidate_count, page_count, safe_outcome, completed_at
    ) values ($1, $2, 3, 'published', 0, 1, 'published', now())
  `, [aheadPayoutRunId, payoutId]);
  await expectRejection('published payout run ahead of authority', 'run_generation_order=1');
  await pool.query('delete from payout_import_runs where id = $1', [aheadPayoutRunId]);

  const replayRunId = '20000000-0000-4000-8000-000000000001';
  const replayRootKey = 'commerce.financial-classification:scan:2:2';
  const replayDigestResult = await pool.query<{ digest: string }>(`
    select encode(sha256(
      convert_to('classification_replay_finalize', 'UTF8') || decode('00', 'hex') ||
      convert_to('', 'UTF8')
    ), 'hex') as digest
  `);
  const replayDigest = replayDigestResult.rows[0]?.digest;
  if (!replayDigest) throw new Error('[restore-verifier] failed to build replay witness digest');
  const replayFinalizerKey =
    `commerce.financial-scan:${replayRunId}:classification_replay_finalize:${replayDigest}`;
  await pool.query(`
    insert into financial_scan_runs (
      id, root_key, kind, phase, state, classifier_version, allocation_algorithm_version,
      replay_id, checkpoint, cursor_digest_sha256, processed_count, enqueued_count, page_count
    ) values ($1, $2, 'classification_replay', 'classification_replay_finalize', 'running',
      2, 2, 'c2-a2', null, $3, 0, 1, 1)
  `, [replayRunId, replayRootKey, replayDigest]);
  await pool.query(`
    insert into jobs (type, payload, deduplication_key, status, attempts, max_attempts)
    values
      ('commerce.financial-scan',
        jsonb_build_object('kind', 'composite_replay', 'classifierVersion', 2,
          'allocationAlgorithmVersion', 2, 'replayId', 'c2-a2'),
        $2, 'pending', 0, 8),
      ('commerce.financial-scan',
        jsonb_build_object('kind', 'continuation', 'scanRunId', $1::uuid,
          'phase', 'classification_replay_finalize', 'cursorDigestSha256', $3::text, 'limit', 100),
        $4, 'pending', 0, 8),
      ('commerce.financial-classification',
        jsonb_build_object('scanRunId', $1::uuid, 'classifierVersion', 2,
          'allocationAlgorithmVersion', 2, 'replayId', 'c2-a2'),
        'restore-replay-child', 'pending', 0, 8)
  `, [replayRunId, replayRootKey, replayDigest, replayFinalizerKey]);
  await pool.query(`
    update financial_projection_versions set
      pending_classifier_version = 2, pending_allocation_algorithm_version = 2,
      pending_replay_id = 'c2-a2', pending_scan_run_id = $1
    where singleton = true
  `, [replayRunId]);
  await expectPass('pending replay with a resumable child');

  await pool.query(`
    insert into jobs (
      type, payload, deduplication_key, status, attempts, max_attempts, completed_at
    ) values (
      'commerce.financial-classification',
      jsonb_build_object('scanRunId', $1::uuid, 'classifierVersion', 2,
        'allocationAlgorithmVersion', 2, 'replayId', 'c2-a2'),
      'restore-replay-child-surplus', 'succeeded', 0, 8, now()
    )
  `, [replayRunId]);
  await expectPass('pending replay with a late-enrolled surplus child');
  await pool.query(
    `delete from jobs where deduplication_key = 'restore-replay-child-surplus'`
  );

  await pool.query(`
    update jobs set status = 'failed', attempts = 1,
      completed_at = now(), last_error = 'restore witness failed child'
    where deduplication_key = 'restore-replay-child'
  `);
  await expectDiagnostics('pending replay with a failed child below its attempt ceiling', [
    'pending_replay_child_incomplete',
    'pending_replay_child_permanent'
  ]);

  await pool.query(`
    update jobs set status = 'failed', attempts = max_attempts,
      completed_at = now(), last_error = 'restore witness exhausted child'
    where deduplication_key = 'restore-replay-child'
  `);
  await expectDiagnostics('pending replay with an exhausted failed child', [
    'pending_replay_child_incomplete',
    'pending_replay_child_retry_exhausted'
  ]);
  await pool.query(`
    update jobs set status = 'succeeded', last_error = null
    where deduplication_key = 'restore-replay-child'
  `);

  await pool.query(`
    update jobs set payload = jsonb_set(payload, '{classifierVersion}', '3'::jsonb)
    where deduplication_key = 'restore-replay-child'
  `);
  await expectRejection(
    'pending replay with a child version mismatch',
    'pending_replay_child_version_mismatch=1'
  );
  await pool.query(`
    update jobs set payload = jsonb_set(payload, '{classifierVersion}', '2'::jsonb)
    where deduplication_key = 'restore-replay-child'
  `);

  await pool.query('update financial_scan_runs set enqueued_count = 2 where id = $1', [replayRunId]);
  await expectRejection(
    'pending replay with an incomplete child barrier',
    'pending_replay_child_count_mismatch=1'
  );
  await pool.query('update financial_scan_runs set enqueued_count = 1 where id = $1', [replayRunId]);

  const orderId = '30000000-0000-4000-8000-000000000001';
  const firstTitleId = '30000000-0000-4000-8000-000000000002';
  const secondTitleId = '30000000-0000-4000-8000-000000000003';
  const firstItemId = '30000000-0000-4000-8000-000000000004';
  const secondItemId = '30000000-0000-4000-8000-000000000005';
  const paymentId = '30000000-0000-4000-8000-000000000006';
  const capacityRefundOneId = '30000000-0000-4000-8000-000000000007';
  const capacityRefundTwoId = '30000000-0000-4000-8000-000000000008';
  const capacityAllocationOneId = '30000000-0000-4000-8000-000000000009';
  const capacityAllocationTwoId = '30000000-0000-4000-8000-00000000000a';
  const splitRefundId = '30000000-0000-4000-8000-00000000000b';
  const splitAllocationId = '30000000-0000-4000-8000-00000000000c';
  await pool.query(`
    insert into titles (id, slug, title, description, creator_name, format, price_minor, currency)
    values
      ($1, 'restore-capacity-title', 'Restore capacity', 'Witness', 'Witness', 'prose', 4, 'USD'),
      ($2, 'restore-split-title', 'Restore split', 'Witness', 'Witness', 'prose', 4, 'USD')
  `, [firstTitleId, secondTitleId]);
  await pool.query(`
    insert into orders (
      id, status, currency, subtotal_minor, tax_minor, total_minor,
      client_checkout_attempt_id, quote_fingerprint_sha256, status_token_sha256
    ) values ($1, 'checkout_pending', 'USD', 6, 2, 8,
      '30000000-0000-4000-8000-00000000000d', repeat('b', 64), repeat('c', 64))
  `, [orderId]);
  await pool.query(`
    insert into order_items (
      id, order_id, title_id, title_snapshot, creator_name_snapshot, format,
      currency, unit_subtotal_minor, tax_minor, total_minor
    ) values
      ($4, $3, $1, 'Restore capacity', 'Witness', 'prose', 'USD', 3, 1, 4),
      ($5, $3, $2, 'Restore split', 'Witness', 'prose', 'USD', 3, 1, 4)
  `, [firstTitleId, secondTitleId, orderId, firstItemId, secondItemId]);
  await pool.query(`
    insert into payments (id, order_id, stripe_payment_intent_id, status, amount_minor, currency)
    values ($1, $2, 'pi_restore_refund_components', 'pending', 8, 'USD')
  `, [paymentId, orderId]);
  await pool.query(`
    insert into refunds (
      id, payment_id, stripe_refund_id, status, amount_minor, currency,
      provider_created_at, allocation_status
    ) values
      ($1, $3, 're_restore_capacity_1', 'succeeded', 2, 'USD',
        '2026-08-03T00:00:00.000Z', 'finalized'),
      ($2, $3, 're_restore_capacity_2', 'succeeded', 2, 'USD',
        '2026-08-04T00:00:00.000Z', 'finalized')
  `, [capacityRefundOneId, capacityRefundTwoId, paymentId]);
  await pool.query(`
    insert into refund_allocations (id, refund_id, order_item_id, amount_minor, source)
    values ($1, $2, $3, 2, 'automatic'), ($4, $5, $3, 2, 'automatic')
  `, [
    capacityAllocationOneId, capacityRefundOneId, firstItemId,
    capacityAllocationTwoId, capacityRefundTwoId
  ]);
  await pool.query(`
    insert into refund_allocation_components (
      refund_allocation_id, refund_id, order_item_id,
      subtotal_minor, tax_minor, total_minor, currency
    ) values
      ($1, $2, $3, 2, 0, 2, 'USD'),
      ($4, $5, $3, 2, 0, 2, 'USD')
  `, [
    capacityAllocationOneId, capacityRefundOneId, firstItemId,
    capacityAllocationTwoId, capacityRefundTwoId
  ]);
  await expectRejection(
    'refund component chronology exceeds a bucket capacity',
    'refund_component_chronology_capacity=1'
  );
  await pool.query('set session_replication_role = replica');
  try {
    await pool.query(`
      update refund_allocation_components set subtotal_minor = 1, tax_minor = 1
      where refund_allocation_id = $1
    `, [capacityAllocationTwoId]);
  } finally {
    await pool.query('set session_replication_role = origin');
  }

  await pool.query(`
    update refunds set allocation_status = 'exception' where id = $1
  `, [capacityRefundTwoId]);
  await expectPass('component-backed refund preserved in exception allocation state', true);
  await pool.query(`
    update refunds set allocation_status = 'needs_review' where id = $1
  `, [capacityRefundTwoId]);
  await expectRejection(
    'component-backed refund in a mutable allocation state',
    'refund_component_chronology_capacity=1'
  );
  await pool.query(`
    update refunds set allocation_status = 'exception' where id = $1
  `, [capacityRefundTwoId]);

  await pool.query(`
    insert into refunds (
      id, payment_id, stripe_refund_id, status, amount_minor, currency,
      provider_created_at, allocation_status
    ) values ($1, $2, 're_restore_split_1', 'succeeded', 2, 'USD',
      '2026-08-05T00:00:00.000Z', 'finalized')
  `, [splitRefundId, paymentId]);
  await pool.query(`
    insert into refund_allocations (id, refund_id, order_item_id, amount_minor, source)
    values ($1, $2, $3, 2, 'automatic')
  `, [splitAllocationId, splitRefundId, secondItemId]);
  await pool.query(`
    insert into refund_allocation_components (
      refund_allocation_id, refund_id, order_item_id,
      subtotal_minor, tax_minor, total_minor, currency
    ) values ($1, $2, $3, 1, 1, 2, 'USD')
  `, [splitAllocationId, splitRefundId, secondItemId]);
  await expectRejection(
    'refund component violates the deterministic two-bucket split',
    'refund_component_deterministic_split=1'
  );

  if (failures.length > 0) {
    throw new Error(`[restore-verifier] invariant witness failures: ${failures.join('; ')}`);
  }
  console.info('[restore-verifier] payout, replay-child, and refund-component witnesses passed');
}

try {
  await migrate(drizzle({ client: pool }), { migrationsFolder: `${repositoryRoot}/drizzle` });
  if (exerciseFinancialInvariantWitnesses) {
    await exerciseInvariantWitnesses();
  } else if (seedMissingCredentialAuthority) {
    await pool.query(`
      with inserted_user as (
        insert into "user" (name, email, email_verified)
        values ('Restore witness', 'restore-witness@example.invalid', true)
        returning id
      )
      insert into account (account_id, provider_id, user_id, password, updated_at)
      select 'restore-witness', 'credential', id, 'witness-hash', now()
      from inserted_user
    `);
  }
  if (!exerciseFinancialInvariantWitnesses) {
    let seededViolationRejected = false;
    const { error } = await verifierOutcome();
    if (error) {
      if (
        seedMissingCredentialAuthority &&
        error.message.includes('credential_authority_missing_or_mismatched=1')
      ) {
        console.info('[restore-verifier] seeded credential-authority violation was rejected');
        seededViolationRejected = true;
      } else {
        throw error;
      }
    }
    if (!seedMissingCredentialAuthority) {
      console.info('[restore-verifier] executable SQL returned zero structural violations');
    } else if (!seededViolationRejected) {
      throw new Error('[restore-verifier] seeded violation was not rejected');
    }
  }
} finally {
  await pool.end();
}
