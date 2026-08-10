import { randomUUID } from 'node:crypto';
import { asc, count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import {
  getAuditEventDetail,
  listAuditEvents,
  parseAuditFilters
} from '$lib/server/audit/query';
import { auditEvents } from '$lib/server/db/schema';
import { databaseClient } from './database';

const admin: Actor = { type: 'user', id: randomUUID(), roles: ['admin'] };
const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };

function row(overrides: Partial<typeof auditEvents.$inferInsert> = {}): typeof auditEvents.$inferInsert {
  return {
    id: randomUUID(),
    occurredAt: new Date('2026-08-09T12:00:00.000Z'),
    actorType: 'user',
    actorId: admin.type === 'user' ? admin.id : 'admin',
    action: 'catalog.title.update',
    outcome: 'succeeded',
    resourceType: 'title',
    resourceId: randomUUID(),
    correlationId: randomUUID(),
    ...overrides
  };
}

describe('audit browsing queries', () => {
  it('paginates tied timestamps newest-first without gaps or duplicates', async () => {
    const inserted = [
      row({ occurredAt: new Date('2026-08-09T13:00:00Z') }),
      row(), row(), row(),
      row({ occurredAt: new Date('2026-08-09T11:00:00Z') })
    ];
    await databaseClient.db.insert(auditEvents).values(inserted);
    const expected = [...inserted].sort((left, right) => {
      const time = right.occurredAt!.getTime() - left.occurredAt!.getTime();
      return time || String(right.id).localeCompare(String(left.id));
    }).map((event) => event.id);

    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listAuditEvents(databaseClient.db, admin, parseAuditFilters(
        new URLSearchParams({ pageSize: '2', ...(cursor ? { cursor } : {}) })
      ));
      for (const event of page.events) {
        collected.push(event.id);
        expect(event).not.toHaveProperty('before');
        expect(event).not.toHaveProperty('after');
        expect(event).not.toHaveProperty('requestMetadata');
      }
      cursor = page.nextCursor;
    } while (cursor);

    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(inserted.length);
  });

  it('combines every supplied filter with AND semantics and does not audit listing', async () => {
    const resourceId = randomUUID();
    const matching = row({ resourceId });
    await databaseClient.db.insert(auditEvents).values([
      matching,
      row({ resourceId, action: 'catalog.title.create' }),
      row({ resourceId: randomUUID(), outcome: 'failed' }),
      row({ actorId: customer.type === 'user' ? customer.id : 'customer' })
    ]);
    const filters = parseAuditFilters(new URLSearchParams({
      actorId: matching.actorId!,
      action: matching.action,
      resourceType: matching.resourceType,
      resourceId,
      outcome: matching.outcome!,
      from: '2026-08-09T11:59:00Z',
      to: '2026-08-09T12:01:00Z',
      pageSize: '50'
    }));
    const result = await listAuditEvents(databaseClient.db, admin, filters);
    expect(result.events.map((event) => event.id)).toEqual([matching.id]);
    const [total] = await databaseClient.db.select({ value: count() }).from(auditEvents);
    expect(total?.value).toBe(4);
  });

  it('authorizes and audits sanitized detail access without recursive behavior', async () => {
    const [source] = await databaseClient.db.insert(auditEvents).values(row({
      requestMetadata: { routeId: '/admin', authorization: 'unsafe' },
      before: { title: 'Before', password: 'unsafe' },
      after: { title: 'After', token: 'unsafe' }
    })).returning();
    if (!source) throw new Error('Expected audit source');

    await expect(getAuditEventDetail(databaseClient.db, {
      actor: customer, eventId: source.id, correlationId: 'denied'
    })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getAuditEventDetail(databaseClient.db, {
      actor: admin, eventId: randomUUID(), correlationId: 'missing'
    })).resolves.toBeNull();

    const detail = await getAuditEventDetail(databaseClient.db, {
      actor: admin, eventId: source.id, correlationId: 'view-source'
    });
    expect(detail).toMatchObject({
      id: source.id,
      requestMetadata: { routeId: '/admin', authorization: '[redacted]' },
      before: { title: 'Before', password: '[redacted]' },
      after: { title: 'After', token: '[redacted]' }
    });
    const views = await databaseClient.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'audit.event.view'))
      .orderBy(asc(auditEvents.occurredAt));
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      resourceType: 'audit_event',
      resourceId: source.id,
      correlationId: 'view-source',
      after: { viewedEventId: source.id }
    });

    await getAuditEventDetail(databaseClient.db, {
      actor: admin, eventId: views[0]!.id, correlationId: 'view-the-view'
    });
    const [total] = await databaseClient.db.select({ value: count() }).from(auditEvents);
    expect(total?.value).toBe(3);
  });

  it('exposes customer download audits through the existing admin filters and detail view', async () => {
    const titleId = randomUUID();
    const revisionId = randomUUID();
    const customerId = randomUUID();
    const [download] = await databaseClient.db
      .insert(auditEvents)
      .values(
        row({
          actorId: customerId,
          action: 'library.original.download',
          resourceType: 'title_revision',
          resourceId: revisionId,
          correlationId: 'download-correlation',
          after: { titleId, activeRevisionId: revisionId, range: false }
        })
      )
      .returning();
    if (!download) throw new Error('Expected download event');

    const page = await listAuditEvents(
      databaseClient.db,
      admin,
      parseAuditFilters(
        new URLSearchParams({
          actorId: customerId,
          action: 'library.original.download',
          resourceType: 'title_revision',
          resourceId: revisionId
        })
      )
    );
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ id: download.id, correlationId: 'download-correlation' });
    expect(page.events[0]).not.toHaveProperty('after');

    const detail = await getAuditEventDetail(databaseClient.db, {
      actor: admin,
      eventId: download.id,
      correlationId: 'view-download'
    });
    expect(detail).toMatchObject({
      requestMetadata: null,
      after: { titleId, activeRevisionId: revisionId, range: false }
    });
  });
});
