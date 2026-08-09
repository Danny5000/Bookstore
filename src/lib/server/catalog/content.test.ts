import { describe, expect, it } from 'vitest';
import { parsePanelRegion, parsePresentationInput, parseProseBlock } from './content';

const firstId = '018f0000-0000-7000-8000-000000000001';
const secondId = '018f0000-0000-7000-8000-000000000002';

describe('publication content validation', () => {
  it('parses the supported semantic prose blocks', () => {
    expect(
      parseProseBlock({
        kind: 'paragraph',
        fragments: [
          { text: 'A safe ', marks: [] },
          { text: 'sentence', marks: ['strong'], href: 'https://example.com/notes' }
        ]
      })
    ).toEqual({
      kind: 'paragraph',
      fragments: [
        { text: 'A safe ', marks: [] },
        { text: 'sentence', marks: ['strong'], href: 'https://example.com/notes' }
      ]
    });
    expect(
      parseProseBlock({
        kind: 'heading',
        level: 2,
        fragments: [{ text: 'Chapter One', marks: ['emphasis', 'emphasis'] }]
      })
    ).toEqual({
      kind: 'heading',
      level: 2,
      fragments: [{ text: 'Chapter One', marks: ['emphasis'] }]
    });
    expect(
      parseProseBlock({
        kind: 'quote',
        fragments: [{ text: 'Quoted', marks: [], href: 'mailto:editor@example.com' }]
      }).kind
    ).toBe('quote');
    expect(
      parseProseBlock({
        kind: 'list',
        ordered: true,
        items: [[{ text: 'First', marks: ['strong'] }], [{ text: 'Second', marks: [] }]]
      }).kind
    ).toBe('list');
    expect(parseProseBlock({ kind: 'image', imageId: firstId, alt: 'Cover detail' })).toEqual({
      kind: 'image',
      imageId: firstId,
      alt: 'Cover detail'
    });
    expect(parseProseBlock({ kind: 'break' })).toEqual({ kind: 'break' });
  });

  it('rejects empty fragments, unknown marks, and unsafe links', () => {
    expect(() =>
      parseProseBlock({ kind: 'paragraph', fragments: [{ text: '   ', marks: [] }] })
    ).toThrow();
    expect(() =>
      parseProseBlock({ kind: 'paragraph', fragments: [{ text: 'bad', marks: ['blink'] }] })
    ).toThrow();
    expect(() =>
      parseProseBlock({
        kind: 'paragraph',
        fragments: [{ text: 'bad', marks: [], href: 'javascript:alert(1)' }]
      })
    ).toThrow();
  });

  it('rejects bad heading levels and unknown JSON keys', () => {
    expect(() =>
      parseProseBlock({
        kind: 'heading',
        level: 7,
        fragments: [{ text: 'Too deep', marks: [] }]
      })
    ).toThrow();
    expect(() => parseProseBlock({ kind: 'break', markup: '<script />' })).toThrow();
    expect(() =>
      parseProseBlock({
        kind: 'image',
        imageId: firstId,
        alt: 'safe',
        storageKey: 'private/path'
      })
    ).toThrow();
  });

  it('validates normalized in-bounds panel rectangles', () => {
    expect(
      parsePanelRegion({
        id: firstId,
        ordinal: 0,
        x: 0.1,
        y: 0.2,
        width: 0.5,
        height: 0.6
      })
    ).toEqual({ id: firstId, ordinal: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.6 });

    expect(() =>
      parsePanelRegion({ id: firstId, ordinal: 0, x: 0.8, y: 0, width: 0.3, height: 1 })
    ).toThrow();
    expect(() =>
      parsePanelRegion({ id: firstId, ordinal: 0, x: 0, y: 0, width: 0, height: 1 })
    ).toThrow();
  });

  it('rejects cross-format presentation boundaries', () => {
    expect(
      parsePresentationInput({
        format: 'prose',
        readingDirection: 'ltr',
        guidedViewEnabled: false,
        previewSectionId: firstId,
        previewBlockId: secondId,
        previewPageId: null
      }).format
    ).toBe('prose');
    expect(
      parsePresentationInput({
        format: 'comic',
        readingDirection: 'rtl',
        guidedViewEnabled: true,
        previewSectionId: null,
        previewBlockId: null,
        previewPageId: firstId
      }).format
    ).toBe('comic');

    expect(() =>
      parsePresentationInput({
        format: 'prose',
        readingDirection: 'ltr',
        guidedViewEnabled: false,
        previewSectionId: firstId,
        previewBlockId: secondId,
        previewPageId: firstId
      })
    ).toThrow();
    expect(() =>
      parsePresentationInput({
        format: 'comic',
        readingDirection: 'ltr',
        guidedViewEnabled: true,
        previewSectionId: firstId,
        previewBlockId: secondId,
        previewPageId: firstId
      })
    ).toThrow();
  });
});
