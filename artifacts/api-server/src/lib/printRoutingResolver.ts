/**
 * printRoutingResolver.ts — Smart bridge routing for print jobs.
 *
 * Routing rules:
 *   Receipts:
 *     1. Default → Raspberry Pi bridge (lowest priority number)
 *     2. Exception: if active operator is on same network as Mac Studio → prefer Mac bridge
 *     3. Health fallback: if preferred bridge is unreachable, try the other active bridge
 *
 *   Labels:
 *     1. Only print for to-go/pickup/delivery orders OR Lucifer Cruz shipment orders (tenantId=1 + shippingAddress set)
 *     2. If operator on Mac network and Mac bridge supports labels → use Mac
 *     3. If operator NOT on Mac network → route to Pi bridge if configured, else skip with reason
 *     4. Never silently fail — always return a blockedReason when not printing
 *
 * Network detection:
 *   Uses the operator's IP address (stored on their active shift record when they clocked in)
 *   compared against the Mac bridge profile's networkSubnetHint (server-side only, not client-trusted).
 */

import { db } from "@workspace/db";
import {
  printBridgeProfilesTable,
  printPrintersTable,
  labTechShiftsTable,
} from "@workspace/db";
import type { PrintBridgeProfile, PrintPrinter } from "@workspace/db";
import { eq, and, asc, sql } from "drizzle-orm";
import { probeBridge, resolveBridgeApiKey } from "./printRouter.js";
import pino from "pino";

const rLog = pino({ name: "printRoutingResolver" });

// ── Types ─────────────────────────────────────────────────────────────────────

export type PrintOrderContext = {
  id: number;
  tenantId?: number | null;
  fulfillmentType?: string | null;
  shippingAddress?: string | null;
  locationId?: number | null;
};

export type LabelEligibility = {
  eligible: boolean;
  reason: string;
};

export type RoutingDecision = {
  requestedRole: "receipt" | "label" | "thank_you_sticker";
  eligible: boolean;
  selectedBridgeProfileId: number | null;
  selectedBridgeUrl: string | null;
  selectedPrinterName: string | null;
  selectedPrinter: PrintPrinter | null;
  fallbackUsed: boolean;
  decisionReason: string;
  blockedReason: string | null;
};

export const THANK_YOU_STICKER_QUEUE = "MARKLIFE_X2";
export const THANK_YOU_STICKER_ARTWORK_SHA256 = "0fad41aa3b9f338e00f02d4bcd1e80acc34a6d4bb1cb8a846ce52b4d740a83f4";
export const THANK_YOU_STICKER_TEMPLATE_VERSION = 1;

/** Dedicated sticker policy: exact role + exact queue, with no fallback. */
export function validateThankYouStickerPrinter(printer: Pick<PrintPrinter, "role" | "bridgePrinterName" | "name" | "isActive"> | null): { eligible: boolean; reason: string } {
  if (!printer?.isActive) return { eligible: false, reason: "MARKLIFE_X2 is not configured and active" };
  if (printer.role !== "thank_you_sticker") return { eligible: false, reason: "printer is not dedicated to thank_you_sticker jobs" };
  if ((printer.bridgePrinterName ?? printer.name) !== THANK_YOU_STICKER_QUEUE) return { eligible: false, reason: "thank_you_sticker queue must be MARKLIFE_X2" };
  return { eligible: true, reason: "dedicated MARKLIFE_X2 route verified" };
}

