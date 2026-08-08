import { describe, expect, it } from 'vitest';
import { databaseClient } from './database';

describe('database client', () => {
  it('queries the disposable PostgreSQL instance', async () => {
    const result = await databaseClient.pool.query<{ value: number }>('select 1 as value');
    expect(result.rows).toEqual([{ value: 1 }]);
  });
});
