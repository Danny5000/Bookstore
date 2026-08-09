import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { appendAuditEvent } from '$lib/server/audit/service';
import { auditEvents } from '$lib/server/db/schema';
import { databaseClient } from './database';

describe('audit events', () => {
  it('appends redacted details and rejects update or delete', async () => {
    const event = await appendAuditEvent(databaseClient.db, {
      actor: { type: 'user', id: 'admin-1', roles: ['admin'] },
      action: 'catalog.title.create',
      outcome: 'succeeded',
      resourceType: 'title',
      resourceId: 'title-1',
      correlationId: 'request-1',
      requestMetadata: {
        method: 'POST',
        routeId: '/admin/catalog',
        authorization: 'unsafe'
      },
      after: { title: 'Safe', password: 'unsafe' }
    });

    expect(event.after).toEqual({ title: 'Safe', password: '[redacted]' });
    expect(event.requestMetadata).toEqual({
      method: 'POST',
      routeId: '/admin/catalog',
      authorization: '[redacted]'
    });

    await expect(
      databaseClient.db
        .update(auditEvents)
        .set({ action: 'tampered' })
        .where(eq(auditEvents.id, event.id))
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: '55000',
        message: 'audit_events is append-only'
      })
    });

    await expect(
      databaseClient.db.execute(sql`delete from audit_events where id = ${event.id}`)
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: '55000',
        message: 'audit_events is append-only'
      })
    });
  });
});
