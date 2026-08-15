import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { databaseClient } from './database';

const guideUrl = new URL('../../docs/stripe-financial-reconciliation.md', import.meta.url);

async function sqlBlocks(): Promise<string[]> {
  const guide = await readFile(guideUrl, 'utf8');
  return [...guide.matchAll(/```sql\r?\n([\s\S]*?)\r?\n```/gu)].map((match) => match[1]!);
}

describe('financial reconciliation operations guide', () => {
  it('keeps every documented SQL block read-only and executable against the current schema', async () => {
    const blocks = await sqlBlocks();
    expect(blocks).toHaveLength(7);

    for (const block of blocks) {
      expect(block.trimStart()).toMatch(/^(select|with)\b/iu);
      expect(block).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|create)\b/iu);
      await expect(databaseClient.db.execute(sql.raw(block))).resolves.toBeDefined();
    }
  });

  it('reports scan identities that strict job parsing or continuation replay would reject', async () => {
    const blocks = await sqlBlocks();
    const impossibleHour = '2026-02-31T12:00:00.000Z';
    const impossibleRunId = randomUUID();
    const payoutRunId = randomUUID();
    const payoutId = randomUUID();
    const digestRunId = randomUUID();
    const checkpoint = `payment:${randomUUID()}`;
    const forgedDigest = 'a'.repeat(64);

    await databaseClient.db.execute(sql`
      insert into financial_scan_runs (id, root_key, kind, phase)
      values
        (${impossibleRunId}, ${`commerce.financial-scan:${impossibleHour}`}, 'hourly', 'source_page'),
        (${payoutRunId}, ${`financial:payout-impact:${payoutId}:1`}, 'payout_impact', 'payout_impact_page'),
        (${digestRunId}, 'commerce.financial-scan:initial:v1', 'initial_backfill', 'source_page')
    `);
    await databaseClient.db.execute(sql`
      update financial_scan_runs
      set checkpoint = ${checkpoint}, cursor_digest_sha256 = ${forgedDigest}
      where id = ${digestRunId}
    `);
    await databaseClient.db.execute(sql`
      update financial_scan_runs
      set classifier_version = 1, allocation_algorithm_version = 1, replay_id = 'c1-a1'
      where id = ${impossibleRunId}
    `);
    await databaseClient.db.execute(sql`
      update financial_scan_runs set phase = 'source_page' where id = ${payoutRunId}
    `);
    await databaseClient.db.execute(sql`
      insert into jobs (
        type, payload, deduplication_key, status, attempts, max_attempts, locked_at, locked_by
      ) values
        ('commerce.financial-scan', '{"kind":"initial","version":1}'::jsonb,
          'commerce.financial-scan:initial:v1', 'pending', 0, 8, null, null),
        ('commerce.financial-scan',
          ${JSON.stringify({ kind: 'hourly', scanGenerationHour: impossibleHour })}::jsonb,
          ${`commerce.financial-scan:${impossibleHour}`}, 'running', 1, 8, now(), 'restore-test'),
        ('commerce.financial-scan',
          ${JSON.stringify({ kind: 'payout_impact', payoutId, payoutGeneration: '1' })}::jsonb,
          ${`financial:payout-impact:${payoutId}:1`}, 'pending', 0, 8, null, null),
        ('commerce.financial-scan',
          ${JSON.stringify({
            kind: 'continuation', scanRunId: digestRunId, phase: 'source_page',
            cursorDigestSha256: forgedDigest, limit: 100
          })}::jsonb,
          ${`commerce.financial-scan:${digestRunId}:source_page:${forgedDigest}`},
          'running', 1, 8, now(), 'restore-test')
    `);

    const result = await databaseClient.db.execute<{
      check_name: string;
      violation_count: number | string;
    }>(sql.raw(blocks[6]!));
    const counts = new Map(result.rows.map((row) => [row.check_name, Number(row.violation_count)]));

    expect(counts.get('scan_root_job_missing')).toBe(2);
    expect(counts.get('running_scan_resume_job_missing')).toBe(2);
    expect(counts.get('running_scan_cursor_integrity')).toBe(1);
    expect(counts.get('scan_phase_checkpoint_shape')).toBe(1);
    expect(counts.get('replay_identity_mismatch')).toBe(1);
    expect(createHash('sha256').update('source_page').update('\0').update(checkpoint).digest('hex'))
      .not.toBe(forgedDigest);
  });

  it('accepts the terminal phase of a completed classification replay', async () => {
    const blocks = await sqlBlocks();
    const runId = randomUUID();
    await databaseClient.db.execute(sql`
      insert into financial_scan_runs (
        id, root_key, kind, phase, state, classifier_version,
        allocation_algorithm_version, replay_id, safe_outcome, completed_at
      ) values (
        ${runId}, 'commerce.financial-classification:scan:7:7',
        'classification_replay', 'classification_replay_finalize', 'completed',
        7, 7, 'c7-a7', 'completed', now()
      )
    `);

    const result = await databaseClient.db.execute<{
      check_name: string;
      violation_count: number | string;
    }>(sql.raw(blocks[6]!));
    const counts = new Map(result.rows.map((row) => [row.check_name, Number(row.violation_count)]));

    expect(counts.get('scan_phase_checkpoint_shape')).toBe(0);
  });

  it('reports multiple active allocation tips even when their fingerprints differ', async () => {
    const blocks = await sqlBlocks();
    const projectionBlock = blocks[4]!;
    const tipQuery = projectionBlock
      .split(/;\s*/u)
      .find((statement) => statement.includes('tip_count'));
    expect(tipQuery).toBeDefined();

    const balanceTransactionId = randomUUID();
    await databaseClient.db.execute(sql`
      insert into stripe_balance_transactions (
        id, provider_id, live_mode, source_family, source_id, raw_type,
        reporting_category, balance_type, amount_minor, fee_minor, net_minor,
        currency, status, provider_created_at, available_at, fingerprint_sha256
      ) values (
        ${balanceTransactionId}, ${`txn_restore_tip_${balanceTransactionId}`}, false,
        'adjustment', null, 'adjustment', 'other_adjustment', 'adjustment',
        100, 0, 100, 'USD', 'available', now(), now(), ${'a'.repeat(64)}
      )
    `);
    await databaseClient.db.execute(sql`
      insert into financial_allocation_sets (
        allocation_identity, balance_transaction_id, source_kind, source_internal_id,
        basis, scope, expected_effect_minor, currency, algorithm_version,
        classifier_version, source_fingerprint_sha256
      ) values
        (${`adjustment:${balanceTransactionId}:restore-tip-a`}, ${balanceTransactionId},
          'adjustment', ${balanceTransactionId}, 'gross_amount', 'account', 100, 'USD',
          1, 1, ${'a'.repeat(64)}),
        (${`adjustment:${balanceTransactionId}:restore-tip-b`}, ${balanceTransactionId},
          'adjustment', ${balanceTransactionId}, 'gross_amount', 'account', 100, 'USD',
          1, 1, ${'b'.repeat(64)})
    `);

    const result = await databaseClient.db.execute<{
      balance_transaction_id: string;
      basis: string;
      tip_count: number | string;
    }>(sql.raw(tipQuery!));

    expect(result.rows).toEqual([expect.objectContaining({
      balance_transaction_id: balanceTransactionId,
      basis: 'gross_amount',
      tip_count: '2'
    })]);
  });

  it('reports every unknown immutable classification row that lacks its exact open issue', async () => {
    const blocks = await sqlBlocks();
    const balanceTransactionId = randomUUID();
    const classificationId = randomUUID();
    const fingerprint = '9'.repeat(64);
    await databaseClient.db.execute(sql`
      insert into stripe_balance_transactions (
        id, provider_id, live_mode, source_family, source_id, raw_type,
        reporting_category, balance_type, amount_minor, fee_minor, net_minor,
        currency, status, provider_created_at, available_at, fingerprint_sha256
      ) values (
        ${balanceTransactionId}, ${`txn_restore_unknown_${balanceTransactionId}`}, false,
        'unknown', null, 'future_type', 'future_category', 'adjustment', 1, 0, 1,
        'USD', 'available', now(), now(), ${fingerprint}
      )
    `);
    await databaseClient.db.execute(sql`
      insert into financial_classification_versions (
        id, subject_type, subject_id, classifier_version, classification,
        source_fingerprint_sha256
      ) values (
        ${classificationId}, 'balance_transaction', ${balanceTransactionId}, 1,
        'unknown', ${fingerprint}
      )
    `);

    const missing = await databaseClient.db.execute<{
      check_name: string;
      violation_count: number | string;
    }>(sql.raw(blocks[2]!));
    expect(new Map(missing.rows.map((row) => [row.check_name, Number(row.violation_count)]))
      .get('financial_unknown_classification_issue')).toBe(1);

    await databaseClient.db.execute(sql`
      insert into financial_reconciliation_issues (
        resource_type, resource_id, safe_code, impact, correlation_id
      ) values (
        'financial_classification', ${classificationId}, 'unsupported_category',
        'exception', 'operations-unknown-classification'
      )
    `);
    const repaired = await databaseClient.db.execute<{
      check_name: string;
      violation_count: number | string;
    }>(sql.raw(blocks[2]!));
    expect(new Map(repaired.rows.map((row) => [row.check_name, Number(row.violation_count)]))
      .has('financial_unknown_classification_issue')).toBe(false);
  });

  it('filters the operational issue queue to active classifications and raw active allocation tips', async () => {
    const blocks = await sqlBlocks();
    const activeIssueQuery = blocks[1]!
      .split(/;\s*/u)
      .find((statement) => statement.includes('active_classifications'));
    expect(activeIssueQuery).toBeDefined();
    const balanceTransactionId = randomUUID();
    const activeClassificationId = randomUUID();
    const inactiveClassificationId = randomUUID();
    const activeSetId = randomUUID();
    const inactiveSetId = randomUUID();
    const fingerprint = '8'.repeat(64);
    await databaseClient.db.execute(sql`
      insert into stripe_balance_transactions (
        id, provider_id, live_mode, source_family, source_id, raw_type,
        reporting_category, balance_type, amount_minor, fee_minor, net_minor,
        currency, status, provider_created_at, available_at, fingerprint_sha256
      ) values (
        ${balanceTransactionId}, ${`txn_operator_active_${balanceTransactionId}`}, false,
        'adjustment', null, 'adjustment', 'other_adjustment', 'adjustment', 1, 0, 1,
        'USD', 'available', now(), now(), ${fingerprint}
      )
    `);
    await databaseClient.db.execute(sql`
      insert into financial_classification_versions (
        id, subject_type, subject_id, classifier_version, classification,
        source_fingerprint_sha256
      ) values
        (${activeClassificationId}, 'balance_transaction', ${balanceTransactionId}, 1,
          'other', ${fingerprint}),
        (${inactiveClassificationId}, 'balance_transaction', ${balanceTransactionId}, 2,
          'unknown', ${fingerprint})
    `);
    await databaseClient.db.execute(sql`
      insert into financial_allocation_sets (
        id, allocation_identity, balance_transaction_id, source_kind,
        source_internal_id, basis, scope, expected_effect_minor, currency,
        algorithm_version, classifier_version, source_fingerprint_sha256,
        supersedes_set_id
      ) values
        (${activeSetId}, ${`adjustment:${balanceTransactionId}:operator-active`},
          ${balanceTransactionId}, 'adjustment', ${balanceTransactionId}, 'gross_amount',
          'account', 1, 'USD', 1, 1, ${fingerprint}, null),
        (${inactiveSetId}, ${`adjustment:${balanceTransactionId}:operator-inactive`},
          ${balanceTransactionId}, 'adjustment', ${balanceTransactionId}, 'gross_amount',
          'account', 1, 'USD', 1, 2, ${fingerprint}, ${activeSetId})
    `);
    await databaseClient.db.execute(sql`
      insert into financial_reconciliation_issues (
        resource_type, resource_id, safe_code, impact, correlation_id
      ) values
        ('financial_classification', ${inactiveClassificationId}, 'unsupported_category',
          'exception', 'operator-inactive-classification'),
        ('allocation_set', ${inactiveSetId}, 'missing_source', 'pending',
          'operator-inactive-allocation'),
        ('allocation_set', ${activeSetId}, 'missing_source', 'pending',
          'operator-active-allocation')
    `);

    const result = await databaseClient.db.execute<{
      resource_id: string;
      resource_type: string;
    }>(sql.raw(activeIssueQuery!));
    expect(result.rows.map((row) => ({
      resourceId: row.resource_id,
      resourceType: row.resource_type
    }))).toEqual([{ resourceId: activeSetId, resourceType: 'allocation_set' }]);
  });

  it('reports a completed classification replay that never reached its finalizer phase', async () => {
    const blocks = await sqlBlocks();
    await databaseClient.db.execute(sql`
      insert into financial_scan_runs (
        id, root_key, kind, phase, state, classifier_version,
        allocation_algorithm_version, replay_id, safe_outcome, completed_at
      ) values (
        ${randomUUID()}, 'commerce.financial-classification:scan:8:8',
        'classification_replay', 'classification_replay_page', 'completed',
        8, 8, 'c8-a8', 'completed', now()
      )
    `);

    const result = await databaseClient.db.execute<{
      check_name: string;
      violation_count: number | string;
    }>(sql.raw(blocks[6]!));
    const counts = new Map(result.rows.map((row) => [row.check_name, Number(row.violation_count)]));

    expect(counts.get('scan_phase_checkpoint_shape')).toBe(1);
  });

  it('reports projection authority that points at no resumable replay run', async () => {
    const blocks = await sqlBlocks();
    const missingRunId = randomUUID();
    await databaseClient.db.execute(sql`
      update financial_projection_versions set
        pending_classifier_version = 7,
        pending_allocation_algorithm_version = 7,
        pending_replay_id = 'c7-a7',
        pending_scan_run_id = ${missingRunId}
      where singleton = true
    `);

    const result = await databaseClient.db.execute<{
      check_name: string;
      violation_count: number | string;
    }>(sql.raw(blocks[6]!));
    const counts = new Map(result.rows.map((row) => [row.check_name, Number(row.violation_count)]));

    expect(counts.get('pending_replay_authority_mismatch')).toBe(1);
  });

  it('reports a supersession chain that violates immutable owner lineage', async () => {
    const blocks = await sqlBlocks();
    const balanceTransactionId = randomUUID();
    const otherSourceId = randomUUID();
    const predecessorId = randomUUID();
    const fingerprint = 'd'.repeat(64);
    await databaseClient.db.execute(sql`
      insert into stripe_balance_transactions (
        id, provider_id, live_mode, source_family, source_id, raw_type,
        reporting_category, balance_type, amount_minor, fee_minor, net_minor,
        currency, status, provider_created_at, available_at, fingerprint_sha256
      ) values
        (${balanceTransactionId}, ${`txn_restore_lineage_${balanceTransactionId}`}, false,
          'adjustment', null, 'adjustment', 'other_adjustment', 'adjustment',
          100, 0, 100, 'USD', 'available', now(), now(), ${fingerprint}),
        (${otherSourceId}, ${`txn_restore_lineage_source_${otherSourceId}`}, false,
          'adjustment', null, 'adjustment', 'other_adjustment', 'adjustment',
          100, 0, 100, 'USD', 'available', now(), now(), ${'e'.repeat(64)})
    `);
    await databaseClient.db.execute(sql`
      insert into financial_classification_versions (
        subject_type, subject_id, classifier_version, classification,
        source_fingerprint_sha256
      ) values (
        'balance_transaction', ${balanceTransactionId}, 1, 'other', ${fingerprint}
      )
    `);
    await databaseClient.db.execute(sql.raw(
      'alter table financial_allocation_sets disable trigger ' +
      'financial_allocation_sets_supersession_lineage_check'
    ));
    try {
      await databaseClient.db.execute(sql`
        insert into financial_allocation_sets (
          id, allocation_identity, balance_transaction_id, source_kind,
          source_internal_id, basis, scope, expected_effect_minor, currency,
          algorithm_version, classifier_version, source_fingerprint_sha256,
          supersedes_set_id
        ) values
          (${predecessorId}, ${`adjustment:${balanceTransactionId}:restore-root`},
            ${balanceTransactionId}, 'adjustment', ${balanceTransactionId},
            'gross_amount', 'account', 100, 'USD', 1, 1, ${fingerprint}, null),
          (${randomUUID()}, ${`adjustment:${balanceTransactionId}:restore-invalid-successor`},
            ${balanceTransactionId}, 'adjustment', ${otherSourceId},
            'gross_amount', 'account', 100, 'USD', 1, 1, ${fingerprint}, ${predecessorId})
      `);
    } finally {
      await databaseClient.db.execute(sql.raw(
        'alter table financial_allocation_sets enable trigger ' +
        'financial_allocation_sets_supersession_lineage_check'
      ));
    }

    const result = await databaseClient.db.execute<{
      check_name: string;
      violation_count: number | string;
    }>(sql.raw(blocks[2]!));
    const counts = new Map(result.rows.map((row) => [row.check_name, Number(row.violation_count)]));
    expect(counts.get('allocation_set_parent_or_chain')).toBe(1);
    expect(counts.get('allocation_set_semantic_source')).toBe(1);
  });

  it('reports an adjustment takeover whose exact parent classification is missing', async () => {
    const blocks = await sqlBlocks();
    const balanceTransactionId = randomUUID();
    const orderId = randomUUID();
    const paymentId = randomUUID();
    const predecessorId = randomUUID();
    const fingerprint = 'f'.repeat(64);
    await databaseClient.db.execute(sql`
      insert into stripe_balance_transactions (
        id, provider_id, live_mode, source_family, source_id, raw_type,
        reporting_category, balance_type, amount_minor, fee_minor, net_minor,
        currency, status, provider_created_at, available_at, fingerprint_sha256
      ) values (${balanceTransactionId}, ${`txn_restore_missing_class_${balanceTransactionId}`},
        false, 'adjustment', null, 'adjustment', 'other_adjustment', 'adjustment',
        100, 0, 100, 'USD', 'available', now(), now(), ${fingerprint})
    `);
    await databaseClient.db.execute(sql`
      insert into financial_classification_versions (
        subject_type, subject_id, classifier_version, classification,
        source_fingerprint_sha256
      ) values (
        'balance_transaction', ${balanceTransactionId}, 1, 'other', ${fingerprint}
      )
    `);
    await databaseClient.db.execute(sql`
      insert into orders (
        id, status, currency, subtotal_minor, client_checkout_attempt_id,
        quote_fingerprint_sha256, status_token_sha256
      ) values (${orderId}, 'checkout_open', 'USD', 100, ${randomUUID()},
        ${'a'.repeat(64)}, ${'b'.repeat(64)})
    `);
    await databaseClient.db.execute(sql`
      insert into payments (
        id, order_id, stripe_payment_intent_id, status, amount_minor, currency
      ) values (${paymentId}, ${orderId}, ${`pi_restore_missing_class_${paymentId}`},
        'pending', 100, 'USD')
    `);
    await databaseClient.db.execute(sql.raw(
      'alter table financial_allocation_sets disable trigger ' +
      'financial_allocation_sets_supersession_lineage_check'
    ));
    try {
      await databaseClient.db.execute(sql`
        insert into financial_allocation_sets (
          id, allocation_identity, balance_transaction_id, source_kind,
          source_internal_id, basis, scope, expected_effect_minor, currency,
          algorithm_version, classifier_version, source_fingerprint_sha256,
          supersedes_set_id
        ) values
          (${predecessorId}, ${`adjustment:${balanceTransactionId}:missing-class-root`},
            ${balanceTransactionId}, 'adjustment', ${balanceTransactionId},
            'gross_amount', 'account', 100, 'USD', 1, 1, ${fingerprint}, null),
          (${randomUUID()}, ${`payment:${paymentId}:missing-class-successor`},
            ${balanceTransactionId}, 'payment', ${paymentId},
            'gross_amount', 'title', 100, 'USD', 1, 2, ${fingerprint}, ${predecessorId})
      `);
    } finally {
      await databaseClient.db.execute(sql.raw(
        'alter table financial_allocation_sets enable trigger ' +
        'financial_allocation_sets_supersession_lineage_check'
      ));
    }

    const result = await databaseClient.db.execute<{
      check_name: string;
      violation_count: number | string;
    }>(sql.raw(blocks[2]!));
    const counts = new Map(result.rows.map((row) => [row.check_name, Number(row.violation_count)]));
    expect(counts.get('allocation_set_parent_or_chain')).toBe(1);
    expect(counts.get('allocation_set_semantic_source')).toBe(1);
  });
});
