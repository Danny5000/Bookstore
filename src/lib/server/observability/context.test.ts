import { describe, expect, test, vi } from 'vitest';

import {
  correlationIdForRequest,
  getDiagnosticContext,
  normalizeOrCreateCorrelationId,
  runWithDiagnosticContext,
  type DiagnosticContext,
  type JobDiagnosticContext,
  type WebDiagnosticContext
} from './context';

const generatedUuid = '01234567-89ab-cdef-0123-456789abcdef';

function requestWithCorrelation(value?: string): Request {
  return new Request('https://bookstore.test/catalog', value === undefined ? undefined : {
    headers: { 'x-request-id': value }
  });
}

function web(correlationId = 'web-request'): WebDiagnosticContext {
  return { kind: 'web', correlationId } as WebDiagnosticContext;
}

function job(overrides: Partial<JobDiagnosticContext> = {}): JobDiagnosticContext {
  return {
    kind: 'job',
    correlationId: 'job-request',
    jobId: generatedUuid,
    jobKind: 'catalog.process',
    attempt: 1,
    workerId: 'worker:1',
    slotId: 0,
    ...overrides
  } as JobDiagnosticContext;
}

describe('diagnostic context', () => {
  test.each([
    'a',
    `a${'x'.repeat(99)}`,
    'request.with_every-punctuation:allowed',
    'MiXeD.Case:Preserved_1'
  ])('preserves valid incoming correlation byte-for-byte: %s', (value) => {
    const uuidSource = vi.fn(() => generatedUuid);

    expect(normalizeOrCreateCorrelationId(value, uuidSource)).toBe(value);
    expect(uuidSource).not.toHaveBeenCalled();
  });

  test.each([
    undefined,
    null,
    '',
    'a'.repeat(101),
    '.leading',
    '_leading',
    ':leading',
    '-leading',
    ' leading',
    'trailing ',
    'two words',
    'café',
    new String('request-1')
  ])('replaces absent or invalid correlation %# without trimming', (value) => {
    const uuidSource = vi.fn(() => generatedUuid);

    expect(normalizeOrCreateCorrelationId(value, uuidSource)).toBe(generatedUuid);
    expect(uuidSource).toHaveBeenCalledOnce();
  });

  test('uses a canonical lowercase UUID when no generator is injected', () => {
    expect(normalizeOrCreateCorrelationId(undefined)).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
    );
  });

  test.each([
    '01234567-89AB-CDEF-0123-456789ABCDEF',
    'not-a-uuid',
    '0123456789ab-cdef-0123-456789abcdef'
  ])('rejects a noncanonical injected UUID: %s', (value) => {
    expect(() => normalizeOrCreateCorrelationId(undefined, () => value)).toThrow(TypeError);
  });

  test('relies on Headers to reject newline-bearing request identifiers', () => {
    expect(() => new Headers({ 'x-request-id': 'request\r\ninjected' })).toThrow(TypeError);
  });

  test('reconstructs and freezes an exact web context for synchronous callbacks', () => {
    const input = { kind: 'web', correlationId: 'request-1', ignored: 'secret' } as unknown as DiagnosticContext;
    const result = runWithDiagnosticContext(input, () => {
      const active = getDiagnosticContext();
      expect(active).toEqual({ kind: 'web', correlationId: 'request-1' });
      expect(active).not.toBe(input);
      expect(Object.isFrozen(active)).toBe(true);
      return 'result';
    });

    expect(result).toBe('result');
    expect(getDiagnosticContext()).toBeUndefined();
  });

  test('propagates through async work and clears after the promise settles', async () => {
    expect(getDiagnosticContext()).toBeUndefined();

    await runWithDiagnosticContext(web('async-request'), async () => {
      await Promise.resolve();
      expect(getDiagnosticContext()).toEqual({ kind: 'web', correlationId: 'async-request' });
    });

    expect(getDiagnosticContext()).toBeUndefined();
  });

  test('isolates concurrent async contexts', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });

    const first = runWithDiagnosticContext(web('first-request'), async () => {
      await firstGate;
      return getDiagnosticContext()?.correlationId;
    });
    const second = runWithDiagnosticContext(web('second-request'), async () => {
      await secondGate;
      return getDiagnosticContext()?.correlationId;
    });

    releaseSecond();
    await expect(second).resolves.toBe('second-request');
    releaseFirst();
    await expect(first).resolves.toBe('first-request');
    expect(getDiagnosticContext()).toBeUndefined();
  });

  test('nests a job over a web context and restores the web context', async () => {
    await runWithDiagnosticContext(web('outer-request'), async () => {
      expect(getDiagnosticContext()).toEqual({ kind: 'web', correlationId: 'outer-request' });

      await runWithDiagnosticContext(job({
        correlationId: normalizeOrCreateCorrelationId('inner-request'),
        generation: 2
      }), async () => {
        await Promise.resolve();
        expect(getDiagnosticContext()).toEqual({
          kind: 'job',
          correlationId: 'inner-request',
          jobId: generatedUuid,
          jobKind: 'catalog.process',
          attempt: 1,
          generation: 2,
          workerId: 'worker:1',
          slotId: 0
        });
        expect(Object.isFrozen(getDiagnosticContext())).toBe(true);
      });

      expect(getDiagnosticContext()).toEqual({ kind: 'web', correlationId: 'outer-request' });
    });

    expect(getDiagnosticContext()).toBeUndefined();
  });

  test.each([
    web(' leading'),
    job({ jobId: '01234567-89AB-CDEF-0123-456789ABCDEF' }),
    job({ jobKind: '1invalid' }),
    job({ attempt: 0 }),
    job({ generation: 0 }),
    job({ workerId: ':worker' }),
    job({ slotId: -1 })
  ])('rejects an invalid diagnostic context %#', (context) => {
    expect(() => runWithDiagnosticContext(context, () => undefined)).toThrow(TypeError);
    expect(getDiagnosticContext()).toBeUndefined();
  });

  test('reads and normalizes the header only when directly invoked outside ingress', () => {
    const request = requestWithCorrelation('Direct.Header:Mixed_Case');
    const before = [...request.headers.entries()];

    expect(correlationIdForRequest(request)).toBe('Direct.Header:Mixed_Case');
    expect([...request.headers.entries()]).toEqual(before);
    expect(request.headers.has('x-correlation-id')).toBe(false);
  });

  test('normalizes an invalid direct header with the injected UUID source', () => {
    const request = requestWithCorrelation('invalid header');

    expect(correlationIdForRequest(request, () => generatedUuid)).toBe(generatedUuid);
    expect(request.headers.get('x-request-id')).toBe('invalid header');
  });

  test.each([web('ambient-web'), job({
    correlationId: normalizeOrCreateCorrelationId('ambient-job')
  })])(
    'prefers the active $kind correlation over a conflicting request header',
    (context) => {
      const request = requestWithCorrelation('conflicting-header');
      const uuidSource = vi.fn(() => generatedUuid);

      const correlationId = runWithDiagnosticContext(context, () => correlationIdForRequest(request, uuidSource));

      expect(correlationId).toBe(context.correlationId);
      expect(uuidSource).not.toHaveBeenCalled();
      expect(request.headers.get('x-request-id')).toBe('conflicting-header');
    }
  );
});
