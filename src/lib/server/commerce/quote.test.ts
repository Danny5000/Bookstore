import { describe, expect, it, vi } from 'vitest';
import {
  createQuoteFingerprint,
  type QuoteFingerprintInputV1
} from './quote';

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

function input(): QuoteFingerprintInputV1 {
  return {
    version: 1,
    actorUserId: uuid(90),
    items: [
      {
        titleId: uuid(2),
        priceMinor: 1200,
        currency: 'USD',
        activeRevisionId: uuid(12),
        presentationPublishedAt: '2026-08-10T12:00:00.000Z'
      },
      {
        titleId: uuid(1),
        priceMinor: 900,
        currency: 'USD',
        activeRevisionId: uuid(11),
        presentationPublishedAt: '2026-08-10T11:00:00.000Z'
      }
    ],
    alreadyOwnedTitleIds: [uuid(4), uuid(3)],
    unavailableTitleIds: [uuid(6), uuid(5)]
  };
}

describe('createQuoteFingerprint', () => {
  it('is invariant to item and classified-ID ordering without locale collation', () => {
    const original = input();
    const reordered: QuoteFingerprintInputV1 = {
      ...original,
      items: [...original.items].reverse(),
      alreadyOwnedTitleIds: [...original.alreadyOwnedTitleIds].reverse(),
      unavailableTitleIds: [...original.unavailableTitleIds].reverse()
    };
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare');

    expect(createQuoteFingerprint(reordered)).toBe(createQuoteFingerprint(original));
    expect(localeCompare).not.toHaveBeenCalled();
    expect(createQuoteFingerprint(original)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    {
      label: 'membership',
      mutate: (value: QuoteFingerprintInputV1) => ({
        ...value,
        unavailableTitleIds: [...value.unavailableTitleIds, uuid(7)]
      })
    },
    {
      label: 'price',
      mutate: (value: QuoteFingerprintInputV1) => ({
        ...value,
        items: value.items.map((item, index) =>
          index === 0 ? { ...item, priceMinor: item.priceMinor + 1 } : item
        )
      })
    },
    {
      label: 'currency',
      mutate: (value: QuoteFingerprintInputV1) => ({
        ...value,
        items: value.items.map((item, index) =>
          index === 0 ? { ...item, currency: 'CAD' } : item
        )
      })
    },
    {
      label: 'active revision',
      mutate: (value: QuoteFingerprintInputV1) => ({
        ...value,
        items: value.items.map((item, index) =>
          index === 0 ? { ...item, activeRevisionId: uuid(99) } : item
        )
      })
    },
    {
      label: 'published presentation',
      mutate: (value: QuoteFingerprintInputV1) => ({
        ...value,
        items: value.items.map((item, index) =>
          index === 0
            ? { ...item, presentationPublishedAt: '2026-08-10T12:00:01.000Z' }
            : item
        )
      })
    },
    {
      label: 'ownership',
      mutate: (value: QuoteFingerprintInputV1) => ({
        ...value,
        alreadyOwnedTitleIds: [...value.alreadyOwnedTitleIds, uuid(8)]
      })
    },
    {
      label: 'actor identity',
      mutate: (value: QuoteFingerprintInputV1) => ({ ...value, actorUserId: uuid(91) })
    }
  ])('changes when $label changes', ({ mutate }) => {
    const original = input();
    expect(createQuoteFingerprint(mutate(original))).not.toBe(
      createQuoteFingerprint(original)
    );
  });
});
