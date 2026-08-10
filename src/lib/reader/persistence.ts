import { z, type ZodType } from 'zod';
import {
  readerBookmarkSchema,
  readerInitialStateSchema,
  readerMigrationNoticeSchema,
  readerPreferencesSchema,
  readerProgressSchema,
  readerTitlePreferencesSchema,
  staleReaderStateSchema,
  type PreferencesMutationInput,
  type ProgressMutationInput,
  type ReaderBookmarkDto,
  type ReaderInitialStateDto,
  type ReaderLocation,
  type ReaderPreferencesDto,
  type ReaderProgressDto,
  type ReaderTitlePreferencesDto,
  type TitlePreferencesMutationInput
} from '$lib/types/library';
import type { ReaderDocument } from '$lib/types/publication';
import { proseBlockVisibleLength } from './locations';

export interface ReaderPersistence {
  readonly kind: 'server' | 'preview-local' | 'memory';
  getInitialState(): ReaderInitialStateDto;
  saveProgress(input: ProgressMutationInput): Promise<ReaderProgressDto>;
  createBookmark(location: ReaderLocation): Promise<ReaderBookmarkDto>;
  deleteBookmark(bookmarkId: string): Promise<void>;
  savePreferences(input: PreferencesMutationInput): Promise<ReaderPreferencesDto>;
  saveTitlePreferences(
    input: TitlePreferencesMutationInput
  ): Promise<ReaderTitlePreferencesDto>;
  acknowledgeMigration(targetRevisionId: string): Promise<void>;
}

export interface ReaderProgressKeepalive {
  saveProgressKeepalive(input: ProgressMutationInput): void;
}

export class ReaderPersistenceError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number | null; retryable: boolean }) {
    super(message);
    this.name = 'ReaderPersistenceError';
    this.status = options.status ?? null;
    this.retryable = options.retryable;
  }
}

export class ReaderConflictError<Value> extends ReaderPersistenceError {
  constructor(readonly current: Value) {
    super('Reader state changed on another client', { status: 409, retryable: false });
    this.name = 'ReaderConflictError';
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function cloneState(state: ReaderInitialStateDto): ReaderInitialStateDto {
  return structuredClone(state);
}

async function parsedJson<Schema extends ZodType>(
  response: Response,
  schema: Schema
): Promise<z.infer<Schema>> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new ReaderPersistenceError('Reader response was not JSON', {
      status: response.status,
      retryable: false
    });
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ReaderPersistenceError('Reader response contained invalid JSON', {
      status: response.status,
      retryable: false
    });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ReaderPersistenceError('Reader response did not match its contract', {
      status: response.status,
      retryable: false
    });
  }
  return parsed.data;
}

function mutationInit(method: string, body?: unknown, keepalive = false): RequestInit {
  return {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(keepalive ? { keepalive: true } : {})
  };
}

async function requestMutation<Schema extends ZodType>(
  fetcher: FetchLike,
  path: string,
  init: RequestInit,
  schema: Schema
): Promise<z.infer<Schema>> {
  let response: Response;
  try {
    response = await fetcher(path, init);
  } catch (cause: unknown) {
    throw new ReaderPersistenceError(
      cause instanceof Error ? cause.message : 'Reader request failed',
      { retryable: true }
    );
  }
  if (response.status === 409) {
    const conflict = await parsedJson(response, staleReaderStateSchema(schema));
    throw new ReaderConflictError((conflict as { current: z.infer<Schema> }).current);
  }
  if (!response.ok) {
    throw new ReaderPersistenceError(`Reader request failed with ${response.status}`, {
      status: response.status,
      retryable: response.status === 503
    });
  }
  return parsedJson(response, schema);
}

