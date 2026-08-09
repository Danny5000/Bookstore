import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Actor } from '$lib/server/auth/admin-policy';
import { CatalogDomainError } from '$lib/server/catalog/errors';
import { IngestionError } from '$lib/server/ingestion/errors';
import { UploadError } from '$lib/server/uploads/multipart';

const database = {};
const storage = { delete: vi.fn().mockResolvedValue(undefined) };
vi.mock('$lib/server/db/runtime', () => ({ getDatabaseClient: () => ({ db: database }) }));
vi.mock('$lib/server/storage/runtime', () => ({ getObjectStorage: () => storage }));
vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({ ingestion: { maxUploadBytes: 100_000_000 } })
}));
vi.mock('$lib/server/catalog/titles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/catalog/titles')>();
  return {
    ...actual,
    listAdminTitles: vi.fn(),
    getAdminTitleDetail: vi.fn(),
    createPrivateTitle: vi.fn(),
    updateTitleMetadata: vi.fn()
  };
});
vi.mock('$lib/server/catalog/revisions', () => ({
  listAdminRevisions: vi.fn(),
  getAdminRevisionReview: vi.fn(),
  getAdminRevisionStatus: vi.fn(),
  retryFailedRevision: vi.fn()
}));
vi.mock('$lib/server/catalog/reader', () => ({ getAdminRevisionReader: vi.fn() }));
vi.mock('$lib/server/catalog/covers', () => ({
  confirmCoverSuggestion: vi.fn(),
  replaceTitleCover: vi.fn()
}));
vi.mock('$lib/server/catalog/presentations', () => ({
  saveDraftPresentation: vi.fn(),
  publishReaderSettings: vi.fn()
}));
vi.mock('$lib/server/catalog/publication', () => ({
  activatePrivateRevision: vi.fn(),
  publishTitleToStorefront: vi.fn(),
  publishReplacementRevision: vi.fn(),
  rollbackRevision: vi.fn(),
  withdrawTitle: vi.fn()
}));
vi.mock('$lib/server/uploads/multipart', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/uploads/multipart')>();
  return { ...actual, parseSingleFileMultipart: vi.fn() };
});
vi.mock('$lib/server/uploads/stream-object', () => ({ streamObjectWithSha256: vi.fn() }));

import { load as loadCatalog } from './+page.server';
import { load as loadOverview } from '../+page.server';
import { actions as newActions } from './new/+page.server';
import { actions as titleActions, load as loadTitle } from './[titleId]/+page.server';
import { POST as uploadCover } from './[titleId]/cover/+server';
import {
  actions as revisionActions,
  load as loadRevision
} from './[titleId]/revisions/[revisionId]/+page.server';
import { GET as revisionStatus } from './[titleId]/revisions/[revisionId]/status/+server';
import {
  createPrivateTitle,
  getAdminTitleDetail,
  listAdminTitles,
  updateTitleMetadata
} from '$lib/server/catalog/titles';
import {
  getAdminRevisionReview,
  getAdminRevisionStatus,
  listAdminRevisions,
  retryFailedRevision
} from '$lib/server/catalog/revisions';
import { getAdminRevisionReader } from '$lib/server/catalog/reader';
import { confirmCoverSuggestion, replaceTitleCover } from '$lib/server/catalog/covers';
import { publishReaderSettings, saveDraftPresentation } from '$lib/server/catalog/presentations';
import {
  activatePrivateRevision,
  publishReplacementRevision,
  publishTitleToStorefront,
  rollbackRevision,
  withdrawTitle
} from '$lib/server/catalog/publication';
import { parseSingleFileMultipart } from '$lib/server/uploads/multipart';
import { streamObjectWithSha256 } from '$lib/server/uploads/stream-object';

const titleId = randomUUID();
const revisionId = randomUUID();
const presentationId = randomUUID();
const suggestionId = randomUUID();
const admin: Actor = { type: 'user', id: randomUUID(), roles: ['admin'] };
const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };
const anonymous: Actor = { type: 'anonymous' };

