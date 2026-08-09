import { getApplicationConfig } from '$lib/server/config';
import { createObjectStorage } from './factory';
import type { ObjectStorage } from './types';

let objectStorage: ObjectStorage | undefined;

export function getObjectStorage(): ObjectStorage {
  objectStorage ??= createObjectStorage(getApplicationConfig().storage);
  return objectStorage;
}
