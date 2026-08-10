import type { ProgressMutationInput, ReaderLocation, ReaderProgressDto } from '$lib/types/library';
import type { ReaderPersistence } from './persistence';
import { ReaderConflictError, ReaderPersistenceError } from './persistence';

export type ProgressSyncStatus =
  | 'idle'
  | 'pending'
  | 'synced'
  | 'retrying'
  | 'failed'
  | 'conflict';

export interface ProgressSyncState {
  status: ProgressSyncStatus;
  progress: ReaderProgressDto | null;
  error: string | null;
}

export interface ProgressSynchronizer {
  navigate(location: ReaderLocation): void;
  flush(): Promise<void>;
  flushBeforeAction<Value>(action: () => Promise<Value>): Promise<Value>;
  dispose(): void;
  snapshot(): ProgressSyncState;
}

const RETRY_DELAYS = [1_000, 2_000, 4_000] as const;

export function createProgressSynchronizer(input: {
  persistence: ReaderPersistence;
  initialProgress: ReaderProgressDto | null;
  onState?: (state: ProgressSyncState) => void;
  keepalive?: (input: ProgressMutationInput) => void;
}): ProgressSynchronizer {
  let state: ProgressSyncState = {
    status: 'idle',
    progress: input.initialProgress ? structuredClone(input.initialProgress) : null,
    error: null
  };
  let pending: ReaderLocation | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const publish = (next: ProgressSyncState): void => {
    state = next;
    input.onState?.(structuredClone(state));
  };
  const clearTimers = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    debounceTimer = null;
    retryTimer = null;
  };
  const mutationFor = (location: ReaderLocation): ProgressMutationInput => ({
    location,
    expectedVersion: state.progress?.version ?? 0
  });
  const wait = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        resolve();
      }, milliseconds);
    });

  const send = async (location: ReaderLocation): Promise<void> => {
    for (let retry = 0; retry <= RETRY_DELAYS.length; retry += 1) {
      try {
        const progress = await input.persistence.saveProgress(mutationFor(location));
        publish({ status: 'synced', progress, error: null });
        return;
      } catch (cause: unknown) {
        if (cause instanceof ReaderConflictError) {
          publish({
            status: 'conflict',
            progress: cause.current as ReaderProgressDto,
            error: cause.message
          });
          pending = null;
          return;
        }
        const retryable = cause instanceof ReaderPersistenceError && cause.retryable;
        if (!retryable || retry === RETRY_DELAYS.length || disposed) {
          publish({
            status: 'failed',
            progress: state.progress,
            error: cause instanceof Error ? cause.message : 'Progress could not be saved'
          });
          return;
        }
        publish({
          status: 'retrying',
          progress: state.progress,
          error: cause instanceof Error ? cause.message : 'Progress save will be retried'
        });
        await wait(RETRY_DELAYS[retry]!);
      }
    }
  };

  const runPending = async (): Promise<void> => {
    if (inFlight) {
      await inFlight;
      if (pending && !disposed) await runPending();
      return;
    }
    const location = pending;
    if (!location || disposed) return;
    pending = null;
    inFlight = send(location).finally(() => {
      inFlight = null;
    });
    await inFlight;
    if (pending && !disposed && !debounceTimer) await runPending();
  };

  return {
    navigate(location) {
      if (disposed) return;
      pending = structuredClone(location);
      if (debounceTimer) clearTimeout(debounceTimer);
      publish({ status: 'pending', progress: state.progress, error: null });
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void runPending();
      }, 750);
    },
    async flush() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      if (inFlight) await inFlight;
      await runPending();
    },
    async flushBeforeAction(action) {
      await this.flush();
      return action();
    },
    dispose() {
      if (disposed) return;
      clearTimers();
      if (pending) input.keepalive?.(mutationFor(pending));
      disposed = true;
    },
    snapshot: () => structuredClone(state)
  };
}
