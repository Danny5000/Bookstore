import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '$lib/server/db/client';
import { StaleReaderStateError } from './errors';
import { saveProgress, saveReaderPreferences } from './service';

describe('reader-state service boundary', () => {
  it('carries only the authoritative safe value in stale errors', () => {
    const current = {
      revisionId: randomUUID(),
      location: { format: 'prose' as const, blockId: randomUUID(), offset: 4 },
      version: 3,
      updatedAt: new Date().toISOString()
    };
    const error = new StaleReaderStateError(current);
    expect(error).toMatchObject({ code: 'STALE_VERSION', current });
    expect(JSON.parse(JSON.stringify({ code: error.code, current: error.current })))
      .toEqual({ code: 'STALE_VERSION', current });
  });

  it('rejects non-user actors before opening a transaction', async () => {
    const database = { transaction: vi.fn() } as unknown as Database;
    await expect(
      saveProgress({
        database,
        actor: { type: 'anonymous' },
        titleId: randomUUID(),
        correlationId: randomUUID(),
        location: { format: 'prose', blockId: randomUUID(), offset: 0 },
        expectedVersion: 0
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(
      saveReaderPreferences({
        database,
        actor: { type: 'guest', id: randomUUID() },
        correlationId: randomUUID(),
        fontSize: 18,
        typeface: 'serif',
        paper: 'white',
        expectedVersion: 0
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
