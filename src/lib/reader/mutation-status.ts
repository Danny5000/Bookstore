import { ReaderConflictError, ReaderPersistenceError } from './persistence';

export type ReaderMutationKind =
  | 'bookmark'
  | 'preferences'
  | 'comic-mode'
  | 'migration-notice';

export type ReaderMutationStatus =
  | { status: 'idle' }
  | {
      kind: ReaderMutationKind;
      status: 'pending' | 'succeeded' | 'failed' | 'conflict';
    };

export const readerMutationRetryDelaysMs = [1_000, 2_000, 4_000] as const;

interface ReaderMutationOptions<Value> {
  kind: ReaderMutationKind;
  work: () => Promise<Value>;
  onStatus: (status: ReaderMutationStatus) => void;
  onSuccess?: (value: Value) => void;
  onConflict?: (current: Value) => void;
  onFailure?: (cause: unknown) => void;
  retryDelaysMs?: readonly number[];
  wait?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export async function runReaderMutation<Value>(
  options: ReaderMutationOptions<Value>
): Promise<void> {
  if (options.signal?.aborted) return;
  options.onStatus({ kind: options.kind, status: 'pending' });
  const retryDelays = options.retryDelaysMs ?? [];
  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) return;
    try {
      const value = await options.work();
      if (options.signal?.aborted) return;
      options.onSuccess?.(value);
      options.onStatus({ kind: options.kind, status: 'succeeded' });
      return;
    } catch (cause: unknown) {
      if (options.signal?.aborted) return;
      if (cause instanceof ReaderConflictError) {
        options.onConflict?.(cause.current as Value);
        options.onStatus({ kind: options.kind, status: 'conflict' });
        return;
      }
      const retryDelay = retryDelays[attempt];
      if (
        cause instanceof ReaderPersistenceError &&
        cause.retryable &&
        retryDelay !== undefined
      ) {
        await (options.wait
          ? options.wait(retryDelay)
          : wait(retryDelay, options.signal));
        if (options.signal?.aborted) return;
        continue;
      }
      options.onFailure?.(cause);
      options.onStatus({ kind: options.kind, status: 'failed' });
      return;
    }
  }
}

export function readerMutationMessage(status: ReaderMutationStatus): string {
  if (status.status === 'idle') return '';
  const messages = {
    bookmark: {
      pending: 'Saving bookmark',
      succeeded: 'Bookmark saved',
      failed: 'Bookmark was not saved',
      conflict: 'Bookmarks changed on another device'
    },
    preferences: {
      pending: 'Saving reader preferences',
      succeeded: 'Reader preferences saved',
      failed: 'Reader preferences were not saved',
      conflict: 'Reader preferences changed on another device'
    },
    'comic-mode': {
      pending: 'Saving comic view preference',
      succeeded: 'Comic view preference saved',
      failed: 'Comic view preference was not saved',
      conflict: 'Comic view preference changed on another device'
    },
    'migration-notice': {
      pending: 'Dismissing edition notice',
      succeeded: 'Edition notice dismissed',
      failed: 'Edition notice was not dismissed',
      conflict: 'Edition notice changed on another device'
    }
  } as const;
  return messages[status.kind][status.status];
}
