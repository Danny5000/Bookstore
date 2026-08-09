import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { Database } from '$lib/server/db/client';
import {
  comicPages,
  jobs,
  proseImages,
  revisionCoverSuggestions,
  titleRevisions,
  titles
} from '$lib/server/db/schema';
import { INGEST_REVISION_JOB } from '$lib/server/ingestion/job';
import { parseStorageKey, stagingUploadsPrefix } from './keys';
import type { ObjectStorage, StorageListPage } from './types';

const cleanupPageSize = 500;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const originalPattern = new RegExp(`^titles/${uuid}/revisions/${uuid}/original$`, 'u');
const derivedPattern = new RegExp(`^titles/${uuid}/revisions/${uuid}/derived/v1/.+$`, 'u');
const titleCoverPattern = new RegExp(`^titles/${uuid}/covers/${uuid}\\.webp$`, 'u');

export interface StorageReferenceSnapshot {
  staging: ReadonlySet<string>;
  derived: ReadonlySet<string>;
  titleCovers: ReadonlySet<string>;
}

export interface CleanupConfig {
  stagingRetentionHours: number;
  orphanRetentionHours: number;
}

export interface CleanupSummary {
  mode: 'dry-run' | 'apply';
  scanned: number;
  candidates: number;
  deleted: number;
  candidateBytes: number;
  deletedBytes: number;
}

type ListedObject = StorageListPage['objects'][number];
type CandidateClass = 'staging' | 'derived' | 'title-cover';
type ReferenceLoader = (
  database: Database,
  objects: readonly ListedObject[]
) => Promise<StorageReferenceSnapshot>;

function olderThan(value: Date, now: Date, hours: number): boolean {
  return value.getTime() < now.getTime() - hours * 60 * 60 * 1_000;
}

export function classifyStorageObject(
  object: ListedObject,
  references: StorageReferenceSnapshot,
  config: CleanupConfig,
  now: Date
): CandidateClass | null {
  const key = object.key;
  if (originalPattern.test(key)) return null;
  if (key.startsWith(`${stagingUploadsPrefix()}/`)) {
    return olderThan(object.modifiedAt, now, config.stagingRetentionHours) &&
      !references.staging.has(key)
      ? 'staging'
      : null;
  }
  if (derivedPattern.test(key)) {
    return olderThan(object.modifiedAt, now, config.orphanRetentionHours) &&
      !references.derived.has(key)
      ? 'derived'
      : null;
  }
  if (titleCoverPattern.test(key)) {
    return olderThan(object.modifiedAt, now, config.orphanRetentionHours) &&
      !references.titleCovers.has(key)
      ? 'title-cover'
      : null;
  }
  return null;
}

async function loadDatabaseReferences(
  database: Database,
  objects: readonly ListedObject[]
): Promise<StorageReferenceSnapshot> {
  const stagingKeys = objects
    .map(({ key }) => key)
    .filter((key) => key.startsWith(`${stagingUploadsPrefix()}/`));
  const derivedKeys = objects.map(({ key }) => key).filter((key) => derivedPattern.test(key));
  const coverKeys = objects.map(({ key }) => key).filter((key) => titleCoverPattern.test(key));

  const stagingRows = stagingKeys.length === 0
    ? []
    : await database
        .selectDistinct({ key: titleRevisions.stagingStorageKey })
        .from(titleRevisions)
        .leftJoin(
          jobs,
          and(
            eq(jobs.type, INGEST_REVISION_JOB),
            inArray(jobs.status, ['pending', 'running']),
            sql`${jobs.payload}->>'revisionId' = ${titleRevisions.id}::text`
          )
        )
        .where(and(
          inArray(titleRevisions.stagingStorageKey, stagingKeys),
          or(
            inArray(titleRevisions.state, ['uploaded', 'processing']),
            isNotNull(jobs.id)
          )
        ));

  const [proseRows, comicRows, suggestionRows, coverRows] = await Promise.all([
    derivedKeys.length === 0
      ? []
      : database.select({ key: proseImages.storageKey }).from(proseImages)
          .where(inArray(proseImages.storageKey, derivedKeys)),
    derivedKeys.length === 0
      ? []
      : database.select({ key: comicPages.storageKey }).from(comicPages)
          .where(inArray(comicPages.storageKey, derivedKeys)),
    derivedKeys.length === 0
      ? []
      : database.select({ key: revisionCoverSuggestions.storageKey }).from(revisionCoverSuggestions)
          .where(inArray(revisionCoverSuggestions.storageKey, derivedKeys)),
    coverKeys.length === 0
      ? []
      : database.select({ key: titles.coverStorageKey }).from(titles)
          .where(inArray(titles.coverStorageKey, coverKeys))
  ]);

  return {
    staging: new Set(stagingRows.flatMap(({ key }) => key ? [key] : [])),
    derived: new Set([...proseRows, ...comicRows, ...suggestionRows].map(({ key }) => key)),
    titleCovers: new Set(coverRows.flatMap(({ key }) => key ? [key] : []))
  };
}

export async function cleanupStorage(options: {
  database: Database;
  storage: ObjectStorage;
  config: CleanupConfig;
  mode: 'dry-run' | 'apply';
  now?: Date;
  loadReferences?: ReferenceLoader;
  log?: (summary: CleanupSummary) => void;
}): Promise<CleanupSummary> {
  const now = options.now ?? new Date();
  const loadReferences = options.loadReferences ?? loadDatabaseReferences;
  const summary: CleanupSummary = {
    mode: options.mode,
    scanned: 0,
    candidates: 0,
    deleted: 0,
    candidateBytes: 0,
    deletedBytes: 0
  };

  for (const prefix of [stagingUploadsPrefix(), parseStorageKey('titles')]) {
    let cursor: string | undefined;
    do {
      const page = await options.storage.listPrefix(prefix, {
        limit: cleanupPageSize,
        ...(cursor ? { cursor } : {})
      });
      summary.scanned += page.objects.length;
      const references = page.objects.length > 0
        ? await loadReferences(options.database, page.objects)
        : { staging: new Set<string>(), derived: new Set<string>(), titleCovers: new Set<string>() };
      for (const object of page.objects) {
        if (!classifyStorageObject(object, references, options.config, now)) continue;
        summary.candidates += 1;
        summary.candidateBytes += object.byteSize;
        if (options.mode === 'apply') {
          await options.storage.delete(object.key);
          summary.deleted += 1;
          summary.deletedBytes += object.byteSize;
        }
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }

  (options.log ?? ((value) => console.info('[storage-cleanup]', value)))(summary);
  return summary;
}
