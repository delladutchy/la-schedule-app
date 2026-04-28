import { DateTime } from "luxon";
import { z } from "zod";
import type { Snapshot } from "./types";
import type { Interval } from "./intervals";
import { overlapsAny } from "./intervals";

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const IsoDaySchema = z.string().regex(ISO_DAY_RE, "Expected YYYY-MM-DD");

export const GigCreateBodySchema = z.object({
  summary: z.string().trim().min(1).max(240),
  description: z.string().trim().max(4000).optional(),
  date: IsoDaySchema.optional(),
  startDate: IsoDaySchema.optional(),
  endDate: IsoDaySchema.optional(),
}).superRefine((value, ctx) => {
  const hasSingle = !!value.date;
  const hasRange = !!value.startDate || !!value.endDate;

  if (!hasSingle && !hasRange) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either date, or startDate + endDate.",
      path: ["date"],
    });
    return;
  }

  if (hasSingle && hasRange) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Use either date or startDate/endDate, not both.",
      path: ["date"],
    });
    return;
  }

  if (hasRange && (!value.startDate || !value.endDate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "startDate and endDate must both be provided.",
      path: ["startDate"],
    });
  }
});

export type GigCreateBody = z.infer<typeof GigCreateBodySchema>;

export interface ResolvedAllDayRange {
  startDate: string;
  endDateInclusive: string;
  endDateExclusive: string;
}

function parseIsoDayUtc(isoDay: string): DateTime {
  return DateTime.fromISO(isoDay, { zone: "utc" }).startOf("day");
}

export function resolveAllDayRange(input: GigCreateBody): ResolvedAllDayRange {
  const startDate = input.date ?? input.startDate;
  const endDateInclusive = input.date ?? input.endDate;
  if (!startDate || !endDateInclusive) {
    throw new Error("Invalid date payload.");
  }

  const start = parseIsoDayUtc(startDate);
  const endInclusive = parseIsoDayUtc(endDateInclusive);
  if (!start.isValid || !endInclusive.isValid) {
    throw new Error("Invalid date format. Expected YYYY-MM-DD.");
  }
  if (endInclusive < start) {
    throw new Error("endDate cannot be before startDate.");
  }

  const endExclusive = endInclusive.plus({ days: 1 }).toFormat("yyyy-LL-dd");
  return {
    startDate: start.toFormat("yyyy-LL-dd"),
    endDateInclusive: endInclusive.toFormat("yyyy-LL-dd"),
    endDateExclusive: endExclusive,
  };
}

export function buildLaJobSummary(laNumberRaw: string, jobNameRaw: string): string {
  const laNumber = laNumberRaw.trim();
  const jobName = jobNameRaw.trim();

  if (!jobName) {
    throw new Error("Job Name is required.");
  }

  if (!laNumber) {
    return jobName;
  }
  if (!/^\d+$/.test(laNumber)) {
    throw new Error("LA # must be numbers only.");
  }

  return `LA#${laNumber} — ${jobName}`;
}

export interface ParsedGigSummary {
  jobNumber?: string;
  jobName: string;
}

