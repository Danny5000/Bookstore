import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import PageFace from './PageFace.svelte';

describe('PageFace semantic provenance', () => {
  it('renders content and marks without exposing internal location metadata', () => {
    const sourceBlockId = '018f0000-0000-7000-8000-000000000301';
    const { body } = render(PageFace, {
      props: {
        box: { pw: 500, ph: 700, pad: 30, fs: 16 },
        page: {
          type: 'text',
          chapter: 0,
          at: 0,
          heading: null,
          paras: [],
          folio: '1',
          blocks: [
            {
              sourceBlockId,
              sourceStartOffset: 8,
              sourceEndOffset: 20,
              content: {
                kind: 'paragraph',
                fragments: [{ text: 'Visible words', marks: ['strong'] }]
              }
            }
          ]
        }
      }
    });

    expect(body).toMatch(/<strong>[\s\S]*Visible words[\s\S]*<\/strong>/u);
    expect(body).not.toContain(sourceBlockId);
    expect(body).not.toContain('sourceStartOffset');
    expect(body).not.toContain('sourceEndOffset');
  });
});
