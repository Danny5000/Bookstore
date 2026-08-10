import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Actor } from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import {
  readerBookmarks,
  readerPreferences,
  readerProgress,
  readerRevisionMigrations,
  readerTitlePreferences,
  type ReaderBookmarkRow,
  type ReaderPreferencesRow,
  type ReaderProgressRow,
  type ReaderRevisionMigrationRow,
  type ReaderTitlePreferencesRow
} from '$lib/server/db/schema';
import { withTransaction, type DatabaseTransaction } from '$lib/server/db/transaction';
import type {
  BookmarkMutationInput,
  MigrationNoticeMutationInput,
  PreferencesMutationInput,
  ProgressMutationInput,
  ReaderBookmarkDto,
  ReaderInitialStateDto,
  ReaderMigrationNoticeDto,
  ReaderPreferencesDto,
  ReaderProgressDto,
  ReaderTitlePreferencesDto,
  TitlePreferencesMutationInput
} from '$lib/types/library';
import { validateReaderLocation } from './anchors';
import {
  ActiveRevisionChangedError,
  ReaderStateNotFoundError,
  StaleReaderStateError
} from './errors';
import {
  lockReaderAccount,
  lockReaderTitle,
  requireUserActor,
  type LockedReaderTitle
} from './lock';
import { migrateLockedReaderState } from './migration';

export interface AccountStateContext {
  database: Database;
  actor: Actor;
  correlationId: string;
}

export interface ReaderStateContext extends AccountStateContext {
  titleId: string;
}

function progressDto(row: ReaderProgressRow): ReaderProgressDto {
  const location = row.format === 'prose'
    ? { format: 'prose' as const, blockId: row.blockId!, offset: row.proseOffset! }
    : { format: 'comic' as const, pageId: row.pageId!, panelOrdinal: row.panelOrdinal };
  return {
    revisionId: row.revisionId,
    location,
    version: row.version,
    updatedAt: row.updatedAt.toISOString()
  };
}

function bookmarkDto(row: ReaderBookmarkRow): ReaderBookmarkDto {
  const location = row.format === 'prose'
    ? { format: 'prose' as const, blockId: row.blockId!, offset: row.proseOffset! }
    : { format: 'comic' as const, pageId: row.pageId!, panelOrdinal: row.panelOrdinal };
  return {
    id: row.id,
    revisionId: row.revisionId,
    location,
    createdAt: row.createdAt.toISOString()
  };
}

function preferencesDto(row: ReaderPreferencesRow): ReaderPreferencesDto {
  return {
    fontSize: row.fontSize,
    typeface: row.typeface,
    paper: row.paper,
    version: row.version
  };
}

function titlePreferencesDto(row: ReaderTitlePreferencesRow): ReaderTitlePreferencesDto {
  return { titleId: row.titleId, comicMode: row.comicMode, version: row.version };
}

function migrationNoticeDto(row: ReaderRevisionMigrationRow): ReaderMigrationNoticeDto {
  return {
    targetRevisionId: row.targetRevisionId,
    progress: row.progressResult,
    panelPositionSimplified: row.panelPositionSimplified,
    migratedBookmarkCount: row.migratedBookmarkCount,
    unmatchedBookmarkCount: row.unmatchedBookmarkCount,
    acknowledged: row.noticeAcknowledgedAt !== null
  };
}

