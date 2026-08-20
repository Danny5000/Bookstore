import { join } from 'node:path';
import { createObjectStorage } from '$lib/server/storage/factory';
import type { StorageKey } from '$lib/server/storage/keys';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration storage`);
  return value;
}

export const storageRoots = {
  staging: required('STORAGE_STAGING_ROOT'),
  publication: required('STORAGE_PUBLICATION_ROOT'),
  covers: required('STORAGE_COVERS_ROOT'),
  scratch: required('STORAGE_SCRATCH_ROOT')
};

export const storage = createObjectStorage({
  provider: 'local',
  stagingRoot: storageRoots.staging,
  publicationRoot: storageRoots.publication,
  coversRoot: storageRoots.covers,
  scratchRoot: storageRoots.scratch,
  stagingRetentionHours: 1,
  orphanRetentionHours: 2
});

export function localPathForStorageKey(key: StorageKey): string {
  const root = key.startsWith('staging/') || key.startsWith('health/')
    ? storageRoots.staging
    : key.includes('/covers/')
      ? storageRoots.covers
      : storageRoots.publication;
  return join(root, ...key.split('/'));
}
