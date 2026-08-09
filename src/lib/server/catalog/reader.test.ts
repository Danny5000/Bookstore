import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import {
  getAdminRevisionReader,
  getPublicPreview,
  getPublicTitleDetail,
  listPublicCatalog
} from './reader';

function databaseReturning(...results: unknown[][]): Database {
  return {
    select: vi.fn(() => {
      const value = results.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
        chain[method] = vi.fn(() => chain);
      }
      chain.then = (resolve: (value: unknown[]) => unknown, reject: (cause: unknown) => unknown) =>
        Promise.resolve(value).then(resolve, reject);
      return chain;
    })
  } as unknown as Database;
}

const titleId = randomUUID();
const revisionId = randomUUID();
const presentationId = randomUUID();
const firstSectionId = randomUUID();
const secondSectionId = randomUUID();
const firstBlockId = randomUUID();
const boundaryBlockId = randomUUID();
const laterBlockId = randomUUID();
const includedImageId = randomUUID();
const excludedImageId = randomUUID();
const firstPageId = randomUUID();
const boundaryPageId = randomUUID();
const laterPageId = randomUUID();

const title = {
  id: titleId,
  slug: 'reader-title',
  title: 'Reader Title',
  subtitle: null,
  description: 'A published title.',
  creatorName: 'Pale Orbit',
  format: 'prose' as const,
  priceMinor: 1299,
  currency: 'USD',
  visibility: 'public' as const,
  activeRevisionId: revisionId,
  coverStorageKey: 'titles/private-cover-key',
  coverMediaType: 'image/webp',
  coverChecksumSha256: 'a'.repeat(64),
  coverByteSize: 123,
  coverWidth: 100,
  coverHeight: 150,
  coverUpdatedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date()
};

const publicRoot = {
  title,
  revisionId,
  presentation: {
    id: presentationId,
    revisionId,
    state: 'published' as const,
    readingDirection: 'ltr' as const,
    guidedViewEnabled: false,
    previewProseSectionId: firstSectionId,
    previewProseBlockId: boundaryBlockId,
    previewComicPageId: null,
    createdAt: new Date(),
    updatedAt: new Date()
  }
};

