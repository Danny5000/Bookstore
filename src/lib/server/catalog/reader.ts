import { and, asc, count, eq } from 'drizzle-orm';
import type { Actor } from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import {
  comicPages,
  comicPanelRegions,
  proseBlocks,
  proseImages,
  proseSections,
  revisionPresentations,
  titleRevisions,
  titles,
  type TitleRow
} from '$lib/server/db/schema';
import {
  resolveAdminReviewAccess,
  type PublicationAccessDecision,
  type PublicationAccessRoot
} from '$lib/server/library/access';
import type {
  CatalogTitleDetail,
  CatalogTitleSummary,
  ComicPageDto,
  ProseImageDto,
  ProseSectionDto,
  PublicationMediaDto,
  ReaderAccess,
  ReaderDocument
} from '$lib/types/publication';
import { CatalogDomainError } from './errors';

type ReaderRoot = PublicationAccessRoot;

function coverDto(title: TitleRow): PublicationMediaDto | null {
  if (
    !title.coverChecksumSha256 ||
    !title.coverMediaType ||
    !title.coverByteSize ||
    !title.coverWidth ||
    !title.coverHeight
  ) return null;
  return {
    url: `/media/covers/${title.id}/${title.coverChecksumSha256}`,
    checksumSha256: title.coverChecksumSha256,
    mediaType: title.coverMediaType,
    byteSize: title.coverByteSize,
    width: title.coverWidth,
    height: title.coverHeight
  };
}

function titleSummary(root: ReaderRoot): CatalogTitleSummary {
  return {
    id: root.title.id,
    slug: root.title.slug,
    title: root.title.title,
    subtitle: root.title.subtitle,
    creatorName: root.title.creatorName,
    format: root.title.format,
    priceMinor: root.title.priceMinor,
    currency: root.title.currency,
    cover: coverDto(root.title)
  };
}

function titleDetail(root: ReaderRoot, extentCount: number): CatalogTitleDetail {
  return {
    ...titleSummary(root),
    description: root.title.description,
    previewUrl: `/api/catalog/${encodeURIComponent(root.title.slug)}/preview`,
    extentCount,
    extentUnit: root.title.format === 'prose' ? 'sections' : 'pages'
  };
}

function publicRootSelection(database: Database) {
  return database
    .select({
      title: titles,
      revisionId: titleRevisions.id,
      presentation: revisionPresentations
    })
    .from(titles)
    .innerJoin(
      titleRevisions,
      and(eq(titleRevisions.id, titles.activeRevisionId), eq(titleRevisions.titleId, titles.id))
    )
    .innerJoin(
      revisionPresentations,
      and(
        eq(revisionPresentations.revisionId, titleRevisions.id),
        eq(revisionPresentations.state, 'published')
      )
    );
}

export async function listPublicCatalog(
  database: Database
): Promise<readonly CatalogTitleSummary[]> {
  const roots = await publicRootSelection(database)
    .where(and(eq(titles.visibility, 'public'), eq(titleRevisions.state, 'active')))
    .orderBy(asc(titles.title), asc(titles.id));
  return roots.map(titleSummary);
}

async function getPublicRoot(database: Database, slug: string): Promise<ReaderRoot | null> {
  const [root] = await publicRootSelection(database)
    .where(
      and(
        eq(titles.slug, slug),
        eq(titles.visibility, 'public'),
        eq(titleRevisions.state, 'active')
      )
    )
    .limit(1);
  return root ?? null;
}

export async function getPublicTitleDetail(
  database: Database,
  slug: string
): Promise<CatalogTitleDetail | null> {
  const root = await getPublicRoot(database, slug);
  if (!root) return null;
  const source = root.title.format === 'prose' ? proseSections : comicPages;
  const [extent] = await database
    .select({ value: count() })
    .from(source)
    .where(eq(source.revisionId, root.revisionId));
  return titleDetail(root, extent?.value ?? 0);
}

function imageDto(revisionId: string, image: typeof proseImages.$inferSelect): ProseImageDto {
  return {
    id: image.id,
    url: `/media/revisions/${revisionId}/images/${image.id}/${image.checksumSha256}`,
    checksumSha256: image.checksumSha256,
    mediaType: image.mediaType,
    byteSize: image.byteSize,
    width: image.width,
    height: image.height
  };
}

