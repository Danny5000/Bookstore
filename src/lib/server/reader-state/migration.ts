import { and, asc, desc, eq, ne } from 'drizzle-orm';
import {
  comicPages,
  comicPanelRegions,
  proseBlocks,
  proseSections,
  readerBookmarks,
  readerProgress,
  readerRevisionMigrations,
  revisionPresentations,
  type ReaderBookmarkRow,
  type ReaderProgressRow,
  type ReaderRevisionMigrationRow
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type { ReaderLocation } from '$lib/types/library';
import { validateReaderLocation } from './anchors';
import { InvalidReaderLocationError } from './errors';
import type { LockedReaderTitle } from './lock';

interface FingerprintedItem {
  id: string;
  semanticFingerprintSha256: string | null;
  semanticFingerprintVersion: number | null;
}

interface PanelGeometry {
  ordinal: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function uniqueFingerprintTarget<Target extends FingerprintedItem>(
  source: Pick<FingerprintedItem, 'semanticFingerprintSha256' | 'semanticFingerprintVersion'>,
  targets: readonly Target[]
): Target | null {
  if (
    source.semanticFingerprintSha256 === null ||
    source.semanticFingerprintVersion === null
  ) return null;
  const matches = targets.filter(
    (target) =>
      target.semanticFingerprintSha256 === source.semanticFingerprintSha256 &&
      target.semanticFingerprintVersion === source.semanticFingerprintVersion
  );
  return matches.length === 1 ? matches[0]! : null;
}

export function panelGeometryListsMatch(
  source: readonly PanelGeometry[],
  target: readonly PanelGeometry[]
): boolean {
  if (source.length !== target.length) return false;
  return source.every((panel, index) => {
    const candidate = target[index];
    return Boolean(
      candidate &&
        panel.ordinal === candidate.ordinal &&
        panel.x === candidate.x &&
        panel.y === candidate.y &&
        panel.width === candidate.width &&
        panel.height === candidate.height
    );
  });
}

function stateRevision(
  progressRows: readonly ReaderProgressRow[],
  bookmarkRows: readonly ReaderBookmarkRow[]
): string | null {
  const activity = new Map<string, number>();
  for (const row of progressRows) {
    activity.set(row.revisionId, Math.max(activity.get(row.revisionId) ?? 0, row.updatedAt.getTime()));
  }
  for (const row of bookmarkRows) {
    activity.set(row.revisionId, Math.max(activity.get(row.revisionId) ?? 0, row.createdAt.getTime()));
  }
  return [...activity.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))[0]?.[0] ?? null;
}

function progressLocation(row: ReaderProgressRow): ReaderLocation {
  return row.format === 'prose'
    ? { format: 'prose', blockId: row.blockId!, offset: row.proseOffset! }
    : { format: 'comic', pageId: row.pageId!, panelOrdinal: row.panelOrdinal };
}

function bookmarkLocation(row: ReaderBookmarkRow): ReaderLocation {
  return row.format === 'prose'
    ? { format: 'prose', blockId: row.blockId!, offset: row.proseOffset! }
    : { format: 'comic', pageId: row.pageId!, panelOrdinal: row.panelOrdinal };
}

function locationColumns(location: ReaderLocation) {
  return location.format === 'prose'
    ? {
        format: 'prose' as const,
        blockId: location.blockId,
        proseOffset: location.offset,
        pageId: null,
        panelOrdinal: null
      }
    : {
        format: 'comic' as const,
        blockId: null,
        proseOffset: null,
        pageId: location.pageId,
        panelOrdinal: location.panelOrdinal
      };
}

async function insertMigrationRecord(
  transaction: DatabaseTransaction,
  values: {
    userId: string;
    titleId: string;
    sourceRevisionId: string;
    targetRevisionId: string;
    progressResult: 'migrated' | 'reset' | 'absent';
    panelPositionSimplified: boolean;
    migratedBookmarkCount: number;
    unmatchedBookmarkCount: number;
  }
): Promise<ReaderRevisionMigrationRow> {
  const [inserted] = await transaction
    .insert(readerRevisionMigrations)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [existing] = await transaction
    .select()
    .from(readerRevisionMigrations)
    .where(
      and(
        eq(readerRevisionMigrations.userId, values.userId),
        eq(readerRevisionMigrations.titleId, values.titleId),
        eq(readerRevisionMigrations.targetRevisionId, values.targetRevisionId)
      )
    )
    .limit(1);
  if (!existing) throw new Error('Migration record conflict returned no row');
  return existing;
}

interface MigrationManifest {
  beginning: ReaderLocation;
  mapLocation: (location: ReaderLocation) => Promise<{
    location: ReaderLocation;
    panelSimplified: boolean;
  } | null>;
}

async function proseManifest(
  transaction: DatabaseTransaction,
  locked: LockedReaderTitle,
  sourceRevisionId: string
): Promise<MigrationManifest> {
  const source = await transaction
    .select({
      id: proseBlocks.id,
      semanticFingerprintSha256: proseBlocks.semanticFingerprintSha256,
      semanticFingerprintVersion: proseBlocks.semanticFingerprintVersion
    })
    .from(proseBlocks)
    .where(eq(proseBlocks.revisionId, sourceRevisionId));
  const target = await transaction
    .select({
      id: proseBlocks.id,
      semanticFingerprintSha256: proseBlocks.semanticFingerprintSha256,
      semanticFingerprintVersion: proseBlocks.semanticFingerprintVersion
    })
    .from(proseBlocks)
    .innerJoin(
      proseSections,
      and(
        eq(proseSections.revisionId, proseBlocks.revisionId),
        eq(proseSections.id, proseBlocks.sectionId)
      )
    )
    .where(eq(proseBlocks.revisionId, locked.revisionId))
    .orderBy(
      asc(proseSections.ordinal),
      asc(proseSections.id),
      asc(proseBlocks.ordinal),
      asc(proseBlocks.id)
    );
  const first = target[0];
  if (!first) throw new InvalidReaderLocationError();
  const sourceById = new Map(source.map((block) => [block.id, block] as const));
  return {
    beginning: { format: 'prose', blockId: first.id, offset: 0 },
    async mapLocation(location) {
      if (location.format !== 'prose') return null;
      const sourceBlock = sourceById.get(location.blockId);
      if (!sourceBlock) return null;
      const targetBlock = uniqueFingerprintTarget(sourceBlock, target);
      return targetBlock
        ? {
            location: {
              format: 'prose',
              blockId: targetBlock.id,
              offset: location.offset
            },
            panelSimplified: false
          }
        : null;
    }
  };
}

async function panelRows(
  transaction: DatabaseTransaction,
  revisionId: string,
  presentationId: string
) {
  return transaction
    .select({
      pageId: comicPanelRegions.pageId,
      ordinal: comicPanelRegions.ordinal,
      x: comicPanelRegions.x,
      y: comicPanelRegions.y,
      width: comicPanelRegions.width,
      height: comicPanelRegions.height
    })
    .from(comicPanelRegions)
    .where(
      and(
        eq(comicPanelRegions.revisionId, revisionId),
        eq(comicPanelRegions.presentationId, presentationId)
      )
    )
    .orderBy(asc(comicPanelRegions.pageId), asc(comicPanelRegions.ordinal));
}

async function comicManifest(
  transaction: DatabaseTransaction,
  locked: LockedReaderTitle,
  sourceRevisionId: string
): Promise<MigrationManifest> {
  const source = await transaction
    .select({
      id: comicPages.id,
      semanticFingerprintSha256: comicPages.semanticFingerprintSha256,
      semanticFingerprintVersion: comicPages.semanticFingerprintVersion
    })
    .from(comicPages)
    .where(eq(comicPages.revisionId, sourceRevisionId));
  const target = await transaction
    .select({
      id: comicPages.id,
      semanticFingerprintSha256: comicPages.semanticFingerprintSha256,
      semanticFingerprintVersion: comicPages.semanticFingerprintVersion
    })
    .from(comicPages)
    .where(eq(comicPages.revisionId, locked.revisionId))
    .orderBy(asc(comicPages.ordinal), asc(comicPages.id));
  const first = target[0];
  if (!first) throw new InvalidReaderLocationError();
  const [sourcePresentation] = await transaction
    .select({ id: revisionPresentations.id })
    .from(revisionPresentations)
    .where(
      and(
        eq(revisionPresentations.revisionId, sourceRevisionId),
        eq(revisionPresentations.state, 'published')
      )
    )
    .orderBy(desc(revisionPresentations.createdAt), desc(revisionPresentations.id))
    .limit(1);
  const sourcePanels = sourcePresentation
    ? await panelRows(transaction, sourceRevisionId, sourcePresentation.id)
    : [];
  const targetPanels = await panelRows(transaction, locked.revisionId, locked.presentation.id);
  const sourceById = new Map(source.map((page) => [page.id, page] as const));
  const geometryFor = (
    rows: readonly (typeof sourcePanels)[number][],
    pageId: string
  ): PanelGeometry[] => rows
    .filter((panel) => panel.pageId === pageId)
    .map(({ ordinal, x, y, width, height }) => ({ ordinal, x, y, width, height }));
  return {
    beginning: { format: 'comic', pageId: first.id, panelOrdinal: null },
    async mapLocation(location) {
      if (location.format !== 'comic') return null;
      const sourcePage = sourceById.get(location.pageId);
      if (!sourcePage) return null;
      const targetPage = uniqueFingerprintTarget(sourcePage, target);
      if (!targetPage) return null;
      if (location.panelOrdinal === null) {
        return {
          location: { format: 'comic', pageId: targetPage.id, panelOrdinal: null },
          panelSimplified: false
        };
      }
      const sourceGeometry = geometryFor(sourcePanels, sourcePage.id);
      const targetGeometry = geometryFor(targetPanels, targetPage.id);
      const samePanels =
        locked.presentation.guidedViewEnabled &&
        sourceGeometry.some((panel) => panel.ordinal === location.panelOrdinal) &&
        targetGeometry.some((panel) => panel.ordinal === location.panelOrdinal) &&
        panelGeometryListsMatch(sourceGeometry, targetGeometry);
      return {
        location: {
          format: 'comic',
          pageId: targetPage.id,
          panelOrdinal: samePanels ? location.panelOrdinal : null
        },
        panelSimplified: !samePanels
      };
    }
  };
}

async function validatedLocation(
  transaction: DatabaseTransaction,
  locked: LockedReaderTitle,
  location: ReaderLocation
): Promise<ReaderLocation | null> {
  try {
    return await validateReaderLocation(transaction, {
      titleId: locked.title.id,
      revisionId: locked.revisionId,
      format: locked.title.format,
      presentation: locked.presentation,
      location
    });
  } catch (error) {
    if (error instanceof InvalidReaderLocationError) return null;
    throw error;
  }
}

export async function migrateLockedReaderState(
  transaction: DatabaseTransaction,
  locked: LockedReaderTitle
): Promise<ReaderRevisionMigrationRow | null> {
  const [existingRecord] = await transaction
    .select()
    .from(readerRevisionMigrations)
    .where(
      and(
        eq(readerRevisionMigrations.userId, locked.userId),
        eq(readerRevisionMigrations.titleId, locked.title.id),
        eq(readerRevisionMigrations.targetRevisionId, locked.revisionId)
      )
    )
    .limit(1);
  if (existingRecord) return existingRecord;

  const targetProgress = await transaction
    .select()
    .from(readerProgress)
    .where(
      and(
        eq(readerProgress.userId, locked.userId),
        eq(readerProgress.titleId, locked.title.id),
        eq(readerProgress.revisionId, locked.revisionId)
      )
    )
    .limit(1);
  const targetBookmarks = await transaction
    .select()
    .from(readerBookmarks)
    .where(
      and(
        eq(readerBookmarks.userId, locked.userId),
        eq(readerBookmarks.titleId, locked.title.id),
        eq(readerBookmarks.revisionId, locked.revisionId)
      )
    );
  const priorProgress = await transaction
    .select()
    .from(readerProgress)
    .where(
      and(
        eq(readerProgress.userId, locked.userId),
        eq(readerProgress.titleId, locked.title.id),
        ne(readerProgress.revisionId, locked.revisionId)
      )
    )
    .orderBy(desc(readerProgress.updatedAt), desc(readerProgress.id));
  const priorBookmarks = await transaction
    .select()
    .from(readerBookmarks)
    .where(
      and(
        eq(readerBookmarks.userId, locked.userId),
        eq(readerBookmarks.titleId, locked.title.id),
        ne(readerBookmarks.revisionId, locked.revisionId)
      )
    )
    .orderBy(desc(readerBookmarks.createdAt), desc(readerBookmarks.id));
  const sourceRevisionId = stateRevision(priorProgress, priorBookmarks);
  if (!sourceRevisionId) return null;
  const sourceProgress = priorProgress.find((row) => row.revisionId === sourceRevisionId) ?? null;
  const sourceBookmarks = priorBookmarks.filter((row) => row.revisionId === sourceRevisionId);

  if (targetProgress.length > 0 || targetBookmarks.length > 0) {
    return insertMigrationRecord(transaction, {
      userId: locked.userId,
      titleId: locked.title.id,
      sourceRevisionId,
      targetRevisionId: locked.revisionId,
      progressResult: 'absent',
      panelPositionSimplified: false,
      migratedBookmarkCount: 0,
      unmatchedBookmarkCount: sourceBookmarks.length
    });
  }

  const manifest = locked.title.format === 'prose'
    ? await proseManifest(transaction, locked, sourceRevisionId)
    : await comicManifest(transaction, locked, sourceRevisionId);
  const beginning = await validatedLocation(transaction, locked, manifest.beginning);
  if (!beginning) throw new InvalidReaderLocationError();
  let progressResult: 'migrated' | 'reset' | 'absent' = 'absent';
  let panelPositionSimplified = false;
  if (sourceProgress) {
    const mapped = await manifest.mapLocation(progressLocation(sourceProgress));
    const location = mapped
      ? await validatedLocation(transaction, locked, mapped.location)
      : null;
    const effective = location ?? beginning;
    progressResult = location ? 'migrated' : 'reset';
    panelPositionSimplified = Boolean(location && mapped?.panelSimplified);
    await transaction.insert(readerProgress).values({
      userId: locked.userId,
      titleId: locked.title.id,
      revisionId: locked.revisionId,
      ...locationColumns(effective)
    });
  }

  let migratedBookmarkCount = 0;
  let unmatchedBookmarkCount = 0;
  for (const bookmark of sourceBookmarks) {
    const mapped = await manifest.mapLocation(bookmarkLocation(bookmark));
    const location = mapped
      ? await validatedLocation(transaction, locked, mapped.location)
      : null;
    if (!location) {
      unmatchedBookmarkCount += 1;
      continue;
    }
    const inserted = await transaction
      .insert(readerBookmarks)
      .values({
        userId: locked.userId,
        titleId: locked.title.id,
        revisionId: locked.revisionId,
        ...locationColumns(location),
        migratedFromBookmarkId: bookmark.id
      })
      .onConflictDoNothing()
      .returning({ id: readerBookmarks.id });
    if (inserted.length === 1) migratedBookmarkCount += 1;
    else unmatchedBookmarkCount += 1;
  }

  return insertMigrationRecord(transaction, {
    userId: locked.userId,
    titleId: locked.title.id,
    sourceRevisionId,
    targetRevisionId: locked.revisionId,
    progressResult,
    panelPositionSimplified,
    migratedBookmarkCount,
    unmatchedBookmarkCount
  });
}
