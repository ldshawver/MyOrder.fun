import { and, eq } from "drizzle-orm";
import { db, inventoryLocationsTable, locationPickupSchedulesTable } from "@workspace/db";
import { z } from "zod";

const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const pickupIntervalSchema = z.object({ open: clockTime, close: clockTime }).strict().refine(interval => interval.open !== interval.close, {
  message: "Opening and closing times must differ",
});
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}, "Use a valid calendar date");
export const weeklyPickupHoursSchema = z.array(z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  intervals: z.array(pickupIntervalSchema).max(4),
}).strict()).max(7).superRefine((rows, ctx) => {
  if (new Set(rows.map(row => row.dayOfWeek)).size !== rows.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Each weekday may appear only once" });
});
export const pickupExceptionsSchema = z.array(z.object({
  date: localDate,
  closed: z.boolean(),
  intervals: z.array(pickupIntervalSchema).max(4).optional(),
  label: z.string().trim().max(80).optional(),
}).strict().superRefine((row, ctx) => {
  if (!row.closed && !row.intervals?.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Open exceptions require hours" });
  if (row.closed && row.intervals?.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Closed exceptions cannot include hours" });
})).max(180).superRefine((rows, ctx) => {
  if (new Set(rows.map(row => row.date)).size !== rows.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Each exception date may appear only once" });
});

export const pickupScheduleInputSchema = z.object({
  timeZone: z.string().trim().min(1).max(80).refine(value => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date()); return true; } catch { return false; }
  }, "Use a valid IANA time zone"),
  weeklyHours: weeklyPickupHoursSchema,
  exceptions: pickupExceptionsSchema,
  slotMinutes: z.union([z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(45), z.literal(60)]),
  maxAdvanceDays: z.number().int().min(1).max(90),
  version: z.number().int().positive(),
}).strict();

export type PickupScheduleInput = z.infer<typeof pickupScheduleInputSchema>;
type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };
type Interval = z.infer<typeof pickupIntervalSchema>;

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  const weekdayName = parts.find(part => part.type === "weekday")?.value ?? "Sun";
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName) };
}

function dateKey(parts: Pick<LocalParts, "year" | "month" | "day">): string {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function addDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

function parseClock(value: string): [number, number] { return value.split(":").map(Number) as [number, number]; }

/** Resolve a wall-clock value to every matching instant. Empty means a DST gap. */
export function localTimeCandidates(date: string, time: string, timeZone: string): Date[] {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = parseClock(time);
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  for (const seed of [wallUtc - 86_400_000, wallUtc - 43_200_000, wallUtc, wallUtc + 43_200_000, wallUtc + 86_400_000]) {
    const p = localParts(new Date(seed), timeZone);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - seed);
  }
  const matches = [...offsets].map(offset => new Date(wallUtc - offset)).filter(candidate => {
    const p = localParts(candidate, timeZone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  });
  return [...new Map(matches.map(value => [value.getTime(), value])).values()].sort((a, b) => a.getTime() - b.getTime());
}

function intervalsForDate(schedule: PickupScheduleInput, date: string): Interval[] {
  const exception = schedule.exceptions.find(row => row.date === date);
  if (exception) return exception.closed ? [] : exception.intervals ?? [];
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return schedule.weeklyHours.find(row => row.dayOfWeek === weekday)?.intervals ?? [];
}

function intervalInstants(schedule: PickupScheduleInput, date: string, interval: Interval): { opensAt: Date; closesAt: Date } | null {
  const opens = localTimeCandidates(date, interval.open, schedule.timeZone);
  const overnight = interval.close <= interval.open;
  const closes = localTimeCandidates(overnight ? addDate(date, 1) : date, interval.close, schedule.timeZone);
  if (!opens.length || !closes.length) return null;
  const opensAt = opens[0];
  const closesAt = closes.at(-1)!;
  return closesAt > opensAt ? { opensAt, closesAt } : null;
}

function localLabel(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(instant);
}

export type PickupAvailability = {
  timeZone: string;
  openNow: boolean;
  immediateAvailable: boolean;
  slots: Array<{ at: string; label: string }>;
  nextOpenAt: string | null;
  message: string;
  regularHours: Array<{ dayOfWeek: number; day: string; hours: string }>;
};

export function calculatePickupAvailability(schedule: PickupScheduleInput, now = new Date()): PickupAvailability {
  const today = dateKey(localParts(now, schedule.timeZone));
  const windows: Array<{ opensAt: Date; closesAt: Date }> = [];
  for (let offset = -1; offset <= schedule.maxAdvanceDays; offset += 1) {
    const date = addDate(today, offset);
    for (const interval of intervalsForDate(schedule, date)) {
      const window = intervalInstants(schedule, date, interval);
      if (window) windows.push(window);
    }
  }
  windows.sort((a, b) => a.opensAt.getTime() - b.opensAt.getTime());
  const openNow = windows.some(window => window.opensAt <= now && now < window.closesAt);
  const slots = new Map<number, { at: string; label: string }>();
  for (const window of windows) {
    for (let at = window.opensAt.getTime(); at < window.closesAt.getTime(); at += schedule.slotMinutes * 60_000) {
      if (at < now.getTime()) continue;
      const instant = new Date(at);
      slots.set(at, { at: instant.toISOString(), label: localLabel(instant, schedule.timeZone) });
      if (slots.size >= 500) break;
    }
  }
  const resultSlots = [...slots.values()];
  const nextOpen = windows.find(window => window.opensAt > now)?.opensAt ?? null;
  return {
    timeZone: schedule.timeZone,
    openNow,
    immediateAvailable: openNow,
    slots: resultSlots,
    nextOpenAt: nextOpen?.toISOString() ?? null,
    message: openNow ? "Open now for immediate pickup." : resultSlots.length ? "The store is closed. Choose a pickup time during the next open period." : "The store is closed and no pickup times are available in the scheduling window.",
    regularHours: [0, 1, 2, 3, 4, 5, 6].map(dayOfWeek => {
      const intervals = schedule.weeklyHours.find(row => row.dayOfWeek === dayOfWeek)?.intervals ?? [];
      return { dayOfWeek, day: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dayOfWeek], hours: intervals.length ? intervals.map(interval => `${interval.open}–${interval.close}${interval.close <= interval.open ? " next day" : ""}`).join(", ") : "Closed" };
    }),
  };
}

