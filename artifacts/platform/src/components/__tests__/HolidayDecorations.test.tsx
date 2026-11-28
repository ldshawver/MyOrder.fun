// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { expect, it, vi } from "vitest";
import { HolidayStorefront, HolidayDecorationLayer } from "../HolidayDecorations";

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "customer", getToken: async () => "test-token" }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("shares one decoration request across catalog, product and checkout without remounting the product grid", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ theme: "christmas", animated: true }) });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient();
  const location = memoryLocation({ path: "/catalog", record: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const products = vi.fn(() => <div data-products>Product listing</div>);
  const Products = products;
  try {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <Router hook={location.hook}><HolidayStorefront><Products /></HolidayStorefront></Router>
      </QueryClientProvider>,
    ));
    const grid = container.querySelector("[data-products]");
    await act(async () => {
      await vi.waitFor(() => expect(client.getQueryData(["holiday-decorations", "customer", null])).toBeDefined());
    });
    expect(container.querySelector("[data-holiday]")?.getAttribute("data-holiday")).toBe("christmas");
    expect(container.querySelectorAll(".holiday-particle")).toHaveLength(14);
    expect(container.querySelector(".holiday-layer")?.textContent).toContain("🎄");
    for (const path of ["/catalog/12", "/cart", "/checkout"]) {
      await act(async () => location.navigate(path));
      expect(container.querySelector("[data-products]")).toBe(grid);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/catalog/holiday-decorations");
    expect(products).toHaveBeenCalledTimes(1);
    await act(async () => location.navigate("/admin/settings"));
    expect(container.querySelector(".holiday-layer")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
  }
});

it("keeps static motifs and omits all animation elements when effects are disabled", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HolidayDecorationLayer theme="christmas" animated={false} />));
    expect(container.querySelector(".holiday-layer")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll(".holiday-corner")).toHaveLength(2);
    expect(container.querySelectorAll(".holiday-particle")).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
  }
});
