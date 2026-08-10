import { describe, expect, it } from 'vitest';
import type { ComicReaderDocument, ProseReaderDocument } from '$lib/types/publication';
import { pageIndexForLocation } from './locations';
import { paginatePublication } from './publication-pagination';

const sectionId = '018f0000-0000-7000-8000-000000000001';
const headingId = '018f0000-0000-7000-8000-000000000002';
const paragraphId = '018f0000-0000-7000-8000-000000000003';
const quoteId = '018f0000-0000-7000-8000-000000000004';
const listId = '018f0000-0000-7000-8000-000000000005';
const breakId = '018f0000-0000-7000-8000-000000000006';
const imageBlockId = '018f0000-0000-7000-8000-000000000007';
const imageId = '018f0000-0000-7000-8000-000000000008';

const proseDocument: ProseReaderDocument = {
  titleId: '018f0000-0000-7000-8000-000000000010',
  revisionId: '018f0000-0000-7000-8000-000000000011',
  presentationId: '018f0000-0000-7000-8000-000000000012',
  title: 'Semantic Book',
  access: 'preview',
  readingDirection: 'ltr',
  format: 'prose',
  sections: [
    {
      id: sectionId,
      ordinal: 0,
      label: 'Chapter One',
      blocks: [
        {
          id: headingId,
          ordinal: 0,
          content: { kind: 'heading', level: 1, fragments: [{ text: 'A Beginning', marks: [] }] }
        },
        {
          id: paragraphId,
          ordinal: 1,
          content: {
            kind: 'paragraph',
            fragments: [
              { text: 'Marked words', marks: ['strong'], href: 'https://example.com/note' },
              { text: ' continue in order.', marks: ['emphasis'] }
            ]
          }
        },
        {
          id: quoteId,
          ordinal: 2,
          content: { kind: 'quote', fragments: [{ text: 'A quotation.', marks: [] }] }
        },
        {
          id: listId,
          ordinal: 3,
          content: {
            kind: 'list',
            ordered: true,
            items: [
              [{ text: 'First item', marks: [] }],
              [{ text: 'Second item', marks: ['code'] }]
            ]
          }
        },
        { id: breakId, ordinal: 4, content: { kind: 'break' } },
        {
          id: imageBlockId,
          ordinal: 5,
          content: { kind: 'image', imageId, alt: 'A station' }
        }
      ]
    }
  ],
  images: [
    {
      id: imageId,
      url: '/media/station.webp',
      checksumSha256: 'a'.repeat(64),
      mediaType: 'image/webp',
      byteSize: 100,
      width: 800,
      height: 600
    }
  ]
};

describe('publication pagination', () => {
  it('preserves semantic block order, marks, links, lists, breaks, and images', () => {
    const pages = paginatePublication(proseDocument, { pw: 700, ph: 1000, pad: 40, fs: 16 });
    const blocks = pages.flatMap((page) => page.type === 'text' ? page.blocks ?? [] : []);
    expect(blocks.map((block) => block.sourceBlockId)).toEqual([
      headingId,
      paragraphId,
      quoteId,
      listId,
      breakId,
      imageBlockId
    ]);
    expect(blocks[1]?.content).toMatchObject({
      kind: 'paragraph',
      fragments: [
        { text: 'Marked words', marks: ['strong'], href: 'https://example.com/note' },
        { text: ' continue in order.', marks: ['emphasis'] }
      ]
    });
    expect(blocks.at(-1)).toMatchObject({
      content: { kind: 'image', imageId, alt: 'A station' },
      imageUrl: '/media/station.webp'
    });
  });

  it('reflows visual pages while numeric section and character anchors restore position', () => {
    const longDocument: ProseReaderDocument = {
      ...proseDocument,
      sections: [{
        ...proseDocument.sections[0]!,
        blocks: [{
          id: paragraphId,
          ordinal: 0,
          content: {
            kind: 'paragraph',
            fragments: [{ text: 'word '.repeat(500), marks: [] }]
          }
        }]
      }],
      images: []
    };
    const wide = paginatePublication(longDocument, { pw: 800, ph: 1000, pad: 40, fs: 16 });
    const narrow = paginatePublication(longDocument, { pw: 300, ph: 500, pad: 30, fs: 18 });
    expect(narrow.length).toBeGreaterThan(wide.length);
    const anchor = { format: 'prose' as const, blockId: paragraphId, offset: 700 };
    const restoredIndex = pageIndexForLocation(longDocument, narrow, anchor);
    expect(restoredIndex).not.toBeNull();
    const restored = narrow[restoredIndex!];
    expect(restored?.chapter).toBe(0);
    expect(restored?.at).toBeLessThanOrEqual(anchor.offset);
    expect(restored?.type === 'text' ? restored.blocks?.[0]?.sourceStartOffset : 0).toBeLessThanOrEqual(
      anchor.offset
    );
  });

  it('partitions split block-relative source ranges without overlap or loss', () => {
    const text = 'word '.repeat(500);
    const document: ProseReaderDocument = {
      ...proseDocument,
      sections: [{
        ...proseDocument.sections[0]!,
        blocks: [{
          id: paragraphId,
          ordinal: 0,
          content: { kind: 'paragraph', fragments: [{ text, marks: [] }] }
        }]
      }],
      images: []
    };
    const pages = paginatePublication(document, { pw: 300, ph: 500, pad: 30, fs: 18 });
    const blocks = pages.flatMap((page) => page.type === 'text' ? page.blocks ?? [] : []);
    expect(blocks[0]).toMatchObject({ sourceBlockId: paragraphId, sourceStartOffset: 0 });
    expect(blocks.at(-1)?.sourceEndOffset).toBe(text.length);
    for (let index = 1; index < blocks.length; index += 1) {
      expect(blocks[index]?.sourceStartOffset).toBe(blocks[index - 1]?.sourceEndOffset);
    }
  });

  it('ends exactly with the server-delivered preview boundary', () => {
    const delivered: ProseReaderDocument = {
      ...proseDocument,
      sections: [{
        ...proseDocument.sections[0]!,
        blocks: proseDocument.sections[0]!.blocks.slice(0, 2)
      }],
      images: []
    };
    const pages = paginatePublication(delivered, { pw: 700, ph: 1000, pad: 40, fs: 16 });
    expect(
      pages.flatMap((page) => page.type === 'text' ? page.blocks?.map((block) => block.sourceBlockId) ?? [] : [])
    ).toEqual([headingId, paragraphId]);
  });

  it('maps each authorized comic page URL and normalized panel regions directly', () => {
    const comic: ComicReaderDocument = {
      titleId: proseDocument.titleId,
      revisionId: proseDocument.revisionId,
      presentationId: proseDocument.presentationId,
      title: 'Comic',
      access: 'preview',
      readingDirection: 'rtl',
      format: 'comic',
      guidedViewEnabled: true,
      pages: [
        {
          id: imageId,
          ordinal: 1,
          url: '/media/page-1.webp',
          checksumSha256: 'b'.repeat(64),
          mediaType: 'image/webp',
          byteSize: 200,
          width: 1200,
          height: 1800,
          panels: [
            { id: headingId, ordinal: 1, x: 0.1, y: 0.2, width: 0.5, height: 0.4 }
          ]
        }
      ]
    };
    const pages = paginatePublication(comic, { pw: 500, ph: 700, pad: 30, fs: 16 });
    expect(pages).toEqual([
      expect.objectContaining({
        type: 'comic',
        imageUrl: '/media/page-1.webp',
        sourcePageId: imageId,
        panels: comic.pages[0]!.panels,
        chapter: 0,
        at: 0
      })
    ]);
  });
});
