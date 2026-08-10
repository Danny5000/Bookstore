import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseStorageKey } from '$lib/server/storage/keys';
import type { ComicPageRow } from './comic';
import type { EpubSectionRow } from './epub';
import { mapComicPagesForInsert, mapProseBlocksForInsert } from './handler';

const revisionId = randomUUID();
const fingerprint = 'a'.repeat(64);

describe('ingestion manifest row mapping', () => {
  it('carries prose semantic fingerprints into database insert values', () => {
    const section: EpubSectionRow = {
      id: randomUUID(),
      ordinal: 0,
      label: 'Chapter',
      sourceReference: 'EPUB/chapter.xhtml',
      blocks: [
        {
          id: randomUUID(),
          ordinal: 0,
          kind: 'paragraph',
          content: { kind: 'paragraph', fragments: [{ text: 'Signal', marks: [] }] },
          imageId: null,
          semanticFingerprintSha256: fingerprint,
          semanticFingerprintVersion: 1
        }
      ]
    };

    expect(mapProseBlocksForInsert(revisionId, [section])).toEqual([
      expect.objectContaining({
        revisionId,
        sectionId: section.id,
        semanticFingerprintSha256: fingerprint,
        semanticFingerprintVersion: 1
      })
    ]);
  });

  it('carries comic semantic fingerprints into database insert values', () => {
    const page: ComicPageRow = {
      id: randomUUID(),
      ordinal: 1,
      sourcePath: 'page-1.png',
      storageKey: parseStorageKey(
        `titles/${randomUUID()}/revisions/${revisionId}/derived/v1/comic-pages/${randomUUID()}.webp`
      ),
      mediaType: 'image/webp',
      checksumSha256: 'b'.repeat(64),
      semanticFingerprintSha256: fingerprint,
      semanticFingerprintVersion: 1,
      byteSize: 10,
      width: 1,
      height: 1,
      warnings: []
    };

    expect(mapComicPagesForInsert(revisionId, [page])).toEqual([
      expect.objectContaining({
        revisionId,
        semanticFingerprintSha256: fingerprint,
        semanticFingerprintVersion: 1
      })
    ]);
  });

  it('rejects an incomplete generated fingerprint before a database insert', () => {
    const malformed = {
      id: randomUUID(),
      ordinal: 0,
      kind: 'paragraph',
      content: { kind: 'paragraph', fragments: [{ text: 'Signal', marks: [] }] },
      imageId: null,
      semanticFingerprintVersion: 1
    };
    const section = {
      id: randomUUID(),
      ordinal: 0,
      label: null,
      sourceReference: 'EPUB/chapter.xhtml',
      blocks: [malformed]
    } as unknown as EpubSectionRow;

    expect(() => mapProseBlocksForInsert(revisionId, [section])).toThrow(
      /semantic fingerprint/iu
    );
  });
});
