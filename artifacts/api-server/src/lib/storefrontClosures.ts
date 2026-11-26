import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { z } from "zod";

const timestamp = z.string().datetime({ offset: true });
const closureWindow = z.object({
  startsAt: timestamp,
  endsAt: timestamp,
  message: z.string().trim().min(1).max(500),
}).strict().refine(entry => Date.parse(entry.startsAt) < Date.parse(entry.endsAt), {
  message: "The reopening time must be after the closing time.",
  path: ["endsAt"],
});

export const closureWindows = z.array(closureWindow).max(50).superRefine((entries, ctx) => {
  const ordered = entries.map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (Date.parse(previous.endsAt) > Date.parse(current.startsAt)) {
      ctx.addIssue({ code: "custom", path: [current.index, "startsAt"], message: "Closure periods cannot overlap." });
    }
  }
});
export const closureSettingsBody = z.object({ windows: closureWindows, version: z.number().int().min(0) }).strict();
type ClosureWindow = z.infer<typeof closureWindow>;
type Executor = Pick<typeof db, "execute">;
export const STOREFRONT_CLOSURE_LOCK = -1038174417;

export function activeStorefrontClosure(windows: ClosureWindow[], now = Date.now()): ClosureWindow | null {
  return windows.find(entry => Date.parse(entry.startsAt) <= now && now < Date.parse(entry.endsAt)) ?? null;
}

export async function loadStorefrontClosures(tenantId: number, executor: Executor = db) {
  const result = await executor.execute<{ windows: ClosureWindow[]; version: number }>(
    sql`SELECT windows, version FROM storefront_closures WHERE tenant_id = ${tenantId}`,
  );
  const row = result?.rows?.[0];
  return row ?? { windows: [], version: 0 };
}

export class StorefrontClosedError extends Error {
  constructor(readonly closure: ClosureWindow) {
    super("The store is closed");
  }
}
