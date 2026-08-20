import { sql } from 'drizzle-orm';
import type { Database } from '$lib/server/db/client';
import { healthProbesPrefix, parseStorageKey, stagingUploadsPrefix } from './keys';
import type { ObjectStorage, StorageListPage } from './types';

const cleanupPageSize = 500;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const generation = '(?:0|[1-9][0-9]{0,9})';
const maximumGeneration = 2_147_483_647;
const derivedClass = '(?:prose-images|comic-pages|cover-suggestions)';
const stagingPattern = new RegExp(`^staging/uploads/${uuid}$`, 'u');
const healthProbePattern = new RegExp(`^health/probes/${uuid}$`, 'u');
const originalPattern = new RegExp(`^titles/${uuid}/revisions/${uuid}/original$`, 'u');
const legacyDerivedPattern = new RegExp(
  `^titles/${uuid}/revisions/${uuid}/derived/v1/${derivedClass}/${uuid}\\.webp$`,
  'u'
);
const generatedDerivedPattern = new RegExp(
  `^titles/${uuid}/revisions/${uuid}/derived/v1/generations/(${generation})/${derivedClass}/${uuid}\\.webp$`,
  'u'
);
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
type CandidateClass = 'staging' | 'health-probe' | 'derived' | 'title-cover';
type ReferenceLoader = (
  database: Database,
  objects: readonly ListedObject[]
) => Promise<StorageReferenceSnapshot>;

interface StorageCleanupReferenceRow extends Record<string, unknown> {
  storageKey: unknown;
}

function olderThan(value: Date, now: Date, hours: number): boolean {
  return value.getTime() < now.getTime() - hours * 60 * 60 * 1_000;
}

function candidateClassForKey(key: string): CandidateClass | null {
  try {
    parseStorageKey(key);
  } catch {
    return null;
  }
  if (stagingPattern.test(key)) return 'staging';
  if (healthProbePattern.test(key)) return 'health-probe';
  if (legacyDerivedPattern.test(key)) return 'derived';
  const generated = generatedDerivedPattern.exec(key);
  if (generated && Number(generated[1]) <= maximumGeneration) return 'derived';
  if (titleCoverPattern.test(key)) return 'title-cover';
  return null;
}

export function classifyStorageObject(
  object: ListedObject,
  references: StorageReferenceSnapshot,
  config: CleanupConfig,
  now: Date
): CandidateClass | null {
  const key = object.key;
  if (originalPattern.test(key)) return null;
  const candidateClass = candidateClassForKey(key);
  if (candidateClass === 'staging') {
    return olderThan(object.modifiedAt, now, config.stagingRetentionHours) &&
      !references.staging.has(key)
      ? 'staging'
      : null;
  }
  if (candidateClass === 'health-probe') {
    return olderThan(object.modifiedAt, now, config.stagingRetentionHours)
      ? 'health-probe'
      : null;
  }
  if (candidateClass === 'derived') {
    return olderThan(object.modifiedAt, now, config.orphanRetentionHours) &&
      !references.derived.has(key)
      ? 'derived'
      : null;
  }
  if (candidateClass === 'title-cover') {
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
  const candidates = objects.flatMap(({ key }) => {
    const storageClass = candidateClassForKey(key);
    return storageClass === null ? [] : [{ storageClass, storageKey: key }];
  });
  const snapshot = {
    staging: new Set<string>(),
    derived: new Set<string>(),
    titleCovers: new Set<string>()
  };
  if (candidates.length === 0) return snapshot;

  const expected = new Map<string, CandidateClass>(candidates.map((candidate) => [
    candidate.storageKey,
    candidate.storageClass
  ]));
  const result = await database.execute<StorageCleanupReferenceRow>(sql`
    select
      "referenced_storage_key" as "storageKey"
    from "public"."storage_cleanup_referenced_keys"(
      ${sql.param(candidates.map(({ storageKey }) => storageKey))}::text[]
    )
  `);
  const seen = new Set<string>();
  for (const row of result.rows) {
    if (
      typeof row.storageKey !== 'string' ||
      !expected.has(row.storageKey) ||
      seen.has(row.storageKey)
    ) throw new Error('Storage cleanup reference result was invalid');
    seen.add(row.storageKey);
    const storageClass = expected.get(row.storageKey);
    if (storageClass === undefined || storageClass === 'health-probe') {
      throw new Error('Storage cleanup reference result was invalid');
    }
    if (storageClass === 'staging') snapshot.staging.add(row.storageKey);
    else if (storageClass === 'derived') snapshot.derived.add(row.storageKey);
    else snapshot.titleCovers.add(row.storageKey);
  }
  return snapshot;
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

  for (const prefix of [
    stagingUploadsPrefix(),
    healthProbesPrefix(),
    parseStorageKey('titles')
  ]) {
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
