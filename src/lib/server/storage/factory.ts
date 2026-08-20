import type { StorageConfig } from '$lib/server/config';
import { createRoutedLocalObjectStorage } from './routed';
import type { ObjectStorage } from './types';

export class UnsupportedStorageProviderError extends Error {
  constructor(provider: string) {
    super(`Unsupported storage provider: ${provider}`);
    this.name = 'UnsupportedStorageProviderError';
  }
}

export class StorageConfigurationError extends Error {
  constructor() {
    super('Local object storage requires staging, publication, and covers roots');
    this.name = 'StorageConfigurationError';
  }
}

export function createObjectStorage(config: StorageConfig): ObjectStorage {
  if (config.provider === 's3') throw new UnsupportedStorageProviderError('s3');
  if (!config.stagingRoot || !config.publicationRoot || !config.coversRoot) {
    throw new StorageConfigurationError();
  }
  return createRoutedLocalObjectStorage({
    stagingRoot: config.stagingRoot,
    publicationRoot: config.publicationRoot,
    coversRoot: config.coversRoot,
    ...(config.scratchRoot ? { scratchBase: config.scratchRoot } : {})
  });
}
