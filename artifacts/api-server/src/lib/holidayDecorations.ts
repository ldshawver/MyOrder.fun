import { db, holidayDecorationsTable, tenantsTable, tenantSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";

const dayMs = 86_400_000;
const date = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day));
const weekday = (year: number, month: number, day: number, ordinal: number) =>
  date(year, month, 1 + (day - date(year, month, 1).getUTCDay() + 7) % 7 + (ordinal - 1) * 7);

function easter(year: number): Date {
  // Gregorian computus.
  const golden = year % 19;
  const century = Math.floor(year / 100);
  const remainder = year % 100;
  const correction = Math.floor((century - Math.floor((century + 8) / 25) + 1) / 3);
  const epact = (19 * golden + century - Math.floor(century / 4) - correction + 15) % 30;
  const offset = (32 + 2 * (century % 4) + 2 * Math.floor(remainder / 4) - epact - remainder % 4) % 7;
  const adjustment = Math.floor((golden + 11 * epact + 22 * offset) / 451);
  const result = epact + offset - 7 * adjustment + 114;
  return date(year, Math.floor(result / 31), result % 31 + 1);
}

const holidays = {
  christmas: { name: "Christmas", day: (y: number) => date(y, 12, 25) },
  halloween: { name: "Halloween", day: (y: number) => date(y, 10, 31) },
  easter: { name: "Easter", day: easter },
  valentines: { name: "Valentine’s Day", day: (y: number) => date(y, 2, 14) },
  independence: { name: "Fourth of July", day: (y: number) => date(y, 7, 4) },
  memorial: { name: "Memorial Day", day: (y: number) => date(y, 5, 31 - (date(y, 5, 31).getUTCDay() + 6) % 7) },
  thanksgiving: { name: "Thanksgiving", day: (y: number) => weekday(y, 11, 4, 4) },
  newyear: { name: "New Year’s Day", day: (y: number) => date(y, 1, 1) },
  labor: { name: "Labor Day", day: (y: number) => weekday(y, 9, 1, 1) },
  juneteenth: { name: "Juneteenth", day: (y: number) => date(y, 6, 19) },
} as const;

type Holiday = keyof typeof holidays;
const ids = Object.keys(holidays) as [Holiday, ...Holiday[]];
const holiday = z.enum(ids);
export const holidayThemes = ids.map(id => ({ id, name: holidays[id].name }));
const preferences = z.object({
  automatic: z.boolean(),
  animated: z.boolean(),
  disabled: z.array(holiday).max(ids.length).refine(entries => new Set(entries).size === entries.length),
  manual: holiday.nullable(),
}).strict();
export const holidaySettingsBody = preferences.extend({ version: z.number().int().nonnegative() }).strict();
export type HolidayPreferences = z.infer<typeof preferences>;
const defaults: HolidayPreferences = { automatic: true, animated: true, disabled: [], manual: null };

export function resolveHoliday(settings: HolidayPreferences, timezone: string, now = new Date()): Holiday | null {
  if (settings.manual) return settings.manual;
  if (!settings.automatic) return null;
  let formatter: Intl.DateTimeFormat;
  const options = { year: "numeric", month: "numeric", day: "numeric" } as const;
  try {
    formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone: timezone });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "America/Los_Angeles" });
  }
  const parts = formatter.formatToParts(now);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
  const year = value("year");
  const today = date(year, value("month"), value("day")).getTime();
  let nearest = Infinity;
  let selected: Holiday | null = null;
  for (const id of ids) {
    if (settings.disabled.includes(id)) continue;
    for (const occurrenceYear of [year, year + 1]) {
      const end = holidays[id].day(occurrenceYear);
      const previousMonth = end.getUTCMonth();
      const previousMonthDays = date(occurrenceYear, previousMonth + 1, 0).getUTCDate();
      const start = date(occurrenceYear, previousMonth, Math.min(previousMonthDays, end.getUTCDate()));
      if (start.getTime() <= today && today < end.getTime() + dayMs && end.getTime() < nearest) {
        nearest = end.getTime();
        selected = id;
      }
    }
  }
  return selected;
}

export async function loadHolidaySettings(tenantId: number, executor: Pick<typeof db, "select"> = db) {
  const [row] = await executor.select({
    preferences: holidayDecorationsTable.preferences,
    version: holidayDecorationsTable.version,
    timezone: tenantSettingsTable.timezone,
  }).from(tenantsTable)
    .leftJoin(holidayDecorationsTable, eq(holidayDecorationsTable.tenantId, tenantsTable.id))
    .leftJoin(tenantSettingsTable, eq(tenantSettingsTable.tenantId, tenantsTable.id))
    .where(eq(tenantsTable.id, tenantId));
  const parsed = preferences.safeParse(row?.preferences);
  return { settings: parsed.success ? parsed.data : defaults, version: row?.version ?? 0, timezone: row?.timezone ?? "America/Los_Angeles" };
}

export async function holidayDisplay(tenantId: number) {
  const { settings, timezone } = await loadHolidaySettings(tenantId);
  return { theme: resolveHoliday(settings, timezone), animated: settings.animated };
}
