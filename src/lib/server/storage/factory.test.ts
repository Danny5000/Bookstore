import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { StorageConfig } from '$lib/server/config';
import { parseStorageKey } from './keys';
import { createObjectStorage, UnsupportedStorageProviderError } from './factory';

describe('object storage factory', () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
  });

  it('creates a working local adapter', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'pale-orbit-storage-factory-'));
    cleanupRoots.push(localRoot);
    const storage = createObjectStorage({
      provider: 'local',
      localRoot,
      stagingRetentionHours: 24,
      orphanRetentionHours: 168
    });
    const key = parseStorageKey('health/probes/018f0000-0000-7000-8000-000000000010');

    await storage.write(key, Readable.from(['ready']), { maxBytes: 5 });

    expect(await storage.stat(key)).toMatchObject({ byteSize: 5 });
  });

  it('fails explicitly when the reserved S3 provider is selected', () => {
    const config: StorageConfig = {
      provider: 's3',
      localRoot: undefined,
      stagingRetentionHours: 24,
      orphanRetentionHours: 168
    };

    expect(() => createObjectStorage(config)).toThrowError(
      new UnsupportedStorageProviderError('s3')
    );
  });
});
