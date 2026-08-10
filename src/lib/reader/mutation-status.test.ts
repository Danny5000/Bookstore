import { describe, expect, it, vi } from 'vitest';
import {
  readerMutationMessage,
  runReaderMutation,
  type ReaderMutationStatus
} from './mutation-status';
import { ReaderConflictError, ReaderPersistenceError } from './persistence';

describe('reader non-progress mutation status', () => {
  it('reports pending before work and success after the saved value is adopted', async () => {
    let resolve!: (value: number) => void;
    const work = new Promise<number>((done) => { resolve = done; });
    const statuses: ReaderMutationStatus[] = [];
    const onSuccess = vi.fn();

    const running = runReaderMutation({
      kind: 'bookmark',
      work: () => work,
      onStatus: (status) => statuses.push(status),
      onSuccess
    });

    expect(statuses).toEqual([{ kind: 'bookmark', status: 'pending' }]);
    resolve(7);
    await running;
    expect(onSuccess).toHaveBeenCalledWith(7);
    expect(statuses.at(-1)).toEqual({ kind: 'bookmark', status: 'succeeded' });
  });

  it('reports failure and invokes rollback when an optimistic comic-mode save fails', async () => {
    let comicMode = 'panel';
    const statuses: ReaderMutationStatus[] = [];

    await runReaderMutation({
      kind: 'comic-mode',
      work: () => Promise.reject(new Error('offline')),
      onStatus: (status) => statuses.push(status),
      onFailure: () => { comicMode = 'page'; }
    });

    expect(comicMode).toBe('page');
    expect(statuses).toEqual([
      { kind: 'comic-mode', status: 'pending' },
      { kind: 'comic-mode', status: 'failed' }
    ]);
  });

  it('retries only bounded retryable failures before reporting success', async () => {
    const work = vi.fn()
      .mockRejectedValueOnce(new ReaderPersistenceError('offline', { retryable: true }))
      .mockRejectedValueOnce(new ReaderPersistenceError('unavailable', {
        status: 503,
        retryable: true
      }))
      .mockResolvedValueOnce(7);
    const wait = vi.fn(async () => undefined);
    const statuses: ReaderMutationStatus[] = [];

    await runReaderMutation({
      kind: 'preferences',
      work,
      retryDelaysMs: [1_000, 2_000, 4_000],
      wait,
      onStatus: (status) => statuses.push(status)
    });

    expect(work).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[1_000], [2_000]]);
    expect(statuses.at(-1)).toEqual({ kind: 'preferences', status: 'succeeded' });
  });

  it('adopts the authoritative conflict value without retrying or reporting success', async () => {
    const current = { fontSize: 20, typeface: 'sans', paper: 'sepia', version: 3 } as const;
    const onConflict = vi.fn();
    const onFailure = vi.fn();
    const statuses: ReaderMutationStatus[] = [];
    const work = vi.fn(async () => { throw new ReaderConflictError(current); });

    await runReaderMutation({
      kind: 'preferences',
      work,
      retryDelaysMs: [0, 0, 0],
      onStatus: (status) => statuses.push(status),
      onConflict,
      onFailure
    });

    expect(work).toHaveBeenCalledOnce();
    expect(onConflict).toHaveBeenCalledWith(current);
    expect(onFailure).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({ kind: 'preferences', status: 'conflict' });
  });

  it('stops retrying when the reader is no longer active', async () => {
    const controller = new AbortController();
    const work = vi.fn(async () => {
      throw new ReaderPersistenceError('offline', { retryable: true });
    });
    const statuses: ReaderMutationStatus[] = [];

    await runReaderMutation({
      kind: 'comic-mode',
      work,
      retryDelaysMs: [1_000, 2_000, 4_000],
      wait: async () => { controller.abort(); },
      signal: controller.signal,
      onStatus: (status) => statuses.push(status)
    });

    expect(work).toHaveBeenCalledOnce();
    expect(statuses).toEqual([{ kind: 'comic-mode', status: 'pending' }]);
  });

  it('suppresses late success callbacks after the reader becomes inactive', async () => {
    const controller = new AbortController();
    let resolveWork!: (value: number) => void;
    const work = new Promise<number>((resolve) => { resolveWork = resolve; });
    const onSuccess = vi.fn();
    const statuses: ReaderMutationStatus[] = [];
    const running = runReaderMutation({
      kind: 'preferences',
      work: () => work,
      signal: controller.signal,
      onStatus: (status) => statuses.push(status),
      onSuccess
    });

    controller.abort();
    resolveWork(7);
    await running;

    expect(onSuccess).not.toHaveBeenCalled();
    expect(statuses).toEqual([{ kind: 'preferences', status: 'pending' }]);
  });

  it('suppresses late conflict and failure callbacks after the reader becomes inactive', async () => {
    const controller = new AbortController();
    let rejectWork!: (cause: unknown) => void;
    const work = new Promise<never>((_resolve, reject) => { rejectWork = reject; });
    const onConflict = vi.fn();
    const onFailure = vi.fn();
    const statuses: ReaderMutationStatus[] = [];
    const running = runReaderMutation({
      kind: 'comic-mode',
      work: () => work,
      signal: controller.signal,
      onStatus: (status) => statuses.push(status),
      onConflict,
      onFailure
    });

    controller.abort();
    rejectWork(new ReaderConflictError({ comicMode: 'page', version: 2 }));
    await running;

    expect(onConflict).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(statuses).toEqual([{ kind: 'comic-mode', status: 'pending' }]);
  });

  it.each([
    ['bookmark', 'Saving bookmark', 'Bookmark saved', 'Bookmark was not saved', 'Bookmarks changed on another device'],
    ['preferences', 'Saving reader preferences', 'Reader preferences saved', 'Reader preferences were not saved', 'Reader preferences changed on another device'],
    ['comic-mode', 'Saving comic view preference', 'Comic view preference saved', 'Comic view preference was not saved', 'Comic view preference changed on another device'],
    ['migration-notice', 'Dismissing edition notice', 'Edition notice dismissed', 'Edition notice was not dismissed', 'Edition notice changed on another device']
  ] as const)('provides accessible %s mutation messages', (
    kind,
    pending,
    succeeded,
    failed,
    conflict
  ) => {
    expect(readerMutationMessage({ kind, status: 'pending' })).toBe(pending);
    expect(readerMutationMessage({ kind, status: 'succeeded' })).toBe(succeeded);
    expect(readerMutationMessage({ kind, status: 'failed' })).toBe(failed);
    expect(readerMutationMessage({ kind, status: 'conflict' })).toBe(conflict);
  });
});
