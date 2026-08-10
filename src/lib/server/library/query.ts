import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '$lib/server/db/client';
import {
  comicPages,
  comicPanelRegions,
  entitlements,
  proseBlocks,
  proseSections,
  readerProgress,
  revisionPresentations,
  titleRevisions,
  titles
} from '$lib/server/db/schema';
import type { LibraryEntryDto } from '$lib/types/library';
import type { ProseBlockData } from '$lib/types/publication';

interface OrderedProseBlock {
  id: string;
  content: ProseBlockData;
}

interface OrderedComicPage {
  id: string;
  panelOrdinals: number[];
}

function clampPercent(value: number): number {
  const bounded = Math.max(0, Math.min(100, value));
  return Math.round(bounded * 100) / 100;
}

function fragmentLength(fragments: readonly { text: string }[]): number {
  return fragments.reduce((total, fragment) => total + fragment.text.length, 0);
}

function visibleTextLength(content: ProseBlockData): number {
  switch (content.kind) {
    case 'heading':
    case 'paragraph':
    case 'quote':
      return fragmentLength(content.fragments);
    case 'list':
      return content.items.reduce((total, item) => total + fragmentLength(item), 0);
    case 'image':
    case 'break':
      return 0;
  }
}

export function proseCompletionPercent(
  blocks: readonly OrderedProseBlock[],
  location: { blockId: string; offset: number }
): number | null {
  const blockIndex = blocks.findIndex((block) => block.id === location.blockId);
  if (blockIndex < 0 || blocks.length === 0) return null;
  const length = visibleTextLength(blocks[blockIndex]!.content);
  const withinBlock = length > 0 ? Math.max(0, Math.min(1, location.offset / length)) : 0;
  return clampPercent(((blockIndex + withinBlock) / blocks.length) * 100);
}

export function comicCompletionPercent(
  pages: readonly OrderedComicPage[],
  location: { pageId: string; panelOrdinal: number | null }
): number | null {
  const pageIndex = pages.findIndex((page) => page.id === location.pageId);
  if (pageIndex < 0 || pages.length === 0) return null;
  let withinPage = 0;
  if (location.panelOrdinal !== null) {
    const panelIndex = pages[pageIndex]!.panelOrdinals.indexOf(location.panelOrdinal);
    if (panelIndex < 0) return null;
    withinPage = (panelIndex + 1) / pages[pageIndex]!.panelOrdinals.length;
  }
  return clampPercent(((pageIndex + withinPage) / pages.length) * 100);
}

function downloadFormat(
  format: 'prose' | 'comic',
  filename: string | null
): LibraryEntryDto['downloadFormat'] {
  const extension = filename?.toLowerCase().match(/\.([^.]+)$/u)?.[1];
  if (format === 'prose') return extension === 'epub' ? 'epub' : null;
  return extension === 'cbz' || extension === 'zip' ? extension : null;
}

function completeCover(row: {
  coverStorageKey: string | null;
  coverMediaType: string | null;
  coverChecksumSha256: string | null;
  coverByteSize: number | null;
  coverWidth: number | null;
  coverHeight: number | null;
}): row is typeof row & { coverChecksumSha256: string } {
  return Boolean(
    row.coverStorageKey &&
      row.coverMediaType &&
      row.coverChecksumSha256 &&
      row.coverByteSize &&
      row.coverWidth &&
      row.coverHeight
  );
}

