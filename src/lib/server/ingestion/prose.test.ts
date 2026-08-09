import { describe, expect, it } from 'vitest';
import { parseOrderedXml } from './xml';
import { convertXhtmlToBlocks, stableIngestionId } from './prose';

const revisionId = '018f0000-0000-7000-8000-000000000011';
const expectedImageId = '018f0000-0000-7000-8000-000000000012';

function convert(body: string) {
  return convertXhtmlToBlocks(
    parseOrderedXml(
      Buffer.from(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`),
      100_000
    ),
    {
      revisionId,
      resourcePath: 'EPUB/text/chapter.xhtml',
      imageIdsByPath: new Map([['EPUB/images/station.png', expectedImageId]])
    }
  );
}

describe('XHTML semantic prose conversion', () => {
  it('converts headings, paragraphs, nested marks, and local images', () => {
    expect(
      convert(`
        <h1>Chapter One</h1>
        <p>The <em>signal</em> arrived.</p>
        <p><strong>Bold <code>code</code></strong> and <sub>sub</sub>/<sup>sup</sup>.</p>
        <img src="../images/station.png" alt="A distant station"/>
      `)
    ).toEqual([
      { kind: 'heading', level: 1, fragments: [{ text: 'Chapter One', marks: [] }] },
      {
        kind: 'paragraph',
        fragments: [
          { text: 'The ', marks: [] },
          { text: 'signal', marks: ['emphasis'] },
          { text: ' arrived.', marks: [] }
        ]
      },
      {
        kind: 'paragraph',
        fragments: [
          { text: 'Bold ', marks: ['strong'] },
          { text: 'code', marks: ['strong', 'code'] },
          { text: ' and ', marks: [] },
          { text: 'sub', marks: ['subscript'] },
          { text: '/', marks: [] },
          { text: 'sup', marks: ['superscript'] },
          { text: '.', marks: [] }
        ]
      },
      { kind: 'image', imageId: expectedImageId, alt: 'A distant station' }
    ]);
  });

  it('converts quotes, lists, thematic breaks, and ignores comments', () => {
    expect(
      convert(`
        <!-- editorial comment -->
        <blockquote>A <em>quiet</em> quote.</blockquote>
        <ol><li>First</li><li>Second <strong>item</strong></li></ol>
        <ul><li>Only</li></ul><hr/>
      `)
    ).toEqual([
      {
        kind: 'quote',
        fragments: [
          { text: 'A ', marks: [] },
          { text: 'quiet', marks: ['emphasis'] },
          { text: ' quote.', marks: [] }
        ]
      },
      {
        kind: 'list',
        ordered: true,
        items: [
          [{ text: 'First', marks: [] }],
          [
            { text: 'Second ', marks: [] },
            { text: 'item', marks: ['strong'] }
          ]
        ]
      },
      { kind: 'list', ordered: false, items: [[{ text: 'Only', marks: [] }]] },
      { kind: 'break' }
    ]);
  });

  it('keeps safe external links and strips unsafe link schemes while retaining text', () => {
    expect(
      convert(
        '<p><a href="https://example.com/notes">Safe</a> <a href="javascript:alert(1)">Unsafe text</a></p>'
      )
    ).toEqual([
      {
        kind: 'paragraph',
        fragments: [
          { text: 'Safe', marks: [], href: 'https://example.com/notes' },
          { text: ' Unsafe text', marks: [] }
        ]
      }
    ]);
  });

  it.each([
    '<script>alert(1)</script>',
    '<iframe src="local.xhtml"></iframe>',
    '<form><input name="secret"/></form>',
    '<object data="local.bin"></object>'
  ])('rejects executable, embedded, or form content', (body) => {
    expect(() => convert(body)).toThrowError(expect.objectContaining({ code: 'unsupported_script' }));
  });

  it('rejects remote and missing image resources', () => {
    expect(() => convert('<img src="https://example.com/tracker.png" alt="remote"/>')).toThrowError(
      expect.objectContaining({ code: 'unsupported_media' })
    );
    expect(() => convert('<img src="missing.png" alt="missing"/>')).toThrowError(
      expect.objectContaining({ code: 'epub_content' })
    );
  });

  it('derives stable UUID-shaped anchors from ingestion identity inputs', () => {
    const first = stableIngestionId(revisionId, 'EPUB/text/chapter.xhtml', 'block', 2);
    const second = stableIngestionId(revisionId, 'EPUB/text/chapter.xhtml', 'block', 2);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});