export async function resolveThankYouStickerRouting(order: PrintOrderContext): Promise<RoutingDecision> {
  const base = { requestedRole: "thank_you_sticker" as const, selectedBridgeProfileId: null, selectedBridgeUrl: null, selectedPrinterName: null, selectedPrinter: null, fallbackUsed: false };
  if (!order.tenantId) return { ...base, eligible: false, decisionReason: "tenant ownership is required for printer routing", blockedReason: "tenant ownership is required for printer routing" };
  const profiles = (await getActiveBridgeProfiles(order.tenantId, order.locationId ?? null)).filter(profile => profile.bridgeType === "mac_studio");
  if (profiles.length !== 1) return { ...base, eligible: false, decisionReason: "exactly one Mac Studio bridge is required", blockedReason: "exactly one Mac Studio bridge is required" };
  const profile = profiles[0];
  if (!await isBridgeHealthy(profile)) return { ...base, eligible: false, decisionReason: "MARKLIFE_X2 bridge is unavailable", blockedReason: "MARKLIFE_X2 bridge is unavailable" };
  const printers = await db.select().from(printPrintersTable).where(and(
    eq(printPrintersTable.tenantId, order.tenantId), eq(printPrintersTable.bridgeProfileId, profile.id),
    eq(printPrintersTable.role, "thank_you_sticker"), eq(printPrintersTable.isActive, true),
  )).limit(2);
  if (printers.length !== 1) return { ...base, eligible: false, decisionReason: "exactly one dedicated MARKLIFE_X2 printer is required", blockedReason: "exactly one dedicated MARKLIFE_X2 printer is required" };
  const printer = printers[0];
  const validation = validateThankYouStickerPrinter(printer ?? null);
  if (!validation.eligible) return { ...base, eligible: false, decisionReason: validation.reason, blockedReason: validation.reason };
  return { requestedRole: "thank_you_sticker", eligible: true, selectedBridgeProfileId: profile.id, selectedBridgeUrl: profile.bridgeUrl, selectedPrinterName: THANK_YOU_STICKER_QUEUE, selectedPrinter: printer, fallbackUsed: false, decisionReason: validation.reason, blockedReason: null };
}

// ── Label Eligibility ─────────────────────────────────────────────────────────

/**
 * Returns whether a label should be printed for this order.
 *
 * Label is eligible when:
 *   - fulfillmentType is to-go/pickup/delivery (case-insensitive), OR
 *   - tenantId === 1 (Lucifer Cruz) AND shippingAddress is non-empty
 */
export function shouldPrintLabel(order: PrintOrderContext): LabelEligibility {
  const ft = order.fulfillmentType?.toLowerCase().trim();
  if (ft && ["to-go", "togo", "takeout", "pickup", "pick-up"].includes(ft)) {
    return { eligible: true, reason: "to-go order" };
  }
  if (ft === "delivery") {
    return { eligible: true, reason: "delivery order" };
  }
  if (order.tenantId === 1 && order.shippingAddress?.trim()) {
    return { eligible: true, reason: "Lucifer Cruz shipment order" };
  }
  const detail = `fulfillmentType=${order.fulfillmentType ?? "none"}, tenantId=${order.tenantId ?? "?"}, hasShipping=${Boolean(order.shippingAddress)}`;
  return { eligible: false, reason: `label skipped: order type not eligible (${detail})` };
}

// ── Network Detection ─────────────────────────────────────────────────────────

/**
 * Server-side only: check if an IP is on the same subnet as a bridge.
 * Uses the bridge profile's networkSubnetHint (e.g., "192.168.1." or "100.64.").
 * Never trusts client-submitted data — operator IP is read from the shift record.
 */
export function isOnSameNetwork(
  operatorIp: string | null | undefined,
  networkSubnetHint: string | null | undefined
): boolean {
  if (!operatorIp || !networkSubnetHint) return false;
  return operatorIp.startsWith(networkSubnetHint);
}

/**
 * Get the IP address of the currently active operator from their shift record.
 * Returns null if no active shift or no IP was recorded.
 */
export async function getActiveOperatorIp(tenantId: number): Promise<string | null> {
  const shifts = await db
    .select({ ipAddress: labTechShiftsTable.ipAddress })
    .from(labTechShiftsTable)
    .where(and(eq(labTechShiftsTable.tenantId, tenantId), eq(labTechShiftsTable.status, "active")))
    .orderBy(asc(labTechShiftsTable.clockedInAt))
    .limit(1);
  return shifts[0]?.ipAddress ?? null;
}

// ── Bridge Profile Helpers ────────────────────────────────────────────────────

/** Load all active bridge profiles ordered by priority (ascending = highest first). */
async function getActiveBridgeProfiles(tenantId: number, locationId: number | null): Promise<PrintBridgeProfile[]> {
  return db
    .select()
    .from(printBridgeProfilesTable)
    .where(and(
      eq(printBridgeProfilesTable.tenantId, tenantId),
      eq(printBridgeProfilesTable.isActive, true),
      locationId === null
        ? and(eq(printBridgeProfilesTable.routingScope, "general"), sql`${printBridgeProfilesTable.locationId} IS NULL`)
        : and(eq(printBridgeProfilesTable.routingScope, "location"), eq(printBridgeProfilesTable.locationId, locationId)),
    ))
    .orderBy(asc(printBridgeProfilesTable.priority));
}

