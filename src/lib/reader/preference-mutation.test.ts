import { describe, expect, it, vi } from 'vitest';
import type { ReaderPreferencesDto } from '$lib/types/library';
import type { ReaderMutationStatus } from './mutation-status';
import { createPreferenceMutationQueue } from './preference-mutation';
import { ReaderConflictError } from './persistence';

describe('reader preference mutation queue', () => {
  it('coalesces rapid edits and saves every requested value in version order', async () => {
    let current: ReaderPreferencesDto = {
      fontSize: 18,
      typeface: 'serif',
      paper: 'white',
      version: 0
    };
    let resolveFirst!: (value: ReaderPreferencesDto) => void;
    let resolveSecond!: (value: ReaderPreferencesDto) => void;
    const first = new Promise<ReaderPreferencesDto>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<ReaderPreferencesDto>((resolve) => { resolveSecond = resolve; });
    const save = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const statuses: ReaderMutationStatus[] = [];
    const queue = createPreferenceMutationQueue({
      current: () => current,
      save,
      onAdopt: (value) => { current = value; },
      onStatus: (status) => statuses.push(status)
    });

    queue.update({ fontSize: 19 });
    expect(save).toHaveBeenCalledWith({
      fontSize: 19,
      typeface: 'serif',
      paper: 'white',
      expectedVersion: 0
    });
    queue.update({ typeface: 'sans' });
    queue.update({ paper: 'sepia' });
    expect(save).toHaveBeenCalledTimes(1);

    resolveFirst({ ...current, fontSize: 19, version: 1 });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith({
      fontSize: 19,
      typeface: 'sans',
      paper: 'sepia',
      expectedVersion: 1
    });

    resolveSecond({ fontSize: 19, typeface: 'sans', paper: 'sepia', version: 2 });
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({
      kind: 'preferences',
      status: 'succeeded'
    }));
    expect(current).toEqual({
      fontSize: 19,
      typeface: 'sans',
      paper: 'sepia',
      version: 2
    });
  });

  it('adopts an authoritative conflict before accepting the next edit', async () => {
    let current: ReaderPreferencesDto = {
      fontSize: 18,
      typeface: 'serif',
      paper: 'white',
      version: 0
    };
    const authoritative: ReaderPreferencesDto = {
      fontSize: 20,
      typeface: 'sans',
      paper: 'sepia',
      version: 3
    };
    const save = vi.fn()
      .mockRejectedValueOnce(new ReaderConflictError(authoritative))
      .mockResolvedValueOnce({ ...authoritative, paper: 'dim', version: 4 });
    const statuses: ReaderMutationStatus[] = [];
    const queue = createPreferenceMutationQueue({
      current: () => current,
      save,
      onAdopt: (value) => { current = value; },
      onStatus: (status) => statuses.push(status)
    });

    queue.update({ fontSize: 19 });
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({
      kind: 'preferences',
      status: 'conflict'
    }));
    expect(current).toEqual(authoritative);

    queue.update({ paper: 'dim' });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith({
      fontSize: 20,
      typeface: 'sans',
      paper: 'dim',
      expectedVersion: 3
    });
    await vi.waitFor(() => expect(current.version).toBe(4));
  });
});