function event(
  actor: Actor,
  path: string,
  values: Record<string, string> = {},
  params: Record<string, string> = {}
) {
  return {
    locals: { actor },
    params,
    request: new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'x-request-id': 'request-123' },
      body: new URLSearchParams(values)
    }),
    route: { id: path }
  };
}

function metadataValues() {
  return {
    slug: 'new-title',
    title: 'New Title',
    subtitle: '',
    description: 'Description',
    creatorName: 'Writer',
    format: 'prose',
    priceMinor: '1299',
    currency: 'usd'
  };
}

describe('admin catalog authorization', () => {
  it('rejects list, editor, and review loads before querying', async () => {
    await expect(loadCatalog({ locals: { actor: anonymous } } as never)).rejects.toMatchObject({ status: 401 });
    await expect(loadTitle({ locals: { actor: customer }, params: { titleId } } as never)).rejects.toMatchObject({ status: 403 });
    await expect(loadRevision({ locals: { actor: anonymous }, params: { titleId, revisionId } } as never)).rejects.toMatchObject({ status: 401 });
    expect(listAdminTitles).not.toHaveBeenCalled();
    expect(getAdminTitleDetail).not.toHaveBeenCalled();
    expect(getAdminRevisionReview).not.toHaveBeenCalled();
  });

  it('rejects actions and endpoints before consuming their bodies', async () => {
    const actionEvent = event(customer, '/admin/catalog/new', metadataValues());
    const formData = vi.spyOn(actionEvent.request, 'formData');
    await expect(newActions.default?.(actionEvent as never)).resolves.toMatchObject({ status: 403 });
    expect(formData).not.toHaveBeenCalled();

    const coverEvent = event(anonymous, `/admin/catalog/${titleId}/cover`, {}, { titleId });
    const coverResponse = await uploadCover(coverEvent as never);
    expect(coverResponse.status).toBe(401);
    expect(parseSingleFileMultipart).not.toHaveBeenCalled();

    const statusResponse = await revisionStatus({
      ...event(customer, '', {}, { titleId, revisionId }),
      request: new Request('http://localhost/status')
    } as never);
    expect(statusResponse.status).toBe(403);
    expect(getAdminRevisionStatus).not.toHaveBeenCalled();
  });
});

