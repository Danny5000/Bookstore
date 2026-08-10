import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReaderLocation, ReaderProgressDto } from '$lib/types/library';
import type { ReaderPersistence } from './persistence';
import { ReaderConflictError, ReaderPersistenceError } from './persistence';
import { createProgressSynchronizer } from './progress-sync';

const revisionId = randomUUID();
const blockId = randomUUID();
const first = { format: 'prose' as const, blockId, offset: 1 };
const latest = { format: 'prose' as const, blockId, offset: 8 };

function progress(location: ReaderLocation = latest, version = 1): ReaderProgressDto {
  return { revisionId, location, version, updatedAt: new Date().toISOString() };
}

function persistence(
  saveProgress: ReaderPersistence['saveProgress'] = vi.fn(async () => progress())
): ReaderPersistence {
  return {
    kind: 'server',
    getInitialState: () => ({
      progress: null,
      bookmarks: [],
      preferences: { fontSize: 18, typeface: 'serif', paper: 'white', version: 0 },
      titlePreferences: null,
      migrationNotice: null
    }),
    saveProgress,
    createBookmark: vi.fn(),
    deleteBookmark: vi.fn(),
    savePreferences: vi.fn(),
    saveTitlePreferences: vi.fn(),
    acknowledgeMigration: vi.fn()
  };
}

afterEach(() => vi.useRealTimers());

describe('progress synchronization', () => {
  it('debounces for 750 ms and coalesces ordinary navigation to the latest location', async () => {
    vi.useFakeTimers();
    const adapter = persistence();
    const states: string[] = [];
    const sync = createProgressSynchronizer({
      persistence: adapter,
      initialProgress: null,
      onState: (state) => states.push(state.status)
    });
    sync.navigate(first);
    await vi.advanceTimersByTimeAsync(500);
    sync.navigate(latest);
    await vi.advanceTimersByTimeAsync(749);
    expect(adapter.saveProgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.saveProgress).toHaveBeenCalledTimes(1);
    expect(adapter.saveProgress).toHaveBeenCalledWith({ location: latest, expectedVersion: 0 });
    expect(states).toContain('pending');
    expect(sync.snapshot().status).toBe('synced');
  });

  it('flushes pending progress before an explicit action', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const adapter = persistence(
      vi.fn(async (input: Parameters<ReaderPersistence['saveProgress']>[0]) => {
        calls.push(`progress:${input.location.format}`);
        return progress(input.location);
      })
    );
    const sync = createProgressSynchronizer({ persistence: adapter, initialProgress: null });
    sync.navigate(latest);
    await sync.flushBeforeAction(async () => calls.push('bookmark'));
    expect(calls).toEqual(['progress:prose', 'bookmark']);
  });

  it('retries only transient failures at 1s, 2s, and 4s, then reports failed', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {
      throw new ReaderPersistenceError('Unavailable', { status: 503, retryable: true });
    });
    const sync = createProgressSynchronizer({
      persistence: persistence(save),
      initialProgress: null
    });
    sync.navigate(latest);
    await vi.advanceTimersByTimeAsync(750);
    expect(save).toHaveBeenCalledTimes(1);
    expect(sync.snapshot().status).toBe('retrying');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(save).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(save).toHaveBeenCalledTimes(4);
    expect(sync.snapshot().status).toBe('failed');
    expect(sync.snapshot().status).not.toBe('synced');
  });

  it('adopts a 409 current value and does not resend the stale location', async () => {
    vi.useFakeTimers();
    const current = progress(first, 4);
    const save = vi.fn(async () => {
      throw new ReaderConflictError(current);
    });
    const sync = createProgressSynchronizer({
      persistence: persistence(save),
      initialProgress: null
    });
    sync.navigate(latest);
    await vi.advanceTimersByTimeAsync(750);
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(1);
    expect(sync.snapshot()).toMatchObject({ status: 'conflict', progress: current });
  });

  it('leaves a best-effort dispose flush pending instead of claiming success', () => {
    vi.useFakeTimers();
    const keepalive = vi.fn();
    const sync = createProgressSynchronizer({
      persistence: persistence(),
      initialProgress: null,
      keepalive
    });
    sync.navigate(latest);
    sync.dispose();
    expect(keepalive).toHaveBeenCalledWith({ location: latest, expectedVersion: 0 });
    expect(sync.snapshot().status).toBe('pending');
  });
});
