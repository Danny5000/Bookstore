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
});
