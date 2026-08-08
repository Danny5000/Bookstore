import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { probeDatabase } from './health';

describe('probeDatabase', () => {
  it('runs a bounded select-one query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: 1 }] });
    const pool = { query } as unknown as Pool;

    await expect(probeDatabase(pool, 1750)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith({
      text: 'select 1 as ready',
      query_timeout: 1750
    });
  });

  it('rejects when PostgreSQL does not return the expected value', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [] })
    } as unknown as Pool;

    await expect(probeDatabase(pool, 1000)).rejects.toThrow('Database readiness query failed');
  });
});
