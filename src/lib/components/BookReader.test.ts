import { readFile } from 'node:fs/promises';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { createMemoryReaderPersistence } from '$lib/reader/persistence';
import type { ReaderInitialStateDto } from '$lib/types/library';
import type { ProseReaderDocument } from '$lib/types/publication';
import BookReader from './BookReader.svelte';

const document: ProseReaderDocument = {
  titleId: '018f0000-0000-7000-8000-000000000100',
  revisionId: '018f0000-0000-7000-8000-000000000101',
  presentationId: '018f0000-0000-7000-8000-000000000102',
  title: 'Persistent Reader',
  access: 'entitled',
  readingDirection: 'ltr',
  format: 'prose',
  sections: [
    {
      id: '018f0000-0000-7000-8000-000000000103',
      ordinal: 0,
      label: 'One',
      blocks: [
        {
          id: '018f0000-0000-7000-8000-000000000104',
          ordinal: 0,
          content: { kind: 'paragraph', fragments: [{ text: 'Reader content.', marks: [] }] }
        }
      ]
    }
  ],
  images: []
};

const initialState: ReaderInitialStateDto = {
  progress: null,
  bookmarks: [],
  preferences: { fontSize: 18, typeface: 'serif', paper: 'white', version: 0 },
  titlePreferences: null,
  migrationNotice: null
};

describe('BookReader persistence boundary', () => {
  it('renders from an injected adapter with an accessible synchronization status', () => {
    const persistence = createMemoryReaderPersistence({ document, initialState });
    const { body } = render(BookReader, { props: { document, persistence } });
    expect(body).toContain('Persistent Reader');
    expect(body).toContain('aria-live="polite"');
    expect(body).not.toContain('Unlock the complete');
  });

  it('does not import the prototype library authority', async () => {
    const source = await readFile(new URL('./BookReader.svelte', import.meta.url), 'utf8');
    expect(source).not.toMatch(/stores\/library|library\.grant|library\.setProgress/u);
    expect(source).toContain('ReaderPersistence');
    expect(source).toContain('locationForPage');
    expect(source).toContain('pageIndexForLocation');
  });
});
