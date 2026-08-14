import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { enqueueActiveEntityJob } from '$lib/server/jobs/repository';
import { PermanentFinancialError } from './errors';
import {
  createFinancialPayoutEventJob,
  createFinancialSourceEventJob,
  createFinancialSourceGraphJob
} from './jobs';
import { rearmCurrentProjectionSubjectsForFinancialSources } from './ledger';

export interface FinancialSourceEventHandoff {
  readonly sourceKind: 'payment' | 'refund' | 'dispute';
  readonly sourceId: string;
  readonly providerEventId: string;
  readonly projectionGraphSourceIds: readonly string[];
}

export interface FinancialPayoutEventHandoff {
  readonly providerPayoutId: string;
  readonly providerEventId: string;
}

function invalid(): never {
  throw new PermanentFinancialError('invalid_job_payload');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length ||
    !actual.every((key) => typeof key === 'string' && keys.includes(key)) ||
    !keys.every((key) => Object.hasOwn(value, key))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => descriptors[key] !== undefined &&
    Object.hasOwn(descriptors[key]!, 'value'));
}

export async function queueFinancialSourceFromEvent(
  transaction: DatabaseTransaction,
  input: FinancialSourceEventHandoff
): Promise<void> {
  let definition: ReturnType<typeof createFinancialSourceEventJob>;
  try {
    if (!exact(input, [
      'sourceKind', 'sourceId', 'providerEventId', 'projectionGraphSourceIds'
    ]) || !Array.isArray(input.projectionGraphSourceIds) ||
      input.projectionGraphSourceIds.some((sourceId) =>
        typeof sourceId !== 'string' || !UUID.test(sourceId))) invalid();
    definition = createFinancialSourceEventJob({
      sourceKind: input.sourceKind as FinancialSourceEventHandoff['sourceKind'],
      sourceId: input.sourceId as string,
      providerEventId: input.providerEventId as string
    });
  } catch {
    return invalid();
  }
  await enqueueActiveEntityJob(transaction, {
    ...definition,
    activeEntity: {
      sourceKind: definition.payload.sourceKind,
      sourceId: definition.payload.sourceId
    }
  });
  const projectionSourceIds = [...new Set(input.projectionGraphSourceIds.map(
    (sourceId) => sourceId.toLowerCase()
  ))].sort();
  if (projectionSourceIds.length > 0) {
    for (const sourceId of projectionSourceIds) {
      if (sourceId === definition.payload.sourceId) continue;
      const graphDefinition = createFinancialSourceGraphJob({
        sourceKind: definition.payload.sourceKind,
        sourceId,
        providerEventId: definition.payload.trigger.providerEventId
      });
      await enqueueActiveEntityJob(transaction, {
        ...graphDefinition,
        activeEntity: {
          sourceKind: graphDefinition.payload.sourceKind,
          sourceId: graphDefinition.payload.sourceId
        }
      });
    }
    await rearmCurrentProjectionSubjectsForFinancialSources(transaction, {
      sourceKind: definition.payload.sourceKind,
      sourceIds: projectionSourceIds
    });
  }
}

export async function queueFinancialPayoutFromEvent(
  transaction: DatabaseTransaction,
  input: FinancialPayoutEventHandoff
): Promise<void> {
  let definition: ReturnType<typeof createFinancialPayoutEventJob>;
  try {
    if (!exact(input, ['providerPayoutId', 'providerEventId'])) invalid();
    definition = createFinancialPayoutEventJob({
      providerPayoutId: input.providerPayoutId as string,
      providerEventId: input.providerEventId as string
    });
  } catch {
    return invalid();
  }
  await enqueueActiveEntityJob(transaction, {
    ...definition,
    activeEntity: { providerPayoutId: definition.payload.providerPayoutId }
  });
}