export function createServerReaderPersistence(input: {
  titleId: string;
  initialState: ReaderInitialStateDto;
  fetcher?: FetchLike;
}): ReaderPersistence & ReaderProgressKeepalive {
  const fetcher = input.fetcher ?? globalThis.fetch.bind(globalThis);
  const state = cloneState(input.initialState);
  const titlePath = `/api/reader-state/${encodeURIComponent(input.titleId)}`;
  return {
    kind: 'server',
    getInitialState: () => cloneState(state),
    async saveProgress(mutation) {
      const value = await requestMutation(
        fetcher,
        `${titlePath}/progress`,
        mutationInit('PUT', mutation),
        readerProgressSchema
      );
      state.progress = value;
      return value;
    },
    saveProgressKeepalive(mutation) {
      void fetcher(`${titlePath}/progress`, mutationInit('PUT', mutation, true)).catch(() => {});
    },
    async createBookmark(location) {
      const value = await requestMutation(
        fetcher,
        `${titlePath}/bookmarks`,
        mutationInit('POST', { location }),
        readerBookmarkSchema
      );
      if (!state.bookmarks.some((bookmark) => bookmark.id === value.id)) {
        state.bookmarks.push(value);
      }
      return value;
    },
    async deleteBookmark(bookmarkId) {
      let response: Response;
      try {
        response = await fetcher(
          `${titlePath}/bookmarks/${encodeURIComponent(bookmarkId)}`,
          mutationInit('DELETE')
        );
      } catch (cause: unknown) {
        throw new ReaderPersistenceError(
          cause instanceof Error ? cause.message : 'Reader request failed',
          { retryable: true }
        );
      }
      if (!response.ok) {
        throw new ReaderPersistenceError(`Reader request failed with ${response.status}`, {
          status: response.status,
          retryable: response.status === 503
        });
      }
      state.bookmarks = state.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId);
    },
    async savePreferences(mutation) {
      const value = await requestMutation(
        fetcher,
        '/api/reader-state/preferences',
        mutationInit('PUT', mutation),
        readerPreferencesSchema
      );
      state.preferences = value;
      return value;
    },
    async saveTitlePreferences(mutation) {
      const value = await requestMutation(
        fetcher,
        `${titlePath}/preferences`,
        mutationInit('PUT', mutation),
        readerTitlePreferencesSchema
      );
      state.titlePreferences = value;
      return value;
    },
    async acknowledgeMigration(targetRevisionId) {
      const value = await requestMutation(
        fetcher,
        `${titlePath}/migration-notice`,
        mutationInit('PATCH', { targetRevisionId }),
        readerMigrationNoticeSchema
      );
      state.migrationNotice = value;
    }
  };
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const previewEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  titleId: z.uuid(),
  revisionId: z.uuid(),
  presentationId: z.uuid(),
  state: readerInitialStateSchema
});

function previewKey(document: ReaderDocument): string {
  return [
    'pale-orbit.reader-preview.v1',
    document.titleId,
    document.revisionId,
    document.presentationId
  ].join(':');
}

function firstDocumentLocation(document: ReaderDocument): ReaderLocation | null {
  if (document.format === 'prose') {
    const block = document.sections.flatMap((section) => section.blocks)[0];
    return block ? { format: 'prose', blockId: block.id, offset: 0 } : null;
  }
  const page = document.pages[0];
  return page ? { format: 'comic', pageId: page.id, panelOrdinal: null } : null;
}

function clampLocation(document: ReaderDocument, location: ReaderLocation): ReaderLocation | null {
  if (document.format === 'prose' && location.format === 'prose') {
    const block = document.sections
      .flatMap((section) => section.blocks)
      .find((candidate) => candidate.id === location.blockId);
    if (block) {
      return {
        ...location,
        offset: Math.min(location.offset, proseBlockVisibleLength(block.content))
      };
    }
  }
  if (document.format === 'comic' && location.format === 'comic') {
    const page = document.pages.find((candidate) => candidate.id === location.pageId);
    if (page) {
      const panelOrdinal =
        location.panelOrdinal !== null &&
        document.guidedViewEnabled &&
        page.panels.some((panel) => panel.ordinal === location.panelOrdinal)
          ? location.panelOrdinal
          : null;
      return { ...location, panelOrdinal };
    }
  }
  return firstDocumentLocation(document);
}

