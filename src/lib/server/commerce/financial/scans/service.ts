import type { StripeCommerceRuntime } from '$lib/server/commerce/stripe/runtime-core';
import type { StripeCommerceGateway } from '$lib/server/commerce/stripe/types';
import { parsePayoutSnapshot, parseStripeListPage } from '$lib/server/commerce/stripe/financial-schemas';
import { PermanentCommerceError, RetryableProviderError } from '$lib/server/commerce/errors';
import type { Database } from '$lib/server/db/client';
import { sql } from 'drizzle-orm';
import {
  createFinancialClassificationSubjectJob,
  createFinancialPayoutScanJob,
  createFinancialSourcePayoutImpactJob,
  createFinancialSourceScanJob,
  parseFinancialCompositeReplayScanJobPayload,
  parseFinancialHourlyScanJobPayload,
  parseFinancialInitialScanJobPayload,
  parseFinancialPayoutImpactScanJobPayload,
  parseFinancialScanContinuationJobPayload,
  type FinancialJobSpec,
  type FinancialScanJobPayload
} from '../jobs';
import { PermanentFinancialError, RetryableFinancialError } from '../errors';
import { stagePayoutSnapshot } from '../payouts/repository';
import {
  commitFinancialScanPage,
  loadClassificationReplayPage,
  loadFinancialSourceScanPage,
  loadIncompletePayoutRunPage,
  loadPayoutImpactSourcePage,
  resumeFinancialScanContinuation,
  startOrResumeFinancialScan,
  type CommitFinancialScanPageInput
} from './repository';
import type { FinancialScanRunRow } from '$lib/server/db/schema';

export interface FinancialScanServiceDependencies {
  readonly database: Database;
  readonly gateway: StripeCommerceGateway;
  readonly runtimeMode: StripeCommerceRuntime['mode'];
}

