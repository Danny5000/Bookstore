import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({ origin: 'https://books.example.com' })
}));

import {
  assertSameOrigin,
  correlationIdForRequest,
  privateEmpty,
  privateJson,
  readStrictJson
} from './strict-json';

const schema = z.strictObject({ value: z.string() });

describe('strict JSON HTTP helpers', () => {
  it('accepts exact JSON media types and strict schemas', async () => {
    await expect(
      readStrictJson(
        new Request('https://books.example.com/api', {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ value: 'safe' })
        }),
        schema
      )
    ).resolves.toEqual({ value: 'safe' });
    await expect(
      readStrictJson(
        new Request('https://books.example.com/api', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'safe', extra: true })
        }),
        schema
      )
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_INPUT' });
  });

  it('distinguishes media type, malformed JSON, and explicit body-limit failures', async () => {
    await expect(
      readStrictJson(
        new Request('https://books.example.com/api', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: '{}'
        }),
        schema
      )
    ).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    await expect(
      readStrictJson(
        new Request('https://books.example.com/api', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{bad'
        }),
        schema
      )
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_JSON' });
    await expect(
      readStrictJson(
        new Request('https://books.example.com/api', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'x'.repeat(40) })
        }),
        schema,
        { maxBytes: 32 }
      )
    ).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('uses configured origin authority rather than request host headers', () => {
    expect(() =>
      assertSameOrigin(
        new Request('https://internal/api', {
          headers: { origin: 'https://books.example.com', host: 'internal' }
        })
      )
    ).not.toThrow();
    for (const origin of [null, 'https://evil.example', 'not a URL']) {
      const init: RequestInit = origin === null ? {} : { headers: { origin } };
      expect(() =>
        assertSameOrigin(new Request('https://internal/api', init))
      ).toThrowError(expect.objectContaining({ status: 403, code: 'forbidden' }));
    }
  });

  it('validates correlation IDs and emits private response helpers', async () => {
    expect(
      correlationIdForRequest(
        new Request('https://books.example.com', {
          headers: { 'x-request-id': 'request-123' }
        })
      )
    ).toBe('request-123');
    expect(
      correlationIdForRequest(
        new Request('https://books.example.com', {
          headers: { 'x-request-id': 'x'.repeat(201) }
        })
      )
    ).toMatch(/^[0-9a-f-]{36}$/u);

    const json = privateJson({ id: randomUUID() }, 201);
    expect(json.status).toBe(201);
    expect(json.headers.get('cache-control')).toBe('no-store');
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const empty = privateEmpty();
    expect(empty.status).toBe(204);
    expect(empty.headers.get('cache-control')).toBe('no-store');
    expect(await empty.text()).toBe('');
  });
});
