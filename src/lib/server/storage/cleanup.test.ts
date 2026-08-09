import { randomUUID } from 'node:crypto';
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

  it('categorically excludes retained originals and unknown object classes', () => {
    const original = object(`titles/${titleId}/revisions/${revisionId}/original`);
    const config = { stagingRetentionHours: 1, orphanRetentionHours: 1 };
    expect(classifyStorageObject(original, references(), config, now)).toBeNull();
    expect(classifyStorageObject(object(`health/probes/${randomUUID()}`), references(), config, now)).toBeNull();
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
    expect(storage.listPrefix).toHaveBeenCalledTimes(3);
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
});