export async function processFinancialScanJob(
  dependencies: FinancialScanServiceDependencies,
  untrustedInput: {
    readonly payload: FinancialScanJobPayload;
    readonly correlationId: string;
    readonly signal: AbortSignal;
  }
): Promise<{ status: 'continued' | 'completed' | 'unchanged'; runId: string | null }> {
  const input = parseInput(untrustedInput);
  if (!['disabled', 'fixture', 'stripe'].includes(dependencies.runtimeMode)) invalid();
  abortIfNeeded(input.signal);
  if (dependencies.runtimeMode === 'disabled' &&
    input.payload.kind !== 'composite_replay' && input.payload.kind !== 'continuation') {
    return { status: 'unchanged', runId: null };
  }

  const run = input.payload.kind === 'continuation'
    ? await resumeFinancialScanContinuation(dependencies.database, input.payload)
    : await startOrResumeFinancialScan(dependencies.database, input.payload);
  abortIfNeeded(input.signal);
  if (run === null) return { status: 'unchanged', runId: null };
  if (dependencies.runtimeMode === 'disabled' && run.kind !== 'classification_replay') {
    return { status: 'unchanged', runId: run.id };
  }
  if (run.state === 'completed') return { status: 'completed', runId: run.id };
  if (run.state !== 'running') throw new PermanentFinancialError('source_linkage_mismatch');
  const limit = input.payload.kind === 'continuation' ? input.payload.limit : 100;

  if (run.phase === 'source_page') {
    const page = await loadFinancialSourceScanPage(dependencies.database, run, limit);
    const hour = scanHour(run);
    return finishPage(dependencies.database, input.signal, run, page, page.data.map((source) =>
      createFinancialSourceScanJob({ ...source, scanRunId: run.id, scanGenerationHour: hour })
    ), page.hasMore ? 'source_page' : 'payout_discovery_page',
    page.hasMore ? page.checkpoint : null, false);
  }

  if (run.phase === 'payout_discovery_page') {
    if (dependencies.runtimeMode === 'disabled') return { status: 'unchanged', runId: run.id };
    const hour = scanHour(run);
    const range = await payoutDiscoveryRange(dependencies.database, run, hour);
    const request = {
      limit,
      ...(run.checkpoint === null ? {} : { startingAfter: run.checkpoint }),
      ...range
    };
    const page = await providerCall(input.signal, async () => parseStripeListPage(
      await dependencies.gateway.listPayouts(request),
      (item) => {
        const liveMode = (item as { livemode?: unknown })?.livemode;
        if (typeof liveMode !== 'boolean') throw new PermanentCommerceError();
        return parsePayoutSnapshot(item, liveMode);
      }
    ));
    const children: FinancialJobSpec<string, unknown>[] = [];
    for (const payout of page.data) {
      await stagePayoutSnapshot(dependencies.database, payout, {
        correlationId: input.correlationId
      });
      abortIfNeeded(input.signal);
      children.push(createFinancialPayoutScanJob({
        providerPayoutId: payout.id,
        scanRunId: run.id,
        scanGenerationHour: hour
      }));
    }
    return finishPage(dependencies.database, input.signal, run, {
      data: page.data,
      hasMore: page.hasMore,
      checkpoint: page.nextStartingAfter
    }, children, page.hasMore ? 'payout_discovery_page' : 'incomplete_payout_run_page',
    page.hasMore ? page.nextStartingAfter : null, false);
  }

  if (run.phase === 'incomplete_payout_run_page') {
    const page = await loadIncompletePayoutRunPage(dependencies.database, run, limit);
    const hour = scanHour(run);
    return finishPage(dependencies.database, input.signal, run, page, page.data.map((payout) =>
      createFinancialPayoutScanJob({ ...payout, scanRunId: run.id, scanGenerationHour: hour })
    ), 'incomplete_payout_run_page', page.checkpoint, !page.hasMore);
  }

  if (run.phase === 'payout_impact_page') {
    const identity = payoutImpactIdentity(run);
    const page = await loadPayoutImpactSourcePage(dependencies.database, run, limit);
    return finishPage(dependencies.database, input.signal, run, page, page.data.map((source) =>
      createFinancialSourcePayoutImpactJob({ ...source, ...identity })
    ), 'payout_impact_page', page.checkpoint, !page.hasMore);
  }

  if (run.phase === 'classification_replay_page') {
    if (!positiveInt(run.classifierVersion) || !positiveInt(run.allocationAlgorithmVersion)) {
      throw new PermanentFinancialError('source_linkage_mismatch');
    }
    const page = await loadClassificationReplayPage(dependencies.database, run, limit);
    return finishPage(dependencies.database, input.signal, run, page, page.data.map((subject) =>
      createFinancialClassificationSubjectJob({
        ...subject,
        classifierVersion: run.classifierVersion!,
        allocationAlgorithmVersion: run.allocationAlgorithmVersion!
      })
    ), 'classification_replay_page', page.checkpoint, !page.hasMore);
  }
  throw new PermanentFinancialError('source_linkage_mismatch');
}

const SAFE_CORRELATION = /^[A-Za-z0-9:_-]{1,100}$/u;
const HOURLY_KEY = /^commerce\.financial-scan:(\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z)$/u;
const IMPACT_KEY = /^financial:payout-impact:([0-9a-f-]{36}):([1-9]\d*)$/u;

function invalid(): never {
  throw new PermanentFinancialError('invalid_job_payload');
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Financial scan was aborted.', 'AbortError');
}

function parsePayload(value: unknown): FinancialScanJobPayload {
  const kind = (value as { kind?: unknown })?.kind;
  if (kind === 'initial') return parseFinancialInitialScanJobPayload(value);
  if (kind === 'hourly') return parseFinancialHourlyScanJobPayload(value);
  if (kind === 'payout_impact') return parseFinancialPayoutImpactScanJobPayload(value);
  if (kind === 'composite_replay') return parseFinancialCompositeReplayScanJobPayload(value);
  if (kind === 'continuation') return parseFinancialScanContinuationJobPayload(value);
  return invalid();
}

function parseInput(value: unknown): {
  payload: FinancialScanJobPayload;
  correlationId: string;
  signal: AbortSignal;
} {
  if (!value || typeof value !== 'object' || Reflect.ownKeys(value).length !== 3 ||
    !Object.hasOwn(value, 'payload') || !Object.hasOwn(value, 'correlationId') ||
    !Object.hasOwn(value, 'signal')) invalid();
  const input = value as Record<string, unknown>;
  if (typeof input.correlationId !== 'string' || !SAFE_CORRELATION.test(input.correlationId) ||
    !(input.signal instanceof AbortSignal)) invalid();
  return {
    payload: parsePayload(input.payload),
    correlationId: input.correlationId,
    signal: input.signal
  };
}

