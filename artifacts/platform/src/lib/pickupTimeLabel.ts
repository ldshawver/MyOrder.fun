/** Customer-facing pickup slot label. Uses the location time zone and a 12-hour clock. */
export function formatPickupSlotLabel(at: string, timeZone: string | null | undefined, fallback = ""): string {
  const instant = new Date(at);
  if (!timeZone || Number.isNaN(instant.getTime())) return fallback || at;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
}
