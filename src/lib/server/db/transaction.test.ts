import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client';
import { withTransaction } from './transaction';

describe('withTransaction', () => {
  it('returns the callback result from Drizzle transaction ownership', async () => {
    const transaction = { marker: 'transaction' };
    const database = {
      transaction: vi.fn(async (work: (value: unknown) => Promise<unknown>) => work(transaction))
    } as unknown as Database;

    await expect(withTransaction(database, async (value) => value)).resolves.toBe(transaction);
  });
});
