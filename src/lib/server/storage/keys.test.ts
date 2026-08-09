import { describe, expect, it } from 'vitest';
import {
  healthProbeKey,
  healthProbesPrefix,
  parseStorageKey,
  revisionComicPageKey,
  revisionCoverSuggestionKey,
  revisionDerivedPrefix,
  revisionOriginalKey,
  revisionProseImageKey,
  stagingUploadKey,
  stagingUploadsPrefix,
  StorageKeyError,
  titleCoverKey,
  titleCoversPrefix
} from './keys';

const uploadId = '018f0000-0000-7000-8000-000000000001';
const titleId = '018f0000-0000-7000-8000-000000000010';
const revisionId = '018f0000-0000-7000-8000-000000000011';
const objectId = '018f0000-0000-7000-8000-000000000012';

describe('storage key policy', () => {
  it('constructs only application-owned object namespaces', () => {
    expect(stagingUploadKey(uploadId)).toBe(`staging/uploads/${uploadId}`);
    expect(revisionOriginalKey(titleId, revisionId)).toBe(
      `titles/${titleId}/revisions/${revisionId}/original`
    );
    expect(revisionProseImageKey(titleId, revisionId, objectId)).toBe(
      `titles/${titleId}/revisions/${revisionId}/derived/v1/prose-images/${objectId}.webp`
    );
    expect(revisionComicPageKey(titleId, revisionId, objectId)).toBe(
      `titles/${titleId}/revisions/${revisionId}/derived/v1/comic-pages/${objectId}.webp`
    );
    expect(revisionCoverSuggestionKey(titleId, revisionId, objectId)).toBe(
      `titles/${titleId}/revisions/${revisionId}/derived/v1/cover-suggestions/${objectId}.webp`
    );
    expect(titleCoverKey(titleId, objectId)).toBe(
      `titles/${titleId}/covers/${objectId}.webp`
    );
    expect(healthProbeKey(objectId)).toBe(`health/probes/${objectId}`);
  });

  it('constructs bounded maintenance prefixes', () => {
    expect(stagingUploadsPrefix()).toBe('staging/uploads');
    expect(revisionDerivedPrefix(titleId, revisionId)).toBe(
      `titles/${titleId}/revisions/${revisionId}/derived/v1`
    );
    expect(titleCoversPrefix(titleId)).toBe(`titles/${titleId}/covers`);
    expect(healthProbesPrefix()).toBe('health/probes');
  });

  it.each([
    '',
    '../secret',
    '/secret',
    'C:/secret',
    'titles\\secret',
    'titles//secret',
    'titles/./secret',
    'titles/../secret',
    'titles/%2e%2e/secret',
    'titles/%2E/secret',
    'titles/%2fsecret',
    'titles/%not-encoded',
    'titles/secret\u0000'
  ])('rejects unsafe key %j', (value) => {
    expect(() => parseStorageKey(value)).toThrowError(StorageKeyError);
  });

  it('rejects oversized keys', () => {
    expect(() => parseStorageKey(`titles/${'a'.repeat(500)}`)).toThrowError(StorageKeyError);
  });

  it('rejects filenames or malformed IDs supplied to constructors', () => {
    expect(() => stagingUploadKey('my-book.epub')).toThrowError(StorageKeyError);
    expect(() => revisionOriginalKey(titleId, '../comic.cbz')).toThrowError(StorageKeyError);
    expect(() => titleCoverKey(titleId, 'cover.jpg')).toThrowError(StorageKeyError);
  });

  it('accepts a validated opaque key unchanged', () => {
    expect(parseStorageKey(`titles/${titleId}/covers/${objectId}.webp`)).toBe(
      `titles/${titleId}/covers/${objectId}.webp`
    );
  });
});
