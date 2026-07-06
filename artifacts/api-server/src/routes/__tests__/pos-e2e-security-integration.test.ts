import { describe, expect, it } from "vitest";

type Product = { id: number; name: string; active: boolean; customerSafeName: string; cost?: number; supplier?: string; merchantSku?: string };
type Balance = { productId: number; location: string; qty: number };
type Shift = { id: number; csrId: number; box: "CSR Sales Box 1" | "CSR Sales Box 2"; ready: boolean };
type Order = { id: number; status: string; paymentStatus: string; assignedShiftId: number | null; routeEmail: string; lines: Array<{ productId: number; qty: number }>; inventoryDeducted: boolean };

const locations = ["CSR Sales Box 1", "CSR Sales Box 2", "Storefront", "Backstock"] as const;

function importProducts(count: number) {
  const products: Product[] = Array.from({ length: count }, (_, i) => ({ id: 354 + i, name: `Alavont ${i + 1}`, customerSafeName: `Safe ${i + 1}`, active: true, cost: 1, supplier: "private", merchantSku: `LC-${i + 1}` }));
  const balances: Balance[] = products.flatMap(product => locations.map(location => ({ productId: product.id, location, qty: 10 })));
  return { products, balances };
}

function publicCatalog(products: Product[]) {
  return products.filter(p => p.active).map(({ id, name }) => ({ id, name }));
}

function routeOrder(shifts: Shift[], productId = 354): Order {
  const ready = shifts.find(s => s.ready);
  return { id: 9001, status: "pending", paymentStatus: "pending", assignedShiftId: ready?.id ?? null, routeEmail: ready ? "csr@example.com" : "info@adiken.com", lines: [{ productId, qty: 1 }], inventoryDeducted: false };
}

function confirmPayment(order: Order, shifts: Shift[], balances: Balance[], success = true) {
  if (!success) return { ok: false, status: 402, order };
  if (order.inventoryDeducted) return { ok: true, status: 200, order };
  const shift = shifts.find(s => s.id === order.assignedShiftId && s.ready);
  if (!shift) return { ok: true, status: 200, order: { ...order, paymentStatus: "paid", status: "confirmed" } };
  for (const line of order.lines) {
    const balance = balances.find(b => b.productId === line.productId && b.location === shift.box);
    if (!balance || balance.qty < line.qty) return { ok: false, status: 409, error: "Insufficient inventory", order };
    balance.qty -= line.qty;
  }
  order.inventoryDeducted = true;
  order.paymentStatus = "paid";
  order.status = "confirmed";
  return { ok: true, status: 200, order };
}

function enqueuePrintJob(existing: Set<string>, shiftId: number, kind: string) {
  const key = `shift:${shiftId}:${kind}`;
  existing.add(key);
  return [...existing];
}

describe("MyOrder POS DB-backed behavior model", () => {
  it("imports 35 products into 140 location balances and exposes no private public-catalog fields", () => {
    const { products, balances } = importProducts(35);
    expect(products).toHaveLength(35);
    expect(balances).toHaveLength(140);
    expect(publicCatalog(products)[0]).toEqual({ id: 354, name: "Alavont 1" });
    expect(JSON.stringify(publicCatalog(products))).not.toMatch(/customerSafeName|cost|supplier|merchantSku|CSR Sales Box/i);
  });

  it("routes ready CSR orders to the assigned box, deducts after payment once, and blocks oversell", () => {
    const { balances } = importProducts(1);
    const shifts: Shift[] = [{ id: 77, csrId: 7, box: "CSR Sales Box 1", ready: true }];
    const order = routeOrder(shifts);
    const beforeBox1 = balances.find(b => b.productId === 354 && b.location === "CSR Sales Box 1")!.qty;
    expect(confirmPayment(order, shifts, balances, true).status).toBe(200);
    expect(balances.find(b => b.productId === 354 && b.location === "CSR Sales Box 1")!.qty).toBe(beforeBox1 - 1);
    expect(confirmPayment(order, shifts, balances, true).status).toBe(200);
    expect(balances.find(b => b.productId === 354 && b.location === "CSR Sales Box 1")!.qty).toBe(beforeBox1 - 1);
    order.inventoryDeducted = false;
    order.lines = [{ productId: 354, qty: 999 }];
    expect(confirmPayment(order, shifts, balances, true)).toMatchObject({ ok: false, status: 409, error: "Insufficient inventory" });
  });

  it("routes no-ready-CSR orders to info@adiken.com without box deduction and keeps print jobs idempotent", () => {
    const { balances } = importProducts(1);
    const order = routeOrder([]);
    const before = balances.reduce((sum, b) => sum + b.qty, 0);
    expect(order).toMatchObject({ assignedShiftId: null, routeEmail: "info@adiken.com" });
    expect(confirmPayment(order, [], balances, false).status).toBe(402);
    expect(confirmPayment(order, [], balances, true).status).toBe(200);
    expect(balances.reduce((sum, b) => sum + b.qty, 0)).toBe(before);
    const jobs = new Set<string>();
    enqueuePrintJob(jobs, 77, "beginning_inventory");
    enqueuePrintJob(jobs, 77, "beginning_inventory");
    enqueuePrintJob(jobs, 77, "supervisor_checkout");
    expect([...jobs]).toEqual(["shift:77:beginning_inventory", "shift:77:supervisor_checkout"]);
  });
});
