import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '$lib/server/db/client';
import { parseStorageKey, type StorageKey } from './keys';
import type { ObjectStorage, StorageListPage } from './types';
import {
  classifyStorageObject,
  cleanupStorage,
  type StorageReferenceSnapshot
} from './cleanup';

const now = new Date('2026-08-09T12:00:00.000Z');
const old = new Date('2026-07-01T00:00:00.000Z');
const recent = new Date('2026-08-09T11:00:00.000Z');
const titleId = randomUUID();
const revisionId = randomUUID();

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  });
}

function object(key: string, modifiedAt = old, byteSize = 10) {
  return { key: parseStorageKey(key), modifiedAt, byteSize };
}

function references(overrides: Partial<StorageReferenceSnapshot> = {}): StorageReferenceSnapshot {
  return {
    staging: new Set(),
    derived: new Set(),
    titleCovers: new Set(),
    ...overrides
  };
}

describe('storage cleanup classification', () => {
  it('classifies only old, unreferenced staging, derived, and title-cover objects', () => {
    const staging = object(`staging/uploads/${randomUUID()}`);
    const derived = object(`titles/${titleId}/revisions/${revisionId}/derived/v1/prose-images/${randomUUID()}.webp`);
    const cover = object(`titles/${titleId}/covers/${randomUUID()}.webp`);
    const config = { stagingRetentionHours: 24, orphanRetentionHours: 168 };

    expect(classifyStorageObject(staging, references(), config, now)).toBe('staging');
    expect(classifyStorageObject(derived, references(), config, now)).toBe('derived');
    expect(classifyStorageObject(cover, references(), config, now)).toBe('title-cover');
    expect(classifyStorageObject({ ...staging, modifiedAt: recent }, references(), config, now)).toBeNull();
    expect(classifyStorageObject(staging, references({ staging: new Set([staging.key]) }), config, now)).toBeNull();
    expect(classifyStorageObject(derived, references({ derived: new Set([derived.key]) }), config, now)).toBeNull();
    expect(classifyStorageObject(cover, references({ titleCovers: new Set([cover.key]) }), config, now)).toBeNull();
  });

  it('ages only canonical health probes with the staging retention window', () => {
    const probe = object(`health/probes/${randomUUID()}`);
    const config = { stagingRetentionHours: 24, orphanRetentionHours: 168 };

    expect(classifyStorageObject(probe, references(), config, now)).toBe('health-probe');
    expect(classifyStorageObject(
      { ...probe, modifiedAt: recent }, references(), config, now
    )).toBeNull();
    expect(classifyStorageObject(
      object(`health/probes/${randomUUID().toUpperCase()}`), references(), config, now
    )).toBeNull();
    expect(classifyStorageObject(
      object('health/probes/not-a-uuid'), references(), config, now
    )).toBeNull();
  });

  it('categorically excludes retained originals and unknown object classes', () => {
    const original = object(`titles/${titleId}/revisions/${revisionId}/original`);
    const config = { stagingRetentionHours: 1, orphanRetentionHours: 1 };
    expect(classifyStorageObject(original, references(), config, now)).toBeNull();
    expect(classifyStorageObject(object('health/arbitrary'), references(), config, now)).toBeNull();
  });

  it('accepts only canonical legacy and generation-qualified derived key shapes', () => {
    const objectId = randomUUID();
    const config = { stagingRetentionHours: 1, orphanRetentionHours: 1 };
    for (const key of [
      `titles/${titleId}/revisions/${revisionId}/derived/v1/prose-images/${objectId}.webp`,
      `titles/${titleId}/revisions/${revisionId}/derived/v1/comic-pages/${objectId}.webp`,
      `titles/${titleId}/revisions/${revisionId}/derived/v1/cover-suggestions/${objectId}.webp`,
      `titles/${titleId}/revisions/${revisionId}/derived/v1/generations/0/prose-images/${objectId}.webp`,
      `titles/${titleId}/revisions/${revisionId}/derived/v1/generations/2147483647/comic-pages/${objectId}.webp`
    ]) {
      expect(classifyStorageObject(object(key), references(), config, now), key).toBe('derived');
    }
    for (const key of [
      `staging/uploads/not-a-uuid`,
      `titles/${titleId}/revisions/${revisionId}/derived/v1/arbitrary`,
      `titles/${titleId}/revisions/${revisionId}/derived/v1/generations/01/prose-images/${objectId}.webp`,
      `titles/${titleId}/revisions/${revisionId}/derived/v1/generations/2147483648/prose-images/${objectId}.webp`,
      `titles/${titleId}/revisions/${revisionId}/derived/v1/generations/1/unknown/${objectId}.webp`,
      `titles/${titleId}/covers/${objectId}.png`
    ]) {
      expect(classifyStorageObject(object(key), references(), config, now), key).toBeNull();
    }
    const controlCharacterKey = `staging/uploads/${objectId}\n` as StorageKey;
    expect(classifyStorageObject(
      { key: controlCharacterKey, modifiedAt: old, byteSize: 10 },
      references(),
      config,
      now
    )).toBeNull();
  });
});

