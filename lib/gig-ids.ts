import { createHash } from "node:crypto";

export function buildAllDayGigEventId(
  calendarId: string,
  startDate: string,
  endDateInclusive: string,
): string {
  const digest = createHash("sha256")
    .update(`${calendarId}|${startDate}|${endDateInclusive}`)
    .digest("hex")
    .slice(0, 40);
  return `g${digest}`;
}
