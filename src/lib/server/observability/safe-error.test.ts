import { describe, expect, expectTypeOf, test } from 'vitest';

import { type CorrelationId, type SafeCode } from './contracts';
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

  test('rejects symbol-keyed trusted, matcher, and nested publicState extras', () => {
    const symbol = Symbol('secret');
    expect(() => createSafeDiagnosticError({ class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', [symbol]: 'customer@example.test' } as never)).toThrow();
    const matcher: SafeErrorMatcher<'known_failure'> = () => ({ class: 'request', code: defineSafeCode('known_failure'), operation: 'http.request', outcome: 'denied', [symbol]: 'customer@example.test' } as never);
    expect(reduceSafeError(new Error(), { operation: 'http.request', matchers: [matcher] }).code).toBe('unexpected_failure');
    expect(() => createSafeDiagnosticError({ class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', publicState: { name: 'safe', value: true, [symbol]: 'customer@example.test' } } as never)).toThrow();
  });

  test.each([
    ['safe', ''], ['a'.repeat(100), 'x'.repeat(100)], ['safe', false], ['safe', -2_147_483_648], ['safe', 2_147_483_647]
  ])('accepts safe public state bounds %#', (name, value) => {
    expect(() => createSafeDiagnosticError({ class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', publicState: { name, value } as never })).not.toThrow();
  });

  test.each([
    ['safe', 'x'.repeat(101)], ['safe', -2_147_483_649], ['safe', 2_147_483_648], ['safe', 1.1], ['safe', Number.NaN], ['safe', Infinity], ['safe', Number.MAX_SAFE_INTEGER + 1]
  ])('rejects unsafe public state bounds %#', (name, value) => {
    expect(() => createSafeDiagnosticError({ class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', publicState: { name, value } as never })).toThrow();
  });

  test('accepts optional safe fields when omitted and rejects present undefined', () => {
    expect(() => createSafeDiagnosticError({ class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied' })).not.toThrow();
    expect(() => createSafeDiagnosticError({ class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', correlationId: undefined } as never)).toThrow();
    expect(() => createSafeDiagnosticError({ class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied', publicState: undefined } as never)).toThrow();
  });

  test('preserves matcher code literals plus unexpected_failure in the reducer result', () => {
    const matcher: SafeErrorMatcher<'first' | 'second'> = () => undefined;
    const reduced = reduceSafeError(new Error(), { operation: 'http.request', matchers: [matcher] });
    expectTypeOf(reduced.code).toEqualTypeOf<SafeCode<'first' | 'second' | 'unexpected_failure'>>();
  });

  test.each(['Uppercase', '1starts_wrong', 'a'.repeat(101)])('defineSafeCode rejects invalid grammar %s', (value) => {
    expect(() => defineSafeCode(value)).toThrow();
  });

  test('does not copy inherited trusted diagnostic optionals', () => {
    const inherited = [
      ['correlationId', correlationId],
      ['publicState', { name: 'http_status', value: 400 }]
    ] as const;
    const previous = inherited.map(([key]) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const);
    for (const [key, value] of inherited) Object.defineProperty(Object.prototype, key, { configurable: true, writable: true, value });
    try {
      const result = createSafeDiagnosticError({ class: 'request', code: defineSafeCode('invalid_request'), operation: 'http.request', outcome: 'denied' });
      expect(result).not.toHaveProperty('correlationId');
      expect(result).not.toHaveProperty('publicState');
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
        else delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  });

  test('ignores inherited reducer options', () => {
    const previous = [
      ['correlationId', Object.getOwnPropertyDescriptor(Object.prototype, 'correlationId')],
      ['publicState', Object.getOwnPropertyDescriptor(Object.prototype, 'publicState')],
      ['matchers', Object.getOwnPropertyDescriptor(Object.prototype, 'matchers')]
    ] as const;
    let invoked = false;
    Object.defineProperties(Object.prototype, {
      correlationId: { configurable: true, writable: true, value: correlationId },
      publicState: { configurable: true, writable: true, value: { name: 'safe', value: true } },
      matchers: { configurable: true, writable: true, value: [() => { invoked = true; return valid(); }] }
    });
    try {
      expect(reduceSafeError(new Error(), { operation: 'http.request' })).toEqual({ class: 'unexpected', code: 'unexpected_failure', operation: 'http.request', outcome: 'failed' });
      expect(invoked).toBe(false);
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
        else delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  });

  test.each([
    { operation: 'http.request', matchers: undefined },
    { operation: 'http.request', correlationId: undefined },
    { operation: 'http.request', publicState: { name: 'safe', value: true } },
    { operation: 'http.request', [Symbol('secret')]: true }
  ])('rejects non-exact reducer options %#', (options) => {
    expect(() => reduceSafeError(new Error(), options as never)).toThrow();
  });

  test('iterates only copied validated matcher functions', () => {
    const matcher: SafeErrorMatcher<'known_failure'> = () => createSafeDiagnosticError({ class: 'request', code: defineSafeCode('known_failure'), operation: 'http.request', outcome: 'failed' });
    const matchers = new Proxy([matcher], {
      get(target, key, receiver) {
        if (key === Symbol.iterator) throw new Error('unsafe iterator');
        return Reflect.get(target, key, receiver);
      }
    });
    expect(reduceSafeError(new Error(), { operation: 'http.request', matchers: matchers as never })).toEqual({ class: 'request', code: 'known_failure', operation: 'http.request', outcome: 'failed' });
  });
});