/** Find the best active printer for a role on a given bridge profile (by bridgeProfileId). */
async function getPrinterForBridgeProfile(
  tenantId: number,
  locationId: number | null,
  bridgeProfileId: number,
  role: "receipt" | "label"
): Promise<PrintPrinter | null> {
  const printers = await db
    .select()
    .from(printPrintersTable)
    .where(
      and(
        eq(printPrintersTable.bridgeProfileId, bridgeProfileId),
        eq(printPrintersTable.tenantId, tenantId),
        eq(printPrintersTable.isActive, true),
        eq(printPrintersTable.role, role),
        locationId === null
          ? and(eq(printPrintersTable.routingScope, "general"), sql`${printPrintersTable.locationId} IS NULL`)
          : and(eq(printPrintersTable.routingScope, "location"), eq(printPrintersTable.locationId, locationId)),
      )
    )
    .limit(1);
  return printers[0] ?? null;
}

/**
 * Find a printer by connectionType that matches the bridge type (legacy fallback
 * for printers not yet linked to a bridge profile).
 */
/**
 * Probe a bridge profile's /health endpoint.
 * Returns true if bridge is reachable and healthy.
 */
async function isBridgeHealthy(profile: PrintBridgeProfile): Promise<boolean> {
  try {
    return await probeBridge(
      profile.bridgeUrl,
      resolveBridgeApiKey(profile.apiKey),
      3000,
    );
  } catch {
    return false;
  }
}

function isTailscaleBridge(profile: PrintBridgeProfile): boolean {
  return profile.bridgeUrl.includes("://100.") || profile.networkSubnetHint?.startsWith("100.") === true;
}

// ── Core Routing Resolver ─────────────────────────────────────────────────────

/**
 * Resolve the full routing decision for a print job.
 *
 * @param role          - "receipt" or "label"
 * @param order         - order context for label eligibility + tenant detection
 * @param operatorIp    - optional override for operator IP (otherwise read from active shift)
 */
