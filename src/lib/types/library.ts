import { z } from 'zod';

const boundedVersionSchema = z.number().int().nonnegative().max(2_147_483_647);
const persistedVersionSchema = z.number().int().positive().max(2_147_483_647);
const semanticOffsetSchema = z.number().int().nonnegative().max(2_147_483_647);
const isoTimestampSchema = z.iso.datetime({ offset: true });
const applicationPathSchema = z.string().trim().min(1).max(2_048).startsWith('/');

export const readerTypefaceSchema = z.enum(['serif', 'sans', 'georgia']);
export const readerPaperSchema = z.enum(['white', 'sepia', 'dim']);
export const comicModeSchema = z.enum(['page', 'guided']);

const proseReaderLocationSchema = z.strictObject({
  format: z.literal('prose'),
  blockId: z.uuid(),
  offset: semanticOffsetSchema
});

const comicReaderLocationSchema = z.strictObject({
  format: z.literal('comic'),
  pageId: z.uuid(),
  panelOrdinal: z.number().int().nonnegative().max(1_000_000).nullable()
});

export const readerLocationSchema = z.discriminatedUnion('format', [
  proseReaderLocationSchema,
  comicReaderLocationSchema
]);

export type ProseReaderLocation = z.infer<typeof proseReaderLocationSchema>;
export type ComicReaderLocation = z.infer<typeof comicReaderLocationSchema>;
export type ReaderLocation = z.infer<typeof readerLocationSchema>;
export type ReaderTypeface = z.infer<typeof readerTypefaceSchema>;
export type ReaderPaper = z.infer<typeof readerPaperSchema>;
export type ComicMode = z.infer<typeof comicModeSchema>;

export const readerProgressInputSchema = z.strictObject({
  location: readerLocationSchema,
  expectedVersion: boundedVersionSchema
});

export const readerBookmarkInputSchema = z.strictObject({
  location: readerLocationSchema
});

export const readerPreferencesInputSchema = z.strictObject({
  fontSize: z.number().int().min(14).max(24),
  typeface: readerTypefaceSchema,
  paper: readerPaperSchema,
  expectedVersion: boundedVersionSchema
});

export const readerTitlePreferencesInputSchema = z.strictObject({
  comicMode: comicModeSchema,
  expectedVersion: boundedVersionSchema
});

export const readerMigrationNoticeInputSchema = z.strictObject({
  targetRevisionId: z.uuid()
});

export type ProgressMutationInput = z.infer<typeof readerProgressInputSchema>;
export type BookmarkMutationInput = z.infer<typeof readerBookmarkInputSchema>;
export type PreferencesMutationInput = z.infer<typeof readerPreferencesInputSchema>;
export type TitlePreferencesMutationInput = z.infer<typeof readerTitlePreferencesInputSchema>;
export type MigrationNoticeMutationInput = z.infer<typeof readerMigrationNoticeInputSchema>;

export const readerProgressSchema = z.strictObject({
  revisionId: z.uuid(),
  location: readerLocationSchema,
  version: persistedVersionSchema,
  updatedAt: isoTimestampSchema
});

export const readerBookmarkSchema = z.strictObject({
  id: z.uuid(),
  revisionId: z.uuid(),
  location: readerLocationSchema,
  createdAt: isoTimestampSchema
});

export const readerPreferencesSchema = z.strictObject({
  fontSize: z.number().int().min(14).max(24),
  typeface: readerTypefaceSchema,
  paper: readerPaperSchema,
  version: boundedVersionSchema
});

export const readerTitlePreferencesSchema = z.strictObject({
  titleId: z.uuid(),
  comicMode: comicModeSchema,
  version: boundedVersionSchema
});

export const readerMigrationNoticeSchema = z.strictObject({
  targetRevisionId: z.uuid(),
  progress: z.enum(['migrated', 'reset', 'absent']),
  panelPositionSimplified: z.boolean(),
  migratedBookmarkCount: z.number().int().nonnegative().max(2_147_483_647),
  unmatchedBookmarkCount: z.number().int().nonnegative().max(2_147_483_647),
  acknowledged: z.boolean()
});

export type ReaderProgressDto = z.infer<typeof readerProgressSchema>;
export type ReaderBookmarkDto = z.infer<typeof readerBookmarkSchema>;
export type ReaderPreferencesDto = z.infer<typeof readerPreferencesSchema>;
export type ReaderTitlePreferencesDto = z.infer<typeof readerTitlePreferencesSchema>;
export type ReaderMigrationNoticeDto = z.infer<typeof readerMigrationNoticeSchema>;

export const readerInitialStateSchema = z.strictObject({
  progress: readerProgressSchema.nullable(),
  bookmarks: z.array(readerBookmarkSchema),
  preferences: readerPreferencesSchema,
  titlePreferences: readerTitlePreferencesSchema.nullable(),
  migrationNotice: readerMigrationNoticeSchema.nullable()
});

export type ReaderInitialStateDto = z.infer<typeof readerInitialStateSchema>;

export interface StaleReaderStateDto<Value> {
  code: 'STALE_VERSION';
  current: Value;
}

export function staleReaderStateSchema<Schema extends z.ZodType>(current: Schema) {
  return z.strictObject({
    code: z.literal('STALE_VERSION'),
    current
  });
}

export const libraryEntrySchema = z.strictObject({
  titleId: z.uuid(),
  slug: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  creatorName: z.string().trim().min(1).max(500),
  format: z.enum(['prose', 'comic']),
  coverUrl: applicationPathSchema.nullable(),
  availability: z.enum(['available', 'temporarily_unavailable']),
  activeRevisionId: z.uuid().nullable(),
  downloadFormat: z.enum(['epub', 'cbz', 'zip']).nullable(),
  progressPercent: z.number().min(0).max(100).nullable(),
  readUrl: applicationPathSchema.nullable(),
  resumeUrl: applicationPathSchema.nullable(),
  downloadUrl: applicationPathSchema.nullable()
});

export const customerLibrarySchema = z.array(libraryEntrySchema);

export type LibraryEntryDto = z.infer<typeof libraryEntrySchema>;
