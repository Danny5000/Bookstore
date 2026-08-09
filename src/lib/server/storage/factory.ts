import type { StorageConfig } from '$lib/server/config';
import { createLocalObjectStorage } from './local';
import type { ObjectStorage } from './types';

export class UnsupportedStorageProviderError extends Error {
  constructor(provider: string) {
    super(`Unsupported storage provider: ${provider}`);
    this.name = 'UnsupportedStorageProviderError';
  }
}

export class StorageConfigurationError extends Error {
  constructor() {
    super('Local object storage requires a configured root');
    this.name = 'StorageConfigurationError';
  }
}

export function createObjectStorage(config: StorageConfig): ObjectStorage {
  if (config.provider === 's3') throw new UnsupportedStorageProviderError('s3');
  if (!config.localRoot) throw new StorageConfigurationError();
  return createLocalObjectStorage(config.localRoot);
}
