import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';

const { resolvePublicationAccess, getReaderDocumentForAccess, getReaderInitialState } = vi.hoisted(
  () => ({
    resolvePublicationAccess: vi.fn(),
    getReaderDocumentForAccess: vi.fn(),
    getReaderInitialState: vi.fn()
  })
);
vi.mock('$lib/server/db/runtime', () => ({ getDatabaseClient: () => ({ db: {} }) }));
vi.mock('$lib/server/library/access', () => ({ resolvePublicationAccess }));
vi.mock('$lib/server/catalog/reader', () => ({
  getPublicPreview: vi.fn(),
  getReaderDocumentForAccess
}));
vi.mock('$lib/server/reader-state/service', () => ({ getReaderInitialState }));

import { load } from './+page.server';

const titleId = randomUUID();
const revisionId = randomUUID();
const presentationId = randomUUID();
const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };
const anonymous: Actor = { type: 'anonymous' };
const root = {
  title: { id: titleId, slug: 'reader-title' },
  revisionId,
  presentation: { id: presentationId }
};
const document = {
  titleId,
  revisionId,
  presentationId,
  title: 'Reader Title',
  access: 'entitled'
};
const initialState = {
  progress: null,
  bookmarks: [],
  preferences: { fontSize: 18, typeface: 'serif', paper: 'white', version: 0 },
  titlePreferences: null,
  migrationNotice: null
};

function event(actor: Actor) {
  return {
    params: { id: titleId },
    locals: { actor },
    url: new URL(`https://books.example.com/read/${titleId}`),
    setHeaders: vi.fn()
  };
}

describe('reader page access loader', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns full entitled state with server persistence and private caching', async () => {
    resolvePublicationAccess.mockResolvedValueOnce({
      level: 'entitled',
      titleId,
      revisionId,
      presentationId,
      root
    });
    getReaderDocumentForAccess.mockResolvedValueOnce(document);
    getReaderInitialState.mockResolvedValueOnce(initialState);
    const request = event(customer);
    await expect(load(request as never)).resolves.toMatchObject({
      document,
      initialState,
      persistenceKind: 'server',
      slug: 'reader-title'
    });
    expect(getReaderInitialState).toHaveBeenCalledWith(
      expect.objectContaining({ actor: customer, titleId })
    );
    expect(request.setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
  });

  it('returns only a preview document and presentation-local persistence configuration', async () => {
    resolvePublicationAccess.mockResolvedValueOnce({
      level: 'preview',
      titleId,
      revisionId,
      presentationId,
      root
    });
    getReaderDocumentForAccess.mockResolvedValueOnce({ ...document, access: 'preview' });
    const request = event(anonymous);
    await expect(load(request as never)).resolves.toMatchObject({
      document: { access: 'preview' },
      persistenceKind: 'preview-local',
      initialState
    });
    expect(getReaderInitialState).not.toHaveBeenCalled();
  });

  it('uses memory persistence for an active admin edition and hides denied titles', async () => {
    const admin: Actor = { type: 'user', id: randomUUID(), roles: ['admin'] };
    resolvePublicationAccess.mockResolvedValueOnce({
      level: 'admin',
      titleId,
      revisionId,
      presentationId,
      root
    });
    getReaderDocumentForAccess.mockResolvedValueOnce({ ...document, access: 'admin' });
    await expect(load(event(admin) as never)).resolves.toMatchObject({
      persistenceKind: 'memory',
      document: { access: 'admin' }
    });

    resolvePublicationAccess.mockResolvedValueOnce({ level: 'denied' });
    await expect(load(event(customer) as never)).rejects.toMatchObject({ status: 404 });
  });
});
