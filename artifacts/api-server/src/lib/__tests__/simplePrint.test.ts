/**
 * simplePrint.ts now only validates queue names and reports the configured
 * bridge URL; it must not be able to print directly.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isValidQueueName } from "../simplePrint";

describe("isValidQueueName", () => {
  it("accepts safe names", () => {
    expect(isValidQueueName("receipt")).toBe(true);
    expect(isValidQueueName("Reciept_POS80_Printer")).toBe(true);
    expect(isValidQueueName("label-1.test")).toBe(true);
  });
  it("rejects unsafe names", () => {
    expect(isValidQueueName("receipt; rm -rf /")).toBe(false);
    expect(isValidQueueName("$(whoami)")).toBe(false);
    expect(isValidQueueName("")).toBe(false);
    expect(isValidQueueName("a".repeat(65))).toBe(false);
  });
});

describe("no direct printing", () => {
  it("has no child_process, lp or network sender", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../simplePrint.ts"), "utf8");
    expect(source).not.toMatch(/child_process|spawn\(|fetch\(|"lp"/);
  });
});
