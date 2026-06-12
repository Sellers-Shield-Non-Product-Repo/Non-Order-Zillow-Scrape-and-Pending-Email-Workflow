/**
 * Pick a random Date in the next `windowHours` whose local hour in `tz`
 * falls in the [startHour, endHour) range. Used to spread out email-triggering
 * Zoho field updates across business hours (default 8am–6pm Central).
 */
export function pickBusinessHourDate(opts: {
  windowHours?: number;
  tz?: string;
  startHour?: number;
  endHour?: number;
} = {}): Date {
  const windowHours = opts.windowHours ?? 48;
  const tz = opts.tz ?? "America/Chicago";
  const startHour = opts.startHour ?? 8;
  const endHour = opts.endHour ?? 18;

  const now = Date.now();
  const windowMs = windowHours * 3600 * 1000;
  const hourFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  });

  for (let i = 0; i < 200; i++) {
    const candidate = new Date(now + Math.random() * windowMs);
    // "24" can appear for midnight in some locales — normalize to 0
    const rawHour = hourFmt.format(candidate);
    const hour = Number(rawHour) % 24;
    if (hour >= startHour && hour < endHour) {
      return candidate;
    }
  }

  // Extremely unlikely fallback: schedule at startHour tomorrow in tz
  return new Date(now + 24 * 3600 * 1000);
}
