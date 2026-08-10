export type ReaderMutationKind =
  | 'bookmark'
  | 'preferences'
  | 'comic-mode'
  | 'migration-notice';

export type ReaderMutationStatus =
  | { status: 'idle' }
  | { kind: ReaderMutationKind; status: 'pending' | 'succeeded' | 'failed' };

interface ReaderMutationOptions<Value> {
  kind: ReaderMutationKind;
  work: () => Promise<Value>;
  onStatus: (status: ReaderMutationStatus) => void;
  onSuccess?: (value: Value) => void;
  onFailure?: (cause: unknown) => void;
}

export async function runReaderMutation<Value>(
  options: ReaderMutationOptions<Value>
): Promise<void> {
  options.onStatus({ kind: options.kind, status: 'pending' });
  try {
    const value = await options.work();
    options.onSuccess?.(value);
    options.onStatus({ kind: options.kind, status: 'succeeded' });
  } catch (cause: unknown) {
    options.onFailure?.(cause);
    options.onStatus({ kind: options.kind, status: 'failed' });
  }
}

export function readerMutationMessage(status: ReaderMutationStatus): string {
  if (status.status === 'idle') return '';
  const messages = {
    bookmark: {
      pending: 'Saving bookmark',
      succeeded: 'Bookmark saved',
      failed: 'Bookmark was not saved'
    },
    preferences: {
      pending: 'Saving reader preferences',
      succeeded: 'Reader preferences saved',
      failed: 'Reader preferences were not saved'
    },
    'comic-mode': {
      pending: 'Saving comic view preference',
      succeeded: 'Comic view preference saved',
      failed: 'Comic view preference was not saved'
    },
    'migration-notice': {
      pending: 'Dismissing edition notice',
      succeeded: 'Edition notice dismissed',
      failed: 'Edition notice was not dismissed'
    }
  } as const;
  return messages[status.kind][status.status];
}
