import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeAuditCursor, encodeAuditCursor, parseAuditFilters } from './query';

describe('audit query input', () => {
  it('parses every filter and caps the page size at 50', () => {
    const id = randomUUID();
    const cursor = encodeAuditCursor({ occurredAt: '2026-08-09T12:00:00.000Z', id });
    const result = parseAuditFilters(new URLSearchParams({
      actorId: 'admin-1',
      action: 'catalog.title.update',
      resourceType: 'title',
      resourceId: id,
      outcome: 'succeeded',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-09T23:59:59.999Z',
      cursor,
      pageSize: '50'
    }));
    expect(result).toEqual({
      actorId: 'admin-1',
      action: 'catalog.title.update',
      resourceType: 'title',
      resourceId: id,
      outcome: 'succeeded',
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-09T23:59:59.999Z'),
      cursor: { occurredAt: new Date('2026-08-09T12:00:00.000Z'), id },
      pageSize: 50
    });
  });

  it('uses a bounded default page size', () => {
    expect(parseAuditFilters(new URLSearchParams())).toEqual({ pageSize: 25 });
  });

  it('treats blank controls submitted by the audit filter form as absent', () => {
    expect(parseAuditFilters(new URLSearchParams({
      actorId: '',
      action: 'audit.event.view',
      resourceType: '',
      resourceId: '',
      outcome: '',
      from: '',
      to: '',
      pageSize: '50'
    }))).toEqual({ action: 'audit.event.view', pageSize: 50 });
  });

  it.each([
    ['unknown key', new URLSearchParams({ surprise: 'value' })],
    ['duplicate key', new URLSearchParams('action=one&action=two')],
    ['invalid outcome', new URLSearchParams({ outcome: 'maybe' })],
    ['non-UTC date', new URLSearchParams({ from: '2026-08-09T12:00:00-04:00' })],
    ['invalid date', new URLSearchParams({ from: 'not-a-date' })],
    ['inverted dates', new URLSearchParams({ from: '2026-08-10T00:00:00Z', to: '2026-08-09T00:00:00Z' })],
    ['oversized value', new URLSearchParams({ action: 'x'.repeat(201) })],
    ['page size over cap', new URLSearchParams({ pageSize: '51' })],
    ['malformed cursor', new URLSearchParams({ cursor: 'not-base64url' })]
  ])('rejects %s', (_label, input) => {
    expect(() => parseAuditFilters(input)).toThrow();
  });
});

describe('audit cursor codec', () => {
  it('round-trips exactly the stable timestamp and UUID tuple', () => {
    const value = { occurredAt: '2026-08-09T12:00:00.000Z', id: randomUUID() };
    expect(decodeAuditCursor(encodeAuditCursor(value))).toEqual({
      occurredAt: new Date(value.occurredAt),
      id: value.id
    });
  });

  it.each([
    Buffer.from(JSON.stringify({ occurredAt: '2026-08-09T12:00:00.000Z', id: randomUUID(), extra: true })).toString('base64url'),
    Buffer.from(JSON.stringify({ occurredAt: 'not-a-date', id: randomUUID() })).toString('base64url'),
    Buffer.from(JSON.stringify({ occurredAt: '2026-08-09T12:00:00.000Z', id: 'not-a-uuid' })).toString('base64url')
  ])('rejects invalid cursor payloads', (cursor) => {
    expect(() => decodeAuditCursor(cursor)).toThrow();
  });

  it.each([
    `${encodeAuditCursor({ occurredAt: '2026-08-09T12:00:00.000Z', id: randomUUID() })}=`,
    `${encodeAuditCursor({ occurredAt: '2026-08-09T12:00:00.000Z', id: randomUUID() })}*`
  ])('rejects noncanonical base64url cursor encodings', (cursor) => {
    expect(() => decodeAuditCursor(cursor)).toThrow('Audit cursor is malformed');
  });
});
