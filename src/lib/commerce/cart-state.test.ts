import { describe, expect, it, vi } from 'vitest';
import {
  addCartTitle,
  clearCart,
  completePaidCart,
  loadCartState,
  MAX_SERIALIZED_CART_STATE_BYTES,
  removeCartTitle,
  resetCart
} from './cart-state';

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

describe('loadCartState', () => {
  it.each([
    { label: 'missing state', value: null },
    { label: 'invalid JSON', value: '{not-json' },
    {
      label: 'oversized JSON',
      value: JSON.stringify({ ignored: 'x'.repeat(MAX_SERIALIZED_CART_STATE_BYTES) })
    },
    {
      label: 'unsupported version',
      value: JSON.stringify({ version: 2, titleIds: [], checkoutAttemptId: uuid(1) })
    },
    {
      label: 'unknown field',
      value: JSON.stringify({
        version: 1,
        titleIds: [],
        checkoutAttemptId: uuid(1),
        priceMinor: 1000
      })
    },
    {
      label: 'duplicate title IDs',
      value: JSON.stringify({
        version: 1,
        titleIds: [uuid(2), uuid(2)],
        checkoutAttemptId: uuid(1)
      })
    },
    {
      label: 'malformed title ID',
      value: JSON.stringify({
        version: 1,
        titleIds: ['not-a-uuid'],
        checkoutAttemptId: uuid(1)
      })
    },
    {
      label: '26 title IDs',
      value: JSON.stringify({
        version: 1,
        titleIds: Array.from({ length: 26 }, (_, index) => uuid(index + 1)),
        checkoutAttemptId: uuid(100)
      })
    }
  ])('turns $label into a fresh empty state', ({ value }) => {
    const generateAttemptId = vi.fn(() => uuid(999));

    expect(loadCartState(value, generateAttemptId)).toEqual({
      version: 1,
      titleIds: [],
      checkoutAttemptId: uuid(999)
    });
    expect(generateAttemptId).toHaveBeenCalledOnce();
  });

  it('accepts exactly 25 unique title IDs', () => {
    const titleIds = Array.from({ length: 25 }, (_, index) => uuid(index + 1));
    const serialized = JSON.stringify({
      version: 1,
      titleIds,
      checkoutAttemptId: uuid(100)
    });

    expect(loadCartState(serialized, () => uuid(999))).toEqual({
      version: 1,
      titleIds,
      checkoutAttemptId: uuid(100)
    });
  });
});

describe('cart state edits', () => {
  const initial = {
    version: 1 as const,
    titleIds: [uuid(1), uuid(2)],
    checkoutAttemptId: uuid(100)
  };

  it('adds uniquely and preserves the checkout attempt while editing', () => {
    expect(addCartTitle(initial, uuid(3))).toEqual({
      ...initial,
      titleIds: [uuid(1), uuid(2), uuid(3)]
    });
    expect(addCartTitle(initial, uuid(2))).toBe(initial);
    expect(() => addCartTitle(initial, 'not-a-uuid')).toThrow();
    expect(() =>
      addCartTitle(
        {
          ...initial,
          titleIds: Array.from({ length: 25 }, (_, index) => uuid(index + 1))
        },
        uuid(26)
      )
    ).toThrow();
  });

  it('removes and clears while preserving the checkout attempt', () => {
    expect(removeCartTitle(initial, uuid(1))).toEqual({
      ...initial,
      titleIds: [uuid(2)]
    });
    expect(removeCartTitle(initial, uuid(9))).toBe(initial);
    expect(clearCart(initial)).toEqual({ ...initial, titleIds: [] });
  });

  it('rotates the attempt only for paid cleanup or explicit reset', () => {
    expect(completePaidCart(initial, [uuid(1)], () => uuid(101))).toEqual({
      version: 1,
      titleIds: [uuid(2)],
      checkoutAttemptId: uuid(101)
    });
    expect(resetCart(() => uuid(102))).toEqual({
      version: 1,
      titleIds: [],
      checkoutAttemptId: uuid(102)
    });
  });
});
