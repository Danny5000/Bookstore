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
function bag<T extends object>(): T { return Object.create(null) as T; }
function put(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true });
}
function publicState(value: unknown): SafePublicState {
  const record = exact(value, ['name', 'value']);
  if (!isSafeToken(record.name)) invalid();
  const state = record.value;
  if (typeof state === 'string') { if (state.length > 100) invalid(); }
  else if (typeof state === 'number') { if (!Number.isSafeInteger(state) || state < -2_147_483_648 || state > 2_147_483_647) invalid(); }
  else if (typeof state !== 'boolean') invalid();
  const result = bag<SafePublicState>();
  put(result, 'name', record.name); put(result, 'value', state);
  return result;
}
function validated<C extends string>(input: unknown): SafeDiagnosticError<C> {
  const record = ownObject(input); const keys = Reflect.ownKeys(record);
  if (!keys.every((key) => typeof key === 'string' && ['class', 'code', 'operation', 'outcome', 'correlationId', 'publicState'].includes(key)) || !['class', 'code', 'operation', 'outcome'].every((key) => keys.includes(key))) invalid();
  if (!classes.has(record.class as SafeErrorClass) || !operations.has(record.operation as SafeErrorOperation) || (record.outcome !== 'denied' && record.outcome !== 'failed') || typeof record.code !== 'string' || !codes.has(record.code)) invalid();
  if (Object.hasOwn(record, 'correlationId') && !isCorrelationId(record.correlationId)) invalid();
  const result = bag<{ class: SafeErrorClass; code: SafeCode<C>; operation: SafeErrorOperation; outcome: 'denied' | 'failed'; correlationId?: CorrelationId; publicState?: SafePublicState }>();
  put(result, 'class', record.class as SafeErrorClass); put(result, 'code', record.code as SafeCode<C>); put(result, 'operation', record.operation as SafeErrorOperation); put(result, 'outcome', record.outcome as 'denied' | 'failed');
  if (Object.hasOwn(record, 'correlationId')) put(result, 'correlationId', record.correlationId as CorrelationId);
  if (Object.hasOwn(record, 'publicState')) put(result, 'publicState', publicState(record.publicState));
  return result;
}

type ValidatedMatcherArray<C extends string> = { readonly length: number; readonly [index: number]: SafeErrorMatcher<C> };

function matcherArray<C extends string>(value: unknown): ValidatedMatcherArray<C> {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor | undefined>;
    const length = descriptors['length'];
    if (!length || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0) invalid();
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)) invalid();
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'function') invalid();
    }
    const result = bag<ValidatedMatcherArray<C>>();
    put(result, 'length', length.value);
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor)) invalid();
      put(result, String(index), descriptor.value as SafeErrorMatcher<C>);
    }
    return result;
  } catch { return invalid(); }
}
function reducerOptions<C extends string>(value: unknown): { readonly operation: SafeErrorOperation; readonly correlationId?: CorrelationId; readonly matchers?: ValidatedMatcherArray<C> } {
  const record = ownObject(value); const keys = Reflect.ownKeys(record);
  if (!keys.every((key) => typeof key === 'string' && ['operation', 'correlationId', 'matchers'].includes(key)) || !Object.hasOwn(record, 'operation') || !operations.has(record.operation as SafeErrorOperation)) invalid();
  if (Object.hasOwn(record, 'correlationId') && !isCorrelationId(record.correlationId)) invalid();
  const matchers = Object.hasOwn(record, 'matchers') ? matcherArray<C>(record.matchers) : undefined;
  const result = bag<{ operation: SafeErrorOperation; correlationId?: CorrelationId; matchers?: ValidatedMatcherArray<C> }>();
  put(result, 'operation', record.operation as SafeErrorOperation);
  if (Object.hasOwn(record, 'correlationId')) put(result, 'correlationId', record.correlationId as CorrelationId);
  if (matchers !== undefined) put(result, 'matchers', matchers);
  return result;
}

export function defineSafeCode<const C extends string>(value: C): SafeCode<C> {
  if (!isSafeToken(value)) invalid();
  codes.add(value);
  return value as SafeCode<C>;
}

export function createSafeDiagnosticError<const C extends string>(input: SafeDiagnosticError<C>): SafeDiagnosticError<C> { return validated<C>(input); }

export function reduceSafeError<const C extends string = never>(cause: unknown, options: { readonly operation: SafeErrorOperation; readonly correlationId?: CorrelationId; readonly matchers?: readonly SafeErrorMatcher<C>[] }): SafeDiagnosticError<C | 'unexpected_failure'> {
  const safeOptions = reducerOptions<C>(options);
  if (safeOptions.matchers !== undefined) {
    for (let index = 0; index < safeOptions.matchers.length; index += 1) {
      try {
        const match = safeOptions.matchers[index]!(cause);
        if (match !== undefined) return validated<C>(match);
      } catch { /* an untrusted matcher cannot escape the boundary */ }
    }
  }
  const result = bag<{ class: 'unexpected'; code: SafeCode<'unexpected_failure'>; operation: SafeErrorOperation; outcome: 'failed'; correlationId?: CorrelationId }>();
  put(result, 'class', 'unexpected'); put(result, 'code', defineSafeCode('unexpected_failure')); put(result, 'operation', safeOptions.operation); put(result, 'outcome', 'failed');
  if (Object.hasOwn(safeOptions, 'correlationId')) put(result, 'correlationId', safeOptions.correlationId);
  return result;
}
