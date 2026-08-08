import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn
} from 'drizzle-orm/pg-core';

export const titleFormat = pgEnum('title_format', ['prose', 'comic']);
export const titleVisibility = pgEnum('title_visibility', ['private', 'public', 'archived']);
export const revisionState = pgEnum('revision_state', [
  'uploaded',
  'processing',
  'ready_for_review',
  'failed',
  'active',
  'retired'
]);

export const titles = pgTable(
  'titles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    description: text('description').notNull(),
    creatorName: text('creator_name').notNull(),
    format: titleFormat('format').notNull(),
    priceMinor: integer('price_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    visibility: titleVisibility('visibility').default('private').notNull(),
    activeRevisionId: uuid('active_revision_id').references(
      (): AnyPgColumn => titleRevisions.id,
      { onDelete: 'set null' }
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('titles_slug_unique').on(table.slug),
    index('titles_visibility_created_idx').on(table.visibility, table.createdAt),
    check('titles_price_minor_nonnegative', sql`${table.priceMinor} >= 0`),
    check('titles_currency_iso_shape', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check('titles_slug_shape', sql`${table.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`)
  ]
);

export const titleRevisions = pgTable(
  'title_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    titleId: uuid('title_id')
      .notNull()
      .references(() => titles.id, { onDelete: 'cascade' }),
    parentRevisionId: uuid('parent_revision_id'),
    state: revisionState('state').default('uploaded').notNull(),
    createdByActorId: text('created_by_actor_id').notNull(),
    changeSummary: text('change_summary').notNull(),
    originalStorageKey: text('original_storage_key'),
    originalChecksumSha256: varchar('original_checksum_sha256', { length: 64 }),
    originalMimeType: text('original_mime_type'),
    originalByteSize: bigint('original_byte_size', { mode: 'number' }),
    originalFilename: text('original_filename'),
    failureCode: text('failure_code'),
    failureDetails: text('failure_details'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true })
  },
  (table) => [
    index('title_revisions_title_created_idx').on(table.titleId, table.createdAt),
    index('title_revisions_state_created_idx').on(table.state, table.createdAt),
    unique('title_revisions_title_id_id_unique').on(table.titleId, table.id),
    uniqueIndex('title_revisions_one_active_per_title')
      .on(table.titleId)
      .where(sql`${table.state} = 'active'`),
    foreignKey({
      name: 'title_revisions_parent_same_title_fk',
      columns: [table.titleId, table.parentRevisionId],
      foreignColumns: [table.titleId, table.id]
    }).onDelete('restrict'),
    check(
      'title_revisions_byte_size_positive',
      sql`${table.originalByteSize} is null or ${table.originalByteSize} > 0`
    ),
    check(
      'title_revisions_checksum_shape',
      sql`${table.originalChecksumSha256} is null or ${table.originalChecksumSha256} ~ '^[0-9a-f]{64}$'`
    )
  ]
);

export type TitleRow = typeof titles.$inferSelect;
export type NewTitleRow = typeof titles.$inferInsert;
export type TitleRevisionRow = typeof titleRevisions.$inferSelect;
export type NewTitleRevisionRow = typeof titleRevisions.$inferInsert;
