import { describe, expect, test } from 'vitest';

import { type CorrelationId } from './contracts';
import {
  createSafeDiagnosticError,
  defineSafeCode,
  reduceSafeError,
  type SafeErrorMatcher
} from './safe-error';

const correlationId = 'request-1' as CorrelationId;
const valid = () => createSafeDiagnosticError({
  class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', correlationId,
  publicState: { name: 'http_status', value: 400 }
});

describe('safe diagnostic errors', () => {
  test('creates only exact trusted safe descriptors', () => {
    expect(valid()).toEqual({ class: 'request', code: 'invalid_request', operation: 'http.request', outcome: 'denied', correlationId, publicState: { name: 'http_status', value: 400 } });
  });

  test.each([
    { class: 'nope', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied' },
    { class: 'request', code: 'Bad' as never, operation: 'http.request', outcome: 'denied' },
    { class: 'request', code: defineSafeCode('invalid_request'), operation: 'nope', outcome: 'denied' },
    { class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'started' },
    { class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', correlationId: undefined },
    { class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', publicState: undefined },
    { class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', publicState: { name: 'Bad', value: 'safe' } },
    { class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', publicState: { name: 'safe', value: 'x'.repeat(101) } },
    { class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', publicState: { name: 'safe', value: 1.1 } },
    { class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', publicState: { name: 'safe', value: null } },
    { class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', payload: 'customer@example.test' }
  ])('rejects unsafe trusted constructor input %#', (input) => {
    expect(() => createSafeDiagnosticError(input as never)).toThrow();
  });

  test('maps registered instances through an exact matcher', () => {
    class KnownError extends Error {}
    const matcher: SafeErrorMatcher<'known_failure'> = (cause) => cause instanceof KnownError
      ? createSafeDiagnosticError({ class: 'dependency', code: defineSafeCode('known_failure'), operation: 'job.handler', outcome: 'failed' })
      : undefined;
    expect(reduceSafeError(new KnownError(), { operation: 'job.handler', correlationId, matchers: [matcher] })).toEqual({ class: 'dependency', code: 'known_failure', operation: 'job.handler', outcome: 'failed' });
  });

  test.each([
    new Error('secret'), 'customer@example.test', { code: 'forged', safeCode: 'forged' },
    Object.defineProperties({}, { code: { enumerable: true, get: () => { throw new Error('getter'); } }, safeCode: { enumerable: true, get: () => { throw new Error('getter'); } } }),
    new Proxy({}, { get: () => { throw new Error('proxy'); }, ownKeys: () => { throw new Error('proxy'); } })
  ])('never reads arbitrary error data and reduces unknown input %#', (cause) => {
    expect(reduceSafeError(cause, { operation: 'worker.runtime', correlationId })).toEqual({ class: 'unexpected', code: 'unexpected_failure', operation: 'worker.runtime', outcome: 'failed', correlationId });
  });

  test('catches matcher failures and rejects forged matcher descriptors', () => {
    const throwing: SafeErrorMatcher<'known_failure'> = () => { throw new Error('secret'); };
    const forged: SafeErrorMatcher<'known_failure'> = () => ({ class: 'request', code: 'forged' as never, operation: 'http.request', outcome: 'denied' });
    expect(reduceSafeError(new Error(), { operation: 'http.request', matchers: [throwing] })).toEqual({ class: 'unexpected', code: 'unexpected_failure', operation: 'http.request', outcome: 'failed' });
    expect(reduceSafeError(new Error(), { operation: 'http.request', matchers: [forged] })).toEqual({ class: 'unexpected', code: 'unexpected_failure', operation: 'http.request', outcome: 'failed' });
  });

  test('does not recurse into nested causes or leak matcher correlation', () => {
    const nested = { cause: new Error('secret') };
    const matcher: SafeErrorMatcher<'known_failure'> = () => createSafeDiagnosticError({ class: 'job', code: defineSafeCode('known_failure'), operation: 'job.handler', outcome: 'failed', correlationId: 'different' as CorrelationId });
    expect(reduceSafeError(nested, { operation: 'job.handler', correlationId, matchers: [matcher] })).toEqual({ class: 'job', code: 'known_failure', operation: 'job.handler', outcome: 'failed', correlationId: 'different' });
  });
});
