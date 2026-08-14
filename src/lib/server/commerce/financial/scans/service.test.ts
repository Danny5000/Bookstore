import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import type { Database } from '$lib/server/db/client';
import type { FinancialScanRunRow } from '$lib/server/db/schema';
import { payoutSnapshotFixture } from '../../../../../../tests/fixtures/stripe/payout';
import { processFinancialScanJob } from './service';

const repository = vi.hoisted(() => ({
  start: vi.fn(), resume: vi.fn(), sources: vi.fn(), payouts: vi.fn(),
  impact: vi.fn(), classifications: vi.fn(), freezePayoutWindow: vi.fn(),
  completeEmptyReplay: vi.fn(), commit: vi.fn()
}));
const payoutRepository = vi.hoisted(() => ({ stage: vi.fn() }));
vi.mock('./repository', () => ({
  startOrResumeFinancialScan: repository.start,
  resumeFinancialScanContinuation: repository.resume,
  loadFinancialSourceScanPage: repository.sources,
  loadIncompletePayoutRunPage: repository.payouts,
  loadPayoutImpactSourcePage: repository.impact,
  loadClassificationReplayPage: repository.classifications,
  freezePayoutDiscoveryWindow: repository.freezePayoutWindow,
  completeEmptyFinancialReplay: repository.completeEmptyReplay,
  commitFinancialScanPage: repository.commit
}));
vi.mock('../payouts/repository', () => ({ stagePayoutSnapshot: payoutRepository.stage }));

const runId = '00000000-0000-4000-8000-000000000501';
const sourceId = '00000000-0000-4000-8000-000000000502';
const payoutId = '00000000-0000-4000-8000-000000000503';

function run(overrides: Partial<FinancialScanRunRow> = {}): FinancialScanRunRow {
  return {
    id: runId,
    rootKey: 'commerce.financial-scan:2026-08-12T19:00:00.000Z',
    kind: 'hourly', phase: 'source_page', state: 'running',
    classifierVersion: null, allocationAlgorithmVersion: null, replayId: null,
    payoutDiscoveryCreatedGte: null, payoutDiscoveryCreatedLt: null,
    checkpoint: null, cursorDigestSha256: null,
    processedCount: 0, enqueuedCount: 0, pageCount: 0, safeOutcome: null,
    startedAt: new Date('2026-08-12T19:00:00.000Z'),
    updatedAt: new Date('2026-08-12T19:00:00.000Z'), completedAt: null,
    ...overrides
  };
}