async function proseDocument(
  database: Database,
  root: ReaderRoot,
  access: ReaderAccess
): Promise<ReaderDocument | null> {
  const sections = await database
    .select()
    .from(proseSections)
    .where(eq(proseSections.revisionId, root.revisionId))
    .orderBy(asc(proseSections.ordinal), asc(proseSections.id));
  const blocks = await database
    .select()
    .from(proseBlocks)
    .where(eq(proseBlocks.revisionId, root.revisionId))
    .orderBy(asc(proseBlocks.sectionId), asc(proseBlocks.ordinal), asc(proseBlocks.id));
  const images = await database
    .select()
    .from(proseImages)
    .where(eq(proseImages.revisionId, root.revisionId));
  const includedImageIds = new Set<string>();
  const mappedSections: ProseSectionDto[] = [];
  let boundaryFound = access !== 'preview';

  for (const section of sections) {
    const mappedBlocks = [];
    for (const block of blocks
      .filter((candidate) => candidate.sectionId === section.id)
      .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))) {
      mappedBlocks.push({ id: block.id, ordinal: block.ordinal, content: block.content });
      if (block.imageId) includedImageIds.add(block.imageId);
      if (
        access === 'preview' &&
        section.id === root.presentation.previewProseSectionId &&
        block.id === root.presentation.previewProseBlockId
      ) {
        boundaryFound = true;
        break;
      }
    }
    if (mappedBlocks.length > 0) {
      mappedSections.push({
        id: section.id,
        ordinal: section.ordinal,
        label: section.label,
        blocks: mappedBlocks
      });
    }
    if (access === 'preview' && boundaryFound) break;
  }
  if (!boundaryFound) return null;
  const mappedImages = images
    .filter((image) => access !== 'preview' || includedImageIds.has(image.id))
    .map((image) => imageDto(root.revisionId, image));
  return {
    titleId: root.title.id,
    revisionId: root.revisionId,
    presentationId: root.presentation.id,
    title: root.title.title,
    access,
    readingDirection: root.presentation.readingDirection,
    format: 'prose',
    sections: mappedSections,
    images: mappedImages
  };
}

function comicPageDto(
  root: ReaderRoot,
  page: typeof comicPages.$inferSelect,
  panels: readonly (typeof comicPanelRegions.$inferSelect)[]
): ComicPageDto {
  return {
    id: page.id,
    ordinal: page.ordinal,
    url: `/media/revisions/${root.revisionId}/images/${page.id}/${page.checksumSha256}`,
    checksumSha256: page.checksumSha256,
    mediaType: page.mediaType,
    byteSize: page.byteSize,
    width: page.width,
    height: page.height,
    panels: panels
      .filter((panel) => panel.pageId === page.id)
      .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
      .map((panel) => ({
        id: panel.id,
        ordinal: panel.ordinal,
        x: panel.x,
        y: panel.y,
        width: panel.width,
        height: panel.height
      }))
  };
}

async function comicDocument(
  database: Database,
  root: ReaderRoot,
  access: ReaderAccess
): Promise<ReaderDocument | null> {
  const allPages = await database
    .select()
    .from(comicPages)
    .where(eq(comicPages.revisionId, root.revisionId))
    .orderBy(asc(comicPages.ordinal), asc(comicPages.id));
  const panels = await database
    .select()
    .from(comicPanelRegions)
    .where(
      and(
        eq(comicPanelRegions.revisionId, root.revisionId),
        eq(comicPanelRegions.presentationId, root.presentation.id)
      )
    );
  let pages = allPages;
  if (access === 'preview') {
    const boundaryIndex = pages.findIndex(
      (page) => page.id === root.presentation.previewComicPageId
    );
    if (boundaryIndex < 0) return null;
    pages = pages.slice(0, boundaryIndex + 1);
  }
  return {
    titleId: root.title.id,
    revisionId: root.revisionId,
    presentationId: root.presentation.id,
    title: root.title.title,
    access,
    readingDirection: root.presentation.readingDirection,
    format: 'comic',
    guidedViewEnabled: root.presentation.guidedViewEnabled,
    pages: pages.map((page) => comicPageDto(root, page, panels))
  };
}

async function readerDocument(
  database: Database,
  root: ReaderRoot,
  access: ReaderAccess
): Promise<ReaderDocument | null> {
  return root.title.format === 'prose'
    ? proseDocument(database, root, access)
    : comicDocument(database, root, access);
}

export async function getPublicPreview(
  database: Database,
  slug: string
): Promise<ReaderDocument | null> {
  const root = await getPublicRoot(database, slug);
  return root ? readerDocument(database, root, 'preview') : null;
}

export async function getReaderDocumentForAccess(
  database: Database,
  decision: PublicationAccessDecision
): Promise<ReaderDocument | null> {
  if (decision.level === 'denied' || decision.level === 'unavailable') return null;
  return readerDocument(database, decision.root, decision.level);
}

export async function getAdminRevisionReader(
  database: Database,
  actor: Actor,
  revisionId: string,
  presentationState: 'draft' | 'published'
): Promise<ReaderDocument> {
  const decision = await resolveAdminReviewAccess({
    db: database,
    actor,
    revisionId,
    presentationState
  });
  const document = await getReaderDocumentForAccess(database, decision);
  if (!document) throw new CatalogDomainError('presentation_not_found');
  return document;
}
