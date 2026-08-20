import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { StorageConfig } from '$lib/server/config';
import { revisionOriginalKey, stagingUploadKey } from './keys';
import {
  createObjectStorage,
  StorageConfigurationError,
  UnsupportedStorageProviderError
} from './factory';

describe('object storage factory', () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
  });

  it('creates a working routed local adapter', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pale-orbit-storage-factory-'));
    cleanupRoots.push(parent);
    const stagingRoot = join(parent, 'staging');
    const publicationRoot = join(parent, 'publication');
    const storage = createObjectStorage({
      provider: 'local',
      stagingRoot,
      publicationRoot,
      coversRoot: join(parent, 'covers'),
      scratchRoot: join(parent, 'scratch'),
      stagingRetentionHours: 24,
      orphanRetentionHours: 168
    });
    const upload = stagingUploadKey('018f0000-0000-7000-8000-000000000010');
    const original = revisionOriginalKey(
      '018f0000-0000-7000-8000-000000000011',
      '018f0000-0000-7000-8000-000000000012'
    );

    await storage.write(upload, Readable.from(['ready']), { maxBytes: 5 });
    await storage.copy(upload, original);

    expect(await storage.stat(original)).toMatchObject({ byteSize: 5 });
    await expect(readFile(join(stagingRoot, ...upload.split('/')), 'utf8')).resolves.toBe('ready');
    await expect(readFile(join(publicationRoot, ...original.split('/')), 'utf8')).resolves.toBe('ready');
  });

  it('fails when any local persistent root is missing', () => {
    expect(() => createObjectStorage({
      provider: 'local',
      stagingRoot: 'staging',
      publicationRoot: undefined,
      coversRoot: 'covers',
      scratchRoot: undefined,
      stagingRetentionHours: 24,
      orphanRetentionHours: 168
    })).toThrow(StorageConfigurationError);
  });

  it('fails explicitly when the reserved S3 provider is selected', () => {
    const config: StorageConfig = {
      provider: 's3',
      stagingRoot: undefined,
      publicationRoot: undefined,
      coversRoot: undefined,
      scratchRoot: undefined,
      stagingRetentionHours: 24,
      orphanRetentionHours: 168
    };

    expect(() => createObjectStorage(config)).toThrowError(
      new UnsupportedStorageProviderError('s3')
    );
  });
});
