import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("@workspace/db", () => ({ db: {}, ordersTable: {}, orderItemsTable: {}, customerCreditAccountsTable: {} }));
vi.mock("../logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { runOrderTool, describeOrderState, MAX_RECENT_ORDERS, type OrderToolDeps } from "../zappyOrderTools";
import { runChatWithAccountTools, MAX_TOOL_ROUNDS, type ModelMessage } from "../zappyChatLoop";

const ME = { tenantId: 1, customerId: 10 };
const base = {
  status: "pending", paymentStatus: "paid", paymentMethod: "cash", fulfillmentStatus: null, deliveryMethod: "pickup",
  total: "25.50", createdAt: new Date("2026-11-20T18:00:00Z"), acceptedAt: null, estimatedReadyAt: null, readyAt: null,
  pickupAt: null, completedAt: null, cancelledAt: null, voidedAt: null, trackingUrl: null,
};
const mine = { ...base, id: 100, tenantId: 1, customerId: 10 };
const otherCustomer = { ...base, id: 200, tenantId: 1, customerId: 11 };
const otherTenant = { ...base, id: 300, tenantId: 2, customerId: 10 };

function fakeDeps(rows: typeof mine[]): OrderToolDeps & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    // Deliberately "leaky" fakes: they return every row so the tool's own
    // ownership re-check is what's being tested.
    loadRecentOrders: async (...a) => { calls.push(["recent", ...a]); return rows as never; },
    loadOrder: async (t, c, id) => { calls.push(["one", t, c, id]); return rows.find(r => r.id === id) as never; },
    loadItems: async () => [{ orderId: 100, catalogItemName: "Lucifer Widget", quantity: 2 }],
    loadCredit: async () => ({ balance: "30.00", reservedBalance: "5.00" }),
  };
}

describe("Zappy account tools — authorization", () => {
  it("passes the authenticated tenant + customer to every loader, never model args", async () => {
    const deps = fakeDeps([mine]);
    await runOrderTool("get_my_order_status", { orderId: 100, customerId: 11, tenantId: 2 }, ME, deps);
    await runOrderTool("get_my_recent_orders", { customerId: 11 }, ME, deps);
    expect(deps.calls).toEqual([["one", 1, 10, 100], ["recent", 1, 10, 3]]);
  });

  it("another customer's order is reported as not found", async () => {
    expect(await runOrderTool("get_my_order_status", { orderId: 200 }, ME, fakeDeps([otherCustomer]))).toEqual({ found: false });
  });

  it("another tenant's order is reported as not found", async () => {
    expect(await runOrderTool("get_my_order_status", { orderId: 300 }, ME, fakeDeps([otherTenant]))).toEqual({ found: false });
  });

  it("history drops rows that aren't the caller's even if a loader leaks them", async () => {
    const out = await runOrderTool("get_my_recent_orders", {}, ME, fakeDeps([mine, otherCustomer, otherTenant])) as { orders: Array<{ orderId: number }> };
    expect(out.orders.map(o => o.orderId)).toEqual([100]);
  });

  it("bounds history size and rejects bad order ids", async () => {
    const deps = fakeDeps([mine]);
    await runOrderTool("get_my_recent_orders", { limit: 999 }, ME, deps);
    expect(deps.calls[0][3]).toBe(MAX_RECENT_ORDERS);
    expect(await runOrderTool("get_my_order_status", { orderId: "1 OR 1=1" }, ME, deps)).toEqual({ found: false });
  });

  it("source loaders filter by tenantId AND customerId", () => {
    const src = readFileSync(resolve(__dirname, "../zappyOrderTools.ts"), "utf8");
    const loaders = src.slice(src.indexOf("export const defaultOrderToolDeps"));
    expect(loaders.match(/eq\(ordersTable\.customerId, customerId\)/g)?.length).toBe(2);
    expect(loaders.match(/eq\(ordersTable\.tenantId, tenantId\)/g)?.length).toBe(2);
    expect(loaders).toMatch(/eq\(customerCreditAccountsTable\.customerId, customerId\)/);
    expect(loaders).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });
});

