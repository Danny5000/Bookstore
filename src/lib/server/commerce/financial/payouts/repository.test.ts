import { describe, expect, it, vi } from 'vitest';
import type { Database } from '$lib/server/db/client';
import { payoutSnapshotFixture } from '../../../../../../tests/fixtures/stripe/payout';
import { stagePayoutSnapshot } from './repository';

describe('payout repository', () => {
  it('stages a canonical payout at generation zero', async () => {
    const database = { transaction: vi.fn() } as unknown as Database;
    vi.mocked(database.transaction).mockResolvedValueOnce({
      payoutId: '00000000-0000-4000-8000-000000000101', generation: 0, changed: true
    });

    await expect(stagePayoutSnapshot(database, payoutSnapshotFixture(), {
      correlationId: 'payout-repository-red'
    })).resolves.toEqual({
      payoutId: '00000000-0000-4000-8000-000000000101', generation: 0, changed: true
    });
  });
});
