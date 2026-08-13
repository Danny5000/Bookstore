import type { StripeCommerceRuntime } from '$lib/server/commerce/stripe/runtime-core';
import type { Database } from '$lib/server/db/client';
import type { WorkerPollHook } from '$lib/server/jobs/runner';
import { enqueueJob } from '$lib/server/jobs/repository';
import { PermanentFinancialError } from '../errors';
import {
  createFinancialCompositeReplayScanJob,
  createFinancialHourlyScanJob,
  createFinancialInitialScanJob,
  type FinancialScanJobSpec
} from '../jobs';

export interface FinancialScheduleDependencies {
  readonly database: Database;
  readonly runtimeMode: StripeCommerceRuntime['mode'];
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
}

export async function ensureHourlyFinancialScan(
  database: Database,
  input: {
    readonly now: Date;
    readonly classifierVersion: number;
    readonly allocationAlgorithmVersion: number;
  }
): Promise<{ enqueued: readonly string[] }> {
  assertScheduleInput(input);
  return ensureSpecs(database, [
    createFinancialInitialScanJob(),
    createFinancialHourlyScanJob({ scanGenerationHour: utcHour(input.now) }),
    createFinancialCompositeReplayScanJob({
      classifierVersion: input.classifierVersion,
      allocationAlgorithmVersion: input.allocationAlgorithmVersion
    })
  ]);
}

export function createFinancialScheduleEnsurer(
  dependencies: FinancialScheduleDependencies
): WorkerPollHook {
  if (!dependencies || typeof dependencies !== 'object' ||
    !['disabled', 'fixture', 'stripe'].includes(dependencies.runtimeMode) ||
    !version(dependencies.classifierVersion) || !version(dependencies.allocationAlgorithmVersion)) {
    throw new PermanentFinancialError('invalid_job_payload');
  }
  let lastProviderHour: string | null = null;
  let lastReplayId: string | null = null;
  return async ({ now, signal }) => {
    if (!(signal instanceof AbortSignal) || !(now instanceof Date) ||
      !Number.isFinite(now.getTime())) invalid();
    if (signal.aborted) abort();
    const hour = utcHour(now);
    const replayId = `c${dependencies.classifierVersion}-a${dependencies.allocationAlgorithmVersion}`;
    const specs: FinancialScanJobSpec[] = [];
    if (dependencies.runtimeMode !== 'disabled' && lastProviderHour !== hour) {
      specs.push(createFinancialInitialScanJob(), createFinancialHourlyScanJob({
        scanGenerationHour: hour
      }));
    }
    if (lastReplayId !== replayId) {
      specs.push(createFinancialCompositeReplayScanJob({
        classifierVersion: dependencies.classifierVersion,
        allocationAlgorithmVersion: dependencies.allocationAlgorithmVersion
      }));
    }
    if (specs.length !== 0) await ensureSpecs(dependencies.database, specs);
    if (signal.aborted) abort();
    if (dependencies.runtimeMode !== 'disabled') lastProviderHour = hour;
    lastReplayId = replayId;
  };
}

const MAX_INT32 = 2_147_483_647;

function invalid(): never {
  throw new PermanentFinancialError('invalid_job_payload');
}

function abort(): never {
  throw new DOMException('Financial scheduling was aborted.', 'AbortError');
}

function version(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_INT32;
}

function assertScheduleInput(input: unknown): asserts input is {
  readonly now: Date;
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
} {
  if (!input || typeof input !== 'object' || Reflect.ownKeys(input).length !== 3 ||
    !Object.hasOwn(input, 'now') || !Object.hasOwn(input, 'classifierVersion') ||
    !Object.hasOwn(input, 'allocationAlgorithmVersion')) invalid();
  const value = input as Record<string, unknown>;
  if (!(value.now instanceof Date) || !Number.isFinite(value.now.getTime()) ||
    !version(value.classifierVersion) || !version(value.allocationAlgorithmVersion)) invalid();
}

function utcHour(now: Date): string {
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  return hour.toISOString();
}

async function ensureSpecs(
  database: Database,
  specs: readonly FinancialScanJobSpec[]
): Promise<{ enqueued: readonly string[] }> {
  const enqueued = await database.transaction(async (transaction) => {
    const keys: string[] = [];
    for (const spec of specs) {
      await enqueueJob(transaction, {
        type: spec.type,
        payload: spec.payload,
        deduplicationKey: spec.deduplicationKey,
        maxAttempts: spec.maxAttempts
      });
      keys.push(spec.deduplicationKey);
    }
    return keys;
  });
  return { enqueued };
}
