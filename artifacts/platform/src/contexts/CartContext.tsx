import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { useBrand, type Brand } from "@/contexts/BrandContext";

export type CartItem = {
  id: number;
  name: string;
  price: number;
  quantity: number;
  imageUrl?: string | null;
};

interface CartContextValue {
  cart: CartItem[];
  brand: Brand;
  addItem: (item: { id: number; name: string; price: number; imageUrl?: string | null }, quantity?: number) => void;
  removeItem: (id: number) => void;
  updateQuantity: (id: number, delta: number) => void;
  setQuantity: (id: number, quantity: number) => void;
  clearCart: () => void;
  replaceCart: (items: CartItem[]) => void;
  itemCount: number;
  cartTotal: number;
}

const CartContext = createContext<CartContextValue>({
  cart: [],
  brand: "alavont",
  addItem: () => {},
  removeItem: () => {},
  updateQuantity: () => {},
  setQuantity: () => {},
  clearCart: () => {},
  replaceCart: () => {},
  itemCount: 0,
  cartTotal: 0,
});

const STORAGE_KEY = "orderflow_cart";

type PersistedCart = { alavont: CartItem[]; lucifer_cruz: CartItem[] };
type StoredCartState = { storageKey: string | null; carts: PersistedCart };

function emptyCart(): PersistedCart {
  return { alavont: [], lucifer_cruz: [] };
}

function loadFromStorage(storageKey: string): PersistedCart {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return emptyCart();
    const parsed = JSON.parse(raw) as Partial<PersistedCart>;
    return {
      alavont: Array.isArray(parsed.alavont) ? parsed.alavont : [],
      lucifer_cruz: Array.isArray(parsed.lucifer_cruz) ? parsed.lucifer_cruz : [],
    };
  } catch {
    return emptyCart();
  }
}

function saveToStorage(storageKey: string, carts: PersistedCart) {
  try { localStorage.setItem(storageKey, JSON.stringify(carts)); } catch { /* storage unavailable */ }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const { brand } = useBrand();
  const { userId, isLoaded } = useAuth();
  const storageKey = isLoaded && userId ? `${STORAGE_KEY}:${userId}` : null;
  const [cartState, setCartState] = useState<StoredCartState>({
    storageKey: null,
    carts: emptyCart(),
  });

  useEffect(() => {
    if (!isLoaded) return;
    setCartState({
      storageKey,
      carts: storageKey ? loadFromStorage(storageKey) : emptyCart(),
    });
  }, [isLoaded, storageKey]);

  useEffect(() => {
    // Do not write a previous signed-in user's in-memory cart into the next
    // user's storage namespace while Clerk identity is changing.
    if (!isLoaded || !storageKey || cartState.storageKey !== storageKey) return;
    saveToStorage(storageKey, cartState.carts);
  }, [cartState, isLoaded, storageKey]);

  const cart = cartState.carts[brand];

  const mutate = useCallback((fn: (prev: CartItem[]) => CartItem[]) => {
    setCartState(prev => prev.storageKey === storageKey
      ? { ...prev, carts: { ...prev.carts, [brand]: fn(prev.carts[brand]) } }
      : prev);
  }, [brand, storageKey]);

  const addItem = useCallback((item: { id: number; name: string; price: number; imageUrl?: string | null }, quantity = 1) => {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return;
    mutate(prev => {
      const existing = prev.find(i => i.id === item.id);
      if (existing) {
        return prev.map(i => i.id === item.id ? { ...i, quantity: i.quantity + quantity } : i);
      }
      return [...prev, { id: item.id, name: item.name, price: item.price, quantity, imageUrl: item.imageUrl ?? null }];
    });
  }, [mutate]);

  const removeItem = useCallback((id: number) => {
    mutate(prev => prev.filter(i => i.id !== id));
  }, [mutate]);

  const updateQuantity = useCallback((id: number, delta: number) => {
    if (!Number.isSafeInteger(delta) || delta === 0) return;
    mutate(prev => prev.flatMap(i => {
      if (i.id !== id) return [i];
      const quantity = i.quantity + delta;
      // A decrement from one uses the normal cart removal behavior; a cart
      // never persists a zero or negative line quantity.
      return quantity > 0 ? [{ ...i, quantity }] : [];
    }));
  }, [mutate]);

  const setQuantity = useCallback((id: number, quantity: number) => {
    if (!Number.isSafeInteger(quantity)) return;
    if (quantity <= 0) {
      mutate(prev => prev.filter(i => i.id !== id));
    } else {
      mutate(prev => prev.map(i => i.id === id ? { ...i, quantity } : i));
    }
  }, [mutate]);

  const clearCart = useCallback(() => {
    mutate(() => []);
  }, [mutate]);

  const replaceCart = useCallback((items: CartItem[]) => {
    setCartState(prev => prev.storageKey === storageKey
      ? { ...prev, carts: { ...prev.carts, [brand]: items } }
      : prev);
  }, [brand, storageKey]);

  const itemCount = cart.reduce((s, i) => s + i.quantity, 0);
  const cartTotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);

  return (
    <CartContext.Provider value={{ cart, brand, addItem, removeItem, updateQuantity, setQuantity, clearCart, replaceCart, itemCount, cartTotal }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  return useContext(CartContext);
}