function storageDouble(pages: ReadonlyMap<string, readonly StorageListPage[]>) {
  const positions = new Map<string, number>();
  const deleted: StorageKey[] = [];
  const storage = {
    listPrefix: vi.fn(async (prefix: StorageKey, options: { limit: number; cursor?: string }) => {
      expect(options.limit).toBeLessThanOrEqual(500);
      const index = positions.get(prefix) ?? 0;
      positions.set(prefix, index + 1);
      return pages.get(prefix)?.[index] ?? { objects: [], cursor: null };
    }),
    delete: vi.fn(async (key: StorageKey) => { deleted.push(key); })
  } as unknown as ObjectStorage;
  return { storage, deleted };
}

describe('bounded storage cleanup', () => {
  const config = { stagingRetentionHours: 24, orphanRetentionHours: 168 };

  it('counts candidate bytes in dry-run mode without deleting and follows bounded pages', async () => {
    const first = object(`staging/uploads/${randomUUID()}`, old, 11);
    const second = object(`staging/uploads/${randomUUID()}`, old, 13);
    const { storage } = storageDouble(new Map([
      ['staging/uploads', [
        { objects: [first], cursor: 'next' },
        { objects: [second], cursor: null }
      ]]
    ]));
    const summary = await cleanupStorage({
      database: {} as Database,
      storage,
      config,
      mode: 'dry-run',
      now,
      loadReferences: async () => references(),
      log: vi.fn()
    });
    expect(summary).toEqual({
      mode: 'dry-run', scanned: 2, candidates: 2, deleted: 0,
      candidateBytes: 24, deletedBytes: 0
    });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.listPrefix).toHaveBeenCalledTimes(4);
  });

  it('scans health probes and deletes only old canonical keys', async () => {
    const oldProbe = object(`health/probes/${randomUUID()}`, old, 7);
    const recentProbe = object(`health/probes/${randomUUID()}`, recent, 11);
    const malformedProbe = object('health/probes/not-a-uuid', old, 13);
    const execute = vi.fn(async (query: SQL) => {
      expect(rendered(query).params).toEqual([[oldProbe.key, recentProbe.key]]);
      return { rows: [] };
    });
    const { storage, deleted } = storageDouble(new Map([
      ['health/probes', [{
        objects: [oldProbe, recentProbe, malformedProbe],
        cursor: null
      }]]
    ]));

    const summary = await cleanupStorage({
      database: { execute } as unknown as Database,
      storage,
      config,
      mode: 'apply',
      now,
      log: vi.fn()
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual([oldProbe.key]);
    expect(summary).toEqual({
      mode: 'apply', scanned: 3, candidates: 1, deleted: 1,
      candidateBytes: 7, deletedBytes: 7
    });
  });

  it('deletes only exact candidates in apply mode', async () => {
    const candidate = object(`titles/${titleId}/covers/${randomUUID()}.webp`, old, 17);
    const retained = object(`titles/${titleId}/revisions/${revisionId}/original`, old, 19);
    const { storage, deleted } = storageDouble(new Map([
      ['titles', [{ objects: [candidate, retained], cursor: null }]]
    ]));
    const summary = await cleanupStorage({
      database: {} as Database,
      storage,
      config,
      mode: 'apply',
      now,
      loadReferences: async () => references(),
      log: vi.fn()
    });
    expect(deleted).toEqual([candidate.key]);
    expect(summary).toMatchObject({ candidates: 1, deleted: 1, deletedBytes: 17 });
  });

  it('stops the batch immediately on a storage or database error', async () => {
    const candidates = [
      object(`staging/uploads/${randomUUID()}`),
      object(`staging/uploads/${randomUUID()}`)
    ];
    const { storage } = storageDouble(new Map([
      ['staging/uploads', [{ objects: candidates, cursor: null }]]
    ]));
    vi.mocked(storage.delete).mockRejectedValueOnce(new Error('delete failed'));
    await expect(cleanupStorage({
      database: {} as Database,
      storage,
      config,
      mode: 'apply',
      now,
      loadReferences: async () => references(),
      log: vi.fn()
    })).rejects.toThrow('delete failed');
    expect(storage.delete).toHaveBeenCalledTimes(1);

    const databaseFailure = storageDouble(new Map([
      ['staging/uploads', [{ objects: [candidates[0]!], cursor: null }]]
    ]));
    await expect(cleanupStorage({
      database: {} as Database,
      storage: databaseFailure.storage,
      config,
      mode: 'dry-run',
      now,
      loadReferences: async () => { throw new Error('database failed'); },
      log: vi.fn()
    })).rejects.toThrow('database failed');
  });

  it('loads one bounded fail-closed reference snapshot through the cleanup routine', async () => {
    const protectedKey = parseStorageKey(
      `titles/${titleId}/revisions/${revisionId}/derived/v1/prose-images/${randomUUID()}.webp`
    );
    const orphanKey = parseStorageKey(
      `titles/${titleId}/revisions/${revisionId}/derived/v1/generations/7/comic-pages/${randomUUID()}.webp`
    );
    const retainedOriginal = parseStorageKey(
      `titles/${titleId}/revisions/${revisionId}/original`
    );
    const malformed = parseStorageKey(
      `titles/${titleId}/revisions/${revisionId}/derived/v1/generations/07/comic-pages/${randomUUID()}.webp`
    );
    const execute = vi.fn(async (query: SQL) => {
      const compiled = rendered(query);
      expect(compiled.sql).toMatch(
        /from "public"\."storage_cleanup_referenced_keys"\(\s*\$1::text\[\]\s*\)/u
      );
      expect(compiled.params).toEqual([[protectedKey, orphanKey]]);
      return {
        rows: [{ storageKey: protectedKey }]
      };
    });
    const { storage } = storageDouble(new Map([
      ['titles', [{
        objects: [object(protectedKey), object(orphanKey), object(retainedOriginal), object(malformed)],
        cursor: null
      }]]
    ]));

    const summary = await cleanupStorage({
      database: { execute } as unknown as Database,
      storage,
      config,
      mode: 'dry-run',
      now,
      log: vi.fn()
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ scanned: 4, candidates: 1, candidateBytes: 10 });
  });

  it('rejects malformed or duplicate rows returned by the privileged cleanup routine', async () => {
    const key = parseStorageKey(`staging/uploads/${randomUUID()}`);
    for (const rows of [
      [
        { storageKey: key },
        { storageKey: key }
      ],
      [{ storageKey: `staging/uploads/${randomUUID()}` }],
      [{ storageKey: null }]
    ]) {
      const { storage } = storageDouble(new Map([
        ['staging/uploads', [{ objects: [object(key)], cursor: null }]]
      ]));
      const database = {
        execute: vi.fn(async () => ({ rows }))
      } as unknown as Database;
      await expect(cleanupStorage({
        database,
        storage,
        config,
        mode: 'dry-run',
        now,
        log: vi.fn()
      })).rejects.toThrow(/cleanup reference result/iu);
    }
  });

  it('rejects a health probe returned as referenced by the privileged routine', async () => {
    const probe = object(`health/probes/${randomUUID()}`);
    const { storage } = storageDouble(new Map([
      ['health/probes', [{ objects: [probe], cursor: null }]]
    ]));
    const database = {
      execute: vi.fn(async () => ({ rows: [{ storageKey: probe.key }] }))
    } as unknown as Database;

    await expect(cleanupStorage({
      database,
      storage,
      config,
      mode: 'dry-run',
      now,
      log: vi.fn()
    })).rejects.toThrow(/cleanup reference result/iu);
  });
});
