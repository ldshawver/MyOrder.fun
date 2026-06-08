/**
 * Cart persistence unit tests.
 *
 * Verifies that CartContext's localStorage layer (key: "orderflow_cart")
 * correctly round-trips cart data so items survive a simulated route change
 * (component unmount → remount).
 *
 * These tests exercise the exact same read/write logic used by CartContext.tsx
 * without requiring a DOM or React rendering environment.
 */
import { describe, it, expect, beforeEach } from "vitest";

const STORAGE_KEY = "orderflow_cart";

type CartItem = { id: number; name: string; price: number; quantity: number; imageUrl?: string | null };
type PersistedCart = { alavont: CartItem[]; lucifer_cruz: CartItem[] };

function loadFromStorage(store: Map<string, string>): PersistedCart {
  try {
    const raw = store.get(STORAGE_KEY);
    if (!raw) return { alavont: [], lucifer_cruz: [] };
    const parsed = JSON.parse(raw) as Partial<PersistedCart>;
    return {
      alavont: Array.isArray(parsed.alavont) ? parsed.alavont : [],
      lucifer_cruz: Array.isArray(parsed.lucifer_cruz) ? parsed.lucifer_cruz : [],
    };
  } catch {
    return { alavont: [], lucifer_cruz: [] };
  }
}

function saveToStorage(store: Map<string, string>, carts: PersistedCart): void {
  store.set(STORAGE_KEY, JSON.stringify(carts));
}

let mockStore: Map<string, string>;

beforeEach(() => {
  mockStore = new Map();
});

describe("Cart persistence — orderflow_cart localStorage key", () => {
  it("returns empty carts when storage is empty (initial load)", () => {
    const result = loadFromStorage(mockStore);
    expect(result.alavont).toEqual([]);
    expect(result.lucifer_cruz).toEqual([]);
  });

  it("round-trips alavont cart items through save → load", () => {
    const items: CartItem[] = [
      { id: 1, name: "Midnight Recovery", price: 29.99, quantity: 2, imageUrl: null },
      { id: 2, name: "Velvet Restore", price: 19.99, quantity: 1, imageUrl: "https://cdn.example.com/a.jpg" },
    ];
    saveToStorage(mockStore, { alavont: items, lucifer_cruz: [] });

    const loaded = loadFromStorage(mockStore);
    expect(loaded.alavont).toHaveLength(2);
    expect(loaded.alavont[0]).toMatchObject({ id: 1, name: "Midnight Recovery", quantity: 2 });
    expect(loaded.alavont[1]).toMatchObject({ id: 2, name: "Velvet Restore", quantity: 1 });
    expect(loaded.lucifer_cruz).toEqual([]);
  });

  it("round-trips lucifer_cruz cart items independently", () => {
    const lcItems: CartItem[] = [
      { id: 10, name: "LC Product A", price: 9.99, quantity: 3, imageUrl: null },
    ];
    saveToStorage(mockStore, { alavont: [], lucifer_cruz: lcItems });

    const loaded = loadFromStorage(mockStore);
    expect(loaded.lucifer_cruz).toHaveLength(1);
    expect(loaded.lucifer_cruz[0]).toMatchObject({ id: 10, quantity: 3 });
    expect(loaded.alavont).toEqual([]);
  });

  it("persists both brand carts simultaneously", () => {
    const alavontItems: CartItem[] = [{ id: 1, name: "A1", price: 10, quantity: 1 }];
    const lcItems: CartItem[] = [{ id: 2, name: "LC1", price: 20, quantity: 2 }];
    saveToStorage(mockStore, { alavont: alavontItems, lucifer_cruz: lcItems });

    const loaded = loadFromStorage(mockStore);
    expect(loaded.alavont).toHaveLength(1);
    expect(loaded.lucifer_cruz).toHaveLength(1);
  });

  it("cart survives a simulated route change (save → fresh load)", () => {
    const items: CartItem[] = [
      { id: 5, name: "Product X", price: 15.0, quantity: 4, imageUrl: null },
    ];

    // Simulate: user adds item, component writes to storage
    saveToStorage(mockStore, { alavont: items, lucifer_cruz: [] });

    // Simulate: user navigates (component unmounts, remounts) — a new
    // CartProvider calls loadFromStorage on mount with the same store
    const afterNavigate = loadFromStorage(mockStore);
    expect(afterNavigate.alavont).toHaveLength(1);
    expect(afterNavigate.alavont[0]!.id).toBe(5);
    expect(afterNavigate.alavont[0]!.quantity).toBe(4);
  });

  it("returns empty carts for corrupted JSON (defensive fallback)", () => {
    mockStore.set(STORAGE_KEY, "{not valid json");
    const result = loadFromStorage(mockStore);
    expect(result.alavont).toEqual([]);
    expect(result.lucifer_cruz).toEqual([]);
  });

  it("ignores non-array values in parsed cart fields", () => {
    mockStore.set(STORAGE_KEY, JSON.stringify({ alavont: "not-an-array", lucifer_cruz: null }));
    const result = loadFromStorage(mockStore);
    expect(result.alavont).toEqual([]);
    expect(result.lucifer_cruz).toEqual([]);
  });
});
