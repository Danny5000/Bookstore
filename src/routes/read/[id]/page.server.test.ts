import { describe, expect, it, vi } from 'vitest';
import { ReaderStateNotFoundError } from '$lib/server/reader-state/errors';
import type { ReaderInitialStateDto } from '$lib/types/library';
import type { ProseReaderDocument } from '$lib/types/publication';

const titleId = '018f0000-0000-7000-8000-000000000100';
const revisionA = '018f0000-0000-7000-8000-000000000101';
const revisionB = '018f0000-0000-7000-8000-000000000201';
const presentationA = '018f0000-0000-7000-8000-000000000102';
const presentationB = '018f0000-0000-7000-8000-000000000202';
const blockA = '018f0000-0000-7000-8000-000000000104';
const blockB = '018f0000-0000-7000-8000-000000000204';

function proseDocument(
  revisionId: string,
  presentationId: string,
  blockId: string
): ProseReaderDocument {
  return {
    titleId,
    revisionId,
    presentationId,
    title: 'Replacement Reader',
    access: 'entitled',
    readingDirection: 'ltr',
    format: 'prose',
    sections: [{
      id: blockId.replace(/4$/u, '3'),
      ordinal: 0,
      label: 'One',
      blocks: [{
        id: blockId,
        ordinal: 0,
        content: { kind: 'paragraph', fragments: [{ text: revisionId, marks: [] }] }
      }]
    }],
    images: []
  };
}

const documentA = proseDocument(revisionA, presentationA, blockA);
const documentB = proseDocument(revisionB, presentationB, blockB);
const stateB: ReaderInitialStateDto = {
  progress: {
    revisionId: revisionB,
    location: { format: 'prose', blockId: blockB, offset: 0 },
    version: 1,
    updatedAt: '2026-08-09T12:00:00.000Z'
  },
  bookmarks: [],
  preferences: { fontSize: 18, typeface: 'serif', paper: 'white', version: 0 },
  titlePreferences: null,
  migrationNotice: null
};

const mocks = vi.hoisted(() => ({
  getReaderDocumentForAccess: vi.fn(),
  getEntitledInitialReader: vi.fn(),
  getReaderInitialState: vi.fn(),
  resolvePublicationAccess: vi.fn()
}));

vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: () => ({ db: {} })
}));
vi.mock('$lib/server/catalog/reader', () => ({
  getPublicPreview: vi.fn(),
  getReaderDocumentForAccess: mocks.getReaderDocumentForAccess,
  getEntitledInitialReader: mocks.getEntitledInitialReader
}));
vi.mock('$lib/server/library/access', () => ({
  resolvePublicationAccess: mocks.resolvePublicationAccess
}));
vi.mock('$lib/server/reader-state/service', () => ({
  getReaderInitialState: mocks.getReaderInitialState
}));

import { load } from './+page.server';

describe('entitled reader page load', () => {
  it('uses one current publication snapshot when replacement retires the access decision revision', async () => {
    mocks.resolvePublicationAccess.mockResolvedValue({
      level: 'entitled',
      titleId,
      revisionId: revisionA,
      presentationId: presentationA,
      root: { title: { id: titleId, slug: 'replacement-reader' } }
    });
    mocks.getReaderDocumentForAccess.mockResolvedValue(documentA);
    mocks.getReaderInitialState.mockResolvedValue(stateB);
    mocks.getEntitledInitialReader.mockResolvedValue({ document: documentB, initialState: stateB });

    const result = await (load as (event: unknown) => Promise<{
      document: ProseReaderDocument;
      initialState: ReaderInitialStateDto;
    }>)({
      params: { id: titleId },
      locals: { actor: { type: 'user', id: titleId, roles: ['customer'] } },
      setHeaders: vi.fn()
    });

    expect(mocks.getEntitledInitialReader).toHaveBeenCalledOnce();
    expect(result.document.revisionId).toBe(revisionB);
    expect(result.initialState.progress?.revisionId).toBe(result.document.revisionId);
    expect(JSON.stringify(result.document)).not.toContain(revisionA);
  });

  it('returns the uniform 404 when entitlement is revoked before the locked snapshot', async () => {
    mocks.resolvePublicationAccess.mockResolvedValue({
      level: 'entitled',
      titleId,
      revisionId: revisionA,
      presentationId: presentationA,
      root: { title: { id: titleId, slug: 'replacement-reader' } }
    });
    mocks.getEntitledInitialReader.mockRejectedValue(new ReaderStateNotFoundError());

    await expect((load as (event: unknown) => Promise<unknown>)({
      params: { id: titleId },
      locals: { actor: { type: 'user', id: titleId, roles: ['customer'] } },
      setHeaders: vi.fn()
    })).rejects.toMatchObject({ status: 404 });
  });
});
