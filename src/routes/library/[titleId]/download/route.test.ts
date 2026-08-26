import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { MediaNotFoundError } from '$lib/server/catalog/media';
import { runWithDiagnosticContext } from '$lib/server/observability/context';

const { database, storage, streamCustomerOriginalDownload } = vi.hoisted(() => ({
  database: {},
  storage: {},
  streamCustomerOriginalDownload: vi.fn()
}));
vi.mock('$lib/server/db/runtime', () => ({ getDatabaseClient: () => ({ db: database }) }));
vi.mock('$lib/server/storage/runtime', () => ({ getObjectStorage: () => storage }));
vi.mock('$lib/server/catalog/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/catalog/media')>()),
  streamCustomerOriginalDownload
}));

import { GET, HEAD } from './+server';

const titleId = randomUUID();
const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };

function event(actor: Actor, method: 'GET' | 'HEAD', range?: string, requestId = 'download-request') {
  return {
    locals: { actor },
    params: { titleId },
    route: { id: '/library/[titleId]/download' },
    request: new Request(`https://books.example.com/library/${titleId}/download`, {
      method,
      headers: {
        'x-request-id': requestId,
        ...(range ? { range } : {})
      }
    })
  };
}

describe('customer original download route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamCustomerOriginalDownload.mockImplementation(
      async (_database, _storage, _actor, input: { method: 'GET' | 'HEAD' }) =>
        input.method === 'HEAD'
          ? new Response(null, { status: 206 })
          : new Response('abcdef', { status: 200 })
    );
  });

  it('streams GET and body-free HEAD through a title-only authorization request', async () => {
    const get = await GET(event(customer, 'GET') as never);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('abcdef');
    const head = await HEAD(event(customer, 'HEAD', 'bytes=1-3') as never);
    expect(head.status).toBe(206);
    expect(await head.text()).toBe('');
    expect(streamCustomerOriginalDownload).toHaveBeenLastCalledWith(
      database,
      storage,
      customer,
      {
        titleId,
        correlationId: 'download-request',
        method: 'HEAD',
        rangeHeader: 'bytes=1-3'
      }
    );
    expect(JSON.stringify(streamCustomerOriginalDownload.mock.calls)).not.toContain('revisionId');
    expect(JSON.stringify(streamCustomerOriginalDownload.mock.calls)).not.toContain('requestMetadata');
  });

  it('fails invalid, signed-out, and inaccessible requests closed', async () => {
    expect((await GET({ ...event(customer, 'GET'), params: { titleId: 'bad' } } as never)).status)
      .toBe(404);
    expect((await GET(event({ type: 'anonymous' }, 'GET') as never)).status).toBe(401);
    streamCustomerOriginalDownload.mockRejectedValueOnce(new MediaNotFoundError());
    expect((await GET(event(customer, 'GET') as never)).status).toBe(404);
  });

  it('maps temporary database and storage failures to a bounded safe 503', async () => {
    streamCustomerOriginalDownload.mockRejectedValueOnce(
      new Error('ECONNREFUSED storage-root C:\\private\\secret')
    );
    const response = await GET(event(customer, 'GET') as never);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('5');
    const body = await response.text();
    expect(body).toBe('Download temporarily unavailable');
    expect(body).not.toMatch(/ECONNREFUSED|storage-root|private|secret/iu);
    expect(body.length).toBeLessThan(100);
  });

  it('uses exact bounded or ambient diagnostic correlation', async () => {
    const maximum = `a${'x'.repeat(99)}`;
    await GET(event(customer, 'GET', undefined, maximum) as never);
    expect(streamCustomerOriginalDownload.mock.calls.at(-1)?.[3].correlationId).toBe(maximum);

    await GET(event(customer, 'GET', undefined, 'x'.repeat(101)) as never);
    expect(streamCustomerOriginalDownload.mock.calls.at(-1)?.[3].correlationId)
      .toMatch(/^[0-9a-f-]{36}$/u);

    await runWithDiagnosticContext(
      { kind: 'web', correlationId: 'ambient-download' } as never,
      () => GET(event(customer, 'GET', undefined, 'conflicting-header') as never)
    );
    expect(streamCustomerOriginalDownload.mock.calls.at(-1)?.[3].correlationId)
      .toBe('ambient-download');
  });
});