function locationColumns(location: ProgressMutationInput['location']) {
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

async function currentProgress(
  transaction: DatabaseTransaction,
  userId: string,
  titleId: string,
  revisionId: string
): Promise<ReaderProgressRow | null> {
  const [row] = await transaction
    .select()
    .from(readerProgress)
    .where(
      and(
        eq(readerProgress.userId, userId),
        eq(readerProgress.titleId, titleId),
        eq(readerProgress.revisionId, revisionId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function getLockedReaderInitialState(
  transaction: DatabaseTransaction,
  locked: LockedReaderTitle
): Promise<ReaderInitialStateDto> {
  await migrateLockedReaderState(transaction, locked);
  const progress = await currentProgress(
    transaction,
    locked.userId,
    locked.title.id,
    locked.revisionId
  );
  const bookmarks = await transaction
    .select()
    .from(readerBookmarks)
    .where(
      and(
        eq(readerBookmarks.userId, locked.userId),
        eq(readerBookmarks.titleId, locked.title.id),
        eq(readerBookmarks.revisionId, locked.revisionId)
      )
    )
    .orderBy(asc(readerBookmarks.createdAt), asc(readerBookmarks.id));
  const preferencesRows = await transaction
    .select()
    .from(readerPreferences)
    .where(eq(readerPreferences.userId, locked.userId))
    .limit(1);
  const titlePreferencesRows = await transaction
    .select()
    .from(readerTitlePreferences)
    .where(
      and(
        eq(readerTitlePreferences.userId, locked.userId),
        eq(readerTitlePreferences.titleId, locked.title.id)
      )
    )
    .limit(1);
  const migrationRows = await transaction
    .select()
    .from(readerRevisionMigrations)
    .where(
      and(
        eq(readerRevisionMigrations.userId, locked.userId),
        eq(readerRevisionMigrations.titleId, locked.title.id),
        eq(readerRevisionMigrations.targetRevisionId, locked.revisionId),
        isNull(readerRevisionMigrations.noticeAcknowledgedAt)
      )
    )
    .orderBy(desc(readerRevisionMigrations.completedAt))
    .limit(1);
  return {
    progress: progress ? progressDto(progress) : null,
    bookmarks: bookmarks.map(bookmarkDto),
    preferences: preferencesRows[0]
      ? preferencesDto(preferencesRows[0])
      : { fontSize: 18, typeface: 'serif', paper: 'white', version: 0 },
    titlePreferences: titlePreferencesRows[0]
      ? titlePreferencesDto(titlePreferencesRows[0])
      : null,
    migrationNotice: migrationRows[0] ? migrationNoticeDto(migrationRows[0]) : null
  };
}

export async function getReaderInitialState(
  input: ReaderStateContext
): Promise<ReaderInitialStateDto> {
  requireUserActor(input.actor);
  return withTransaction(input.database, async (transaction) => {
    const locked = await lockReaderTitle(transaction, input.actor, input.titleId);
    return getLockedReaderInitialState(transaction, locked);
  });
}

export async function saveProgress(
  input: ReaderStateContext & ProgressMutationInput
): Promise<ReaderProgressDto> {
  requireUserActor(input.actor);
  return withTransaction(input.database, async (transaction) => {
    const locked = await lockReaderTitle(transaction, input.actor, input.titleId);
    await validateReaderLocation(transaction, {
      titleId: locked.title.id,
      revisionId: locked.revisionId,
      format: locked.title.format,
      presentation: locked.presentation,
      location: input.location
    });
    const values = {
      userId: locked.userId,
      titleId: locked.title.id,
      revisionId: locked.revisionId,
      ...locationColumns(input.location)
    };
    const rows: ReaderProgressRow[] = input.expectedVersion === 0
      ? await transaction
        .insert(readerProgress)
        .values(values)
        .onConflictDoNothing()
        .returning()
      : await transaction
        .update(readerProgress)
        .set({
          ...locationColumns(input.location),
          version: sql`${readerProgress.version} + 1`,
          updatedAt: sql`clock_timestamp()`
        })
        .where(
          and(
            eq(readerProgress.userId, locked.userId),
            eq(readerProgress.titleId, locked.title.id),
            eq(readerProgress.revisionId, locked.revisionId),
            eq(readerProgress.version, input.expectedVersion)
          )
        )
        .returning();
    if (rows[0]) return progressDto(rows[0]);
    const current = await currentProgress(
      transaction,
      locked.userId,
      locked.title.id,
      locked.revisionId
    );
    if (!current) throw new ActiveRevisionChangedError();
    throw new StaleReaderStateError(progressDto(current));
  });
}

function bookmarkWhere(
  userId: string,
  titleId: string,
  revisionId: string,
  location: BookmarkMutationInput['location']
) {
  const identity = [
    eq(readerBookmarks.userId, userId),
    eq(readerBookmarks.titleId, titleId),
    eq(readerBookmarks.revisionId, revisionId),
    eq(readerBookmarks.format, location.format)
  ];
  return location.format === 'prose'
    ? and(
        ...identity,
        eq(readerBookmarks.blockId, location.blockId),
        eq(readerBookmarks.proseOffset, location.offset)
      )
    : and(
        ...identity,
        eq(readerBookmarks.pageId, location.pageId),
        location.panelOrdinal === null
          ? isNull(readerBookmarks.panelOrdinal)
          : eq(readerBookmarks.panelOrdinal, location.panelOrdinal)
      );
}

export async function createBookmark(
  input: ReaderStateContext & BookmarkMutationInput
): Promise<ReaderBookmarkDto> {
  requireUserActor(input.actor);
  return withTransaction(input.database, async (transaction) => {
    const locked = await lockReaderTitle(transaction, input.actor, input.titleId);
    await validateReaderLocation(transaction, {
      titleId: locked.title.id,
      revisionId: locked.revisionId,
      format: locked.title.format,
      presentation: locked.presentation,
      location: input.location
    });
    const rows = await transaction
      .insert(readerBookmarks)
      .values({
        userId: locked.userId,
        titleId: locked.title.id,
        revisionId: locked.revisionId,
        ...locationColumns(input.location)
      })
      .onConflictDoNothing()
      .returning();
    if (rows[0]) return bookmarkDto(rows[0]);
    const [existing] = await transaction
      .select()
      .from(readerBookmarks)
      .where(bookmarkWhere(locked.userId, locked.title.id, locked.revisionId, input.location))
      .limit(1);
    if (!existing) throw new ReaderStateNotFoundError();
    return bookmarkDto(existing);
  });
}

export async function deleteBookmark(
  input: ReaderStateContext & { bookmarkId: string }
): Promise<void> {
  requireUserActor(input.actor);
  await withTransaction(input.database, async (transaction) => {
    const locked = await lockReaderTitle(transaction, input.actor, input.titleId);
    await transaction
      .delete(readerBookmarks)
      .where(
        and(
          eq(readerBookmarks.id, input.bookmarkId),
          eq(readerBookmarks.userId, locked.userId),
          eq(readerBookmarks.titleId, locked.title.id),
          eq(readerBookmarks.revisionId, locked.revisionId)
        )
      );
  });
}

async function currentPreferences(
  transaction: DatabaseTransaction,
  userId: string
): Promise<ReaderPreferencesRow | null> {
  const [row] = await transaction
    .select()
    .from(readerPreferences)
    .where(eq(readerPreferences.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function saveReaderPreferences(
  input: AccountStateContext & PreferencesMutationInput
): Promise<ReaderPreferencesDto> {
  requireUserActor(input.actor);
  return withTransaction(input.database, async (transaction) => {
    const locked = await lockReaderAccount(transaction, input.actor);
    const values = {
      userId: locked.userId,
      fontSize: input.fontSize,
      typeface: input.typeface,
      paper: input.paper
    };
    const rows: ReaderPreferencesRow[] = input.expectedVersion === 0
      ? await transaction
        .insert(readerPreferences)
        .values(values)
        .onConflictDoNothing()
        .returning()
      : await transaction
        .update(readerPreferences)
        .set({
          fontSize: input.fontSize,
          typeface: input.typeface,
          paper: input.paper,
          version: sql`${readerPreferences.version} + 1`,
          updatedAt: sql`clock_timestamp()`
        })
        .where(
          and(
            eq(readerPreferences.userId, locked.userId),
            eq(readerPreferences.version, input.expectedVersion)
          )
        )
        .returning();
    if (rows[0]) return preferencesDto(rows[0]);
    const current = await currentPreferences(transaction, locked.userId);
    if (!current) throw new ReaderStateNotFoundError();
    throw new StaleReaderStateError(preferencesDto(current));
  });
}

async function currentTitlePreferences(
  transaction: DatabaseTransaction,
  userId: string,
  titleId: string
): Promise<ReaderTitlePreferencesRow | null> {
  const [row] = await transaction
    .select()
    .from(readerTitlePreferences)
    .where(
      and(
        eq(readerTitlePreferences.userId, userId),
        eq(readerTitlePreferences.titleId, titleId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function saveReaderTitlePreferences(
  input: ReaderStateContext & TitlePreferencesMutationInput
): Promise<ReaderTitlePreferencesDto> {
  requireUserActor(input.actor);
  return withTransaction(input.database, async (transaction) => {
    const locked = await lockReaderTitle(transaction, input.actor, input.titleId);
    if (locked.title.format !== 'comic') throw new ReaderStateNotFoundError();
    const values = {
      userId: locked.userId,
      titleId: locked.title.id,
      comicMode: input.comicMode
    };
    const rows: ReaderTitlePreferencesRow[] = input.expectedVersion === 0
      ? await transaction
        .insert(readerTitlePreferences)
        .values(values)
        .onConflictDoNothing()
        .returning()
      : await transaction
        .update(readerTitlePreferences)
        .set({
          comicMode: input.comicMode,
          version: sql`${readerTitlePreferences.version} + 1`,
          updatedAt: sql`clock_timestamp()`
        })
        .where(
          and(
            eq(readerTitlePreferences.userId, locked.userId),
            eq(readerTitlePreferences.titleId, locked.title.id),
            eq(readerTitlePreferences.version, input.expectedVersion)
          )
        )
        .returning();
    if (rows[0]) return titlePreferencesDto(rows[0]);
    const current = await currentTitlePreferences(transaction, locked.userId, locked.title.id);
    if (!current) throw new ReaderStateNotFoundError();
    throw new StaleReaderStateError(titlePreferencesDto(current));
  });
}

export async function acknowledgeMigrationNotice(
  input: ReaderStateContext & MigrationNoticeMutationInput
): Promise<ReaderMigrationNoticeDto> {
  requireUserActor(input.actor);
  return withTransaction(input.database, async (transaction) => {
    const locked = await lockReaderTitle(transaction, input.actor, input.titleId);
    if (input.targetRevisionId !== locked.revisionId) throw new ReaderStateNotFoundError();
    const [updated] = await transaction
      .update(readerRevisionMigrations)
      .set({ noticeAcknowledgedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(readerRevisionMigrations.userId, locked.userId),
          eq(readerRevisionMigrations.titleId, locked.title.id),
          eq(readerRevisionMigrations.targetRevisionId, locked.revisionId),
          isNull(readerRevisionMigrations.noticeAcknowledgedAt)
        )
      )
      .returning();
    if (updated) return migrationNoticeDto(updated);
    const [existing] = await transaction
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
    if (!existing) throw new ReaderStateNotFoundError();
    return migrationNoticeDto(existing);
  });
}
