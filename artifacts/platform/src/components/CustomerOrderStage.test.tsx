// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CustomerOrderStage, type StageOrder } from "./CustomerOrderStage";

vi.mock("@clerk/react", () => ({ useAuth: () => ({ getToken: async () => null }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@/hooks/useOrderEvents", () => ({ useOrderEvents: () => {} }));

const scheduledOrder: StageOrder = {
  id: 1,
  status: "submitted",
  deliveryMethod: "pickup",
  createdAt: "2026-11-28T05:00:00Z",
  estimatedReadyAt: "2026-11-28T05:30:00Z",
  serverNow: "2026-11-28T05:00:01Z",
  pickupAt: "2026-11-28T22:00:00Z",
  pickupSchedule: { mode: "scheduled", localLabel: "Sat, Nov 28 at 2:00 PM PST" },
};

it("shows the store's scheduled pickup time in place of the legacy countdown", () => {
  const html = renderToStaticMarkup(createElement(CustomerOrderStage, { order: scheduledOrder }));
  expect(html).toContain("Your order will be ready for pickup at Sat, Nov 28 at 2:00 PM PST.");
  expect(html).not.toContain("until ready");
});

it("keeps the immediate countdown and honors a real ready status for scheduled orders", () => {
  const immediate = { ...scheduledOrder, pickupSchedule: { mode: "immediate" } };
  const ready = { ...scheduledOrder, status: "ready" };
  expect(renderToStaticMarkup(createElement(CustomerOrderStage, { order: immediate }))).toContain("until ready");
  expect(renderToStaticMarkup(createElement(CustomerOrderStage, { order: ready }))).toContain("Ready now");
});
