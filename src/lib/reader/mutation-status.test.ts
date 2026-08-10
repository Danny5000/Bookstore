import { describe, expect, it, vi } from 'vitest';
import {
  readerMutationMessage,
  runReaderMutation,
  type ReaderMutationStatus
} from './mutation-status';

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

  it.each([
    ['bookmark', 'Saving bookmark', 'Bookmark saved', 'Bookmark was not saved'],
    ['preferences', 'Saving reader preferences', 'Reader preferences saved', 'Reader preferences were not saved'],
    ['comic-mode', 'Saving comic view preference', 'Comic view preference saved', 'Comic view preference was not saved'],
    ['migration-notice', 'Dismissing edition notice', 'Edition notice dismissed', 'Edition notice was not dismissed']
  ] as const)('provides accessible %s pending, success, and failure messages', (
    kind,
    pending,
    succeeded,
    failed
  ) => {
    expect(readerMutationMessage({ kind, status: 'pending' })).toBe(pending);
    expect(readerMutationMessage({ kind, status: 'succeeded' })).toBe(succeeded);
    expect(readerMutationMessage({ kind, status: 'failed' })).toBe(failed);
  });
});
