import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs } from '$lib/server/db/schema';
import {
  createFinancialPayoutEventJob,
  createFinancialPayoutScanJob,
  createFinancialSourceEventJob,
  createFinancialSourceScanJob
} from '$lib/server/commerce/financial/jobs';
import {
  createPostgresJobRepository,
  enqueueActiveEntityJob,
  enqueueJob
} from '$lib/server/jobs/repository';
import { applicationConfig, databaseClient } from './database';

const SOURCE_ID = '00000000-0000-4000-8000-000000001621';
const SCAN_RUN_ID = '00000000-0000-4000-8000-000000001622';
const HOUR = '2026-08-12T12:00:00.000Z';
const NEXT_HOUR = '2026-08-12T13:00:00.000Z';

function sourceInput(spec: ReturnType<
  typeof createFinancialSourceEventJob | typeof createFinancialSourceScanJob
>) {
  return {
    ...spec,
    activeEntity: {
      sourceKind: spec.payload.sourceKind,
      sourceId: spec.payload.sourceId
    }
  };
}

function payoutInput(spec: ReturnType<
  typeof createFinancialPayoutEventJob | typeof createFinancialPayoutScanJob
>) {
  return {
    ...spec,
    activeEntity: { providerPayoutId: spec.payload.providerPayoutId }
  };
}

describe('PostgreSQL active financial entity jobs', () => {
  it('serializes event-versus-hour races so concurrent workers leave one active source job', async () => {
    const event = sourceInput(createFinancialSourceEventJob({
      sourceKind: 'refund', sourceId: SOURCE_ID, providerEventId: 'evt_active_race_1621'
    }));
    const hourly = sourceInput(createFinancialSourceScanJob({
      sourceKind: 'refund', sourceId: SOURCE_ID,
      scanRunId: SCAN_RUN_ID, scanGenerationHour: HOUR
    }));

    let arrivals = 0;
    let release!: () => void;
    const bothTransactionsStarted = new Promise<void>((resolve) => { release = resolve; });
    const enqueueFromNamedTransaction = (
      applicationName: string,
      input: typeof event | typeof hourly
    ) => databaseClient.db.transaction(async (transaction) => {
      await transaction.execute(sql.raw(
        `set local application_name = '${applicationName}'`
      ));
      arrivals += 1;
      if (arrivals === 2) release();
      await bothTransactionsStarted;
      return enqueueActiveEntityJob(transaction, input);
    });
    const results = await Promise.all([
      enqueueFromNamedTransaction('plan6b-active-event', event),
      enqueueFromNamedTransaction('plan6b-active-hourly', hourly)
    ]);

    expect(results[0].id).toBe(results[1].id);
    expect(await databaseClient.db.select().from(jobs)).toHaveLength(1);

    const repository = createPostgresJobRepository(databaseClient.db, applicationConfig.jobs);
    const claimed = await repository.claimNext('worker-a');
    expect(claimed?.id).toBe(results[0].id);
    const whileRunning = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, sourceInput(createFinancialSourceEventJob({
        sourceKind: 'refund', sourceId: SOURCE_ID, providerEventId: 'evt_active_race_1622'
      })))
    );
    expect(whileRunning.id).toBe(claimed?.id);
    expect(await databaseClient.db.select().from(jobs)).toHaveLength(1);
  });

  it('keeps exact terminal replay permanent but permits a distinct later generation', async () => {
    const eventSpec = createFinancialSourceEventJob({
      sourceKind: 'payment', sourceId: SOURCE_ID, providerEventId: 'evt_active_terminal_1621'
    });
    const event = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, sourceInput(eventSpec))
    );
    const repository = createPostgresJobRepository(databaseClient.db, applicationConfig.jobs);
    expect((await repository.claimNext('worker-terminal'))?.id).toBe(event.id);
    await databaseClient.db.update(jobs)
      .set({ attempts: eventSpec.maxAttempts })
      .where(eq(jobs.id, event.id));
    await expect(repository.fail(event.id, 'worker-terminal', 'safe exhaustion', true))
      .resolves.toBe(true);

    const exactReplay = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, sourceInput(eventSpec))
    );
    expect(exactReplay).toMatchObject({ id: event.id, status: 'failed', attempts: 12 });

    const recovery = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, sourceInput(createFinancialSourceScanJob({
        sourceKind: 'payment', sourceId: SOURCE_ID,
        scanRunId: SCAN_RUN_ID, scanGenerationHour: NEXT_HOUR
      })))
    );
    expect(recovery.id).not.toBe(event.id);
    expect(recovery.status).toBe('pending');
    expect(await databaseClient.db.select().from(jobs)).toHaveLength(2);
  });

  it('guards payout entities by provider ID across distinct event and scan keys', async () => {
    const event = payoutInput(createFinancialPayoutEventJob({
      providerPayoutId: 'po_active_1621', providerEventId: 'evt_active_payout_1621'
    }));
    const scan = payoutInput(createFinancialPayoutScanJob({
      providerPayoutId: 'po_active_1621', scanRunId: SCAN_RUN_ID,
      scanGenerationHour: HOUR
    }));
    const [first, second] = await Promise.all([
      databaseClient.db.transaction((transaction) => enqueueActiveEntityJob(transaction, event)),
      databaseClient.db.transaction((transaction) => enqueueActiveEntityJob(transaction, scan))
    ]);
    expect(second.id).toBe(first.id);
    expect(await databaseClient.db.select().from(jobs)).toHaveLength(1);
  });

  it('does not change permanent dedupe or parallel behavior for nonfinancial jobs', async () => {
    const [first, second] = await Promise.all([
      enqueueJob(databaseClient.db, {
        type: 'test.nonfinancial', payload: { entityId: SOURCE_ID },
        deduplicationKey: 'test:nonfinancial:one'
      }),
      enqueueJob(databaseClient.db, {
        type: 'test.nonfinancial', payload: { entityId: SOURCE_ID },
        deduplicationKey: 'test:nonfinancial:two'
      })
    ]);
    expect(second.id).not.toBe(first.id);
    expect(await databaseClient.db.select().from(jobs)).toHaveLength(2);
  });
});
