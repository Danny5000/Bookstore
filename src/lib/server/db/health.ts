import type { Pool, QueryConfig } from 'pg';

interface TimedQueryConfig extends QueryConfig {
  query_timeout: number;
}

export async function probeDatabase(pool: Pool, timeoutMs: number): Promise<void> {
  const query: TimedQueryConfig = {
    text: 'select 1 as ready',
    query_timeout: timeoutMs
  };
  const result = await pool.query<{ ready: number }>(query);

  if (result.rows[0]?.ready !== 1) {
    throw new Error('Database readiness query failed');
  }
}
