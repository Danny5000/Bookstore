import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { comicPages, proseBlocks, titleRevisions, titles } from './catalog';

export const readerLocationFormat = pgEnum('reader_location_format', ['prose', 'comic']);
export const readerTypeface = pgEnum('reader_typeface', ['serif', 'sans', 'georgia']);
export const readerPaper = pgEnum('reader_paper', ['white', 'sepia', 'dim']);
export const readerComicMode = pgEnum('reader_comic_mode', ['page', 'guided']);
export const readerMigrationProgress = pgEnum('reader_migration_progress', [
  'migrated',
  'reset',
  'absent'
]);

export const entitlements = pgTable(
  'entitlements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    titleId: uuid('title_id')
      .notNull()
      .references(() => titles.id, { onDelete: 'cascade' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    unique('entitlements_user_title_unique').on(table.userId, table.titleId),
    index('entitlements_user_title_idx').on(table.userId, table.titleId),
    index('entitlements_active_user_idx')
      .on(table.userId, table.titleId)
      .where(sql`${table.revokedAt} is null`),
    check(
      'entitlements_revocation_after_grant',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.grantedAt}`
    )
  ]
);

export const readerProgress = pgTable(
  'reader_progress',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    titleId: uuid('title_id')
      .notNull()
      .references(() => titles.id, { onDelete: 'cascade' }),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => titleRevisions.id, { onDelete: 'cascade' }),
    format: readerLocationFormat('format').notNull(),
    blockId: uuid('block_id'),
    proseOffset: integer('prose_offset'),
    pageId: uuid('page_id'),
    panelOrdinal: integer('panel_ordinal'),
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    unique('reader_progress_user_title_revision_unique').on(
      table.userId,
      table.titleId,
      table.revisionId
    ),
    index('reader_progress_user_title_idx').on(table.userId, table.titleId, table.updatedAt),
    foreignKey({
      name: 'reader_progress_revision_same_title_fk',
      columns: [table.titleId, table.revisionId],
      foreignColumns: [titleRevisions.titleId, titleRevisions.id]
    }).onDelete('cascade'),
    foreignKey({
      name: 'reader_progress_block_same_revision_fk',
      columns: [table.revisionId, table.blockId],
      foreignColumns: [proseBlocks.revisionId, proseBlocks.id]
    }).onDelete('cascade'),
    foreignKey({
      name: 'reader_progress_page_same_revision_fk',
      columns: [table.revisionId, table.pageId],
      foreignColumns: [comicPages.revisionId, comicPages.id]
    }).onDelete('cascade'),
    check(
      'reader_progress_location_shape',
      sql`(
        ${table.format} = 'prose' and
        ${table.blockId} is not null and
        ${table.proseOffset} is not null and ${table.proseOffset} >= 0 and
        ${table.pageId} is null and ${table.panelOrdinal} is null
      ) or (
        ${table.format} = 'comic' and
        ${table.blockId} is null and ${table.proseOffset} is null and
        ${table.pageId} is not null and
        (${table.panelOrdinal} is null or ${table.panelOrdinal} >= 0)
      )`
    ),
    check('reader_progress_version_positive', sql`${table.version} > 0`)
  ]
);

export const readerBookmarks = pgTable(
  'reader_bookmarks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    titleId: uuid('title_id')
      .notNull()
      .references(() => titles.id, { onDelete: 'cascade' }),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => titleRevisions.id, { onDelete: 'cascade' }),
    format: readerLocationFormat('format').notNull(),
    blockId: uuid('block_id'),
    proseOffset: integer('prose_offset'),
    pageId: uuid('page_id'),
    panelOrdinal: integer('panel_ordinal'),
    migratedFromBookmarkId: uuid('migrated_from_bookmark_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index('reader_bookmarks_user_title_revision_idx').on(
      table.userId,
      table.titleId,
      table.revisionId,
      table.createdAt
    ),
    uniqueIndex('reader_bookmarks_prose_location_unique')
      .on(table.userId, table.titleId, table.revisionId, table.blockId, table.proseOffset)
      .where(sql`${table.format} = 'prose'`),
    uniqueIndex('reader_bookmarks_comic_location_unique')
      .on(
        table.userId,
        table.titleId,
        table.revisionId,
        table.pageId,
        sql`coalesce(${table.panelOrdinal}, -1)`
      )
      .where(sql`${table.format} = 'comic'`),
    foreignKey({
      name: 'reader_bookmarks_revision_same_title_fk',
      columns: [table.titleId, table.revisionId],
      foreignColumns: [titleRevisions.titleId, titleRevisions.id]
    }).onDelete('cascade'),
    foreignKey({
      name: 'reader_bookmarks_block_same_revision_fk',
      columns: [table.revisionId, table.blockId],
      foreignColumns: [proseBlocks.revisionId, proseBlocks.id]
    }).onDelete('cascade'),
    foreignKey({
      name: 'reader_bookmarks_page_same_revision_fk',
      columns: [table.revisionId, table.pageId],
      foreignColumns: [comicPages.revisionId, comicPages.id]
    }).onDelete('cascade'),
    foreignKey({
      name: 'reader_bookmarks_migrated_from_fk',
      columns: [table.migratedFromBookmarkId],
      foreignColumns: [table.id]
    }).onDelete('restrict'),
    check(
      'reader_bookmarks_location_shape',
      sql`(
        ${table.format} = 'prose' and
        ${table.blockId} is not null and
        ${table.proseOffset} is not null and ${table.proseOffset} >= 0 and
        ${table.pageId} is null and ${table.panelOrdinal} is null
      ) or (
        ${table.format} = 'comic' and
        ${table.blockId} is null and ${table.proseOffset} is null and
        ${table.pageId} is not null and
        (${table.panelOrdinal} is null or ${table.panelOrdinal} >= 0)
      )`
    )
  ]
);

export const readerPreferences = pgTable(
  'reader_preferences',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    fontSize: integer('font_size').default(18).notNull(),
    typeface: readerTypeface('typeface').default('serif').notNull(),
    paper: readerPaper('paper').default('white').notNull(),
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    check('reader_preferences_font_size_bounds', sql`${table.fontSize} between 14 and 24`),
    check('reader_preferences_version_positive', sql`${table.version} > 0`)
  ]
);

export const readerTitlePreferences = pgTable(
  'reader_title_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    titleId: uuid('title_id')
      .notNull()
      .references(() => titles.id, { onDelete: 'cascade' }),
    comicMode: readerComicMode('comic_mode').default('page').notNull(),
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    primaryKey({
      name: 'reader_title_preferences_user_title_pk',
      columns: [table.userId, table.titleId]
    }),
    check('reader_title_preferences_version_positive', sql`${table.version} > 0`)
  ]
);

export const readerRevisionMigrations = pgTable(
  'reader_revision_migrations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    titleId: uuid('title_id')
      .notNull()
      .references(() => titles.id, { onDelete: 'cascade' }),
    sourceRevisionId: uuid('source_revision_id')
      .notNull()
      .references(() => titleRevisions.id, { onDelete: 'cascade' }),
    targetRevisionId: uuid('target_revision_id')
      .notNull()
      .references(() => titleRevisions.id, { onDelete: 'cascade' }),
    progressResult: readerMigrationProgress('progress_result').notNull(),
    panelPositionSimplified: boolean('panel_position_simplified').default(false).notNull(),
    migratedBookmarkCount: integer('migrated_bookmark_count').default(0).notNull(),
    unmatchedBookmarkCount: integer('unmatched_bookmark_count').default(0).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).defaultNow().notNull(),
    noticeAcknowledgedAt: timestamp('notice_acknowledged_at', { withTimezone: true })
  },
  (table) => [
    unique('reader_revision_migrations_source_target_unique').on(
      table.userId,
      table.titleId,
      table.sourceRevisionId,
      table.targetRevisionId
    ),
    unique('reader_revision_migrations_target_unique').on(
      table.userId,
      table.titleId,
      table.targetRevisionId
    ),
    index('reader_revision_migrations_user_title_idx').on(
      table.userId,
      table.titleId,
      table.completedAt
    ),
    foreignKey({
      name: 'reader_revision_migrations_source_same_title_fk',
      columns: [table.titleId, table.sourceRevisionId],
      foreignColumns: [titleRevisions.titleId, titleRevisions.id]
    }).onDelete('cascade'),
    foreignKey({
      name: 'reader_revision_migrations_target_same_title_fk',
      columns: [table.titleId, table.targetRevisionId],
      foreignColumns: [titleRevisions.titleId, titleRevisions.id]
    }).onDelete('cascade'),
    check(
      'reader_revision_migrations_distinct_revisions',
      sql`${table.sourceRevisionId} <> ${table.targetRevisionId}`
    ),
    check(
      'reader_revision_migrations_counts_nonnegative',
      sql`${table.migratedBookmarkCount} >= 0 and ${table.unmatchedBookmarkCount} >= 0`
    ),
    check(
      'reader_revision_migrations_panel_simplified_shape',
      sql`not ${table.panelPositionSimplified} or ${table.progressResult} = 'migrated'`
    ),
    check(
      'reader_revision_migrations_acknowledged_after_completion',
      sql`${table.noticeAcknowledgedAt} is null or ${table.noticeAcknowledgedAt} >= ${table.completedAt}`
    )
  ]
);

export type EntitlementRow = typeof entitlements.$inferSelect;
export type ReaderProgressRow = typeof readerProgress.$inferSelect;
export type ReaderBookmarkRow = typeof readerBookmarks.$inferSelect;
export type ReaderPreferencesRow = typeof readerPreferences.$inferSelect;
export type ReaderTitlePreferencesRow = typeof readerTitlePreferences.$inferSelect;
export type ReaderRevisionMigrationRow = typeof readerRevisionMigrations.$inferSelect;
