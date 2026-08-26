import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { runWithDiagnosticContext } from '$lib/server/observability/context';

const database = {};
vi.mock('$lib/server/db/runtime', () => ({ getDatabaseClient: () => ({ db: database }) }));
vi.mock('$lib/server/audit/query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/audit/query')>();
  return { ...actual, listAuditEvents: vi.fn(), getAuditEventDetail: vi.fn() };
});

import { load as loadAudit } from './+page.server';
import { load as loadDetail } from './[eventId]/+page.server';
import { getAuditEventDetail, listAuditEvents } from '$lib/server/audit/query';

const admin: Actor = { type: 'user', id: randomUUID(), roles: ['admin'] };
const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };
const anonymous: Actor = { type: 'anonymous' };

describe('audit routes', () => {
  it('authorizes list and detail access before querying', async () => {
    await expect(loadAudit({
      locals: { actor: anonymous },
      url: new URL('http://localhost/admin/audit')
    } as never)).rejects.toMatchObject({ status: 401 });
    await expect(loadDetail({
      locals: { actor: customer }, params: { eventId: randomUUID() },
      request: new Request('http://localhost/admin/audit/event'), route: { id: '/admin/audit/[eventId]' }
    } as never)).rejects.toMatchObject({ status: 403 });
    expect(listAuditEvents).not.toHaveBeenCalled();
    expect(getAuditEventDetail).not.toHaveBeenCalled();
  });

  it('maps strict query failures to a public 400', async () => {
    await expect(loadAudit({
      locals: { actor: admin },
      url: new URL('http://localhost/admin/audit?unknown=value')
    } as never)).rejects.toMatchObject({ status: 400 });
    expect(listAuditEvents).not.toHaveBeenCalled();
  });

  it('loads a filtered page and preserves filters in the next-page URL', async () => {
    vi.mocked(listAuditEvents).mockResolvedValueOnce({ events: [], nextCursor: 'next-cursor' });
    const result = await loadAudit({
      locals: { actor: admin },
      url: new URL('http://localhost/admin/audit?action=catalog.title.update&pageSize=10')
    } as never);
    expect(listAuditEvents).toHaveBeenCalledWith(database, admin, expect.objectContaining({
      action: 'catalog.title.update', pageSize: 10
    }));
    if (!result) throw new Error('Expected the audit loader to return page data');
    expect(result).toMatchObject({ page: { events: [], nextCursor: 'next-cursor' } });
    expect(result.nextUrl).toContain('action=catalog.title.update');
    expect(result.nextUrl).toContain('cursor=next-cursor');
  });

  it('validates detail IDs and maps missing events to 404 without querying twice', async () => {
    await expect(loadDetail({
      locals: { actor: admin }, params: { eventId: 'invalid' },
      request: new Request('http://localhost/admin/audit/invalid'), route: { id: '/admin/audit/[eventId]' }
    } as never)).rejects.toMatchObject({ status: 404 });
    expect(getAuditEventDetail).not.toHaveBeenCalled();

    vi.mocked(getAuditEventDetail).mockResolvedValueOnce(null);
    await expect(loadDetail({
      locals: { actor: admin }, params: { eventId: randomUUID() },
      request: new Request('http://localhost/admin/audit/missing'), route: { id: '/admin/audit/[eventId]' }
    } as never)).rejects.toMatchObject({ status: 404 });
    expect(getAuditEventDetail).toHaveBeenCalledTimes(1);
  });

  it('uses an exact bounded correlation ID or generates a UUID', async () => {
    const eventId = randomUUID();
    vi.mocked(getAuditEventDetail).mockResolvedValue({ id: eventId } as never);
    const maximum = `a${'x'.repeat(99)}`;
    await loadDetail({
      locals: { actor: admin }, params: { eventId },
      request: new Request(`http://localhost/admin/audit/${eventId}`, { headers: { 'x-request-id': maximum } }),
      route: { id: '/admin/audit/[eventId]' }
    } as never);
    expect(getAuditEventDetail).toHaveBeenLastCalledWith(database, {
      actor: admin, eventId, correlationId: maximum
    });

    await loadDetail({
      locals: { actor: admin }, params: { eventId },
      request: new Request(`http://localhost/admin/audit/${eventId}`, { headers: { 'x-request-id': 'x'.repeat(101) } }),
      route: { id: '/admin/audit/[eventId]' }
    } as never);
    expect(vi.mocked(getAuditEventDetail).mock.calls.at(-1)?.[1].correlationId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('prefers ambient diagnostic correlation over a conflicting header', async () => {
    const eventId = randomUUID();
    vi.mocked(getAuditEventDetail).mockResolvedValue({ id: eventId } as never);

    await runWithDiagnosticContext(
      { kind: 'web', correlationId: 'ambient-audit' } as never,
      () => loadDetail({
        locals: { actor: admin }, params: { eventId },
        request: new Request(`http://localhost/admin/audit/${eventId}`, { headers: { 'x-request-id': 'conflicting-header' } }),
        route: { id: '/admin/audit/[eventId]' }
      } as never)
    );

    expect(vi.mocked(getAuditEventDetail).mock.calls.at(-1)?.[1].correlationId).toBe('ambient-audit');
  });
});
