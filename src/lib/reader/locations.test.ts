import { describe, expect, it } from 'vitest';
import type { ComicReaderDocument, ProseReaderDocument } from '$lib/types/publication';
import { paginatePublication } from './publication-pagination';
import { locationForPage, pageIndexForLocation } from './locations';

const titleId = '018f0000-0000-7000-8000-000000000100';
const revisionId = '018f0000-0000-7000-8000-000000000101';
const presentationId = '018f0000-0000-7000-8000-000000000102';
const sectionId = '018f0000-0000-7000-8000-000000000103';
const secondSectionId = '018f0000-0000-7000-8000-000000000104';
const longBlockId = '018f0000-0000-7000-8000-000000000105';
const secondBlockId = '018f0000-0000-7000-8000-000000000106';

function proseDocument(text = 'semantic words '.repeat(250)): ProseReaderDocument {
  return {
    titleId,
    revisionId,
    presentationId,
    title: 'Location Book',
    access: 'entitled',
    readingDirection: 'ltr',
    format: 'prose',
    sections: [
      {
        id: sectionId,
        ordinal: 0,
        label: 'First',
        blocks: [
          {
            id: longBlockId,
            ordinal: 0,
            content: { kind: 'paragraph', fragments: [{ text, marks: [] }] }
          }
        ]
      },
      {
        id: secondSectionId,
        ordinal: 1,
        label: 'Second',
        blocks: [
          {
            id: secondBlockId,
            ordinal: 0,
            content: {
              kind: 'paragraph',
              fragments: [{ text: 'A separate chapter.', marks: [] }]
            }
          }
        ]
      }
    ],
    images: []
  };
}

describe('semantic prose locations', () => {
  it('resolves and reverses block-relative offsets after repagination', () => {
    const document = proseDocument();
    const wide = paginatePublication(document, { pw: 800, ph: 1000, pad: 40, fs: 16 });
    const narrow = paginatePublication(document, { pw: 300, ph: 500, pad: 30, fs: 20 });
    const location = { format: 'prose' as const, blockId: longBlockId, offset: 700 };
    const wideIndex = pageIndexForLocation(document, wide, location);
    const narrowIndex = pageIndexForLocation(document, narrow, location);

    expect(wideIndex).not.toBeNull();
    expect(narrowIndex).not.toBeNull();
    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(locationForPage(document, narrow, narrowIndex!, 'page')).toMatchObject({
      format: 'prose',
      blockId: longBlockId,
      offset: expect.any(Number)
    });
    const reverse = locationForPage(document, narrow, narrowIndex!, 'page');
    expect(reverse?.format === 'prose' ? reverse.offset : 0).toBeLessThanOrEqual(location.offset);
  });

  it('handles exact endpoints, chapter boundaries, empty blocks, and missing IDs', () => {
    const document = proseDocument('abcdef');
    const pages = paginatePublication(document, { pw: 700, ph: 900, pad: 40, fs: 16 });
    expect(
      pageIndexForLocation(document, pages, {
        format: 'prose',
        blockId: longBlockId,
        offset: 0
      })
    ).toBe(0);
    expect(
      pageIndexForLocation(document, pages, {
        format: 'prose',
        blockId: longBlockId,
        offset: 6
      })
    ).toBe(0);
    expect(
      pageIndexForLocation(document, pages, {
        format: 'prose',
        blockId: secondBlockId,
        offset: 0
      })
    ).toBe(1);
    expect(
      pageIndexForLocation(document, pages, {
        format: 'prose',
        blockId: '018f0000-0000-7000-8000-000000000199',
        offset: 0
      })
    ).toBeNull();

    const empty = proseDocument('');
    const emptyPages = paginatePublication(empty, { pw: 700, ph: 900, pad: 40, fs: 16 });
    expect(
      pageIndexForLocation(empty, emptyPages, {
        format: 'prose',
        blockId: longBlockId,
        offset: 0
      })
    ).toBe(0);
  });
});

describe('semantic comic locations', () => {
  const firstPageId = '018f0000-0000-7000-8000-000000000201';
  const secondPageId = '018f0000-0000-7000-8000-000000000202';
  const comic: ComicReaderDocument = {
    titleId,
    revisionId,
    presentationId,
    title: 'Location Comic',
    access: 'entitled',
    readingDirection: 'rtl',
    format: 'comic',
    guidedViewEnabled: true,
    pages: [
      {
        id: firstPageId,
        ordinal: 1,
        url: '/media/first.webp',
        checksumSha256: 'a'.repeat(64),
        mediaType: 'image/webp',
        byteSize: 10,
        width: 100,
        height: 200,
        panels: [
          {
            id: '018f0000-0000-7000-8000-000000000211',
            ordinal: 2,
            x: 0,
            y: 0,
            width: 1,
            height: 0.5
          },
          {
            id: '018f0000-0000-7000-8000-000000000212',
            ordinal: 5,
            x: 0,
            y: 0.5,
            width: 1,
            height: 0.5
          }
        ]
      },
      {
        id: secondPageId,
        ordinal: 2,
        url: '/media/second.webp',
        checksumSha256: 'b'.repeat(64),
        mediaType: 'image/webp',
        byteSize: 10,
        width: 100,
        height: 200,
        panels: []
      }
    ]
  };

  it('maps whole pages and only real published guided panels', () => {
    const pages = paginatePublication(comic, { pw: 500, ph: 700, pad: 30, fs: 16 });
    expect(
      pageIndexForLocation(comic, pages, {
        format: 'comic',
        pageId: firstPageId,
        panelOrdinal: null
      })
    ).toBe(0);
    expect(
      pageIndexForLocation(comic, pages, {
        format: 'comic',
        pageId: firstPageId,
        panelOrdinal: 5
      })
    ).toBe(0);
    expect(
      pageIndexForLocation(comic, pages, {
        format: 'comic',
        pageId: firstPageId,
        panelOrdinal: 3
      })
    ).toBeNull();
    expect(locationForPage(comic, pages, 0, 'page')).toEqual({
      format: 'comic',
      pageId: firstPageId,
      panelOrdinal: null
    });
    expect(locationForPage(comic, pages, 0, 'guided')).toEqual({
      format: 'comic',
      pageId: firstPageId,
      panelOrdinal: 2
    });
    expect(locationForPage(comic, pages, 1, 'guided')).toBeNull();
    expect(locationForPage(comic, pages, 99, 'page')).toBeNull();
  });
});