describe('financial scan page service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.freezePayoutWindow.mockResolvedValue({
      createdGte: Math.floor(new Date('2026-08-09T19:00:00.000Z').getTime() / 1000),
      createdLt: Math.floor(new Date('2026-08-12T20:00:00.000Z').getTime() / 1000)
    });
    repository.commit.mockImplementation(async (_database, input) => run({
      phase: input.nextPhase,
      checkpoint: input.nextCheckpoint,
      pageCount: input.expectedPageCount + 1,
      state: input.complete ? 'completed' : 'running',
      completedAt: input.complete ? new Date() : null
    }));
    repository.completeEmptyReplay.mockResolvedValue(run({
      kind: 'classification_replay', phase: 'classification_replay_page', state: 'completed',
      classifierVersion: 2, allocationAlgorithmVersion: 4, replayId: 'c2-a4',
      pageCount: 1, safeOutcome: 'completed', completedAt: new Date()
    }));
    payoutRepository.stage.mockResolvedValue({ payoutId, generation: 0, changed: true });
  });

  it('turns one bounded local source page into exact hour-keyed children and the next phase', async () => {
    repository.start.mockResolvedValue(run());
    repository.sources.mockResolvedValue({
      data: [
        { sourceKind: 'payment', sourceId },
        { sourceKind: 'refund', sourceId: '00000000-0000-4000-8000-000000000504' }
      ], hasMore: false, checkpoint: null
    });
    const gateway = { listPayouts: vi.fn() } as unknown as StripeCommerceGateway;

    await expect(processFinancialScanJob({ database: {} as Database, gateway, runtimeMode: 'stripe' }, {
      payload: { kind: 'hourly', scanGenerationHour: '2026-08-12T19:00:00.000Z' },
      correlationId: 'scan-source-page', signal: new AbortController().signal
    })).resolves.toEqual({ status: 'continued', runId });

    const commit = repository.commit.mock.calls[0]?.[1];
    expect(commit).toMatchObject({
      runId, expectedPhase: 'source_page', nextPhase: 'payout_discovery_page',
      nextCheckpoint: null, processedCount: 2, complete: false
    });
    expect(commit.children.map((child: { deduplicationKey: string }) => child.deduplicationKey))
      .toEqual([
        `financial:source:scan:payment:${sourceId}:2026-08-12T19:00:00.000Z`,
        'financial:source:scan:refund:00000000-0000-4000-8000-000000000504:2026-08-12T19:00:00.000Z'
      ]);
    expect(gateway.listPayouts).not.toHaveBeenCalled();
  });

  it('validates one canonical payout page and atomically checkpoints children without staging it', async () => {
    repository.resume.mockResolvedValue(run({ phase: 'payout_discovery_page' }));
    const trace: string[] = [];
    const payout = payoutSnapshotFixture({ id: 'po_scan_page_101' });
    const gateway = {
      listPayouts: vi.fn(async () => {
        trace.push('provider');
        return { data: [payout], hasMore: true, nextStartingAfter: payout.id };
      })
    } as unknown as StripeCommerceGateway;
    repository.commit.mockImplementation(async (_database, input) => {
      trace.push('commit');
      return run({ phase: input.nextPhase, checkpoint: input.nextCheckpoint, pageCount: 1 });
    });

    await processFinancialScanJob({ database: {} as Database, gateway, runtimeMode: 'stripe' }, {
      payload: {
        kind: 'continuation', scanRunId: runId, phase: 'payout_discovery_page',
        cursorDigestSha256: 'a'.repeat(64), limit: 100
      }, correlationId: 'scan-payout-page', signal: new AbortController().signal
    });
    expect(trace).toEqual(['provider', 'commit']);
    expect(payoutRepository.stage).not.toHaveBeenCalled();
    expect(repository.freezePayoutWindow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: runId, phase: 'payout_discovery_page' }),
      '2026-08-12T19:00:00.000Z'
    );
    expect(gateway.listPayouts).toHaveBeenCalledWith({
      limit: 100,
      createdGte: Math.floor(new Date('2026-08-09T19:00:00.000Z').getTime() / 1000),
      createdLt: Math.floor(new Date('2026-08-12T20:00:00.000Z').getTime() / 1000)
    });
    expect(repository.commit.mock.calls[0]?.[1]).toMatchObject({
      nextPhase: 'payout_discovery_page', nextCheckpoint: payout.id,
      processedCount: 1, complete: false
    });
    expect(repository.commit.mock.calls[0]?.[1].children[0].deduplicationKey)
      .toBe(`financial:payout:scan:${payout.id}:2026-08-12T19:00:00.000Z`);
  });

  it('uses the persisted initial-backfill run kind for the seven-day payout lookback', async () => {
    const earliestPaidAt = new Date('2026-07-01T12:00:00.000Z');
    const database = {} as Database;
    repository.freezePayoutWindow.mockResolvedValue({
      createdGte: Math.floor((earliestPaidAt.getTime() - 7 * 86_400_000) / 1000),
      createdLt: Math.floor(new Date('2026-08-12T20:00:00.000Z').getTime() / 1000)
    });
    repository.resume.mockResolvedValue(run({
      rootKey: 'commerce.financial-scan:initial:v1',
      kind: 'initial_backfill',
      phase: 'payout_discovery_page'
    }));
    const gateway = {
      listPayouts: vi.fn(async () => ({ data: [], hasMore: false, nextStartingAfter: null }))
    } as unknown as StripeCommerceGateway;

    await processFinancialScanJob({ database, gateway, runtimeMode: 'stripe' }, {
      payload: {
        kind: 'continuation', scanRunId: runId, phase: 'payout_discovery_page',
        cursorDigestSha256: 'a'.repeat(64), limit: 100
      }, correlationId: 'scan-initial-backfill', signal: new AbortController().signal
    });

    expect(repository.freezePayoutWindow).toHaveBeenCalledWith(
      database,
      expect.objectContaining({ kind: 'initial_backfill' }),
      '2026-08-12T19:00:00.000Z'
    );
    expect(gateway.listPayouts).toHaveBeenCalledWith({
      limit: 100,
      createdGte: Math.floor((earliestPaidAt.getTime() - 7 * 86_400_000) / 1000),
      createdLt: Math.floor(new Date('2026-08-12T20:00:00.000Z').getTime() / 1000)
    });
  });

  it('rejects a malformed provider page before staging or committing it', async () => {
    repository.resume.mockResolvedValue(run({ phase: 'payout_discovery_page' }));
    const gateway = {
      listPayouts: vi.fn(async () => ({ data: [], hasMore: true, nextStartingAfter: null }))
    } as unknown as StripeCommerceGateway;
    await expect(processFinancialScanJob({ database: {} as Database, gateway, runtimeMode: 'stripe' }, {
      payload: {
        kind: 'continuation', scanRunId: runId, phase: 'payout_discovery_page',
        cursorDigestSha256: 'a'.repeat(64), limit: 100
      }, correlationId: 'scan-malformed-page', signal: new AbortController().signal
    })).rejects.toMatchObject({
      name: 'PermanentFinancialError', safeCode: 'unsupported_provider_evidence'
    });
    expect(payoutRepository.stage).not.toHaveBeenCalled();
    expect(repository.commit).not.toHaveBeenCalled();
  });

  it('emits payout-impact and classification children with recurrence dimensions intact', async () => {
    repository.start.mockResolvedValueOnce(run({
      rootKey: `financial:payout-impact:${payoutId}:3`, kind: 'payout_impact',
      phase: 'payout_impact_page'
    }));
    repository.impact.mockResolvedValue({
      data: [{ sourceKind: 'dispute', sourceId }], hasMore: false, checkpoint: null
    });
    const deps = { database: {} as Database, gateway: {} as StripeCommerceGateway, runtimeMode: 'stripe' as const };
    await processFinancialScanJob(deps, {
      payload: { kind: 'payout_impact', payoutId, payoutGeneration: 3 },
      correlationId: 'scan-impact', signal: new AbortController().signal
    });
    expect(repository.commit.mock.calls[0]?.[1].children[0].deduplicationKey)
      .toBe(`financial:source:payout-impact:${payoutId}:3:dispute:${sourceId}`);

    vi.clearAllMocks();
    repository.start.mockResolvedValue(run({
      rootKey: 'commerce.financial-classification:scan:2:4', kind: 'classification_replay',
      phase: 'classification_replay_page', classifierVersion: 2,
      allocationAlgorithmVersion: 4, replayId: 'c2-a4'
    }));
    repository.classifications.mockResolvedValue({
      data: [{ subjectType: 'balance_transaction', subjectId: sourceId,
        sourceFingerprintSha256: 'b'.repeat(64) }], hasMore: false, checkpoint: null
    });
    repository.commit.mockImplementation(async (_database, input) => run({
      state: 'completed', completedAt: new Date(), phase: input.nextPhase
    }));
    await processFinancialScanJob({ ...deps, runtimeMode: 'disabled' }, {
      payload: { kind: 'composite_replay', classifierVersion: 2,
        allocationAlgorithmVersion: 4, replayId: 'c2-a4' },
      correlationId: 'scan-classification', signal: new AbortController().signal
    });
    expect(repository.commit.mock.calls[0]?.[1].children[0].deduplicationKey)
      .toBe(`financial:classification:2:4:balance_transaction:${sourceId}:${'b'.repeat(64)}`);
  });

  it('continues a disabled-mode composite replay after its first bounded page', async () => {
    repository.resume.mockResolvedValue(run({
      rootKey: 'commerce.financial-classification:scan:2:4', kind: 'classification_replay',
      phase: 'classification_replay_page', classifierVersion: 2,
      allocationAlgorithmVersion: 4, replayId: 'c2-a4', checkpoint: sourceId,
      cursorDigestSha256: 'a'.repeat(64), pageCount: 1
    }));
    repository.classifications.mockResolvedValue({
      data: [{ subjectType: 'balance_transaction', subjectId: payoutId,
        sourceFingerprintSha256: 'b'.repeat(64) }], hasMore: false, checkpoint: null
    });

    await expect(processFinancialScanJob({
      database: {} as Database, gateway: {} as StripeCommerceGateway, runtimeMode: 'disabled'
    }, {
      payload: { kind: 'continuation', scanRunId: runId,
        phase: 'classification_replay_page', cursorDigestSha256: 'a'.repeat(64), limit: 100 },
      correlationId: 'scan-disabled-continuation', signal: new AbortController().signal
    })).resolves.toEqual({ status: 'completed', runId });

    expect(repository.resume).toHaveBeenCalledOnce();
    expect(repository.classifications).toHaveBeenCalledOnce();
    expect(repository.commit).toHaveBeenCalledOnce();
  });

  it('atomically activates and completes an empty composite replay', async () => {
    repository.start.mockResolvedValue(run({
      rootKey: 'commerce.financial-classification:scan:2:4', kind: 'classification_replay',
      phase: 'classification_replay_page', classifierVersion: 2,
      allocationAlgorithmVersion: 4, replayId: 'c2-a4'
    }));
    repository.classifications.mockResolvedValue({ data: [], hasMore: false, checkpoint: null });

    await expect(processFinancialScanJob({
      database: {} as Database, gateway: {} as StripeCommerceGateway, runtimeMode: 'disabled'
    }, {
      payload: { kind: 'composite_replay', classifierVersion: 2,
        allocationAlgorithmVersion: 4, replayId: 'c2-a4' },
      correlationId: 'scan-empty-replay', signal: new AbortController().signal
    })).resolves.toEqual({ status: 'completed', runId });

    expect(repository.completeEmptyReplay).toHaveBeenCalledWith(expect.anything(), {
      runId, expectedCheckpoint: null, expectedPageCount: 0,
      classifierVersion: 2, allocationAlgorithmVersion: 4,
      correlationId: 'scan-empty-replay'
    });
    expect(repository.commit).not.toHaveBeenCalled();
  });

  it('rechecks abort immediately before committing a loaded page', async () => {
    const controller = new AbortController();
    repository.start.mockResolvedValue(run());
    repository.sources.mockImplementation(async () => {
      controller.abort();
      return {
        data: [{ sourceKind: 'payment', sourceId }], hasMore: false, checkpoint: null
      };
    });

    await expect(processFinancialScanJob({
      database: {} as Database, gateway: {} as StripeCommerceGateway, runtimeMode: 'stripe'
    }, {
      payload: { kind: 'hourly', scanGenerationHour: '2026-08-12T19:00:00.000Z' },
      correlationId: 'scan-abort-before-commit', signal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(repository.commit).not.toHaveBeenCalled();
  });

  it('does no provider or source work for disabled non-composite roots', async () => {
    await expect(processFinancialScanJob({
      database: {} as Database,
      gateway: { listPayouts: vi.fn() } as unknown as StripeCommerceGateway,
      runtimeMode: 'disabled'
    }, {
      payload: { kind: 'initial', version: 1 }, correlationId: 'scan-disabled',
      signal: new AbortController().signal
    })).resolves.toEqual({ status: 'unchanged', runId: null });
    expect(repository.start).not.toHaveBeenCalled();
  });
});
