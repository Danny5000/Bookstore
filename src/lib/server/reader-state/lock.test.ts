import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { lockReaderTitle } from './lock';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TITLE_ID = '22222222-2222-4222-8222-222222222222';
const REVISION_ID = '33333333-3333-4333-8333-333333333333';

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value.replaceAll("'", "''")}'`
  });
}

class FakeReaderTransaction {
  readonly executed: SQL[] = [];
  readonly operations: string[] = [];
  readonly selects: string[][] = [];
  private readonly selectLabels = ['user', 'titles', 'entitlements', 'publication'];
  private readonly responses = [
    [{ id: USER_ID }],
    [{ id: TITLE_ID, activeRevisionId: REVISION_ID }],
    [{ id: '44444444-4444-4444-8444-444444444444' }],
    [{
      revisionId: REVISION_ID,
      presentation: { revisionId: REVISION_ID, state: 'published' }
    }]
  ];

  async execute(query: SQL): Promise<{ rows: unknown[] }> {
    this.executed.push(query);
    this.operations.push(`execute:${String(rendered(query).params[0])}`);
    return { rows: [{}] };
  }

  select(): unknown {
    const call = this.selects.length;
    const methods: string[] = [];
    this.selects.push(methods);
    const builder = {
      from: () => {
        methods.push('from');
        this.operations.push(`select:${this.selectLabels[call] ?? 'unexpected'}`);
        return builder;
      },
      innerJoin: () => {
        methods.push('innerJoin');
        return builder;
      },
      where: () => {
        methods.push('where');
        return builder;
      },
      for: (mode: string) => {
        methods.push(`for:${mode}`);
        return builder;
      },
      limit: async () => {
        methods.push('limit');
        return this.responses[call] ?? [];
      }
    };
    return builder;
  }
}

describe('reader title locking', () => {
  it('serializes entitlement reads with the worker projection key without taking a row lock', async () => {
    const fake = new FakeReaderTransaction();

    await expect(lockReaderTitle(
      fake as unknown as DatabaseTransaction,
      { type: 'user', id: USER_ID, roles: ['customer'] },
      TITLE_ID
    )).resolves.toMatchObject({ userId: USER_ID, revisionId: REVISION_ID });

    expect(fake.executed.map((query) => rendered(query).params)).toEqual([
      [TITLE_ID],
      [`pale-orbit:reader-state:${USER_ID}:${TITLE_ID}`],
      [`pale-orbit:commerce:entitlement:${USER_ID}:${TITLE_ID}`]
    ]);
    expect(fake.operations).toEqual([
      `execute:${TITLE_ID}`,
      `execute:pale-orbit:reader-state:${USER_ID}:${TITLE_ID}`,
      `execute:pale-orbit:commerce:entitlement:${USER_ID}:${TITLE_ID}`,
      'select:user',
      'select:titles',
      'select:entitlements',
      'select:publication'
    ]);
    expect(fake.selects[1]).toContain('for:update');
    expect(fake.selects[2]).not.toContain('for:update');
  });
});
