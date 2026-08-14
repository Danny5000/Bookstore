import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  processFinancialScanJob
} from '$lib/server/commerce/financial/scans/service';
import {
  commitFinancialScanPage,
  freezePayoutDiscoveryWindow,
  startOrResumeFinancialScan
} from '$lib/server/commerce/financial/scans/repository';
import {
  auditEvents,
  financialPayoutDiscoveryState,
  financialProjectionVersions,
  financialScanRuns
} from '$lib/server/db/schema';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import { databaseClient } from './database';

const HOUR = '2026-08-12T22:00:00.000Z';
const HOUR_END = new Date('2026-08-12T23:00:00.000Z');

async function discoveryRun() {
  const started = await startOrResumeFinancialScan(databaseClient.db, {
    kind: 'hourly', scanGenerationHour: HOUR
  });
  const [run] = await databaseClient.db.update(financialScanRuns)
    .set({ phase: 'payout_discovery_page' })
    .where(eq(financialScanRuns.id, started.id))
    .returning();
  if (!run) throw new Error('Test scan run was not updated');
  return run;
}

describe('durable payout discovery coverage', () => {
  it('freezes an outage-sized window and reuses it after the high-water moves', async () => {
    await databaseClient.db.update(financialPayoutDiscoveryState)
      .set({ coveredThrough: new Date('2026-08-01T00:00:00.000Z') });
    const run = await discoveryRun();

    const first = await freezePayoutDiscoveryWindow(databaseClient.db, run, HOUR);
    expect(first).toEqual({
      createdGte: Math.floor(new Date('2026-07-29T00:00:00.000Z').getTime() / 1000),
      createdLt: Math.floor(HOUR_END.getTime() / 1000)
    });

    await databaseClient.db.update(financialPayoutDiscoveryState)
      .set({ coveredThrough: new Date('2026-08-10T00:00:00.000Z') });
    const [frozen] = await databaseClient.db.select().from(financialScanRuns)
      .where(eq(financialScanRuns.id, run.id));
    await expect(freezePayoutDiscoveryWindow(databaseClient.db, frozen!, HOUR))
      .resolves.toEqual(first);
  });

  it('advances the exclusive high-water in the terminal discovery-page commit', async () => {
    await databaseClient.db.update(financialPayoutDiscoveryState)
      .set({ coveredThrough: new Date('2026-08-10T00:00:00.000Z') });
    const run = await discoveryRun();
    await freezePayoutDiscoveryWindow(databaseClient.db, run, HOUR);

    await commitFinancialScanPage(databaseClient.db, {
      runId: run.id, expectedPhase: 'payout_discovery_page', expectedCheckpoint: null,
      expectedPageCount: 0, nextPhase: 'incomplete_payout_run_page', nextCheckpoint: null,
      processedCount: 0, children: [], complete: false
    });

    expect(await databaseClient.db.select().from(financialPayoutDiscoveryState))
      .toEqual([expect.objectContaining({ coveredThrough: HOUR_END })]);
    expect(await databaseClient.db.select().from(financialScanRuns)
      .where(eq(financialScanRuns.id, run.id)))
      .toEqual([expect.objectContaining({ phase: 'incomplete_payout_run_page', pageCount: 1 })]);
  });

  it('uses seven days before the earliest paid order when coverage has not started', async () => {
    const userId = randomUUID();
    const paidAt = new Date('2026-07-01T12:00:00.000Z');
    await databaseClient.db.execute(sql`
      insert into "user" (id, name, email, email_verified)
      values (${userId}, 'Coverage Reader', ${`coverage-${userId}@example.com`}, true)
    `);
    await databaseClient.db.execute(sql`
      insert into orders
        (status, initiating_user_id, purchase_email, currency, subtotal_minor, tax_minor,
          total_minor, client_checkout_attempt_id, quote_fingerprint_sha256,
          status_token_sha256, paid_at)
      values ('paid', ${userId}, ${`coverage-${userId}@example.com`}, 'USD', 100, 0,
        100, ${randomUUID()}, ${'a'.repeat(64)}, ${'b'.repeat(64)}, ${paidAt})
    `);
    const started = await startOrResumeFinancialScan(databaseClient.db, { kind: 'initial', version: 1 });
    const [run] = await databaseClient.db.update(financialScanRuns)
      .set({ phase: 'payout_discovery_page' })
      .where(eq(financialScanRuns.id, started.id)).returning();

    await expect(freezePayoutDiscoveryWindow(databaseClient.db, run!, HOUR)).resolves.toEqual({
      createdGte: Math.floor((paidAt.getTime() - 7 * 86_400_000) / 1000),
      createdLt: Math.floor(HOUR_END.getTime() / 1000)
    });
  });

  it('activates the target pair when a composite replay has no subjects', async () => {
    await processFinancialScanJob({
      database: databaseClient.db,
      gateway: {} as StripeCommerceGateway,
      runtimeMode: 'disabled'
    }, {
      payload: { kind: 'composite_replay', classifierVersion: 2,
        allocationAlgorithmVersion: 3, replayId: 'c2-a3' },
      correlationId: 'empty-composite-replay-c2-a3',
      signal: new AbortController().signal
    });

    expect(await databaseClient.db.select().from(financialProjectionVersions))
      .toEqual([expect.objectContaining({ classifierVersion: 2, allocationAlgorithmVersion: 3 })]);
    expect(await databaseClient.db.select().from(financialScanRuns))
      .toEqual([expect.objectContaining({
        kind: 'classification_replay', state: 'completed', processedCount: 0,
        pageCount: 1, safeOutcome: 'completed'
      })]);
    expect(await databaseClient.db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'financial.projection_version.activated')))
      .toHaveLength(1);
  });
});