async function providerCall<Value>(signal: AbortSignal, work: () => Promise<Value>): Promise<Value> {
  abortIfNeeded(signal);
  try {
    const result = await work();
    abortIfNeeded(signal);
    return result;
  } catch (error) {
    abortIfNeeded(signal);
    if (error instanceof RetryableProviderError) {
      throw new RetryableFinancialError('provider_unavailable');
    }
    if (error instanceof PermanentCommerceError) {
      throw new PermanentFinancialError('unsupported_provider_evidence');
    }
    if (error instanceof PermanentFinancialError || error instanceof RetryableFinancialError) {
      throw error;
    }
    throw new RetryableFinancialError('provider_unavailable');
  }
}

function scanHour(run: FinancialScanRunRow): string {
  const match = HOURLY_KEY.exec(run.rootKey);
  if (match) return match[1]!;
  const hour = new Date(run.startedAt);
  if (!Number.isFinite(hour.getTime())) throw new PermanentFinancialError('source_linkage_mismatch');
  hour.setUTCMinutes(0, 0, 0);
  return hour.toISOString();
}

function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647;
}

function payoutImpactIdentity(run: FinancialScanRunRow): {
  payoutId: string;
  payoutGeneration: number;
} {
  const match = IMPACT_KEY.exec(run.rootKey);
  const payoutGeneration = match ? Number(match[2]) : Number.NaN;
  if (!match || !positiveInt(payoutGeneration)) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
  return { payoutId: match[1]!, payoutGeneration };
}

async function payoutDiscoveryRange(
  database: Database,
  run: FinancialScanRunRow,
  hour: string
): Promise<{ createdGte: number; createdLt: number }> {
  const hourStart = new Date(hour);
  const createdLt = Math.floor((hourStart.getTime() + 3_600_000) / 1000);
  if (run.kind !== 'initial') {
    return { createdGte: Math.floor((hourStart.getTime() - 72 * 3_600_000) / 1000), createdLt };
  }
  const result = await database.execute<{ createdGte: number | string | null }>(sql`
    select extract(epoch from (min(paid_at) - interval '7 days'))::bigint as "createdGte"
    from orders where status = 'paid' and paid_at is not null
  `);
  const raw = result.rows[0]?.createdGte;
  const createdGte = raw === null || raw === undefined
    ? Math.floor((hourStart.getTime() - 7 * 86_400_000) / 1000)
    : Number(raw);
  if (!Number.isSafeInteger(createdGte) || createdGte >= createdLt) {
    throw new PermanentFinancialError('source_linkage_mismatch');
  }
  return { createdGte, createdLt };
}

async function finishPage(
  database: Database,
  signal: AbortSignal,
  run: FinancialScanRunRow,
  page: { readonly data: readonly unknown[]; readonly hasMore: boolean; readonly checkpoint: string | null },
  children: readonly FinancialJobSpec<string, unknown>[],
  nextPhase: CommitFinancialScanPageInput['nextPhase'],
  nextCheckpoint: string | null,
  complete: boolean
): Promise<{ status: 'continued' | 'completed'; runId: string }> {
  if (!isScanPhase(run.phase)) throw new PermanentFinancialError('source_linkage_mismatch');
  const input: CommitFinancialScanPageInput = {
    runId: run.id,
    expectedPhase: run.phase,
    expectedCheckpoint: run.checkpoint,
    expectedPageCount: run.pageCount,
    nextPhase,
    nextCheckpoint,
    processedCount: page.data.length,
    children,
    complete
  };
  abortIfNeeded(signal);
  const committed = await commitFinancialScanPage(database, input);
  return {
    status: committed.state === 'completed' ? 'completed' : 'continued',
    runId: committed.id
  };
}

function isScanPhase(value: string): value is CommitFinancialScanPageInput['nextPhase'] {
  return [
    'source_page', 'payout_discovery_page', 'incomplete_payout_run_page',
    'payout_impact_page', 'classification_replay_page'
  ].includes(value);
}
