import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { classifyStorageObject } from './cleanup';
import type { StorageKey } from './keys';
import { probeStorage } from './health';
import type { ObjectStorage } from './types';

type ProbeClass = 'staging' | 'publication-sentinel' | 'publication-probe' | 'covers';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const sentinelKey = 'health/publication/readiness-v1' as StorageKey;
const sentinelBytes = Buffer.from('pale-orbit-publication-ready-v1', 'utf8');
const probePatterns: Record<Exclude<ProbeClass, 'publication-sentinel'>, RegExp> = {
  staging: new RegExp(`^health/probes/${uuid}$`, 'u'),
  'publication-probe': new RegExp(
    `^titles/${uuid}/revisions/${uuid}/derived/v1/generations/0/cover-suggestions/${uuid}\\.webp$`,
    'u'
  ),
  covers: new RegExp(`^titles/${uuid}/covers/${uuid}\\.webp$`, 'u')
};

function probeClass(key: StorageKey): ProbeClass {
  if (key === sentinelKey) return 'publication-sentinel';
  for (const [storageClass, pattern] of Object.entries(probePatterns)) {
    if (pattern.test(key)) return storageClass as Exclude<ProbeClass, 'publication-sentinel'>;
  }
  throw new Error(`Unexpected readiness key: ${key}`);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function probeStorageDouble(options: {
  mismatch?: ProbeClass;
  sentinelMissing?: boolean;
} = {}) {
  const objects = new Map<StorageKey, Buffer>();
  if (!options.sentinelMissing) objects.set(sentinelKey, sentinelBytes);
  const write = vi.fn(async (
    key: StorageKey,
    body: Readable,
    _options: { maxBytes: number; expectedBytes?: number }
  ) => {
    const value = await collect(body);
    objects.set(key, value);
    return { byteSize: value.byteLength, modifiedAt: new Date(0) };
  });
  const read = vi.fn(async (key: StorageKey) => {
    const value = objects.get(key);
    if (!value) throw new Error('Object does not exist');
    return Readable.from([
      options.mismatch === probeClass(key) ? Buffer.from('wrong') : value
    ]);
  });
  const stat = vi.fn(async (key: StorageKey) => {
    const value = objects.get(key);
    return value
      ? { byteSize: value.byteLength, modifiedAt: new Date(0) }
      : null;
  });
  const deleteObject = vi.fn(async (key: StorageKey) => {
    objects.delete(key);
  });
  const storage = {
    write,
    read,
    readRange: vi.fn(),
    prepareVerifiedRead: vi.fn(),
    stat,
    copy: vi.fn(),
    delete: deleteObject,
    listPrefix: vi.fn()
  } satisfies ObjectStorage;
  return { storage, objects, write, read, stat, deleteObject };
}

function calledKeys(mock: ReturnType<typeof vi.fn>): StorageKey[] {
  return mock.mock.calls.map((call) => call[0] as StorageKey);
}

describe('probeStorage', () => {
  it('round-trips only writable web roots and reads the fixed publication sentinel', async () => {
    const { storage, write, read, stat, deleteObject } = probeStorageDouble();

    await expect(probeStorage(storage, 'web')).resolves.toBeUndefined();

    expect(calledKeys(write).map(probeClass)).toEqual(['staging', 'covers']);
    expect(calledKeys(read).map(probeClass)).toEqual([
      'staging',
      'publication-sentinel',
      'covers'
    ]);
    expect(calledKeys(deleteObject)).toEqual(calledKeys(write));
    expect(stat).not.toHaveBeenCalled();
    expect(write.mock.calls.every((call) => call[2]?.maxBytes === 32)).toBe(true);
  });

  it('provisions the sentinel and round-trips every writable root for writer processes', async () => {
    const { storage, objects, write, read, stat, deleteObject } = probeStorageDouble({
      sentinelMissing: true
    });

    await expect(probeStorage(storage, 'writer')).resolves.toBeUndefined();

    expect(calledKeys(write).map(probeClass)).toEqual([
      'staging',
      'publication-sentinel',
      'publication-probe',
      'covers'
    ]);
    expect(calledKeys(read).map(probeClass)).toEqual(calledKeys(write).map(probeClass));
    expect(calledKeys(deleteObject).map(probeClass)).toEqual([
      'staging',
      'publication-probe',
      'covers'
    ]);
    expect(objects.get(sentinelKey)).toEqual(sentinelBytes);
    expect(write.mock.calls.map((call) => [probeClass(call[0]), call[2].maxBytes])).toEqual([
      ['staging', 32],
      ['publication-sentinel', sentinelBytes.byteLength],
      ['publication-probe', 32],
      ['covers', 32]
    ]);
    expect(stat).not.toHaveBeenCalled();
  });

  it('keeps the sentinel outside cleanup while crash probes remain disposable', async () => {
    const { storage, write } = probeStorageDouble();
    await probeStorage(storage, 'writer');
    const references = {
      staging: new Set<string>(),
      derived: new Set<string>(),
      titleCovers: new Set<string>()
    };
    const now = new Date('2026-08-15T12:00:00.000Z');

    expect(calledKeys(write).map((key) => classifyStorageObject(
      { key, byteSize: 32, modifiedAt: new Date('2026-08-01T12:00:00.000Z') },
      references,
      { stagingRetentionHours: 24, orphanRetentionHours: 168 },
      now
    ))).toEqual(['health-probe', null, 'derived', 'title-cover']);
  });

  it.each<ProbeClass>([
    'staging',
    'publication-sentinel',
    'publication-probe',
    'covers'
  ])(
    'fails closed on a %s mismatch and deletes every attempted transient writer probe',
    async (mismatch) => {
      const { storage, write, deleteObject } = probeStorageDouble({ mismatch });

      await expect(probeStorage(storage, 'writer')).rejects.toThrow(
        'Storage readiness probe failed'
      );

      const transientWrites = calledKeys(write).filter((key) => key !== sentinelKey);
      expect(calledKeys(deleteObject)).toEqual(transientWrites);
      expect(calledKeys(deleteObject)).not.toContain(sentinelKey);
    }
  );

  it.each([
    { sentinelMissing: true },
    { mismatch: 'publication-sentinel' as const }
  ])('fails web readiness when the fixed publication sentinel is unavailable or mismatched', async (options) => {
    const { storage, write, deleteObject } = probeStorageDouble(options);

    await expect(probeStorage(storage, 'web')).rejects.toThrow();

    expect(calledKeys(write).map(probeClass)).toEqual(['staging']);
    expect(calledKeys(deleteObject)).toEqual(calledKeys(write));
    expect(calledKeys(deleteObject)).not.toContain(sentinelKey);
  });
});
