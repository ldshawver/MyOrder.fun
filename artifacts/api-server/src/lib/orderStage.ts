import { deliveryUpdateLabel } from "./deliveryUpdate";

export type OrderStageView = {
  preparerName: string | null;
  pickupInstructions: string | null;
  specialNotes: string | null;
  acceptedAt: string | null;
  estimatedReadyAt: string | null;
  promisedMinutes: number | null;
  readyAt: string | null;
  pickupAt: string | null;
  deliveryMethod: string | null;
  deliveryLabel: string | null;
  departedAt: string | null;
};

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const GENERAL_QUEUE_NOTE = /general\s*que/i;

/** Drops operational General Queue lines from text a customer can read. */
export function customerVisibleNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const kept = value
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !GENERAL_QUEUE_NOTE.test(line));
  return kept.length ? kept.join("\n") : null;
}

/** Customer-safe snapshot for the live order hourglass. Never includes email. */
export function orderStageView(input: {
  preparerFirstName?: string | null;
  preparerLastName?: string | null;
  pickupNote?: unknown;
  notes?: string | null;
  acceptedAt?: Date | string | null;
  estimatedReadyAt?: Date | string | null;
  promisedMinutes?: number | null;
  readyAt?: Date | string | null;
  pickupAt?: Date | string | null;
  deliveryMethod?: string | null;
  deliveryLabel?: string | null;
  departedAt?: Date | string | null;
}): OrderStageView {
  const preparerName = `${input.preparerFirstName ?? ""} ${input.preparerLastName ?? ""}`.trim() || null;
  return {
    preparerName,
    pickupInstructions: customerVisibleNote(input.pickupNote),
    specialNotes: customerVisibleNote(input.notes),
    acceptedAt: iso(input.acceptedAt),
    estimatedReadyAt: iso(input.estimatedReadyAt),
    promisedMinutes: typeof input.promisedMinutes === "number" ? input.promisedMinutes : null,
    readyAt: iso(input.readyAt),
    pickupAt: iso(input.pickupAt),
    deliveryMethod: input.deliveryMethod ?? null,
    deliveryLabel: input.deliveryLabel ?? deliveryUpdateLabel({
      deliveryMethod: input.deliveryMethod,
      departedAt: input.departedAt,
    }),
    departedAt: iso(input.departedAt),
  };
}
