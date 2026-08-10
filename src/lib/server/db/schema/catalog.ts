import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
  type PgTableExtraConfigValue
} from 'drizzle-orm/pg-core';
import type { ProseBlockData } from '$lib/types/publication';

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
export const revisionPresentationState = pgEnum('revision_presentation_state', [
  'draft',
  'published',
  'superseded'
]);
export const proseBlockKind = pgEnum('prose_block_kind', [
  'heading',
  'paragraph',
  'quote',
  'list',
  'image',
  'break'
]);
export const readingDirection = pgEnum('reading_direction', ['ltr', 'rtl']);

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
    activeRevisionId: uuid('active_revision_id'),
    coverStorageKey: text('cover_storage_key'),
    coverMediaType: text('cover_media_type'),
    coverChecksumSha256: varchar('cover_checksum_sha256', { length: 64 }),
    coverByteSize: bigint('cover_byte_size', { mode: 'number' }),
    coverWidth: integer('cover_width'),
    coverHeight: integer('cover_height'),
    coverUpdatedAt: timestamp('cover_updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex('titles_slug_unique').on(table.slug),
    index('titles_visibility_created_idx').on(table.visibility, table.createdAt),
    foreignKey({
      name: 'titles_active_revision_same_title_fk',
      columns: [table.id, table.activeRevisionId],
      foreignColumns: [titleRevisions.titleId, titleRevisions.id]
    }),
    check('titles_price_minor_nonnegative', sql`${table.priceMinor} >= 0`),
    check('titles_currency_iso_shape', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check('titles_slug_shape', sql`${table.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    check(
      'titles_cover_complete',
      sql`(
        ${table.coverStorageKey} is null and
        ${table.coverMediaType} is null and
        ${table.coverChecksumSha256} is null and
        ${table.coverByteSize} is null and
        ${table.coverWidth} is null and
        ${table.coverHeight} is null and
        ${table.coverUpdatedAt} is null
      ) or (
        ${table.coverStorageKey} is not null and
        ${table.coverMediaType} is not null and
        ${table.coverChecksumSha256} is not null and
        ${table.coverByteSize} > 0 and
        ${table.coverWidth} > 0 and
        ${table.coverHeight} > 0 and
        ${table.coverUpdatedAt} is not null
      )`
    ),
    check(
      'titles_cover_checksum_shape',
      sql`${table.coverChecksumSha256} is null or ${table.coverChecksumSha256} ~ '^[0-9a-f]{64}$'`
    )
  ]
);

export const titleRevisions = pgTable(
  'title_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    titleId: uuid('title_id')
      .notNull()
      .references((): AnyPgColumn => titles.id, { onDelete: 'cascade' }),
    parentRevisionId: uuid('parent_revision_id'),
    state: revisionState('state').default('uploaded').notNull(),
    createdByActorId: text('created_by_actor_id').notNull(),
    changeSummary: text('change_summary').notNull(),
    stagingStorageKey: text('staging_storage_key'),
    stagingChecksumSha256: varchar('staging_checksum_sha256', { length: 64 }),
    stagingByteSize: bigint('staging_byte_size', { mode: 'number' }),
    uploadFilename: text('upload_filename'),
    uploadMimeType: text('upload_mime_type'),
    ingestionGeneration: integer('ingestion_generation').default(0).notNull(),
    derivationVersion: integer('derivation_version').default(1).notNull(),
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
      'title_revisions_staging_byte_size_positive',
      sql`${table.stagingByteSize} is null or ${table.stagingByteSize} > 0`
    ),
    check(
      'title_revisions_staging_checksum_shape',
      sql`${table.stagingChecksumSha256} is null or ${table.stagingChecksumSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'title_revisions_byte_size_positive',
      sql`${table.originalByteSize} is null or ${table.originalByteSize} > 0`
    ),
    check(
      'title_revisions_checksum_shape',
      sql`${table.originalChecksumSha256} is null or ${table.originalChecksumSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check('title_revisions_ingestion_generation_nonnegative', sql`${table.ingestionGeneration} >= 0`),
    check('title_revisions_derivation_version_positive', sql`${table.derivationVersion} > 0`)
  ]
);

export const proseSections = pgTable(
  'prose_sections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => titleRevisions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    label: text('label'),
    sourceReference: text('source_reference').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    unique('prose_sections_revision_id_id_unique').on(table.revisionId, table.id),
    unique('prose_sections_revision_ordinal_unique').on(table.revisionId, table.ordinal),
    index('prose_sections_revision_idx').on(table.revisionId, table.ordinal),
    check('prose_sections_ordinal_nonnegative', sql`${table.ordinal} >= 0`)
  ]
);

export const proseImages = pgTable(
  'prose_images',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => titleRevisions.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    mediaType: text('media_type').notNull(),
    checksumSha256: varchar('checksum_sha256', { length: 64 }).notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    altText: text('alt_text').default('').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    unique('prose_images_revision_id_id_unique').on(table.revisionId, table.id),
    uniqueIndex('prose_images_storage_key_unique').on(table.storageKey),
    index('prose_images_revision_idx').on(table.revisionId),
    check('prose_images_byte_size_positive', sql`${table.byteSize} > 0`),
    check('prose_images_dimensions_positive', sql`${table.width} > 0 and ${table.height} > 0`),
    check('prose_images_checksum_shape', sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`)
  ]
);

export const proseBlocks = pgTable(
  'prose_blocks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => titleRevisions.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    kind: proseBlockKind('kind').notNull(),
    content: jsonb('content').$type<ProseBlockData>().notNull(),
    imageId: uuid('image_id'),
    semanticFingerprintSha256: varchar('semantic_fingerprint_sha256', { length: 64 }),
    semanticFingerprintVersion: integer('semantic_fingerprint_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    unique('prose_blocks_revision_id_id_unique').on(table.revisionId, table.id),
    unique('prose_blocks_section_ordinal_unique').on(
      table.revisionId,
      table.sectionId,
      table.ordinal
    ),
    index('prose_blocks_revision_section_idx').on(
      table.revisionId,
      table.sectionId,
      table.ordinal
    ),
    index('prose_blocks_semantic_fingerprint_idx').on(
      table.revisionId,
      table.semanticFingerprintVersion,
      table.semanticFingerprintSha256
    ),
    foreignKey({
      name: 'prose_blocks_section_same_revision_fk',
      columns: [table.revisionId, table.sectionId],
      foreignColumns: [proseSections.revisionId, proseSections.id]
    }).onDelete('cascade'),
    foreignKey({
      name: 'prose_blocks_image_same_revision_fk',
      columns: [table.revisionId, table.imageId],
      foreignColumns: [proseImages.revisionId, proseImages.id]
    }).onDelete('cascade'),
    check('prose_blocks_ordinal_nonnegative', sql`${table.ordinal} >= 0`),
    check('prose_blocks_image_kind_shape', sql`(${table.kind} = 'image') = (${table.imageId} is not null)`),
    check(
      'prose_blocks_semantic_fingerprint_pair',
      sql`(${table.semanticFingerprintSha256} is null) = (${table.semanticFingerprintVersion} is null)`
    ),
    check(
      'prose_blocks_semantic_fingerprint_shape',
      sql`${table.semanticFingerprintSha256} is null or ${table.semanticFingerprintSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'prose_blocks_semantic_fingerprint_version_positive',
      sql`${table.semanticFingerprintVersion} is null or ${table.semanticFingerprintVersion} > 0`
    )
  ]
);

export const comicPages = pgTable(
  'comic_pages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => titleRevisions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    sourcePath: text('source_path').notNull(),
    storageKey: text('storage_key').notNull(),
    mediaType: text('media_type').notNull(),
    checksumSha256: varchar('checksum_sha256', { length: 64 }).notNull(),
    semanticFingerprintSha256: varchar('semantic_fingerprint_sha256', { length: 64 }),
    semanticFingerprintVersion: integer('semantic_fingerprint_version'),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    unique('comic_pages_revision_id_id_unique').on(table.revisionId, table.id),
    unique('comic_pages_revision_ordinal_unique').on(table.revisionId, table.ordinal),
    uniqueIndex('comic_pages_storage_key_unique').on(table.storageKey),
    index('comic_pages_revision_idx').on(table.revisionId, table.ordinal),
    index('comic_pages_semantic_fingerprint_idx').on(
      table.revisionId,
      table.semanticFingerprintVersion,
      table.semanticFingerprintSha256
    ),
    check('comic_pages_ordinal_positive', sql`${table.ordinal} > 0`),
    check('comic_pages_byte_size_positive', sql`${table.byteSize} > 0`),
    check('comic_pages_dimensions_positive', sql`${table.width} > 0 and ${table.height} > 0`),
    check('comic_pages_checksum_shape', sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'comic_pages_semantic_fingerprint_pair',
      sql`(${table.semanticFingerprintSha256} is null) = (${table.semanticFingerprintVersion} is null)`
    ),
    check(
      'comic_pages_semantic_fingerprint_shape',
      sql`${table.semanticFingerprintSha256} is null or ${table.semanticFingerprintSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      'comic_pages_semantic_fingerprint_version_positive',
      sql`${table.semanticFingerprintVersion} is null or ${table.semanticFingerprintVersion} > 0`
    )
  ]
);

export const revisionPresentations = pgTable(
  'revision_presentations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => titleRevisions.id, { onDelete: 'cascade' }),
    state: revisionPresentationState('state').default('draft').notNull(),
    readingDirection: readingDirection('reading_direction').default('ltr').notNull(),
    guidedViewEnabled: boolean('guided_view_enabled').default(false).notNull(),
    previewProseSectionId: uuid('preview_prose_section_id'),
    previewProseBlockId: uuid('preview_prose_block_id'),
    previewComicPageId: uuid('preview_comic_page_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    unique('revision_presentations_revision_id_id_unique').on(table.revisionId, table.id),
    uniqueIndex('revision_presentations_one_draft_per_revision')
      .on(table.revisionId)
      .where(sql`${table.state} = 'draft'`),
    uniqueIndex('revision_presentations_one_published_per_revision')
      .on(table.revisionId)
      .where(sql`${table.state} = 'published'`),
    index('revision_presentations_revision_state_idx').on(table.revisionId, table.state),
    foreignKey({
      name: 'revision_presentations_section_same_revision_fk',
      columns: [table.revisionId, table.previewProseSectionId],
      foreignColumns: [proseSections.revisionId, proseSections.id]
    }).onDelete('cascade'),
    foreignKey({
      name: 'revision_presentations_block_same_revision_fk',
      columns: [table.revisionId, table.previewProseBlockId],
      foreignColumns: [proseBlocks.revisionId, proseBlocks.id]
    }).onDelete('cascade'),
    foreignKey({
      name: 'revision_presentations_page_same_revision_fk',
      columns: [table.revisionId, table.previewComicPageId],
      foreignColumns: [comicPages.revisionId, comicPages.id]
    }).onDelete('cascade'),
    check(
      'revision_presentations_preview_shape',
      sql`(
        ${table.state} = 'draft' and
        ${table.previewProseSectionId} is null and
        ${table.previewProseBlockId} is null and
        ${table.previewComicPageId} is null
      ) or (
        ${table.previewProseSectionId} is not null and
        ${table.previewProseBlockId} is not null and
        ${table.previewComicPageId} is null
      ) or (
        ${table.previewProseSectionId} is null and
        ${table.previewProseBlockId} is null and
        ${table.previewComicPageId} is not null
      )`
    )
  ]
);

export const comicPanelRegions = pgTable(
  'comic_panel_regions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => titleRevisions.id, { onDelete: 'cascade' }),
    presentationId: uuid('presentation_id').notNull(),
    pageId: uuid('page_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    width: doublePrecision('width').notNull(),
    height: doublePrecision('height').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    unique('comic_panel_regions_presentation_page_ordinal_unique').on(
      table.revisionId,
      table.presentationId,
      table.pageId,
      table.ordinal
    ),
    index('comic_panel_regions_presentation_page_idx').on(
      table.presentationId,
      table.pageId,
      table.ordinal
    ),
    foreignKey({
      name: 'comic_panel_regions_presentation_same_revision_fk',
      columns: [table.revisionId, table.presentationId],
      foreignColumns: [revisionPresentations.revisionId, revisionPresentations.id]
    }).onDelete('cascade'),
    foreignKey({
      name: 'comic_panel_regions_page_same_revision_fk',
      columns: [table.revisionId, table.pageId],
      foreignColumns: [comicPages.revisionId, comicPages.id]
    }).onDelete('cascade'),
    check('comic_panel_regions_ordinal_nonnegative', sql`${table.ordinal} >= 0`),
    check(
      'comic_panel_regions_bounds',
      sql`${table.x} >= 0 and ${table.y} >= 0 and
        ${table.width} > 0 and ${table.height} > 0 and
        ${table.x} + ${table.width} <= 1 and ${table.y} + ${table.height} <= 1`
    )
  ]
);

export const revisionCoverSuggestions = pgTable(
  'revision_cover_suggestions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => titleRevisions.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    sourceDescription: text('source_description').notNull(),
    mediaType: text('media_type').notNull(),
    checksumSha256: varchar('checksum_sha256', { length: 64 }).notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('revision_cover_suggestions_revision_unique').on(table.revisionId),
    uniqueIndex('revision_cover_suggestions_storage_key_unique').on(table.storageKey),
    check('revision_cover_suggestions_byte_size_positive', sql`${table.byteSize} > 0`),
    check(
      'revision_cover_suggestions_dimensions_positive',
      sql`${table.width} > 0 and ${table.height} > 0`
    ),
    check(
      'revision_cover_suggestions_checksum_shape',
      sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`
    )
  ]
);

export const revisionIngestionWarnings = pgTable(
  'revision_ingestion_warnings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => titleRevisions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    code: text('code').notNull(),
    safeMessage: text('safe_message').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    unique('revision_ingestion_warnings_revision_ordinal_unique').on(
      table.revisionId,
      table.ordinal
    ),
    index('revision_ingestion_warnings_revision_idx').on(table.revisionId, table.ordinal),
    check('revision_ingestion_warnings_ordinal_nonnegative', sql`${table.ordinal} >= 0`)
  ]
);

export type TitleRow = typeof titles.$inferSelect;
export type NewTitleRow = typeof titles.$inferInsert;
export type TitleRevisionRow = typeof titleRevisions.$inferSelect;
export type NewTitleRevisionRow = typeof titleRevisions.$inferInsert;
export type RevisionPresentationRow = typeof revisionPresentations.$inferSelect;
export type NewRevisionPresentationRow = typeof revisionPresentations.$inferInsert;