describe("Zappy account tools — data returned", () => {
  it("returns only allow-listed fields (no tokens, addresses or notes)", async () => {
    const leaky = { ...mine, paymentToken: "tok_secret", shippingAddress: "1 Main St", notes: "internal" };
    const out = await runOrderTool("get_my_order_status", { orderId: 100 }, ME, fakeDeps([leaky as never]));
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/tok_secret|1 Main St|internal/);
    expect(text).toContain("Lucifer Widget");
  });

  it("tracking link is only the recorded https URL, otherwise null", async () => {
    const withUrl = await runOrderTool("get_my_order_status", { orderId: 100 }, ME, fakeDeps([{ ...mine, trackingUrl: "https://track.example/x" }]));
    const bad = await runOrderTool("get_my_order_status", { orderId: 100 }, ME, fakeDeps([{ ...mine, trackingUrl: "javascript:alert(1)" }]));
    expect((withUrl as { order: { deliveryTrackingUrl: string } }).order.deliveryTrackingUrl).toBe("https://track.example/x");
    expect((bad as { order: { deliveryTrackingUrl: null } }).order.deliveryTrackingUrl).toBeNull();
  });

  it("credit is read-only and reports available = balance − reserved", async () => {
    expect(await runOrderTool("get_my_customer_credit", {}, ME, fakeDeps([]))).toEqual({ availableCredit: 25, reservedForOpenOrders: 5 });
    const none = { ...fakeDeps([]), loadCredit: async () => undefined };
    expect(await runOrderTool("get_my_customer_credit", {}, ME, none)).toEqual({ availableCredit: 0, reservedForOpenOrders: 0 });
  });

  it("customer-facing state comes only from recorded fields", () => {
    expect(describeOrderState(mine)).toBe("received, waiting to be accepted");
    expect(describeOrderState({ ...mine, acceptedAt: new Date() })).toBe("being prepared");
    expect(describeOrderState({ ...mine, readyAt: new Date() })).toBe("ready for pickup");
    expect(describeOrderState({ ...mine, cancelledAt: new Date() })).toBe("cancelled");
  });
});

describe("Zappy chat loop", () => {
  const call = (id: string, name: string, args: object) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

  it("runs account lookups server-side and feeds results back as data", async () => {
    const seen: Array<Array<Record<string, unknown>>> = [];
    const replies: ModelMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("t1", "get_my_order_status", { orderId: 100 })] },
      { role: "assistant", content: "Order 100 is waiting to be accepted." },
    ];
    const out = await runChatWithAccountTools({
      systemPrompt: "", messages: [{ role: "user", content: "where's 100?" }], ctx: ME, deps: fakeDeps([mine]),
      call: async m => { seen.push(m); return replies.shift()!; },
    });
    expect(out.content).toBe("Order 100 is waiting to be accepted.");
    const toolMsg = seen[1].find(m => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("t1");
    expect(JSON.parse(String(toolMsg.content)).data.order.orderId).toBe(100);
  });

  it("keeps cart proposals for the client and doesn't execute them server-side", async () => {
    const replies: ModelMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("c1", "add_to_cart", { catalogItemId: 1, itemName: "W" }), call("t1", "get_my_customer_credit", {})] },
      { role: "assistant", content: "You have $25 available." },
    ];
    const out = await runChatWithAccountTools({ systemPrompt: "", messages: [], ctx: ME, deps: fakeDeps([]), call: async () => replies.shift()! });
    expect(out.tool_calls?.map(c => c.function.name)).toEqual(["add_to_cart"]);
  });

  it("stops after the maximum number of lookup rounds", async () => {
    let n = 0;
    await runChatWithAccountTools({
      systemPrompt: "", messages: [], ctx: ME, deps: fakeDeps([mine]),
      call: async () => { n++; return { role: "assistant", content: "x", tool_calls: [call(`t${n}`, "get_my_recent_orders", {})] }; },
    });
    expect(n).toBe(MAX_TOOL_ROUNDS + 1);
  });

  it("a failing lookup becomes an error result, not a crash or a guess", async () => {
    const deps = { ...fakeDeps([]), loadOrder: async () => { throw new Error("db down"); } };
    const seen: Array<Array<Record<string, unknown>>> = [];
    const replies: ModelMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("t1", "get_my_order_status", { orderId: 1 })] },
      { role: "assistant", content: "I couldn't look that up right now." },
    ];
    await runChatWithAccountTools({ systemPrompt: "", messages: [], ctx: ME, deps, call: async m => { seen.push(m); return replies.shift()!; } });
    expect(String(seen[1].at(-1)!.content)).toContain("lookup_failed");
  });
});
