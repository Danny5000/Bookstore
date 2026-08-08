import { describe, expect, it } from 'vitest';
import { databaseClient } from './database';

const PLAN_2_TABLES = [
  'audit_events',
  'jobs',
  'outbox_messages',
  'title_revisions',
  'titles'
];

describe('Plan 2 migrations', () => {
  it('creates every Plan 2 table', async () => {
    const result = await databaseClient.pool.query<{ table_name: string }>(
      `
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name = any($1::text[])
        order by table_name
      `,
      [PLAN_2_TABLES]
    );

    expect(result.rows.map((row) => row.table_name)).toEqual(PLAN_2_TABLES);
  });
});
