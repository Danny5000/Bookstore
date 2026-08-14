import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs } from '$lib/server/db/schema';
import {
  createFinancialPayoutContinuationJob,
  createFinancialPayoutEventJob,
  createFinancialPayoutScanJob,
  createFinancialSourceEventJob,
  createFinancialSourceGraphJob,
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
const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');

function sourceInput(spec: ReturnType<
  typeof createFinancialSourceEventJob |
  typeof createFinancialSourceGraphJob |
  typeof createFinancialSourceScanJob
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

    const repository = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => FAR_FUTURE
    );
    const claimed = await repository.claimNext('worker-a');
    expect(claimed?.id).toBe(results[0].id);
    const whileRunning = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, sourceInput(createFinancialSourceEventJob({
        sourceKind: 'refund', sourceId: SOURCE_ID, providerEventId: 'evt_active_race_1622'
      })))
    );
    expect(whileRunning.id).toBe(claimed?.id);
    expect(await databaseClient.db.select().from(jobs)).toHaveLength(1);
    expect((await databaseClient.db.select().from(jobs))[0]).toMatchObject({
      status: 'running', rerunRequestedAt: expect.any(Date)
    });

    await expect(repository.complete(claimed!.id, 'worker-a')).resolves.toBe(true);
    expect((await databaseClient.db.select().from(jobs))[0]).toMatchObject({
      status: 'pending', attempts: 0, rerunRequestedAt: null, completedAt: null
    });
    const rerun = await repository.claimNext('worker-b');
    expect(rerun?.id).toBe(claimed?.id);
    await expect(repository.complete(rerun!.id, 'worker-b')).resolves.toBe(true);
    expect((await databaseClient.db.select().from(jobs))[0]).toMatchObject({
      status: 'succeeded', attempts: 1, rerunRequestedAt: null,
      completedAt: expect.any(Date)
    });
  });

  it('keeps exact terminal replay permanent but permits a distinct later generation', async () => {
    const eventSpec = createFinancialSourceEventJob({
      sourceKind: 'payment', sourceId: SOURCE_ID, providerEventId: 'evt_active_terminal_1621'
    });
    const event = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, sourceInput(eventSpec))
    );
    const repository = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => FAR_FUTURE
    );
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

  it('coalesces active graph work, gives terminal graph publication a fresh generation, and keeps exact graph retry permanent', async () => {
    const eventSpec = createFinancialSourceEventJob({
      sourceKind: 'refund', sourceId: SOURCE_ID,
      providerEventId: 'evt_active_graph_origin_1621'
    });
    const graphSpec = createFinancialSourceGraphJob({
      sourceKind: 'refund', sourceId: SOURCE_ID,
      providerEventId: 'evt_active_graph_publication_1621'
    });
    const event = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, sourceInput(eventSpec))
    );
    const pendingCoalesced = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, sourceInput(graphSpec))
    );
    expect(pendingCoalesced.id).toBe(event.id);
    expect(await databaseClient.db.select().from(jobs)).toHaveLength(1);

    const repository = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => FAR_FUTURE
    );
    expect((await repository.claimNext('worker-graph-event'))?.id).toBe(event.id);
    const runningCoalesced = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, sourceInput(graphSpec))
    );
    expect(runningCoalesced).toMatchObject({
      id: event.id,
      status: 'running',
      rerunRequestedAt: expect.anything()
    });
    await expect(repository.complete(event.id, 'worker-graph-event')).resolves.toBe(true);
    expect((await databaseClient.db.select().from(jobs))[0]).toMatchObject({
      id: event.id,
      status: 'pending',
      attempts: 0,
      rerunRequestedAt: null
    });
    expect((await repository.claimNext('worker-graph-rerun'))?.id).toBe(event.id);
    await expect(repository.complete(event.id, 'worker-graph-rerun')).resolves.toBe(true);

    const graph = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, sourceInput(graphSpec))
    );
    expect(graph).toMatchObject({ status: 'pending', payload: graphSpec.payload });
    expect(graph.id).not.toBe(event.id);
    const localOnly = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => FAR_FUTURE,
      'local-only'
    );
    await expect(localOnly.claimNext('worker-graph-local')).resolves.toBeNull();
    expect((await repository.claimNext('worker-graph-provider'))?.id).toBe(graph.id);
    await expect(repository.complete(graph.id, 'worker-graph-provider')).resolves.toBe(true);

    const exactGraphReplay = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, sourceInput(graphSpec))
    );
    expect(exactGraphReplay).toMatchObject({
      id: graph.id,
      status: 'succeeded',
      attempts: 1,
      payload: graphSpec.payload,
      deduplicationKey: graphSpec.deduplicationKey
    });
    expect(await databaseClient.db.select().from(jobs)).toHaveLength(2);
  });

  it('turns a distinct trigger arriving before failure into one fresh attempt', async () => {
    const event = sourceInput(createFinancialSourceEventJob({
      sourceKind: 'dispute', sourceId: SOURCE_ID,
      providerEventId: 'evt_active_failure_1621'
    }));
    const queued = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, event)
    );
    const repository = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => FAR_FUTURE
    );
    expect((await repository.claimNext('worker-failure-a'))?.id).toBe(queued.id);

    await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, sourceInput(createFinancialSourceScanJob({
        sourceKind: 'dispute', sourceId: SOURCE_ID,
        scanRunId: SCAN_RUN_ID, scanGenerationHour: HOUR
      })))
    );
    await expect(repository.fail(
      queued.id,
      'worker-failure-a',
      'safe current-attempt failure',
      false
    )).resolves.toBe(true);

    expect((await databaseClient.db.select().from(jobs))[0]).toMatchObject({
      status: 'pending', attempts: 0, rerunRequestedAt: null,
      completedAt: null, lastError: null
    });
    const rerun = await repository.claimNext('worker-failure-b');
    expect(rerun?.id).toBe(queued.id);
    await expect(repository.complete(rerun!.id, 'worker-failure-b')).resolves.toBe(true);
  });

  it('gives a dirty rerun a fresh retry budget when reclaiming an expired lease', async () => {
    let currentTime = new Date('2026-08-14T12:00:00.000Z');
    const event = sourceInput(createFinancialSourceEventJob({
      sourceKind: 'payment', sourceId: SOURCE_ID,
      providerEventId: 'evt_active_expired_1621'
    }));
    const queued = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, event)
    );
    const repository = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => currentTime
    );
    expect((await repository.claimNext('worker-expired-a'))?.id).toBe(queued.id);
    await databaseClient.db.update(jobs)
      .set({ attempts: event.maxAttempts - 1, lastError: 'old attempt history' })
      .where(eq(jobs.id, queued.id));
    await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, sourceInput(createFinancialSourceScanJob({
        sourceKind: 'payment', sourceId: SOURCE_ID,
        scanRunId: SCAN_RUN_ID, scanGenerationHour: HOUR
      })))
    );

    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs + 1);
    const rerun = await repository.claimNext('worker-expired-b');
    expect(rerun).toMatchObject({ id: queued.id, attempts: 1 });
    expect((await databaseClient.db.select().from(jobs))[0]).toMatchObject({
      status: 'running', attempts: 1, lastError: null, rerunRequestedAt: null
    });
    await expect(repository.fail(
      queued.id,
      'worker-expired-b',
      'fresh transient failure',
      true
    )).resolves.toBe(true);
    expect((await databaseClient.db.select().from(jobs))[0]).toMatchObject({
      status: 'pending', attempts: 1, lastError: 'fresh transient failure'
    });
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

  it('keeps a later payout root distinct from an immutable-cursor continuation', async () => {
    const providerPayoutId = 'po_active_continuation_1621';
    const continuation = createFinancialPayoutContinuationJob({
      providerPayoutId,
      payoutId: '00000000-0000-4000-8000-000000001623',
      runId: '00000000-0000-4000-8000-000000001624',
      payoutGeneration: 0,
      cursorDigestSha256: 'a'.repeat(64)
    });
    const continuationRow = await enqueueJob(databaseClient.db, continuation);

    const root = await databaseClient.db.transaction((transaction) =>
      enqueueActiveEntityJob(transaction, payoutInput(createFinancialPayoutEventJob({
        providerPayoutId,
        providerEventId: 'evt_active_continuation_1621'
      })))
    );

    expect(root.id).not.toBe(continuationRow.id);
    expect(await databaseClient.db.select().from(jobs)).toHaveLength(2);
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
