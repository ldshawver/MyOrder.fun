import { describe, expect, it } from "vitest";
import {
  IllegalOrderTransitionError,
  normalizeOrderLifecycleState,
  nextStateForOrderAction,
} from "../orderStateMachine";

describe("canonical order state machine", () => {
  it.each([
    ["draft", "draft", "draft"],
    ["pending", "submitted", "legacy pending"],
    ["accepted", "in_progress", "legacy accepted"],
    ["processing", "preparing", "legacy processing"],
    ["ready_behind_gate", "ready", "legacy ready gate"],
    ["handed_off", "completed", "legacy handed off"],
    ["failed", "reconciliation_required", "legacy failed"],
  ] as const)("normalizes %s to %s (%s)", (input, expected) => {
    expect(normalizeOrderLifecycleState(input)).toBe(expected);
  });

  it.each([
    ["submitted", "claim", "in_progress"],
    ["in_progress", "prepare", "preparing"],
    ["preparing", "ready", "ready"],
    ["ready", "complete", "completed"],
    ["completed", "refund", "refunded"],
  ] as const)("allows legal %s via %s -> %s", (from, action, to) => {
    expect(nextStateForOrderAction(from, action)).toEqual({ from, to, changed: true });
  });

  it.each([
    ["submitted", "ready"],
    ["submitted", "complete"],
    ["in_progress", "complete"],
    ["preparing", "complete"],
    ["ready", "prepare"],
    ["completed", "ready"],
    ["cancelled", "complete"],
  ] as const)("rejects illegal %s via %s", (from, action) => {
    expect(() => nextStateForOrderAction(from, action)).toThrow(IllegalOrderTransitionError);
  });

  it.each([
    ["in_progress", "claim", "in_progress"],
    ["preparing", "prepare", "preparing"],
    ["ready", "ready", "ready"],
    ["completed", "complete", "completed"],
  ] as const)("treats duplicate %s action as idempotent", (from, action, to) => {
    expect(nextStateForOrderAction(from, action)).toEqual({ from, to, changed: false });
  });
});
