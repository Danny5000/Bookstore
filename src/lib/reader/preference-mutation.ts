import type {
  PreferencesMutationInput,
  ReaderPreferencesDto
} from '$lib/types/library';
import {
  readerMutationRetryDelaysMs,
  runReaderMutation,
  type ReaderMutationStatus
} from './mutation-status';

type PreferenceValues = Omit<PreferencesMutationInput, 'expectedVersion'>;

interface PreferenceMutationQueueOptions {
  current: () => ReaderPreferencesDto;
  save: (input: PreferencesMutationInput) => Promise<ReaderPreferencesDto>;
  onAdopt: (value: ReaderPreferencesDto) => void;
  onStatus: (status: ReaderMutationStatus) => void;
  signal?: AbortSignal;
}

export function createPreferenceMutationQueue(options: PreferenceMutationQueueOptions): {
  update(values: Partial<PreferenceValues>): void;
} {
  let desired: PreferenceValues | null = null;
  let running = false;

  const update = (values: Partial<PreferenceValues>): void => {
    const current = desired ?? options.current();
    desired = {
      fontSize: current.fontSize,
      typeface: current.typeface,
      paper: current.paper,
      ...values
    };
    if (running) return;
    running = true;
    void runReaderMutation({
      kind: 'preferences',
      work: async () => {
        let saved = options.current();
        while (desired) {
          const target = desired;
          saved = await options.save({ ...target, expectedVersion: saved.version });
          options.onAdopt(saved);
          if (desired === target) desired = null;
        }
        return saved;
      },
      onStatus: options.onStatus,
      ...(options.signal ? { signal: options.signal } : {}),
      retryDelaysMs: readerMutationRetryDelaysMs,
      onConflict: (current) => {
        desired = null;
        options.onAdopt(current);
      },
      onFailure: () => { desired = null; }
    }).finally(() => { running = false; });
  };

  return { update };
}
