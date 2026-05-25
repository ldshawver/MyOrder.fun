import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
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

function loadFromStorage(): PersistedCart {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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

function saveToStorage(carts: PersistedCart) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(carts)); } catch { /* storage unavailable */ }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const { brand } = useBrand();
  const [carts, setCarts] = useState<PersistedCart>(loadFromStorage);

  useEffect(() => {
    saveToStorage(carts);
  }, [carts]);

  const cart = carts[brand];

  const mutate = useCallback((fn: (prev: CartItem[]) => CartItem[]) => {
    setCarts(prev => ({ ...prev, [brand]: fn(prev[brand]) }));
  }, [brand]);

  const addItem = useCallback((item: { id: number; name: string; price: number; imageUrl?: string | null }, quantity = 1) => {
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
    mutate(prev =>
      prev.map(i => i.id === id ? { ...i, quantity: Math.max(1, i.quantity + delta) } : i)
    );
  }, [mutate]);

  const setQuantity = useCallback((id: number, quantity: number) => {
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
    setCarts(prev => ({ ...prev, [brand]: items }));
  }, [brand]);

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