export function parseLaJobSummary(summaryRaw: string): ParsedGigSummary {
  const summary = summaryRaw.trim().replace(/\s+/g, " ");
  if (!summary) return { jobName: "" };

  const match = summary.match(/^\s*LA\s*#?\s*(\d{3,})\s*(?:[—–\-:|]\s*)?(.*)$/i);
  if (!match) {
    return { jobName: summary };
  }

  const digits = match[1] ?? "";
  const remainder = (match[2] ?? "").trim();
  return {
    jobNumber: `LA#${digits}`,
    jobName: remainder || summary,
  };
}

export interface ParsedGigDescription {
  callTime?: string;
  jobNotes?: string;
}

export function parseGigDescription(descriptionRaw?: string): ParsedGigDescription {
  const description = descriptionRaw?.trim();
  if (!description) return {};

  const lines = description.split(/\r?\n/).map((line) => line.trim());
  let callTime: string | undefined;
  const notesParts: string[] = [];
  const fallbackParts: string[] = [];
  let readingNotes = false;

  for (const line of lines) {
    if (!line) continue;

    const callMatch = line.match(/^Call\s*Time:\s*(.+)$/i);
    if (callMatch) {
      callTime = callMatch[1]?.trim() || undefined;
      readingNotes = false;
      continue;
    }

    const notesMatch = line.match(/^Job\s*Notes:\s*(.*)$/i);
    if (notesMatch) {
      const first = notesMatch[1]?.trim();
      if (first) notesParts.push(first);
      readingNotes = true;
      continue;
    }

    if (readingNotes) {
      notesParts.push(line);
      continue;
    }

    fallbackParts.push(line);
  }

  const jobNotes = notesParts.join("\n").trim() || fallbackParts.join("\n").trim() || undefined;
  return {
    ...(callTime ? { callTime } : {}),
    ...(jobNotes ? { jobNotes } : {}),
  };
}

export function buildGigDescription(callTimeRaw?: string, jobNotesRaw?: string): string | undefined {
  const callTime = callTimeRaw?.trim();
  const jobNotes = jobNotesRaw?.trim();
  const parts = [
    callTime ? `Call Time: ${callTime}` : "",
    jobNotes ? `Job Notes: ${jobNotes}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function busyIntervalsFromSnapshot(snapshot: Snapshot): Interval[] {
  return snapshot.busy
    .map((block) => ({
      startMs: Date.parse(block.startUtc),
      endMs: Date.parse(block.endUtc),
      tentative: block.tentative,
    }))
    .filter((interval) =>
      Number.isFinite(interval.startMs)
      && Number.isFinite(interval.endMs)
      && interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

export function isDateRangeAvailableInSnapshot(
  snapshot: Snapshot,
  timezone: string,
  startDate: string,
  endDateInclusive: string,
): boolean {
  const start = DateTime.fromISO(startDate, { zone: timezone }).startOf("day");
  const end = DateTime.fromISO(endDateInclusive, { zone: timezone }).startOf("day");
  if (!start.isValid || !end.isValid || end < start) {
    return false;
  }

  const busy = busyIntervalsFromSnapshot(snapshot);
  let day = start;
  while (day <= end) {
    const frame = {
      startMs: day.toUTC().toMillis(),
      endMs: day.plus({ days: 1 }).toUTC().toMillis(),
    };
    if (overlapsAny(frame, busy)) {
      return false;
    }
    day = day.plus({ days: 1 });
  }

  return true;
}

export function isDateRangeAvailableForEditInSnapshot(
  snapshot: Snapshot,
  timezone: string,
  startDate: string,
  endDateInclusive: string,
  opts: {
    eventId: string;
    editorCalendarId: string;
  },
): boolean {
  const start = DateTime.fromISO(startDate, { zone: timezone }).startOf("day");
  const end = DateTime.fromISO(endDateInclusive, { zone: timezone }).startOf("day");
  if (!start.isValid || !end.isValid || end < start) {
    return false;
  }

  const busy = busyIntervalsFromSnapshot(snapshot);
  const namedEvents = (snapshot.namedEvents ?? [])
    .map((event) => ({
      ...event,
      startMs: Date.parse(event.startUtc),
      endMs: Date.parse(event.endUtc),
    }))
    .filter((event) =>
      Number.isFinite(event.startMs)
      && Number.isFinite(event.endMs)
      && event.endMs > event.startMs);

  let day = start;
  while (day <= end) {
    const frame = {
      startMs: day.toUTC().toMillis(),
      endMs: day.plus({ days: 1 }).toUTC().toMillis(),
    };
    const dayHasBusy = overlapsAny(frame, busy);
    if (!dayHasBusy) {
      day = day.plus({ days: 1 });
      continue;
    }

    const dayOverlappingEvents = namedEvents.filter((event) =>
      event.startMs < frame.endMs && event.endMs > frame.startMs);

    const overlapsOtherEvent = dayOverlappingEvents.some((event) => {
      const sameEditableEvent = event.calendarId === opts.editorCalendarId
        && event.eventId === opts.eventId;
      return !sameEditableEvent;
    });
    if (overlapsOtherEvent) {
      return false;
    }

    const overlapsSelfEvent = dayOverlappingEvents.some((event) =>
      event.calendarId === opts.editorCalendarId
      && event.eventId === opts.eventId);
    if (!overlapsSelfEvent) {
      // Busy day with no attributable matching event id: fail closed.
      return false;
    }

    day = day.plus({ days: 1 });
  }

  return true;
}
