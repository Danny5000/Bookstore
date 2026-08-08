import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { titles } from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { databaseClient } from './database';

describe('database transactions', () => {
  it('rolls back every write when the callback rejects', async () => {
    await expect(
      withTransaction(databaseClient.db, async (transaction) => {
        await transaction.insert(titles).values({
          slug: 'rolled-back-title',
          title: 'Rolled Back Title',
          description: 'This row must not survive.',
          creatorName: 'Pale Orbit',
          format: 'prose',
          priceMinor: 1200,
          currency: 'USD'
        });
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    const count = await databaseClient.db.execute<{ count: number }>(sql`
      select count(*)::int as count from titles
    `);
    expect(count.rows[0]?.count).toBe(0);
  });
});
