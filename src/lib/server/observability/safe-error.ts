import { isCorrelationId, isSafeToken, type CorrelationId, type SafeCode } from './contracts';

export type SafeErrorClass = 'configuration' | 'dependency' | 'request' | 'job' | 'heartbeat' | 'shutdown' | 'unexpected';
export type SafeErrorOperation = 'http.request' | 'worker.startup' | 'worker.runtime' | 'worker.heartbeat' | 'worker.shutdown' | 'job.claim' | 'job.poll' | 'job.handler' | 'job.completion' | 'job.failure_transition' | 'job.lease_renewal';
export interface SafePublicState { readonly name: string; readonly value: string | number | boolean; }
export interface SafeDiagnosticError<C extends string = string> { readonly class: SafeErrorClass; readonly code: SafeCode<C>; readonly operation: SafeErrorOperation; readonly outcome: 'denied' | 'failed'; readonly correlationId?: CorrelationId; readonly publicState?: SafePublicState; }
export type SafeErrorMatcher<C extends string = string> = (cause: unknown) => SafeDiagnosticError<C> | undefined;

const codes = new Set<string>();
const classes = new Set<SafeErrorClass>(['configuration', 'dependency', 'request', 'job', 'heartbeat', 'shutdown', 'unexpected']);
const operations = new Set<SafeErrorOperation>(['http.request', 'worker.startup', 'worker.runtime', 'worker.heartbeat', 'worker.shutdown', 'job.claim', 'job.poll', 'job.handler', 'job.completion', 'job.failure_transition', 'job.lease_renewal']);

function invalid(): never { throw new TypeError('invalid safe diagnostic error'); }
function ownObject(value: unknown): Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') invalid();
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    }
    return value as Record<string, unknown>;
  } catch { return invalid(); }
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = ownObject(value); const actual = Reflect.ownKeys(record);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid();
  return record;
}
function publicState(value: unknown): SafePublicState {
  const record = exact(value, ['name', 'value']);
  if (!isSafeToken(record.name)) invalid();
  const state = record.value;
  if (typeof state === 'string') { if (state.length > 100) invalid(); }
  else if (typeof state === 'number') { if (!Number.isSafeInteger(state) || state < -2_147_483_648 || state > 2_147_483_647) invalid(); }
  else if (typeof state !== 'boolean') invalid();
  return { name: record.name, value: state };
}
function validated<C extends string>(input: unknown): SafeDiagnosticError<C> {
  const record = ownObject(input); const keys = Reflect.ownKeys(record);
  if (!keys.every((key) => typeof key === 'string' && ['class', 'code', 'operation', 'outcome', 'correlationId', 'publicState'].includes(key)) || !['class', 'code', 'operation', 'outcome'].every((key) => keys.includes(key))) invalid();
  if (!classes.has(record.class as SafeErrorClass) || !operations.has(record.operation as SafeErrorOperation) || (record.outcome !== 'denied' && record.outcome !== 'failed') || typeof record.code !== 'string' || !codes.has(record.code)) invalid();
  if ('correlationId' in record && !isCorrelationId(record.correlationId)) invalid();
  const result: { class: SafeErrorClass; code: SafeCode<C>; operation: SafeErrorOperation; outcome: 'denied' | 'failed'; correlationId?: CorrelationId; publicState?: SafePublicState } = { class: record.class as SafeErrorClass, code: record.code as SafeCode<C>, operation: record.operation as SafeErrorOperation, outcome: record.outcome as 'denied' | 'failed' };
  if ('correlationId' in record) result.correlationId = record.correlationId as CorrelationId;
  if ('publicState' in record) result.publicState = publicState(record.publicState);
  return result;
}

export function defineSafeCode<const C extends string>(value: C): SafeCode<C> {
  if (!isSafeToken(value)) invalid();
  codes.add(value);
  return value as SafeCode<C>;
}

export function createSafeDiagnosticError<const C extends string>(input: SafeDiagnosticError<C>): SafeDiagnosticError<C> { return validated<C>(input); }

export function reduceSafeError<const C extends string = never>(cause: unknown, options: { readonly operation: SafeErrorOperation; readonly correlationId?: CorrelationId; readonly matchers?: readonly SafeErrorMatcher<C>[] }): SafeDiagnosticError<C | 'unexpected_failure'> {
  if (!operations.has(options.operation) || ('correlationId' in options && !isCorrelationId(options.correlationId))) invalid();
  for (const matcher of options.matchers ?? []) {
    try {
      const match = matcher(cause);
      if (match !== undefined) return validated<C>(match);
    } catch { /* an untrusted matcher cannot escape the boundary */ }
  }
  const result: { class: 'unexpected'; code: SafeCode<'unexpected_failure'>; operation: SafeErrorOperation; outcome: 'failed'; correlationId?: CorrelationId } = { class: 'unexpected', code: defineSafeCode('unexpected_failure'), operation: options.operation, outcome: 'failed' };
  if (options.correlationId !== undefined) result.correlationId = options.correlationId;
  return result;
}
