import { describe, expect, it } from 'vitest';
import { parseCreateRevisionInput, parseCreateTitleInput } from './input';

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
    { slug: 'valid', currency: 'USD', priceMinor: -1 }
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
});