export function validatePickupSelection(schedule: PickupScheduleInput, requestedAt: unknown, now = new Date()) {
  const availability = calculatePickupAvailability(schedule, now);
  if (requestedAt == null || requestedAt === "") {
    if (!availability.immediateAvailable) throw new Error("PICKUP_TIME_REQUIRED");
    return { pickupAt: now, mode: "immediate" as const, availability };
  }
  if (!(requestedAt instanceof Date) && typeof requestedAt !== "string") throw new Error("PICKUP_TIME_INVALID");
  const requested = requestedAt instanceof Date ? requestedAt : new Date(requestedAt);
  if (Number.isNaN(requested.getTime()) || !availability.slots.some(slot => slot.at === requested.toISOString())) throw new Error("PICKUP_TIME_UNAVAILABLE");
  return { pickupAt: requested, mode: "scheduled" as const, availability };
}

/** Return the authoritative store-hours window containing a validated pickup. */
export function pickupOperatingWindow(schedule: PickupScheduleInput, pickupAt: Date): { opensAt: Date; closesAt: Date } {
  const localDate = dateKey(localParts(pickupAt, schedule.timeZone));
  for (const date of [addDate(localDate, -1), localDate]) {
    for (const interval of intervalsForDate(schedule, date)) {
      const window = intervalInstants(schedule, date, interval);
      if (window && window.opensAt <= pickupAt && pickupAt < window.closesAt) return window;
    }
  }
  throw new Error("PICKUP_TIME_UNAVAILABLE");
}

export async function loadPickupSchedule(tenantId: number, locationId: number): Promise<PickupScheduleInput & { updatedAt: Date }> {
  const [row] = await db.select().from(locationPickupSchedulesTable).where(and(eq(locationPickupSchedulesTable.tenantId, tenantId), eq(locationPickupSchedulesTable.locationId, locationId))).limit(1);
  if (!row) throw new Error("PICKUP_SCHEDULE_UNAVAILABLE");
  const parsed = pickupScheduleInputSchema.parse({ timeZone: row.timeZone, weeklyHours: row.weeklyHours, exceptions: row.exceptions, slotMinutes: row.slotMinutes, maxAdvanceDays: row.maxAdvanceDays, version: row.version });
  return { ...parsed, updatedAt: row.updatedAt };
}

export async function resolvePickupLocation(tenantId: number, requestedLocationId?: number | null) {
  const locations = await db.select({ id: inventoryLocationsTable.id, name: inventoryLocationsTable.name }).from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.type, "storefront"), eq(inventoryLocationsTable.isActive, true)));
  if (requestedLocationId != null) {
    const selected = locations.find(location => location.id === requestedLocationId);
    if (!selected) throw new Error("PICKUP_LOCATION_UNAVAILABLE");
    return selected;
  }
  if (locations.length !== 1) throw new Error(locations.length ? "PICKUP_LOCATION_REQUIRED" : "PICKUP_LOCATION_UNAVAILABLE");
  return locations[0];
}

export function pickupScheduleSnapshot(schedule: PickupScheduleInput & { updatedAt: Date }, location: { id: number; name: string }, selection: ReturnType<typeof validatePickupSelection>) {
  return { schemaVersion: 1, locationId: location.id, locationName: location.name, timeZone: schedule.timeZone, weeklyHours: structuredClone(schedule.weeklyHours), exceptions: structuredClone(schedule.exceptions), slotMinutes: schedule.slotMinutes, maxAdvanceDays: schedule.maxAdvanceDays, scheduleVersion: schedule.version, scheduleUpdatedAt: schedule.updatedAt.toISOString(), pickupAt: selection.pickupAt.toISOString(), mode: selection.mode, localLabel: localLabel(selection.pickupAt, schedule.timeZone) };
}
