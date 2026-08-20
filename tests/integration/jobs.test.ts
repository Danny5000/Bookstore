import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { financialProjectionVersions, financialScanRuns, jobs } from '$lib/server/db/schema';
import { enqueueJob, createPostgresJobRepository } from '$lib/server/jobs/repository';
import { processFinancialScanJob } from '$lib/server/commerce/financial/scans/service';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import { applicationConfig, workerDatabaseClient as databaseClient } from './database';

describe('PostgreSQL jobs', () => {
  it('deduplicates enqueue by key', async () => {
    const first = await enqueueJob(databaseClient.db, {
      type: 'test.one',
      payload: { value: 1 },
      deduplicationKey: 'same-key'
    });
    const second = await enqueueJob(databaseClient.db, {
      type: 'test.one',
      payload: { value: 2 },
      deduplicationKey: 'same-key'
    });
    expect(second.id).toBe(first.id);
  });

  it('uses skip locked so two workers claim different jobs', async () => {
    const alreadyDue = new Date(0);
    await enqueueJob(databaseClient.db, {
      type: 'test.one',
      payload: { order: 1 },
      runAt: alreadyDue
    });
    await enqueueJob(databaseClient.db, {
      type: 'test.two',
      payload: { order: 2 },
      runAt: alreadyDue
    });
    const repository = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs
    );

    const [first, second] = await Promise.all([
      repository.claimNext('worker-a'),
      repository.claimNext('worker-b')
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.id).not.toBe(second?.id);
  });

  it('returns the exact permanent key on claims and null for unkeyed work', async () => {
    const due = new Date(0);
    await enqueueJob(databaseClient.db, {
      type: 'test.keyed-claim', payload: {}, runAt: due,
      deduplicationKey: 'test:keyed-claim:one'
    });
    await enqueueJob(databaseClient.db, {
      type: 'test.unkeyed-claim', payload: {}, runAt: new Date(1)
    });
    const repository = createPostgresJobRepository(databaseClient.db, applicationConfig.jobs);
    const keyed = await repository.claimNext('worker-keyed');
    expect(keyed?.deduplicationKey).toBe('test:keyed-claim:one');
    expect(await repository.complete(keyed!.id, 'worker-keyed')).toBe(true);
    const unkeyed = await repository.claimNext('worker-unkeyed');
    expect(unkeyed?.deduplicationKey).toBeNull();
  });

  it('leaves provider-backed work pending in local-only mode while claiming local work', async () => {
    const due = new Date('2026-08-12T12:00:00.000Z');
    const replayRunId = crypto.randomUUID();
    const replayDigest = 'b'.repeat(64);
    await databaseClient.db.insert(financialScanRuns).values({
      id: replayRunId, rootKey: 'commerce.financial-classification:scan:1:1',
      kind: 'classification_replay', phase: 'classification_replay_page',
      classifierVersion: 1, allocationAlgorithmVersion: 1, replayId: 'c1-a1',
      cursorDigestSha256: replayDigest
    });
    const providerJobs = [
      { type: 'commerce.stripe-event', payload: { stripeEventId: crypto.randomUUID() } },
      { type: 'commerce.financial-source', payload: { sourceKind: 'payment' } },
      { type: 'commerce.financial-payout', payload: { providerPayoutId: 'po_disabled_claim' } },
      { type: 'commerce.financial-scan', payload: { kind: 'hourly' } },
      { type: 'commerce.financial-scan', payload: { kind: 'payout_impact' } },
      { type: 'commerce.financial-scan', payload: {
        kind: 'continuation', phase: 'payout_discovery_page'
      } }
    ] as const;
    const localJobs = [
      { type: 'test.local-only', payload: {} },
      { type: 'commerce.financial-classification', payload: {
        subjectType: 'balance_transaction', subjectId: crypto.randomUUID(),
        sourceFingerprintSha256: 'a'.repeat(64), classifierVersion: 1,
        allocationAlgorithmVersion: 1, replayId: 'c1-a1'
      } },
      { type: 'commerce.financial-scan', payload: {
        kind: 'composite_replay', classifierVersion: 1,
        allocationAlgorithmVersion: 1, replayId: 'c1-a1'
      } },
      { type: 'commerce.financial-scan', payload: {
        kind: 'continuation', scanRunId: replayRunId,
        phase: 'classification_replay_page', cursorDigestSha256: replayDigest, limit: 100
      } }
    ] as const;
    for (const [index, job] of [...providerJobs, ...localJobs].entries()) {
      await enqueueJob(databaseClient.db, {
        ...job, runAt: due, deduplicationKey: `test:local-claim:${index}`
      });
    }

    const repository = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => new Date('2026-08-12T13:00:00.000Z'),
      'local-only'
    );
    const claimedTypes: string[] = [];
    for (;;) {
      const claimed = await repository.claimNext('local-only-worker');
      if (claimed === null) break;
      claimedTypes.push(`${claimed.type}:${String(claimed.payload.kind ?? '')}:${String(claimed.payload.phase ?? '')}`);
      await repository.complete(claimed.id, 'local-only-worker');
    }

    expect(claimedTypes).toEqual([
      'test.local-only::',
      'commerce.financial-classification::',
      'commerce.financial-scan:composite_replay:',
      'commerce.financial-scan:continuation:classification_replay_page'
    ]);
    expect(await databaseClient.db.select().from(jobs).where(eq(jobs.status, 'pending')))
      .toHaveLength(providerJobs.length);
  });

  it('leaves predecessor classification work and replay roots for a retaining worker', async () => {
    const due = new Date(0);
    await enqueueJob(databaseClient.db, {
      type: 'commerce.financial-classification',
      payload: {
        subjectType: 'balance_transaction', subjectId: crypto.randomUUID(),
        sourceFingerprintSha256: 'a'.repeat(64), classifierVersion: 1,
        allocationAlgorithmVersion: 1, replayId: 'c1-a1'
      },
      deduplicationKey: `test:predecessor-classification:${crypto.randomUUID()}`,
      runAt: due, maxAttempts: 5
    });
    await enqueueJob(databaseClient.db, {
      type: 'commerce.financial-scan',
      payload: {
        kind: 'composite_replay', classifierVersion: 1,
        allocationAlgorithmVersion: 1, replayId: 'c1-a1'
      },
      deduplicationKey: `test:predecessor-replay-root:${crypto.randomUUID()}`,
      runAt: due, maxAttempts: 8
    });
    const repository = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => new Date(1), 'all',
      { classifierVersion: 2, allocationAlgorithmVersion: 2 }
    );

    await expect(repository.claimNext('new-implementation-worker')).resolves.toBeNull();
    expect(await databaseClient.db.select().from(jobs).where(eq(jobs.status, 'pending')))
      .toHaveLength(2);
  });

  it('defers provider-backed financial claims for every worker until pending activation', async () => {
    const scanRunId = crypto.randomUUID();
    await databaseClient.db.update(financialProjectionVersions).set({
      pendingClassifierVersion: 2,
      pendingAllocationAlgorithmVersion: 2,
      pendingReplayId: 'c2-a2',
      pendingScanRunId: scanRunId
    });
    const due = new Date(0);
    const providerJobs = [
      {
        type: 'commerce.stripe-event',
        payload: { stripeEventId: crypto.randomUUID() },
        maxAttempts: 12
      },
      {
        type: 'commerce.financial-source',
        payload: {
          sourceKind: 'payment', sourceId: crypto.randomUUID(),
          trigger: { kind: 'event', providerEventId: 'evt_active_claim_source' }
        },
        maxAttempts: 12
      },
      {
        type: 'commerce.financial-payout',
        payload: {
          providerPayoutId: 'po_active_claim',
          trigger: { kind: 'event', providerEventId: 'evt_active_claim_payout' }
        },
        maxAttempts: 12
      },
      {
        type: 'commerce.financial-scan',
        payload: { kind: 'hourly', scanGenerationHour: '2026-08-12T12:00:00.000Z' },
        maxAttempts: 8
      },
      {
        type: 'commerce.financial-scan',
        payload: { kind: 'initial', version: 1 },
        maxAttempts: 8
      },
      {
        type: 'commerce.financial-scan',
        payload: { kind: 'payout_impact', payoutId: crypto.randomUUID(), payoutGeneration: 1 },
        maxAttempts: 8
      },
      ...([
        'source_page',
        'payout_discovery_page',
        'incomplete_payout_run_page',
        'payout_impact_page'
      ] as const).map((phase, index) => ({
        type: 'commerce.financial-scan' as const,
        payload: {
          kind: 'continuation' as const,
          scanRunId: crypto.randomUUID(),
          phase,
          cursorDigestSha256: String(index + 1).repeat(64),
          limit: 100
        },
        maxAttempts: 8
      }))
    ] as const;
    const ordinary = await enqueueJob(databaseClient.db, {
      type: 'test.pending-provider-barrier-local',
      payload: {},
      runAt: due,
      deduplicationKey: 'test:pending-provider-barrier-local'
    });
    const queuedProviderJobs: Awaited<ReturnType<typeof enqueueJob>>[] = [];
    for (const [index, job] of providerJobs.entries()) {
      queuedProviderJobs.push(await enqueueJob(databaseClient.db, {
        ...job,
        runAt: due,
        deduplicationKey: `test:active-implementation-provider:${index}`
      }));
    }
    const pendingWorker = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => new Date(1), 'all',
      { classifierVersion: 2, allocationAlgorithmVersion: 2 }
    );
    const activeWorker = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => new Date(1), 'all',
      { classifierVersion: 1, allocationAlgorithmVersion: 1 }
    );

    await expect(activeWorker.claimNext('active-local-worker')).resolves.toMatchObject({
      id: ordinary.id,
      type: 'test.pending-provider-barrier-local'
    });
    await expect(activeWorker.complete(ordinary.id, 'active-local-worker')).resolves.toBe(true);
    await expect(pendingWorker.claimNext('pending-provider-worker')).resolves.toBeNull();
    await expect(activeWorker.claimNext('active-provider-worker')).resolves.toBeNull();
    await expect(databaseClient.db.select().from(jobs).where(eq(jobs.status, 'pending')))
      .resolves.toEqual(providerJobs.map((_, index) => expect.objectContaining({
        deduplicationKey: `test:active-implementation-provider:${index}`,
        status: 'pending',
        attempts: 0
      })));

    await databaseClient.db.update(financialProjectionVersions).set({
      classifierVersion: 2,
      allocationAlgorithmVersion: 2,
      pendingClassifierVersion: null,
      pendingAllocationAlgorithmVersion: null,
      pendingReplayId: null,
      pendingScanRunId: null,
      activatedAt: new Date('2099-08-12T13:00:00.000Z'),
      activationCorrelationId: 'test-provider-claim-activation'
    });
    const postActivation = await enqueueJob(databaseClient.db, {
      ...providerJobs[1],
      runAt: due,
      deduplicationKey: 'test:active-implementation-provider:after-activation'
    });
    await expect(activeWorker.claimNext('retired-provider-worker')).resolves.toBeNull();
    for (const expected of [...queuedProviderJobs, postActivation]) {
      const claimed = await pendingWorker.claimNext('activated-provider-worker');
      expect(claimed).toMatchObject({ id: expected.id, type: expected.type });
      await expect(pendingWorker.complete(claimed!.id, 'activated-provider-worker'))
        .resolves.toBe(true);
    }
  });

  it('holds an expired provider lease through pending replay and reclaims it after activation', async () => {
    let currentTime = new Date('2099-08-14T12:00:00.000Z');
    const queued = await enqueueJob(databaseClient.db, {
      type: 'commerce.financial-source',
      payload: {
        sourceKind: 'payment', sourceId: crypto.randomUUID(),
        trigger: { kind: 'event', providerEventId: 'evt_pending_crash_reclaim' }
      },
      runAt: currentTime,
      deduplicationKey: 'test:pending-provider-crash-reclaim',
      maxAttempts: 12
    });
    const activeWorker = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => currentTime, 'all',
      { classifierVersion: 1, allocationAlgorithmVersion: 1 }
    );
    const successorWorker = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => currentTime, 'all',
      { classifierVersion: 2, allocationAlgorithmVersion: 2 }
    );
    await expect(activeWorker.claimNext('provider-before-pending')).resolves.toMatchObject({
      id: queued.id,
      attempts: 1
    });
    await databaseClient.db.update(financialProjectionVersions).set({
      pendingClassifierVersion: 2,
      pendingAllocationAlgorithmVersion: 2,
      pendingReplayId: 'c2-a2',
      pendingScanRunId: crypto.randomUUID()
    });
    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs + 1);

    await expect(activeWorker.claimNext('provider-pending-reclaim-old')).resolves.toBeNull();
    await expect(successorWorker.claimNext('provider-pending-reclaim-new')).resolves.toBeNull();
    await expect(databaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id)))
      .resolves.toEqual([expect.objectContaining({
        status: 'running', attempts: 1, lockedBy: 'provider-before-pending'
      })]);

    await databaseClient.db.update(financialProjectionVersions).set({
      classifierVersion: 2,
      allocationAlgorithmVersion: 2,
      pendingClassifierVersion: null,
      pendingAllocationAlgorithmVersion: null,
      pendingReplayId: null,
      pendingScanRunId: null,
      activatedAt: currentTime,
      activationCorrelationId: 'test-provider-crash-reclaim-activation'
    });
    await expect(activeWorker.claimNext('provider-retired-reclaim')).resolves.toBeNull();
    await expect(successorWorker.claimNext('provider-activated-reclaim')).resolves.toMatchObject({
      id: queued.id,
      attempts: 2,
      lockedBy: 'provider-activated-reclaim'
    });
  });

  it('only lets the owning implementation claim replay page and finalizer continuations', async () => {
    const scanRunId = crypto.randomUUID();
    const pageDigest = 'c'.repeat(64);
    const finalizeDigest = 'd'.repeat(64);
    await databaseClient.db.insert(financialScanRuns).values({
      id: scanRunId, rootKey: 'commerce.financial-classification:scan:2:2',
      kind: 'classification_replay', phase: 'classification_replay_page',
      classifierVersion: 2, allocationAlgorithmVersion: 2, replayId: 'c2-a2',
      cursorDigestSha256: pageDigest
    });
    const page = await enqueueJob(databaseClient.db, {
      type: 'commerce.financial-scan',
      payload: {
        kind: 'continuation', scanRunId, phase: 'classification_replay_page',
        cursorDigestSha256: pageDigest, limit: 100
      },
      deduplicationKey: `test:replay-page:${scanRunId}`, runAt: new Date(0)
    });
    const oldWorker = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => new Date(1), 'local-only',
      { classifierVersion: 1, allocationAlgorithmVersion: 1 }
    );
    const owningWorker = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => new Date(1), 'local-only',
      { classifierVersion: 2, allocationAlgorithmVersion: 2 }
    );

    await expect(oldWorker.claimNext('old-page-worker')).resolves.toBeNull();
    await expect(owningWorker.claimNext('owning-page-worker')).resolves.toMatchObject({
      id: page.id, payload: expect.objectContaining({ phase: 'classification_replay_page' })
    });
    await expect(owningWorker.complete(page.id, 'owning-page-worker')).resolves.toBe(true);

    await databaseClient.db.update(financialScanRuns).set({
      phase: 'classification_replay_finalize', cursorDigestSha256: finalizeDigest
    }).where(eq(financialScanRuns.id, scanRunId));
    const finalizer = await enqueueJob(databaseClient.db, {
      type: 'commerce.financial-scan',
      payload: {
        kind: 'continuation', scanRunId, phase: 'classification_replay_finalize',
        cursorDigestSha256: finalizeDigest, limit: 100
      },
      deduplicationKey: `test:replay-finalizer-version:${scanRunId}`,
      runAt: new Date(0)
    });

    await expect(oldWorker.claimNext('old-finalizer-worker')).resolves.toBeNull();
    await expect(owningWorker.claimNext('owning-finalizer-worker')).resolves.toMatchObject({
      id: finalizer.id,
      payload: expect.objectContaining({ phase: 'classification_replay_finalize' })
    });
  });

  it('reclaims owning replay continuations after their run transition committed', async () => {
    const scanRunId = crypto.randomUUID();
    const pageDigest = 'e'.repeat(64);
    const finalizeDigest = 'f'.repeat(64);
    let currentTime = new Date('2026-08-12T12:00:00.000Z');
    await databaseClient.db.insert(financialScanRuns).values({
      id: scanRunId, rootKey: 'commerce.financial-classification:scan:2:2',
      kind: 'classification_replay', phase: 'classification_replay_page',
      classifierVersion: 2, allocationAlgorithmVersion: 2, replayId: 'c2-a2',
      cursorDigestSha256: pageDigest
    });
    const page = await enqueueJob(databaseClient.db, {
      type: 'commerce.financial-scan',
      payload: {
        kind: 'continuation', scanRunId, phase: 'classification_replay_page',
        cursorDigestSha256: pageDigest, limit: 100
      },
      deduplicationKey: `test:replay-page-crash:${scanRunId}`, runAt: new Date(0)
    });
    const owningWorker = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => currentTime, 'local-only',
      { classifierVersion: 2, allocationAlgorithmVersion: 2 }
    );
    const retiredWorker = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => currentTime, 'local-only',
      { classifierVersion: 1, allocationAlgorithmVersion: 1 }
    );
    const replayDependencies = {
      database: databaseClient.db,
      gateway: new Proxy({}, {
        get: () => () => { throw new Error('stale replay continuation must not call Stripe'); }
      }) as StripeCommerceGateway,
      runtimeMode: 'disabled' as const
    };

    await expect(owningWorker.claimNext('page-crash-worker')).resolves.toMatchObject({ id: page.id });
    await databaseClient.db.update(financialScanRuns).set({
      phase: 'classification_replay_finalize', checkpoint: null,
      cursorDigestSha256: finalizeDigest
    }).where(eq(financialScanRuns.id, scanRunId));
    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs + 1);

    await expect(retiredWorker.claimNext('retired-page-recovery')).resolves.toBeNull();
    const recoveredPage = await owningWorker.claimNext('page-recovery-worker');
    expect(recoveredPage).toMatchObject({
      id: page.id,
      payload: expect.objectContaining({ phase: 'classification_replay_page' })
    });
    await expect(processFinancialScanJob(replayDependencies, {
      payload: recoveredPage!.payload as never,
      correlationId: 'replay-page-crash-recovery', signal: new AbortController().signal
    })).resolves.toEqual({ status: 'unchanged', runId: null });
    await expect(owningWorker.complete(page.id, 'page-recovery-worker')).resolves.toBe(true);

    const finalizer = await enqueueJob(databaseClient.db, {
      type: 'commerce.financial-scan',
      payload: {
        kind: 'continuation', scanRunId, phase: 'classification_replay_finalize',
        cursorDigestSha256: finalizeDigest, limit: 100
      },
      deduplicationKey: `test:replay-finalizer-crash:${scanRunId}`, runAt: new Date(0)
    });
    await expect(owningWorker.claimNext('finalizer-crash-worker')).resolves.toMatchObject({
      id: finalizer.id
    });
    await databaseClient.db.update(financialScanRuns).set({
      state: 'completed', safeOutcome: 'completed', cursorDigestSha256: null,
      completedAt: currentTime
    }).where(eq(financialScanRuns.id, scanRunId));
    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs + 1);

    await expect(retiredWorker.claimNext('retired-finalizer-recovery')).resolves.toBeNull();
    const recoveredFinalizer = await owningWorker.claimNext('finalizer-recovery-worker');
    expect(recoveredFinalizer).toMatchObject({
      id: finalizer.id,
      payload: expect.objectContaining({ phase: 'classification_replay_finalize' })
    });
    await expect(processFinancialScanJob(replayDependencies, {
      payload: recoveredFinalizer!.payload as never,
      correlationId: 'replay-finalizer-crash-recovery', signal: new AbortController().signal
    })).resolves.toEqual({ status: 'unchanged', runId: null });
    await expect(owningWorker.complete(finalizer.id, 'finalizer-recovery-worker')).resolves.toBe(true);
    await expect(databaseClient.db.select().from(jobs).where(eq(jobs.id, finalizer.id)))
      .resolves.toEqual([expect.objectContaining({ status: 'succeeded', attempts: 2 })]);
  });

  it('keeps a replay finalizer claim-ineligible while any run-linked child failed', async () => {
    const scanRunId = crypto.randomUUID();
    const due = new Date(0);
    await databaseClient.db.insert(financialScanRuns).values({
      id: scanRunId, rootKey: 'commerce.financial-classification:scan:2:2',
      kind: 'classification_replay', phase: 'classification_replay_finalize',
      classifierVersion: 2, allocationAlgorithmVersion: 2, replayId: 'c2-a2',
      cursorDigestSha256: 'b'.repeat(64)
    });
    await enqueueJob(databaseClient.db, {
      type: 'commerce.financial-classification',
      payload: {
        subjectType: 'balance_transaction', subjectId: crypto.randomUUID(),
        sourceFingerprintSha256: 'a'.repeat(64), classifierVersion: 2,
        allocationAlgorithmVersion: 2, replayId: 'c2-a2', scanRunId
      },
      deduplicationKey: `test:replay-child:${scanRunId}`, runAt: due, maxAttempts: 1
    });
    await enqueueJob(databaseClient.db, {
      type: 'commerce.financial-scan',
      payload: {
        kind: 'continuation', scanRunId, phase: 'classification_replay_finalize',
        cursorDigestSha256: 'b'.repeat(64), limit: 100
      },
      deduplicationKey: `test:replay-finalizer:${scanRunId}`, runAt: due
    });
    const repository = createPostgresJobRepository(
      databaseClient.db, applicationConfig.jobs, () => new Date(1), 'local-only',
      { classifierVersion: 2, allocationAlgorithmVersion: 2 }
    );

    const child = await repository.claimNext('replay-child-worker');
    expect(child?.type).toBe('commerce.financial-classification');
    await expect(repository.fail(
      child!.id, 'replay-child-worker', 'bounded replay failure', false
    )).resolves.toBe(true);

    await expect(repository.claimNext('replay-finalizer-worker')).resolves.toBeNull();
    const [finalizer] = await databaseClient.db.select().from(jobs).where(
      eq(jobs.deduplicationKey, `test:replay-finalizer:${scanRunId}`)
    );
    expect(finalizer?.status).toBe('pending');

    await databaseClient.db.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.id, child!.id));
    await expect(repository.claimNext('replay-finalizer-worker')).resolves.toMatchObject({
      id: finalizer!.id, type: 'commerce.financial-scan',
      payload: expect.objectContaining({ phase: 'classification_replay_finalize', scanRunId })
    });
  });

  it('reschedules a retry and eventually marks an exhausted job failed', async () => {
    let currentTime = new Date('2026-08-08T12:00:00.000Z');
    const repository = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => currentTime
    );
    const queued = await enqueueJob(databaseClient.db, {
      type: 'test.retry',
      payload: {},
      runAt: currentTime,
      maxAttempts: 2
    });

    const first = await repository.claimNext('worker-a');
    expect(first?.attempts).toBe(1);
    await repository.fail(queued.id, 'worker-a', 'safe transient failure', true);

    const [pending] = await databaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id));
    expect(pending).toMatchObject({ status: 'pending', attempts: 1 });

    currentTime = new Date('2026-08-08T12:00:01.000Z');
    const second = await repository.claimNext('worker-b');
    expect(second?.attempts).toBe(2);
    await repository.fail(queued.id, 'worker-b', 'safe transient failure', true);

    const [failed] = await databaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id));
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 2,
      lastError: 'safe transient failure'
    });
  });

  it('reclaims an expired lease and fails it after the final crashed attempt', async () => {
    let currentTime = new Date('2026-08-08T12:00:00.000Z');
    const repository = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => currentTime
    );
    const queued = await enqueueJob(databaseClient.db, {
      type: 'test.crash',
      payload: {},
      runAt: currentTime,
      maxAttempts: 2
    });

    expect((await repository.claimNext('worker-a'))?.attempts).toBe(1);
    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs + 1);
    expect((await repository.claimNext('worker-b'))?.attempts).toBe(2);
    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs + 1);
    await expect(repository.claimNext('worker-c')).resolves.toBeNull();

    const [failed] = await databaseClient.db.select().from(jobs).where(eq(jobs.id, queued.id));
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 2,
      lastError: 'Job lease expired after final attempt'
    });
  });

  it('renews only the exact running owner and reclaims only after the renewed lease expires', async () => {
    let currentTime = new Date('2026-08-08T12:00:00.000Z');
    const repository = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => currentTime
    );
    const queued = await enqueueJob(databaseClient.db, {
      type: 'test.heartbeat',
      payload: {},
      runAt: currentTime,
      maxAttempts: 3
    });

    expect((await repository.claimNext('worker-a'))?.attempts).toBe(1);
    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs - 1);
    await expect(repository.renewLease(queued.id, 'worker-b')).resolves.toBe(false);
    await expect(repository.renewLease(queued.id, 'worker-a')).resolves.toBe(true);
    expect((await databaseClient.db.select().from(jobs)
      .where(eq(jobs.id, queued.id)))[0]?.lockedAt?.getTime()).toBe(currentTime.getTime());

    currentTime = new Date('2026-08-08T12:00:00.000Z');
    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs + 1);
    await expect(repository.claimNext('worker-b')).resolves.toBeNull();

    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs);
    expect((await repository.claimNext('worker-b'))?.attempts).toBe(2);
  });

  it('returns false for stale terminal writes without changing the current owner', async () => {
    let currentTime = new Date('2026-08-08T12:00:00.000Z');
    const repository = createPostgresJobRepository(
      databaseClient.db,
      applicationConfig.jobs,
      () => currentTime
    );
    const queued = await enqueueJob(databaseClient.db, {
      type: 'test.stale-terminal',
      payload: {},
      runAt: currentTime,
      maxAttempts: 3
    });

    await repository.claimNext('worker-a');
    currentTime = new Date(currentTime.getTime() + applicationConfig.jobs.leaseMs + 1);
    await repository.claimNext('worker-b');

    await expect(repository.complete(queued.id, 'worker-a')).resolves.toBe(false);
    await expect(repository.fail(queued.id, 'worker-a', 'stale', true)).resolves.toBe(false);
    expect((await databaseClient.db.select().from(jobs)
      .where(eq(jobs.id, queued.id)))[0]).toMatchObject({
      status: 'running',
      lockedBy: 'worker-b',
      attempts: 2
    });
    await expect(repository.complete(queued.id, 'worker-b')).resolves.toBe(true);
  });
});
