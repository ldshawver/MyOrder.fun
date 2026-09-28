/**
 * simplePrint.ts — shared helpers for the legacy "simple" printer settings
 * surface (/api/admin/printers/*).
 *
 * The direct local-CUPS (`lp`) and unregistered bridge senders that lived
 * here were removed: every print now goes through a registered printer, its
 * tenant bridge and a print_jobs row (see lib/print/documentJobs.ts).
 */

export const DEFAULT_BRIDGE_URL = "http://100.83.99.2:3100";

export type PrintRole = "receipt" | "label";
export type PrintMethod = "local_cups" | "bridge";

/** Resolve the configured bridge base URL (display only). */
export function getBridgeUrl(): string {
  return process.env.PRINT_BRIDGE_URL ?? DEFAULT_BRIDGE_URL;
}

/** Validate a printer queue name — only safe characters. */
export function isValidQueueName(name: string): boolean {
  return typeof name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(name);
}