function localPersistence(input: {
  kind: 'preview-local' | 'memory';
  document: ReaderDocument;
  initialState: ReaderInitialStateDto;
  load?: () => ReaderInitialStateDto | null;
  persist?: (state: ReaderInitialStateDto) => void;
  now?: () => Date;
  uuid?: () => string;
}): ReaderPersistence & ReaderProgressKeepalive {
  const now = input.now ?? (() => new Date());
  const uuid = input.uuid ?? (() => globalThis.crypto.randomUUID());
  const state = cloneState(input.load?.() ?? input.initialState);
  const write = (): void => input.persist?.(state);
  const stale = <Value>(expected: number, current: Value & { version: number }): void => {
    if (expected !== current.version) throw new ReaderConflictError(structuredClone(current));
  };
  const persistProgress = (mutation: ProgressMutationInput): ReaderProgressDto => {
    const location = clampLocation(input.document, mutation.location);
    if (!location) {
      throw new ReaderPersistenceError('Reader document has no valid location', {
        retryable: false
      });
    }
    const currentVersion = state.progress?.version ?? 0;
    if (mutation.expectedVersion !== currentVersion && state.progress) {
      throw new ReaderConflictError(structuredClone(state.progress));
    }
    const value: ReaderProgressDto = {
      revisionId: input.document.revisionId,
      location,
      version: currentVersion + 1,
      updatedAt: now().toISOString()
    };
    state.progress = value;
    write();
    return structuredClone(value);
  };
  return {
    kind: input.kind,
    getInitialState: () => cloneState(state),
    async saveProgress(mutation) {
      return persistProgress(mutation);
    },
    saveProgressKeepalive(mutation) {
      try {
        persistProgress(mutation);
      } catch {
        // Page lifecycle flushes are intentionally best effort.
      }
    },
    async createBookmark(location) {
      const bounded = clampLocation(input.document, location);
      if (!bounded) {
        throw new ReaderPersistenceError('Reader document has no valid location', {
          retryable: false
        });
      }
      const existing = state.bookmarks.find(
        (bookmark) => JSON.stringify(bookmark.location) === JSON.stringify(bounded)
      );
      if (existing) return structuredClone(existing);
      const value: ReaderBookmarkDto = {
        id: uuid(),
        revisionId: input.document.revisionId,
        location: bounded,
        createdAt: now().toISOString()
      };
      state.bookmarks.push(value);
      write();
      return structuredClone(value);
    },
    async deleteBookmark(bookmarkId) {
      state.bookmarks = state.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId);
      write();
    },
    async savePreferences(mutation) {
      stale(mutation.expectedVersion, state.preferences);
      const value: ReaderPreferencesDto = {
        fontSize: mutation.fontSize,
        typeface: mutation.typeface,
        paper: mutation.paper,
        version: state.preferences.version + 1
      };
      state.preferences = value;
      write();
      return structuredClone(value);
    },
    async saveTitlePreferences(mutation) {
      const current = state.titlePreferences ?? {
        titleId: input.document.titleId,
        comicMode: 'page' as const,
        version: 0
      };
      stale(mutation.expectedVersion, current);
      const value: ReaderTitlePreferencesDto = {
        titleId: input.document.titleId,
        comicMode: mutation.comicMode,
        version: current.version + 1
      };
      state.titlePreferences = value;
      write();
      return structuredClone(value);
    },
    async acknowledgeMigration(targetRevisionId) {
      if (state.migrationNotice?.targetRevisionId === targetRevisionId) {
        state.migrationNotice = { ...state.migrationNotice, acknowledged: true };
        write();
      }
    }
  };
}

export function createPreviewReaderPersistence(input: {
  document: ReaderDocument;
  initialState: ReaderInitialStateDto;
  storage?: StorageLike;
  now?: () => Date;
  uuid?: () => string;
}): ReaderPersistence & ReaderProgressKeepalive {
  const storage = input.storage ?? globalThis.localStorage;
  const key = previewKey(input.document);
  return localPersistence({
    kind: 'preview-local',
    document: input.document,
    initialState: input.initialState,
    load: () => {
      let value: unknown;
      try {
        const stored = storage.getItem(key);
        if (!stored) return null;
        value = JSON.parse(stored);
      } catch {
        return null;
      }
      const parsed = previewEnvelopeSchema.safeParse(value);
      if (!parsed.success) return null;
      const envelope = parsed.data;
      if (
        envelope.titleId !== input.document.titleId ||
        envelope.revisionId !== input.document.revisionId ||
        envelope.presentationId !== input.document.presentationId
      ) return null;
      return envelope.state;
    },
    persist: (state) => {
      storage.setItem(
        key,
        JSON.stringify({
          version: 1,
          titleId: input.document.titleId,
          revisionId: input.document.revisionId,
          presentationId: input.document.presentationId,
          state
        })
      );
    },
    ...(input.now ? { now: input.now } : {}),
    ...(input.uuid ? { uuid: input.uuid } : {})
  });
}

export function createMemoryReaderPersistence(input: {
  document: ReaderDocument;
  initialState: ReaderInitialStateDto;
  now?: () => Date;
  uuid?: () => string;
}): ReaderPersistence & ReaderProgressKeepalive {
  return localPersistence({
    kind: 'memory',
    document: input.document,
    initialState: input.initialState,
    ...(input.now ? { now: input.now } : {}),
    ...(input.uuid ? { uuid: input.uuid } : {})
  });
}

export function progressKeepaliveFor(
  persistence: ReaderPersistence
): ((input: ProgressMutationInput) => void) | undefined {
  const candidate = persistence as Partial<ReaderProgressKeepalive>;
  return typeof candidate.saveProgressKeepalive === 'function'
    ? candidate.saveProgressKeepalive.bind(candidate)
    : undefined;
}
