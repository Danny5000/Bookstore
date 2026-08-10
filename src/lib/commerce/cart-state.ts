import {
  MAX_CART_TITLES,
  cartStateV1Schema,
  cartTitleIdSchema,
  type CartStateV1
} from '$lib/types/commerce';

export const MAX_SERIALIZED_CART_STATE_BYTES = 8 * 1024;

export type AttemptIdGenerator = () => string;

const defaultAttemptId: AttemptIdGenerator = () => globalThis.crypto.randomUUID();

export class CartStateError extends Error {
  constructor() {
    super('Invalid cart state');
    this.name = 'CartStateError';
  }
}

export function resetCart(generateAttemptId: AttemptIdGenerator = defaultAttemptId): CartStateV1 {
  return cartStateV1Schema.parse({
    version: 1,
    titleIds: [],
    checkoutAttemptId: generateAttemptId()
  });
}

export function loadCartState(
  serialized: string | null,
  generateAttemptId: AttemptIdGenerator = defaultAttemptId
): CartStateV1 {
  if (serialized === null) return resetCart(generateAttemptId);
  if (new TextEncoder().encode(serialized).byteLength > MAX_SERIALIZED_CART_STATE_BYTES) {
    return resetCart(generateAttemptId);
  }

  try {
    const parsed = cartStateV1Schema.parse(JSON.parse(serialized));
    if (new Set(parsed.titleIds).size !== parsed.titleIds.length) {
      return resetCart(generateAttemptId);
    }
    return parsed;
  } catch {
    return resetCart(generateAttemptId);
  }
}

export function serializeCartState(state: CartStateV1): string {
  const parsed = cartStateV1Schema.parse(state);
  if (new Set(parsed.titleIds).size !== parsed.titleIds.length) throw new CartStateError();
  const serialized = JSON.stringify(parsed);
  if (new TextEncoder().encode(serialized).byteLength > MAX_SERIALIZED_CART_STATE_BYTES) {
    throw new CartStateError();
  }
  return serialized;
}

export function addCartTitle(state: CartStateV1, titleId: string): CartStateV1 {
  const parsedTitleId = cartTitleIdSchema.safeParse(titleId);
  if (!parsedTitleId.success) throw new CartStateError();
  if (state.titleIds.includes(parsedTitleId.data)) return state;
  if (state.titleIds.length >= MAX_CART_TITLES) throw new CartStateError();
  return cartStateV1Schema.parse({
    ...state,
    titleIds: [...state.titleIds, parsedTitleId.data]
  });
}

export function removeCartTitle(state: CartStateV1, titleId: string): CartStateV1 {
  if (!state.titleIds.includes(titleId)) return state;
  return cartStateV1Schema.parse({
    ...state,
    titleIds: state.titleIds.filter((candidate) => candidate !== titleId)
  });
}

export function clearCart(state: CartStateV1): CartStateV1 {
  if (state.titleIds.length === 0) return state;
  return cartStateV1Schema.parse({ ...state, titleIds: [] });
}

export function completePaidCart(
  state: CartStateV1,
  completedTitleIds: readonly string[],
  generateAttemptId: AttemptIdGenerator = defaultAttemptId
): CartStateV1 {
  const completed = new Set<string>();
  for (const titleId of completedTitleIds) {
    const parsed = cartTitleIdSchema.safeParse(titleId);
    if (!parsed.success || completed.has(parsed.data)) throw new CartStateError();
    completed.add(parsed.data);
  }
  return cartStateV1Schema.parse({
    version: 1,
    titleIds: state.titleIds.filter((titleId) => !completed.has(titleId)),
    checkoutAttemptId: generateAttemptId()
  });
}
