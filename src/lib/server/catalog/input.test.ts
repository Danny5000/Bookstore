import { describe, expect, it } from 'vitest';
import {
  parseConfirmCoverSuggestionInput,
  parseCreateRevisionInput,
  parseCreateTitleInput,
  parsePublishReaderSettingsInput,
  parseRevisionPublicationActionInput,
  parseSaveDraftPresentationInput,
  parseTitlePublicationActionInput,
  parseUpdateTitleMetadataInput
} from './input';

const titleId = '018f0000-0000-7000-8000-000000000001';
const revisionId = '018f0000-0000-7000-8000-000000000002';
const presentationId = '018f0000-0000-7000-8000-000000000003';
const sectionId = '018f0000-0000-7000-8000-000000000004';
const blockId = '018f0000-0000-7000-8000-000000000005';
const pageId = '018f0000-0000-7000-8000-000000000006';
const suggestionId = '018f0000-0000-7000-8000-000000000007';

describe('catalog inputs', () => {
  it('normalizes a private title command', () => {
    expect(
      parseCreateTitleInput({
        slug: '  vector-and-vine ',
        title: ' Vector & Vine ',
        subtitle: ' ',
        description: ' A comic. ',
        creatorName: ' Pale Orbit ',
        format: 'comic',
        priceMinor: 1299,
        currency: 'usd'
      })
    ).toEqual({
      slug: 'vector-and-vine',
      title: 'Vector & Vine',
      subtitle: null,
      description: 'A comic.',
      creatorName: 'Pale Orbit',
      format: 'comic',
      priceMinor: 1299,
      currency: 'USD'
    });
  });

  it.each([
    { slug: 'Not Valid', currency: 'USD', priceMinor: 100 },
    { slug: 'valid', currency: 'US', priceMinor: 100 },
    { slug: 'valid', currency: 'USD', priceMinor: -1 },
    { slug: 'valid', currency: 'USD', priceMinor: 0 },
    { slug: 'valid', currency: 'USD', priceMinor: 50_000_000 }
  ])('rejects invalid title money or slug fields', (invalid) => {
    expect(() =>
      parseCreateTitleInput({
        ...invalid,
        title: 'Title',
        description: 'Description',
        creatorName: 'Creator',
        format: 'prose'
      })
    ).toThrow();
  });

  it.each(['JPY', 'BHD', 'EUR'])(
    'accepts supported %s create and metadata inputs',
    (currency) => {
      const metadata = {
        slug: 'supported-currency',
        title: 'Supported Currency',
        subtitle: null,
        description: 'Description',
        creatorName: 'Creator',
        priceMinor: 1234,
        currency: currency.toLowerCase()
      };
      expect(parseCreateTitleInput({ ...metadata, format: 'prose' }).currency).toBe(currency);
      expect(parseUpdateTitleMetadataInput({ ...metadata, titleId }).currency).toBe(currency);
    }
  );

  it.each(['ABC', 'IRR', 'KPW', 'ISK', 'UGX'])(
    'rejects unsupported %s create and metadata inputs',
    (currency) => {
      const metadata = {
        slug: 'unsupported-currency',
        title: 'Unsupported Currency',
        subtitle: null,
        description: 'Description',
        creatorName: 'Creator',
        priceMinor: 1234,
        currency
      };
      expect(() => parseCreateTitleInput({ ...metadata, format: 'prose' })).toThrow();
      expect(() => parseUpdateTitleMetadataInput({ ...metadata, titleId })).toThrow();
    }
  );

  it('validates revision identifiers and trims the change summary', () => {
    expect(
      parseCreateRevisionInput({
        titleId: '4dc17f45-f2ac-4ed1-89eb-c6285808f123',
        parentRevisionId: null,
        changeSummary: ' Initial upload '
      })
    ).toEqual({
      titleId: '4dc17f45-f2ac-4ed1-89eb-c6285808f123',
      parentRevisionId: null,
      changeSummary: 'Initial upload'
    });
  });

  it('strictly normalizes metadata updates without accepting a format change', () => {
    expect(
      parseUpdateTitleMetadataInput({
        titleId,
        slug: ' revised-title ',
        title: ' Revised Title ',
        subtitle: ' ',
        description: ' Revised description. ',
        creatorName: ' Pale Orbit ',
        priceMinor: 1599,
        currency: 'usd'
      })
    ).toEqual({
      titleId,
      slug: 'revised-title',
      title: 'Revised Title',
      subtitle: null,
      description: 'Revised description.',
      creatorName: 'Pale Orbit',
      priceMinor: 1599,
      currency: 'USD'
    });
    expect(() =>
      parseUpdateTitleMetadataInput({
        titleId,
        slug: 'revised-title',
        title: 'Revised Title',
        subtitle: null,
        description: 'Description',
        creatorName: 'Creator',
        priceMinor: 100,
        currency: 'USD',
        format: 'comic'
      })
    ).toThrow();
  });

  it('strictly validates cover suggestion confirmation IDs', () => {
    expect(parseConfirmCoverSuggestionInput({ titleId, revisionId, suggestionId })).toEqual({
      titleId,
      revisionId,
      suggestionId
    });
    expect(() =>
      parseConfirmCoverSuggestionInput({ titleId, revisionId, suggestionId, storageKey: 'private' })
    ).toThrow();
  });

  it('validates prose draft boundaries and optimistic timestamps', () => {
    expect(
      parseSaveDraftPresentationInput({
        titleId,
        revisionId,
        presentationId,
        expectedUpdatedAt: '2026-08-09T12:00:00.000Z',
        format: 'prose',
        readingDirection: 'ltr',
        guidedViewEnabled: false,
        previewSectionId: sectionId,
        previewBlockId: blockId,
        previewPageId: null,
        panels: []
      })
    ).toMatchObject({
      format: 'prose',
      expectedUpdatedAt: new Date('2026-08-09T12:00:00.000Z')
    });
    expect(() =>
      parseSaveDraftPresentationInput({
        titleId,
        revisionId,
        presentationId,
        expectedUpdatedAt: 'not-a-date',
        format: 'prose',
        readingDirection: 'ltr',
        guidedViewEnabled: false,
        previewSectionId: null,
        previewBlockId: null,
        previewPageId: null,
        panels: []
      })
    ).toThrow();
  });

  it('validates comic panel replacements and rejects duplicate order or invalid rectangles', () => {
    const valid = {
      titleId,
      revisionId,
      presentationId,
      expectedUpdatedAt: '2026-08-09T12:00:00.000Z',
      format: 'comic' as const,
      readingDirection: 'rtl' as const,
      guidedViewEnabled: true,
      previewSectionId: null,
      previewBlockId: null,
      previewPageId: pageId,
      panels: [{ pageId, ordinal: 1, x: 0.125, y: 0.25, width: 0.5, height: 0.375 }]
    };
    expect(parseSaveDraftPresentationInput(valid).panels).toEqual(valid.panels);
    expect(() =>
      parseSaveDraftPresentationInput({ ...valid, panels: [...valid.panels, valid.panels[0]] })
    ).toThrow();
    expect(() =>
      parseSaveDraftPresentationInput({
        ...valid,
        panels: [{ pageId, ordinal: 1, x: 0.8, y: 0, width: 0.3, height: 1 }]
      })
    ).toThrow();
    expect(() =>
      parseSaveDraftPresentationInput({
        ...valid,
        panels: [{ ...valid.panels[0], revisionId }]
      })
    ).toThrow();
  });

  it('strictly validates settings publication and lifecycle action IDs', () => {
    expect(
      parsePublishReaderSettingsInput({
        titleId,
        revisionId,
        presentationId,
        expectedUpdatedAt: '2026-08-09T12:00:00.000Z'
      })
    ).toEqual({
      titleId,
      revisionId,
      presentationId,
      expectedUpdatedAt: new Date('2026-08-09T12:00:00.000Z')
    });
    expect(parseRevisionPublicationActionInput({ titleId, revisionId })).toEqual({ titleId, revisionId });
    expect(parseTitlePublicationActionInput({ titleId })).toEqual({ titleId });
    expect(() => parseRevisionPublicationActionInput({ titleId, revisionId: 'bad' })).toThrow();
    expect(() => parseTitlePublicationActionInput({ titleId, revisionId })).toThrow();
  });

  it('canonicalizes title IDs before the shared publication lock boundary', () => {
    expect(parseTitlePublicationActionInput({ titleId: titleId.toUpperCase() })).toEqual({
      titleId
    });
    expect(parseRevisionPublicationActionInput({
      titleId: titleId.toUpperCase(),
      revisionId
    })).toEqual({ titleId, revisionId });
  });
});