describe('admin catalog routes', () => {
  it('derives overview counts from safe catalog queries', async () => {
    vi.mocked(listAdminTitles).mockResolvedValueOnce([
      { id: titleId, visibility: 'private' },
      { id: randomUUID(), visibility: 'public' }
    ] as never);
    await expect(loadOverview({ locals: { actor: admin } } as never)).resolves.toEqual({
      catalog: { total: 2, private: 1, public: 1 }
    });
  });

  it('lists safe title rows and creates a private title with request context', async () => {
    const title = { id: titleId, title: 'New Title', visibility: 'private' };
    vi.mocked(listAdminTitles).mockResolvedValueOnce([title] as never);
    await expect(loadCatalog({ locals: { actor: admin } } as never)).resolves.toMatchObject({ titles: [title] });

    vi.mocked(createPrivateTitle).mockResolvedValueOnce(title as never);
    await expect(
      newActions.default?.(event(admin, '/admin/catalog/new', metadataValues()) as never)
    ).rejects.toMatchObject({ status: 303, location: `/admin/catalog/${titleId}` });
    expect(createPrivateTitle).toHaveBeenCalledWith(database, {
      actor: admin,
      correlationId: 'request-123',
      requestMetadata: { method: 'POST', routeId: '/admin/catalog/new' },
      input: expect.objectContaining({ format: 'prose', priceMinor: 1299, currency: 'USD' })
    });
  });

  it('redacts title storage pointers from page data', async () => {
    vi.mocked(listAdminTitles).mockResolvedValueOnce([{
      id: titleId,
      slug: 'safe-title',
      title: 'Safe Title',
      subtitle: null,
      description: 'Description',
      creatorName: 'Writer',
      format: 'prose',
      priceMinor: 100,
      currency: 'USD',
      visibility: 'private',
      activeRevisionId: null,
      coverStorageKey: 'titles/private/cover.webp',
      coverMediaType: 'image/webp',
      coverChecksumSha256: 'a'.repeat(64),
      coverByteSize: 100,
      coverWidth: 600,
      coverHeight: 900,
      coverUpdatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    }]);
    const result = await loadCatalog({ locals: { actor: admin } } as never);
    expect(JSON.stringify(result)).not.toMatch(/storage|private\/cover/iu);
  });

  it('loads a title with revisions and maps validation/domain failures safely', async () => {
    const title = { id: titleId, title: 'Title' };
    vi.mocked(getAdminTitleDetail).mockResolvedValueOnce(title as never);
    vi.mocked(listAdminRevisions).mockResolvedValueOnce([]);
    await expect(loadTitle({ locals: { actor: admin }, params: { titleId } } as never)).resolves.toMatchObject({ title, revisions: [] });

    const validation = z.string().safeParse(1);
    if (validation.success) throw new Error('Expected validation failure');
    vi.mocked(updateTitleMetadata).mockRejectedValueOnce(validation.error);
    const invalid = await titleActions.metadata?.(
      event(admin, `/admin/catalog/${titleId}`, metadataValues(), { titleId }) as never
    );
    expect(invalid).toMatchObject({ status: 400 });

    vi.mocked(updateTitleMetadata).mockRejectedValueOnce(new CatalogDomainError('title_not_found'));
    const missing = await titleActions.metadata?.(
      event(admin, `/admin/catalog/${titleId}`, metadataValues(), { titleId }) as never
    );
    expect(missing).toMatchObject({ status: 404 });
  });

  it('passes title lifecycle actions only explicit IDs and server request context', async () => {
    vi.mocked(publishTitleToStorefront).mockResolvedValueOnce({ id: titleId } as never);
    vi.mocked(withdrawTitle).mockResolvedValueOnce({ id: titleId } as never);
    await titleActions.publish?.(event(admin, `/admin/catalog/${titleId}`, {}, { titleId }) as never);
    await titleActions.withdraw?.(event(admin, `/admin/catalog/${titleId}`, {}, { titleId }) as never);
    for (const service of [publishTitleToStorefront, withdrawTitle]) {
      expect(service).toHaveBeenCalledWith(database, expect.objectContaining({
        actor: admin,
        correlationId: 'request-123',
        requestMetadata: { method: 'POST', routeId: `/admin/catalog/${titleId}` },
        input: { titleId }
      }));
    }
  });

  it('loads full ready revision review data and an administrator document', async () => {
    const review = {
      title: { id: titleId, format: 'comic' },
      revision: { id: revisionId, state: 'ready_for_review' },
      draft: { id: presentationId },
      published: null,
      warnings: [],
      suggestion: null
    };
    const document = { titleId, revisionId, access: 'admin' };
    vi.mocked(getAdminRevisionReview).mockResolvedValueOnce(review as never);
    vi.mocked(getAdminRevisionReader).mockResolvedValueOnce(document as never);
    await expect(loadRevision({ locals: { actor: admin }, params: { titleId, revisionId } } as never)).resolves.toMatchObject({ review, document });
    expect(getAdminRevisionReader).toHaveBeenCalledWith(database, admin, revisionId, 'draft');
  });

  it('routes settings, suggestion, lifecycle, and retry commands', async () => {
    const common = { titleId, revisionId };
    vi.mocked(confirmCoverSuggestion).mockResolvedValueOnce({ titleId, checksumSha256: 'a'.repeat(64) });
    await revisionActions.confirmCover?.(event(admin, '/review', { suggestionId }, common) as never);
    expect(confirmCoverSuggestion).toHaveBeenCalledWith(database, storage, expect.objectContaining({
      actor: admin,
      correlationId: 'request-123',
      requestMetadata: { method: 'POST', routeId: '/review' },
      input: { ...common, suggestionId }
    }));

    const settings = {
      presentationId,
      expectedUpdatedAt: new Date().toISOString(),
      format: 'comic',
      readingDirection: 'rtl',
      guidedViewEnabled: 'false',
      previewSectionId: '',
      previewBlockId: '',
      previewPageId: randomUUID(),
      panels: '[]'
    };
    vi.mocked(saveDraftPresentation).mockResolvedValueOnce({ id: presentationId } as never);
    await revisionActions.saveSettings?.(event(admin, '/review', settings, common) as never);
    expect(saveDraftPresentation).toHaveBeenCalledWith(database, expect.objectContaining({
      actor: admin,
      requestMetadata: { method: 'POST', routeId: '/review' },
      input: expect.objectContaining({ ...common, format: 'comic', panels: [] })
    }));

    for (const [name, service] of [
      ['publishSettings', publishReaderSettings],
      ['activatePrivate', activatePrivateRevision],
      ['publishReplacement', publishReplacementRevision],
      ['rollback', rollbackRevision],
      ['retry', retryFailedRevision]
    ] as const) {
      vi.mocked(service).mockResolvedValueOnce({ id: revisionId } as never);
      await revisionActions[name]?.(event(admin, '/review', {
        presentationId,
        expectedUpdatedAt: new Date().toISOString()
      }, common) as never);
      expect(service).toHaveBeenCalled();
    }
  });

  it('returns only safe revision status fields with no caching', async () => {
    vi.mocked(getAdminRevisionStatus).mockResolvedValueOnce({
      state: 'failed',
      processingStartedAt: null,
      processedAt: new Date('2026-08-09T12:00:00Z'),
      failure: { code: 'invalid_epub', message: 'The EPUB is invalid' },
      warnings: []
    });
    const response = await revisionStatus({
      ...event(admin, '', {}, { titleId, revisionId }),
      request: new Request('http://localhost/status')
    } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).not.toMatch(/storage|path/iu);
  });

  it('streams one cover file through normalization and never returns its storage key', async () => {
    vi.mocked(parseSingleFileMultipart).mockResolvedValueOnce({
      filename: 'cover.png',
      mediaType: 'image/png',
      file: {} as never,
      fields: {},
      completion: Promise.resolve()
    });
    vi.mocked(streamObjectWithSha256).mockResolvedValueOnce({ byteSize: 42, checksumSha256: 'b'.repeat(64) });
    vi.mocked(replaceTitleCover).mockResolvedValueOnce({ titleId, checksumSha256: 'c'.repeat(64) });
    const response = await uploadCover(event(admin, `/admin/catalog/${titleId}/cover`, {}, { titleId }) as never);
    expect(response.status).toBe(202);
    expect(await response.text()).not.toMatch(/storage|path/iu);
    expect(storage.delete).toHaveBeenCalled();
  });

  it('maps cover size and decoded media failures to safe responses', async () => {
    vi.mocked(parseSingleFileMultipart).mockRejectedValueOnce(
      new UploadError('file_size_limit', 'Uploaded file exceeds the size limit')
    );
    const tooLarge = await uploadCover(event(admin, `/admin/catalog/${titleId}/cover`, {}, { titleId }) as never);
    expect(tooLarge.status).toBe(413);

    vi.mocked(parseSingleFileMultipart).mockResolvedValueOnce({
      filename: 'cover.gif', mediaType: 'image/gif', file: {} as never,
      fields: {}, completion: Promise.resolve()
    });
    vi.mocked(streamObjectWithSha256).mockResolvedValueOnce({ byteSize: 42, checksumSha256: 'd'.repeat(64) });
    vi.mocked(replaceTitleCover).mockRejectedValueOnce(
      new IngestionError('unsupported_media', 'Cover must be a JPEG or PNG', false)
    );
    const unsupported = await uploadCover(event(admin, `/admin/catalog/${titleId}/cover`, {}, { titleId }) as never);
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toEqual({
      code: 'unsupported_media',
      message: 'Cover must be a JPEG or PNG'
    });
  });
});
