// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getToken: vi.fn(async () => "test-token") }));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ getToken: auth.getToken }) }));
import OrderNotifications from "../admin/order-notifications";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove(); root = undefined; host = undefined; vi.unstubAllGlobals();
});

it("lets an authorized user enable and reload configured MyOrder light alerts", async () => {
  let persisted = { lightEnabled: false, smsEnabled: false, alertDurationSeconds: 60,
    generalAssigneeUserId: null, generalFallbackUserId: null };
  vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
    if (init?.method === "PUT") persisted = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ settings: persisted, recipients: [], lightConfigured: true, smsConfigured: false }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(OrderNotifications)));
  await vi.waitFor(() => expect(host?.textContent).toContain("Server device configuration: Ready"));
  const checkbox = host!.querySelector('input[type="checkbox"]') as HTMLInputElement;
  expect(checkbox.disabled).toBe(false);
  await act(async () => { checkbox.click(); });
  const save = [...host!.querySelectorAll("button")].find(button => button.textContent === "Save settings")!;
  await act(async () => save.click());
  await vi.waitFor(() => expect(host?.textContent).toContain("Order alert settings saved."));
  expect(persisted.lightEnabled).toBe(true);
  await act(async () => { root!.unmount(); root = createRoot(host!); root.render(createElement(OrderNotifications)); });
  await vi.waitFor(() => expect((host!.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true));
});

it("keeps the light option disabled when server setup or the worker is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ settings: {
    lightEnabled: false, smsEnabled: false, alertDurationSeconds: 60, generalAssigneeUserId: null, generalFallbackUserId: null,
  }, recipients: [], lightConfigured: false, smsConfigured: false }), { status: 200, headers: { "Content-Type": "application/json" } })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(OrderNotifications)));
  await vi.waitFor(() => expect(host?.textContent).toContain("Server device configuration: Not configured"));
  expect((host!.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
});