export async function listCustomerLibrary(
  db: Database,
  userId: string
): Promise<LibraryEntryDto[]> {
  const shelf = await db
    .select({
      titleId: titles.id,
      slug: titles.slug,
      title: titles.title,
      creatorName: titles.creatorName,
      format: titles.format,
      activeRevisionId: titles.activeRevisionId,
      coverStorageKey: titles.coverStorageKey,
      coverMediaType: titles.coverMediaType,
      coverChecksumSha256: titles.coverChecksumSha256,
      coverByteSize: titles.coverByteSize,
      coverWidth: titles.coverWidth,
      coverHeight: titles.coverHeight,
      revisionId: titleRevisions.id,
      presentationId: revisionPresentations.id,
      originalStorageKey: titleRevisions.originalStorageKey,
      originalChecksumSha256: titleRevisions.originalChecksumSha256,
      originalMimeType: titleRevisions.originalMimeType,
      originalByteSize: titleRevisions.originalByteSize,
      originalFilename: titleRevisions.originalFilename,
      progressFormat: readerProgress.format,
      progressBlockId: readerProgress.blockId,
      progressOffset: readerProgress.proseOffset,
      progressPageId: readerProgress.pageId,
      progressPanelOrdinal: readerProgress.panelOrdinal
    })
    .from(entitlements)
    .innerJoin(titles, eq(titles.id, entitlements.titleId))
    .leftJoin(
      titleRevisions,
      and(
        eq(titleRevisions.id, titles.activeRevisionId),
        eq(titleRevisions.titleId, titles.id),
        eq(titleRevisions.state, 'active')
      )
    )
    .leftJoin(
      revisionPresentations,
      and(
        eq(revisionPresentations.revisionId, titleRevisions.id),
        eq(revisionPresentations.state, 'published')
      )
    )
    .leftJoin(
      readerProgress,
      and(
        eq(readerProgress.userId, userId),
        eq(readerProgress.titleId, titles.id),
        eq(readerProgress.revisionId, titleRevisions.id)
      )
    )
    .where(and(eq(entitlements.userId, userId), isNull(entitlements.revokedAt)))
    .orderBy(asc(titles.title), asc(titles.id));

  const proseRevisionIds = shelf
    .filter((row) => row.format === 'prose' && row.revisionId && row.presentationId)
    .map((row) => row.revisionId as string);
  const comicRevisionIds = shelf
    .filter((row) => row.format === 'comic' && row.revisionId && row.presentationId)
    .map((row) => row.revisionId as string);

  const [proseRows, comicRows] = await Promise.all([
    proseRevisionIds.length === 0
      ? []
      : db
          .select({
            revisionId: proseBlocks.revisionId,
            id: proseBlocks.id,
            content: proseBlocks.content
          })
          .from(proseBlocks)
          .innerJoin(
            proseSections,
            and(
              eq(proseSections.revisionId, proseBlocks.revisionId),
              eq(proseSections.id, proseBlocks.sectionId)
            )
          )
          .where(inArray(proseBlocks.revisionId, proseRevisionIds))
          .orderBy(
            asc(proseBlocks.revisionId),
            asc(proseSections.ordinal),
            asc(proseSections.id),
            asc(proseBlocks.ordinal),
            asc(proseBlocks.id)
          ),
    comicRevisionIds.length === 0
      ? []
      : db
          .select({
            revisionId: comicPages.revisionId,
            id: comicPages.id,
            ordinal: comicPages.ordinal,
            panelOrdinal: comicPanelRegions.ordinal
          })
          .from(comicPages)
          .innerJoin(
            revisionPresentations,
            and(
              eq(revisionPresentations.revisionId, comicPages.revisionId),
              eq(revisionPresentations.state, 'published')
            )
          )
          .leftJoin(
            comicPanelRegions,
            and(
              eq(comicPanelRegions.revisionId, comicPages.revisionId),
              eq(comicPanelRegions.presentationId, revisionPresentations.id),
              eq(comicPanelRegions.pageId, comicPages.id)
            )
          )
          .where(inArray(comicPages.revisionId, comicRevisionIds))
          .orderBy(
            asc(comicPages.revisionId),
            asc(comicPages.ordinal),
            asc(comicPages.id),
            asc(comicPanelRegions.ordinal)
          )
  ]);

  const proseByRevision = new Map<string, OrderedProseBlock[]>();
  for (const block of proseRows) {
    const blocks = proseByRevision.get(block.revisionId) ?? [];
    blocks.push({ id: block.id, content: block.content });
    proseByRevision.set(block.revisionId, blocks);
  }
  const comicByRevision = new Map<string, OrderedComicPage[]>();
  for (const page of comicRows) {
    const pages = comicByRevision.get(page.revisionId) ?? [];
    let target = pages.at(-1);
    if (!target || target.id !== page.id) {
      target = { id: page.id, panelOrdinals: [] };
      pages.push(target);
    }
    if (page.panelOrdinal !== null) {
      target.panelOrdinals.push(page.panelOrdinal);
    }
    comicByRevision.set(page.revisionId, pages);
  }

  return shelf.map((row): LibraryEntryDto => {
    const available = Boolean(row.revisionId && row.presentationId);
    if (!available || !row.revisionId) {
      return {
        titleId: row.titleId,
        slug: row.slug,
        title: row.title,
        creatorName: row.creatorName,
        format: row.format,
        coverUrl: completeCover(row)
          ? `/media/covers/${row.titleId}/${row.coverChecksumSha256}`
          : null,
        availability: 'temporarily_unavailable',
        activeRevisionId: null,
        downloadFormat: null,
        progressPercent: null,
        readUrl: null,
        resumeUrl: null,
        downloadUrl: null
      };
    }

    let progressPercent: number | null = null;
    if (
      row.format === 'prose' &&
      row.progressFormat === 'prose' &&
      row.progressBlockId &&
      row.progressOffset !== null
    ) {
      progressPercent = proseCompletionPercent(
        proseByRevision.get(row.revisionId) ?? [],
        { blockId: row.progressBlockId, offset: row.progressOffset }
      );
    } else if (
      row.format === 'comic' &&
      row.progressFormat === 'comic' &&
      row.progressPageId
    ) {
      progressPercent = comicCompletionPercent(
        comicByRevision.get(row.revisionId) ?? [],
        { pageId: row.progressPageId, panelOrdinal: row.progressPanelOrdinal }
      );
    }

    const retainedOriginal = Boolean(
      row.originalStorageKey &&
        row.originalChecksumSha256 &&
        row.originalMimeType &&
        row.originalByteSize &&
        row.originalFilename
    );
    const retainedFormat = retainedOriginal
      ? downloadFormat(row.format, row.originalFilename)
      : null;
    return {
      titleId: row.titleId,
      slug: row.slug,
      title: row.title,
      creatorName: row.creatorName,
      format: row.format,
      coverUrl: completeCover(row)
        ? `/media/covers/${row.titleId}/${row.coverChecksumSha256}`
        : null,
      availability: 'available',
      activeRevisionId: row.revisionId,
      downloadFormat: retainedFormat,
      progressPercent,
      readUrl: `/read/${row.titleId}`,
      resumeUrl: `/read/${row.titleId}?resume=1`,
      downloadUrl: retainedFormat ? `/library/${row.titleId}/download` : null
    };
  });
}