describe('publication reader queries', () => {
  it('maps only qualified public roots into safe list and detail DTOs', async () => {
    const listDatabase = databaseReturning([publicRoot]);
    const detailDatabase = databaseReturning([publicRoot]);

    await expect(listPublicCatalog(listDatabase)).resolves.toEqual([
      {
        id: titleId,
        slug: 'reader-title',
        title: 'Reader Title',
        subtitle: null,
        creatorName: 'Pale Orbit',
        format: 'prose',
        priceMinor: 1299,
        currency: 'USD',
        cover: {
          url: `/media/covers/${titleId}/${'a'.repeat(64)}`,
          checksumSha256: 'a'.repeat(64),
          mediaType: 'image/webp',
          byteSize: 123,
          width: 100,
          height: 150
        }
      }
    ]);
    await expect(getPublicTitleDetail(detailDatabase, 'reader-title')).resolves.toMatchObject({
      id: titleId,
      description: 'A published title.',
      previewUrl: '/api/catalog/reader-title/preview'
    });
    await expect(getPublicTitleDetail(databaseReturning([]), 'private-or-missing')).resolves.toBeNull();
  });

  it('applies the prose boundary before mapping blocks or image references', async () => {
    const sections = [
      { id: firstSectionId, revisionId, ordinal: 0, label: 'One', sourceReference: 'one.xhtml', createdAt: new Date() },
      { id: secondSectionId, revisionId, ordinal: 1, label: 'Two', sourceReference: 'two.xhtml', createdAt: new Date() }
    ];
    const blocks = [
      {
        id: firstBlockId,
        revisionId,
        sectionId: firstSectionId,
        ordinal: 0,
        kind: 'paragraph' as const,
        content: { kind: 'paragraph' as const, fragments: [{ text: 'First', marks: [] }] },
        imageId: null,
        createdAt: new Date()
      },
      {
        id: boundaryBlockId,
        revisionId,
        sectionId: firstSectionId,
        ordinal: 1,
        kind: 'image' as const,
        content: { kind: 'image' as const, imageId: includedImageId, alt: 'Included' },
        imageId: includedImageId,
        createdAt: new Date()
      },
      {
        id: laterBlockId,
        revisionId,
        sectionId: secondSectionId,
        ordinal: 0,
        kind: 'image' as const,
        content: { kind: 'image' as const, imageId: excludedImageId, alt: 'Excluded' },
        imageId: excludedImageId,
        createdAt: new Date()
      }
    ];
    const images = [includedImageId, excludedImageId].map((id, index) => ({
      id,
      revisionId,
      storageKey: `private/${id}`,
      mediaType: 'image/webp',
      checksumSha256: String(index + 1).repeat(64),
      byteSize: 100,
      width: 10,
      height: 20,
      altText: index === 0 ? 'Included' : 'Excluded',
      createdAt: new Date()
    }));
    const document = await getPublicPreview(
      databaseReturning([publicRoot], sections, blocks, images),
      'reader-title'
    );

    expect(document).toMatchObject({ access: 'preview', format: 'prose', revisionId });
    expect(document?.format === 'prose' ? document.sections : []).toHaveLength(1);
    expect(document?.format === 'prose' ? document.sections[0]?.blocks : []).toHaveLength(2);
    expect(document?.format === 'prose' ? document.images.map((image) => image.id) : []).toEqual([
      includedImageId
    ]);
    expect(JSON.stringify(document)).not.toContain(excludedImageId);
    expect(JSON.stringify(document)).not.toMatch(/storage|sourcePath|uploadFilename/iu);
  });

  it('applies the comic page boundary and only the published presentation panels', async () => {
    const comicRoot = {
      ...publicRoot,
      title: { ...title, format: 'comic' as const },
      presentation: {
        ...publicRoot.presentation,
        guidedViewEnabled: true,
        previewProseSectionId: null,
        previewProseBlockId: null,
        previewComicPageId: boundaryPageId
      }
    };
    const pages = [firstPageId, boundaryPageId, laterPageId].map((id, index) => ({
      id,
      revisionId,
      ordinal: index + 1,
      sourcePath: `page-${index + 1}.png`,
      storageKey: `private/${id}`,
      mediaType: 'image/webp',
      checksumSha256: String(index + 1).repeat(64),
      byteSize: 100,
      width: 100,
      height: 150,
      createdAt: new Date()
    }));
    const panels = [
      { id: randomUUID(), revisionId, presentationId, pageId: firstPageId, ordinal: 1, x: 0, y: 0, width: 1, height: 1, createdAt: new Date(), updatedAt: new Date() },
      { id: randomUUID(), revisionId, presentationId, pageId: laterPageId, ordinal: 1, x: 0, y: 0, width: 1, height: 1, createdAt: new Date(), updatedAt: new Date() }
    ];
    const document = await getPublicPreview(
      databaseReturning([comicRoot], pages, panels),
      'reader-title'
    );

    expect(document?.format === 'comic' ? document.pages.map((page) => page.id) : []).toEqual([
      firstPageId,
      boundaryPageId
    ]);
    expect(document?.format === 'comic' ? document.pages[0]?.panels : []).toHaveLength(1);
    expect(JSON.stringify(document)).not.toContain(laterPageId);
    expect(JSON.stringify(document)).not.toMatch(/storage|sourcePath|uploadFilename/iu);
  });

  it('authorizes admin review and returns the complete requested presentation manifest', async () => {
    const admin: Actor = { type: 'user', id: randomUUID(), roles: ['admin'] };
    const sections = [
      { id: firstSectionId, revisionId, ordinal: 0, label: 'One', sourceReference: 'one.xhtml', createdAt: new Date() },
      { id: secondSectionId, revisionId, ordinal: 1, label: 'Two', sourceReference: 'two.xhtml', createdAt: new Date() }
    ];
    const blocks = [firstBlockId, laterBlockId].map((id, ordinal) => ({
      id,
      revisionId,
      sectionId: sections[ordinal]!.id,
      ordinal: 0,
      kind: 'paragraph' as const,
      content: { kind: 'paragraph' as const, fragments: [{ text: String(ordinal), marks: [] }] },
      imageId: null,
      createdAt: new Date()
    }));
    const database = databaseReturning([publicRoot], sections, blocks, []);

    const document = await getAdminRevisionReader(database, admin, revisionId, 'published');
    expect(document.format === 'prose' ? document.sections : []).toHaveLength(2);
    expect(document.access).toBe('admin');
    expect(JSON.stringify(document)).not.toMatch(/storage|sourcePath|uploadFilename/iu);

    const deniedDatabase = databaseReturning([publicRoot]);
    await expect(
      getAdminRevisionReader(
        deniedDatabase,
        { type: 'user', id: randomUUID(), roles: ['customer'] },
        revisionId,
        'draft'
      )
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(deniedDatabase.select).not.toHaveBeenCalled();
  });
});
