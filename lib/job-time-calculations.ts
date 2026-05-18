export interface TimeHoursResult {
  totalHours: number;
  regularHours: number;
  overtimeHours: number;
}

/**
 * Calculate total / regular / OT hours from a clock-in/out pair.
 * clockOutAt null means "still running"; nowIso is used as the end time.
 * Stored timestamps are exact; display values are rounded to nearest 0.25h.
 */
export function calculateTimeHours(
  clockInAt: string,
  clockOutAt: string | null,
  nowIso?: string,
): TimeHoursResult {
  const inMs = Date.parse(clockInAt);
  const outMs = clockOutAt
    ? Date.parse(clockOutAt)
    : Date.parse(nowIso ?? new Date().toISOString());

  const totalMs = Math.max(0, outMs - inMs);
  const totalHours = totalMs / (1000 * 60 * 60);
  const regularHours = Math.min(totalHours, 10);
  const overtimeHours = Math.max(0, totalHours - 10);

  return { totalHours, regularHours, overtimeHours };
}

/** Round to nearest 0.25h (invoice-friendly) and return a fixed-2 string. */
export function formatHoursDisplay(hours: number): string {
  const rounded = Math.round(hours * 4) / 4;
  return rounded.toFixed(2);
}

/** Format elapsed hours as h:mm:ss for the running clock display. */
export function formatElapsed(totalHours: number): string {
  const totalSeconds = Math.floor(totalHours * 3600);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