export async function resolveRoutingDecision(
  role: "receipt" | "label",
  order: PrintOrderContext,
  operatorIp?: string | null
): Promise<RoutingDecision> {
  const base: Omit<RoutingDecision, "decisionReason" | "blockedReason" | "eligible"> = {
    requestedRole: role,
    selectedBridgeProfileId: null,
    selectedBridgeUrl: null,
    selectedPrinterName: null,
    selectedPrinter: null,
    fallbackUsed: false,
  };
  if (!order.tenantId) {
    const msg = "tenant ownership is required for printer routing";
    return { ...base, eligible: false, decisionReason: msg, blockedReason: msg };
  }
  const locationId = order.locationId ?? null;

  // ── Label eligibility gate ─────────────────────────────────────────────────
  if (role === "label") {
    const eligibility = shouldPrintLabel(order);
    if (!eligibility.eligible) {
      rLog.info({ event: "label_skipped", orderId: order.id, reason: eligibility.reason }, "label skipped");
      return { ...base, eligible: false, decisionReason: eligibility.reason, blockedReason: eligibility.reason };
    }
  }

  // ── Get bridge profiles ────────────────────────────────────────────────────
  const profiles = await getActiveBridgeProfiles(order.tenantId, locationId);
  if (profiles.length === 0) {
    const msg = locationId === null ? "no tenant general bridge configured" : "no bridge configured for the assigned location";
    return { ...base, eligible: false, decisionReason: msg, blockedReason: msg };
  }

  // ── Detect operator network ────────────────────────────────────────────────
  const resolvedOperatorIp = operatorIp ?? await getActiveOperatorIp(order.tenantId);
  const macProfile = profiles.find(p => p.bridgeType === "mac_studio");
  const piProfile = profiles.find(p => p.bridgeType === "raspberry_pi");

  const operatorOnMacNetwork = macProfile
    ? isOnSameNetwork(resolvedOperatorIp, macProfile.networkSubnetHint)
    : false;
  const macReachableOverTailscale = macProfile ? isTailscaleBridge(macProfile) : false;

  rLog.info({
    event: "routing_context",
    orderId: order.id,
    role,
    operatorIp: resolvedOperatorIp,
    operatorOnMacNetwork,
    macProfileId: macProfile?.id ?? null,
    piProfileId: piProfile?.id ?? null,
    profileCount: profiles.length,
  }, "routing context resolved");

  // ── Filter profiles supporting this role ──────────────────────────────────
  const eligible = (p: PrintBridgeProfile) =>
    p.supportedRoles === "both" || p.supportedRoles === role;

  const supportingProfiles = profiles.filter(eligible);
  if (supportingProfiles.length === 0) {
    const msg = `no active bridge profile supports role="${role}"`;
    return { ...base, eligible: false, decisionReason: msg, blockedReason: msg };
  }

  // ── Label-specific Mac restriction ────────────────────────────────────────
  // If role=label and operator is NOT on Mac network, exclude Mac bridge for labels.
  let candidateProfiles = supportingProfiles;
  if (role === "label" && !operatorOnMacNetwork && !macReachableOverTailscale && macProfile) {
    candidateProfiles = supportingProfiles.filter(p => p.bridgeType !== "mac_studio");
    if (candidateProfiles.length === 0) {
      const msg = "Label not printed: active operator is not on Mac Studio network and no Pi label bridge is configured";
      rLog.warn({ event: "label_blocked", orderId: order.id, msg }, "label blocked");
      return { ...base, eligible: false, decisionReason: msg, blockedReason: msg };
    }
    rLog.info({ event: "mac_excluded_for_label", orderId: order.id }, "Mac bridge excluded for label (operator not on Mac network)");
  }

  // Scope is authoritative. Never try a second bridge for a different location.
  const ordered = [...candidateProfiles].sort((a, b) => a.priority - b.priority).slice(0, 1);

  // ── Try each candidate bridge in order ────────────────────────────────────
  const fallbackUsed = false;
  for (const profile of ordered) {
    const healthy = await isBridgeHealthy(profile);
    if (!healthy) {
      rLog.warn({ event: "bridge_unhealthy", bridgeId: profile.id, bridgeType: profile.bridgeType, url: profile.bridgeUrl }, "bridge unhealthy, trying next");
      const msg = `assigned bridge ${profile.id} is unavailable`;
      return { ...base, eligible: false, decisionReason: msg, blockedReason: msg };
    }

    const printer = await getPrinterForBridgeProfile(order.tenantId, locationId, profile.id, role);

    if (!printer) {
      rLog.warn({ event: "no_printer_on_bridge", bridgeId: profile.id, role }, "bridge healthy but no printer configured for role");
      const msg = `assigned bridge ${profile.id} has no active ${role} printer in scope`;
      return { ...base, eligible: false, decisionReason: msg, blockedReason: msg };
    }

    const decision: RoutingDecision = {
      requestedRole: role,
      eligible: true,
      selectedBridgeProfileId: profile.id,
      selectedBridgeUrl: profile.bridgeUrl,
      selectedPrinterName: printer.bridgePrinterName ?? printer.name,
      selectedPrinter: printer,
      fallbackUsed,
      decisionReason: operatorOnMacNetwork && profile.bridgeType === "mac_studio"
        ? `routed to Mac Studio (operator on Mac network)${fallbackUsed ? " [fallback used]" : ""}`
        : `routed to ${profile.name} (${profile.bridgeType})${fallbackUsed ? " [fallback used]" : ""}`,
      blockedReason: null,
    };

    rLog.info({ event: "routing_decision", orderId: order.id, ...decision, selectedPrinter: undefined, selectedPrinterId: printer.id }, "routing decision made");
    return decision;
  }

  // ── All bridges failed ─────────────────────────────────────────────────────
  const msg = `all ${ordered.length} candidate bridge(s) were unreachable or had no configured printer`;
  rLog.error({ event: "all_bridges_failed", orderId: order.id, role, msg }, "all bridges failed");
  return { ...base, eligible: role === "receipt", decisionReason: msg, blockedReason: msg };
}
