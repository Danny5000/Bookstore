import type { Readable } from 'node:stream';
import type { StorageKey } from './keys';

export interface StoredObjectStat {
  byteSize: number;
  modifiedAt: Date;
}

export interface StorageListPage {
  objects: readonly {
    key: StorageKey;
    byteSize: number;
    modifiedAt: Date;
  }[];
  cursor: string | null;
}

export interface ObjectStorage {
  write(
    key: StorageKey,
    body: Readable,
    options: { maxBytes: number }
  ): Promise<StoredObjectStat>;
  read(key: StorageKey): Promise<Readable>;
  readRange(key: StorageKey, start: number, endInclusive: number): Promise<Readable>;
  stat(key: StorageKey): Promise<StoredObjectStat | null>;
  copy(source: StorageKey, destination: StorageKey): Promise<StoredObjectStat>;
  delete(key: StorageKey): Promise<void>;
  listPrefix(
    prefix: StorageKey,
    options: { limit: number; cursor?: string }
  ): Promise<StorageListPage>;
}
