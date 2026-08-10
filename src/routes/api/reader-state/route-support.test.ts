import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AuthorizationError } from '$lib/server/auth/admin-policy';
import {
  InvalidReaderLocationError,
  ReaderStateNotFoundError,
  StaleReaderStateError
} from '$lib/server/reader-state/errors';

vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({ origin: 'https://books.example.com' })
}));

import {
  assertSameOrigin,
  correlationIdForRequest,
  parseRouteUuid,
  readStrictJson,
  readerStateErrorResponse,
  requireMutationActor
} from './route-support';

const schema = z.strictObject({ value: z.string().max(20) });

describe('reader-state route support', () => {
  it('requires a real user actor with stable authentication errors', () => {
    expect(() => requireMutationActor({ type: 'anonymous' })).toThrowError(
      expect.objectContaining({ status: 401, code: 'unauthenticated' })
    );
    expect(() => requireMutationActor({ type: 'guest', id: randomUUID() })).toThrowError(
      expect.objectContaining({ status: 403, code: 'forbidden' })
    );
    expect(requireMutationActor({
      type: 'user', id: randomUUID(), roles: ['customer']
    }).type).toBe('user');
  });

  it('uses configured origin authority and rejects absent or mismatched origins', () => {
    expect(() => assertSameOrigin(new Request('https://internal/mutate'))).toThrowError(
      expect.objectContaining({ status: 403 })
    );
    expect(() => assertSameOrigin(new Request('https://internal/mutate', {
      headers: { origin: 'https://evil.example', host: 'books.example.com' }
    }))).toThrowError(expect.objectContaining({ status: 403 }));
    expect(() => assertSameOrigin(new Request('https://internal/mutate', {
      headers: { origin: 'https://books.example.com' }
    }))).not.toThrow();
  });

  it('accepts only bounded strict JSON and never echoes invalid input', async () => {
    await expect(readStrictJson(new Request('https://books.example.com/mutate', {
      method: 'PUT',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ value: 'safe' })
    }), schema)).resolves.toEqual({ value: 'safe' });

    for (const request of [
      new Request('https://books.example.com/mutate', {
        method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '{}'
      }),
      new Request('https://books.example.com/mutate', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{bad'
      }),
      new Request('https://books.example.com/mutate', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'safe', userId: randomUUID() })
      }),
      new Request('https://books.example.com/mutate', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(17_000) })
      })
    ]) {
      const response = readerStateErrorResponse(await readStrictJson(request, schema).catch((error) => error));
      expect([400, 413, 415, 422]).toContain(response.status);
      expect(await response.text()).not.toContain('userId');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('maps domain, stale, authorization, and transient failures to safe private responses', async () => {
    for (const cause of [
      new ReaderStateNotFoundError(),
      new AuthorizationError('forbidden', 403)
    ]) {
      const response = readerStateErrorResponse(cause);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: 'NOT_FOUND' });
    }
    const current = {
      revisionId: randomUUID(),
      location: { format: 'prose' as const, blockId: randomUUID(), offset: 1 },
      version: 2,
      updatedAt: new Date().toISOString()
    };
    const stale = readerStateErrorResponse(new StaleReaderStateError(current));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ code: 'STALE_VERSION', current });
    const transient = readerStateErrorResponse(new Error('secret database detail'));
    expect(transient.status).toBe(503);
    expect(await transient.text()).not.toContain('secret');
  });

  it('maps a structurally valid but invalid reader location to the approved 422 response', async () => {
    const response = readerStateErrorResponse(new InvalidReaderLocationError());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ code: 'INVALID_INPUT' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('validates route UUIDs and correlation IDs without trusting arbitrary input', () => {
    const id = randomUUID();
    expect(parseRouteUuid(id)).toBe(id);
    expect(() => parseRouteUuid('../bad')).toThrowError(expect.objectContaining({ status: 404 }));
    expect(correlationIdForRequest(new Request('https://books.example.com', {
      headers: { 'x-request-id': 'request-123' }
    }))).toBe('request-123');
    expect(correlationIdForRequest(new Request('https://books.example.com', {
      headers: { 'x-request-id': 'x'.repeat(201) }
    }))).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
