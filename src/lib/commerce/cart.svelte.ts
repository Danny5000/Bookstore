import { browser } from '$app/environment';
import type { CartStateV1 } from '$lib/types/commerce';
import {
  addCartTitle,
  clearCart,
  completePaidCart,
  loadCartState,
  removeCartTitle,
  resetCart,
  rotateCheckoutAttempt,
  serializeCartState,
  type AttemptIdGenerator
} from './cart-state';

export const CART_STORAGE_KEY = 'paleorbit.cart.v1';

export interface CartStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CreateCartStoreOptions {
  storage?: CartStorage | null;
  generateAttemptId?: AttemptIdGenerator;
}

const PLACEHOLDER_ATTEMPT_ID = '00000000-0000-4000-8000-000000000000';

class CartStore {
  state = $state<CartStateV1>({
    version: 1,
    titleIds: [],
    checkoutAttemptId: PLACEHOLDER_ATTEMPT_ID
  });

  constructor(
    private readonly storage: CartStorage | null,
    private readonly generateAttemptId: AttemptIdGenerator
  ) {
    let stored: string | null = null;
    try {
      stored = storage?.getItem(CART_STORAGE_KEY) ?? null;
    } catch {
      // Storage can be unavailable in private browsing; use the fresh-state fallback.
    }
    this.state = loadCartState(stored, generateAttemptId);
  }

  get titleIds(): readonly string[] {
    return [...this.state.titleIds];
  }

  get checkoutAttemptId(): string {
    return this.state.checkoutAttemptId;
  }

  get size(): number {
    return this.state.titleIds.length;
  }

  add(titleId: string): boolean {
    try {
      const next = addCartTitle(this.state, titleId);
      if (next === this.state) return false;
      this.state = next;
      this.persist();
      return true;
    } catch {
      return false;
    }
  }

  remove(titleId: string): boolean {
    const next = removeCartTitle(this.state, titleId);
    if (next === this.state) return false;
    this.state = next;
    this.persist();
    return true;
  }

  clear(): boolean {
    const next = clearCart(this.state);
    if (next === this.state) return false;
    this.state = next;
    this.persist();
    return true;
  }

  completePaid(completedTitleIds: readonly string[]): void {
    this.state = completePaidCart(this.state, completedTitleIds, this.generateAttemptId);
    this.persist();
  }

  rotateAttempt(): void {
    this.state = rotateCheckoutAttempt(this.state, this.generateAttemptId);
    this.persist();
  }

  reset(): void {
    this.state = resetCart(this.generateAttemptId);
    this.persist();
  }

  private persist(): void {
    try {
      this.storage?.setItem(CART_STORAGE_KEY, serializeCartState(this.state));
    } catch {
      // Storage can be unavailable in private browsing; in-memory state remains usable.
    }
  }
}

export function createCartStore(options: CreateCartStoreOptions = {}): CartStore {
  const storage = options.storage === undefined
    ? browser
      ? globalThis.localStorage
      : null
    : options.storage;
  const generateAttemptId = options.generateAttemptId ?? (() => globalThis.crypto.randomUUID());
  return new CartStore(storage, generateAttemptId);
}

export const cart = createCartStore();
