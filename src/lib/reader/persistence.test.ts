import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ReaderInitialStateDto, ReaderLocation } from '$lib/types/library';
import type { ProseReaderDocument } from '$lib/types/publication';
import {
  createMemoryReaderPersistence,
  createPreviewReaderPersistence,
  createServerReaderPersistence
} from './persistence';

const titleId = randomUUID();
const revisionId = randomUUID();
const presentationId = randomUUID();
const blockId = randomUUID();
const otherBlockId = randomUUID();

const initialState: ReaderInitialStateDto = {
  progress: null,
  bookmarks: [],
  preferences: { fontSize: 18, typeface: 'serif', paper: 'white', version: 0 },
  titlePreferences: null,
  migrationNotice: null
};

const document: ProseReaderDocument = {
  titleId,
  revisionId,
  presentationId,
  title: 'Adapter Book',
  access: 'preview',
  readingDirection: 'ltr',
  format: 'prose',
  sections: [
    {
      id: randomUUID(),
      ordinal: 0,
      label: 'Preview',
      blocks: [
        {
          id: blockId,
          ordinal: 0,
          content: { kind: 'paragraph', fragments: [{ text: 'preview', marks: [] }] }
        }
      ]
    }
  ],
  images: []
};

describe('reader persistence adapters', () => {
  it('uses only same-origin routes, credentials, strict JSON, and parsed responses', async () => {
    const updatedAt = new Date().toISOString();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/^\/api\/reader-state\//u);
      expect(init?.credentials).toBe('same-origin');
      expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
      return new Response(
        JSON.stringify({
          revisionId,
          location: { format: 'prose', blockId, offset: 2 },
          version: 1,
          updatedAt
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const adapter = createServerReaderPersistence({ titleId, initialState, fetcher });
    await expect(
      adapter.saveProgress({
        location: { format: 'prose', blockId, offset: 2 },
        expectedVersion: 0
      })
    ).resolves.toMatchObject({ version: 1 });
    expect(fetcher).toHaveBeenCalledWith(
      `/api/reader-state/${titleId}/progress`,
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' })
    );

    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    await expect(
      adapter.saveProgress({
        location: { format: 'prose', blockId, offset: 3 },
        expectedVersion: 1
      })
    ).rejects.toMatchObject({ name: 'ReaderPersistenceError', retryable: false });
    expect(adapter).not.toHaveProperty('grant');
    expect(adapter).not.toHaveProperty('owns');
  });

  it('scopes preview state to the publication and clamps it to the preview document', async () => {
    const records = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => records.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => records.set(key, value))
    };
    const fetcher = vi.fn();
    const first = createPreviewReaderPersistence({
      document,
      initialState,
      storage,
      now: () => new Date('2026-08-09T12:00:00.000Z'),
      uuid: () => randomUUID()
    });
    const invalidLocation: ReaderLocation = { format: 'prose', blockId: otherBlockId, offset: 99 };
    const saved = await first.saveProgress({ location: invalidLocation, expectedVersion: 0 });
    expect(saved.location).toEqual({ format: 'prose', blockId, offset: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    const [key] = storage.setItem.mock.calls[0] ?? [];
    expect(key).toContain('v1');
    expect(key).toContain(titleId);
    expect(key).toContain(revisionId);
    expect(key).toContain(presentationId);

    const restored = createPreviewReaderPersistence({ document, initialState, storage });
    expect(restored.getInitialState().progress?.location).toEqual({
      format: 'prose',
      blockId,
      offset: 0
    });
    const nextPresentation = createPreviewReaderPersistence({
      document: { ...document, presentationId: randomUUID() },
      initialState,
      storage
    });
    expect(nextPresentation.getInitialState()).toEqual(initialState);
    expect(first).not.toHaveProperty('grant');
  });

  it('keeps admin-review memory state isolated per adapter and performs no I/O', async () => {
    const first = createMemoryReaderPersistence({ document, initialState });
    const second = createMemoryReaderPersistence({ document, initialState });
    const bookmark = await first.createBookmark({ format: 'prose', blockId, offset: 2 });
    await first.savePreferences({
      fontSize: 20,
      typeface: 'georgia',
      paper: 'dim',
      expectedVersion: 0
    });
    expect(first.getInitialState()).toMatchObject({
      bookmarks: [{ id: bookmark.id }],
      preferences: { fontSize: 20, typeface: 'georgia', paper: 'dim', version: 1 }
    });
    expect(second.getInitialState()).toEqual(initialState);
    expect(first.kind).toBe('memory');
    expect(first).not.toHaveProperty('grant');
  });
});
