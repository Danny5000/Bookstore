import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { GuestIdentityRow } from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import {
  findOrCreateGuestIdentity,
  guestIdentityInsertQuery,
  normalizeEmailAddress
} from './identity';

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  });
}

function guestIdentity(email: string): GuestIdentityRow {
  const now = new Date('2026-08-15T12:00:00.000Z');
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email,
    claimedByUserId: null,
    claimedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

class FakeGuestIdentityExecutor {
  readonly insertedEmails: string[] = [];
  readonly selectedEmails: string[] = [];

  constructor(
    private readonly inserted: GuestIdentityRow | undefined,
    private readonly existing: GuestIdentityRow | undefined
  ) {}

  async execute(query: SQL): Promise<{ rows: { id: string }[] }> {
    const statement = rendered(query);
    this.insertedEmails.push(String(statement.params[0]));
    return { rows: this.inserted ? [{ id: this.inserted.id }] : [] };
  }

  select(): unknown {
    return {
      from: () => ({
        where: () => ({
          limit: async () => {
            const selected = this.inserted ?? this.existing;
            this.selectedEmails.push(selected?.email ?? 'missing');
            return selected ? [selected] : [];
          }
        })
      })
    };
  }
}

describe('normalizeEmailAddress', () => {
  it('trims and lowercases a valid address', () => {
    expect(normalizeEmailAddress('  Reader@Example.COM ')).toBe('reader@example.com');
  });

  it.each(['not-an-email', '', 'reader@'])('rejects invalid address %j', (value) => {
    expect(() => normalizeEmailAddress(value)).toThrow('Invalid email address');
  });
});

describe('findOrCreateGuestIdentity', () => {
  it('targets only the granted email column in its parameterized insert', () => {
    const query = rendered(guestIdentityInsertQuery('reader@example.com'));
    const normalized = query.sql.replace(/\s+/gu, ' ').trim();
    expect(normalized).toMatch(
      /^insert into "public"\."guest_identities" \("email"\) values \(\$1::text\) on conflict \("email"\) do nothing returning /u
    );
    expect(normalized).toMatch(/returning "id"$/u);
    expect(query.sql).not.toMatch(/insert into[\s\S]+\((?:[^)]*\b(?:id|claimed_by_user_id|claimed_at|created_at|updated_at)\b)/u);
    expect(query.params).toEqual(['reader@example.com']);
  });

  it('hydrates the inserted identity through a schema-aware SELECT without UPDATE privilege', async () => {
    const inserted = guestIdentity('reader@example.com');
    const database = new FakeGuestIdentityExecutor(inserted, undefined);

    await expect(
      findOrCreateGuestIdentity(database as unknown as DatabaseExecutor, ' Reader@Example.com ')
    ).resolves.toEqual(inserted);
    expect(database.insertedEmails).toEqual(['reader@example.com']);
    expect(database.selectedEmails).toEqual(['reader@example.com']);
  });

  it('uses INSERT DO NOTHING followed by SELECT for an existing email', async () => {
    const existing = guestIdentity('reader@example.com');
    const database = new FakeGuestIdentityExecutor(undefined, existing);

    await expect(
      findOrCreateGuestIdentity(database as unknown as DatabaseExecutor, 'reader@example.com')
    ).resolves.toEqual(existing);
    expect(database.insertedEmails).toEqual(['reader@example.com']);
    expect(database.selectedEmails).toEqual(['reader@example.com']);
  });
});
