import { describe, expect, it } from 'vitest';
import { CART_STORAGE_KEY, createCartStore, type CartStorage } from './cart.svelte';

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

class MemoryStorage implements CartStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('cart store', () => {
  it('loads invalid storage as a fresh state and persists only the minimal contract', () => {
    const storage = new MemoryStorage();
    storage.values.set(CART_STORAGE_KEY, '{invalid');
    const attempts = [uuid(100), uuid(101)];
    const cart = createCartStore({ storage, generateAttemptId: () => attempts.shift()! });

    expect(cart.state).toEqual({ version: 1, titleIds: [], checkoutAttemptId: uuid(100) });
    expect(cart.add(uuid(1))).toBe(true);
    expect(JSON.parse(storage.values.get(CART_STORAGE_KEY)!)).toEqual({
      version: 1,
      titleIds: [uuid(1)],
      checkoutAttemptId: uuid(100)
    });
    expect(storage.values.get(CART_STORAGE_KEY)).not.toMatch(
      /price|email|owned|order|provider|url|paid/iu
    );
  });

  it('adds, removes, and clears uniquely without rotating the attempt', () => {
    const storage = new MemoryStorage();
    const cart = createCartStore({ storage, generateAttemptId: () => uuid(100) });

    expect(cart.add(uuid(1))).toBe(true);
    expect(cart.add(uuid(1))).toBe(false);
    expect(cart.add(uuid(2))).toBe(true);
    expect(cart.size).toBe(2);
    expect(cart.remove(uuid(9))).toBe(false);
    expect(cart.remove(uuid(1))).toBe(true);
    expect(cart.clear()).toBe(true);
    expect(cart.checkoutAttemptId).toBe(uuid(100));
    expect(cart.titleIds).toEqual([]);
  });

  it('rotates the attempt after paid cleanup and explicit reset only', () => {
    const storage = new MemoryStorage();
    const attempts = [uuid(100), uuid(101), uuid(102)];
    const cart = createCartStore({ storage, generateAttemptId: () => attempts.shift()! });
    cart.add(uuid(1));

    cart.add(uuid(2));
    cart.completePaid([uuid(1)]);
    expect(cart.state).toEqual({
      version: 1,
      titleIds: [uuid(2)],
      checkoutAttemptId: uuid(101)
    });
    cart.add(uuid(2));
    cart.reset();
    expect(cart.state).toEqual({ version: 1, titleIds: [], checkoutAttemptId: uuid(102) });
  });

  it('does not touch browser storage when no storage adapter is available', () => {
    const cart = createCartStore({ storage: null, generateAttemptId: () => uuid(100) });

    expect(cart.add(uuid(1))).toBe(true);
    expect(cart.titleIds).toEqual([uuid(1)]);
  });

  it('rotates a failed attempt while preserving every title', () => {
    const storage = new MemoryStorage();
    const attempts = [uuid(100), uuid(101)];
    const cart = createCartStore({ storage, generateAttemptId: () => attempts.shift()! });
    cart.add(uuid(1));
    cart.add(uuid(2));

    cart.rotateAttempt();
    expect(cart.state).toEqual({
      version: 1,
      titleIds: [uuid(1), uuid(2)],
      checkoutAttemptId: uuid(101)
    });
  });

  it('rejects a duplicate and a twenty-sixth title without mutating storage', () => {
    const storage = new MemoryStorage();
    const cart = createCartStore({ storage, generateAttemptId: () => uuid(100) });
    for (let index = 1; index <= 25; index += 1) {
      expect(cart.add(uuid(index))).toBe(true);
    }
    const atLimit = storage.values.get(CART_STORAGE_KEY);

    expect(cart.add(uuid(25))).toBe(false);
    expect(cart.add(uuid(26))).toBe(false);
    expect(cart.size).toBe(25);
    expect(storage.values.get(CART_STORAGE_KEY)).toBe(atLimit);
  });
});
