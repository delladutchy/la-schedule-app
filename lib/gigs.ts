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
  bookingMode: z.enum(["la", "overture"]).optional(),
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
  jobTitle?: string;
  jobNotes?: string;
  dayDetails?: Record<string, {
    startTime?: string;
    notes?: string;
  }>;
}

export const APP_DAILY_DETAILS_BLOCK_START = "--- LA SCHEDULE APP DAILY DETAILS START ---";
export const APP_DAILY_DETAILS_BLOCK_END = "--- LA SCHEDULE APP DAILY DETAILS END ---";

interface ParsedDescriptionBlock {
  humanDescription: string;
  blockPayloadRaw: string | null;
  hasWellFormedBlock: boolean;
  hasMalformedBlock: boolean;
}

function parseDescriptionBlock(descriptionRaw?: string): ParsedDescriptionBlock {
  const description = descriptionRaw ?? "";
  const startIndex = description.indexOf(APP_DAILY_DETAILS_BLOCK_START);
  if (startIndex < 0) {
    return {
      humanDescription: description,
      blockPayloadRaw: null,
      hasWellFormedBlock: false,
      hasMalformedBlock: false,
    };
  }

  const endIndex = description.indexOf(
    APP_DAILY_DETAILS_BLOCK_END,
    startIndex + APP_DAILY_DETAILS_BLOCK_START.length,
  );
  if (endIndex < 0) {
    return {
      humanDescription: description,
      blockPayloadRaw: null,
      hasWellFormedBlock: false,
      hasMalformedBlock: true,
    };
  }

  const blockStartContentIndex = startIndex + APP_DAILY_DETAILS_BLOCK_START.length;
  const blockPayloadRaw = description
    .slice(blockStartContentIndex, endIndex)
    .replace(/^\s*\n?/, "")
    .replace(/\n?\s*$/, "");

  const before = description.slice(0, startIndex);
  const after = description.slice(endIndex + APP_DAILY_DETAILS_BLOCK_END.length);
  const humanDescription = `${before}${after}`
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");

  return {
    humanDescription,
    blockPayloadRaw,
    hasWellFormedBlock: true,
    hasMalformedBlock: false,
  };
}

function parseLegacyGigDescription(descriptionRaw?: string): ParsedGigDescription {
  const description = descriptionRaw?.trim();
  if (!description) return {};

  const lines = description.split(/\r?\n/).map((line) => line.trim());
  let callTime: string | undefined;
  const notesParts: string[] = [];
  const fallbackParts: string[] = [];
  let readingNotes = false;
  let readingDailyDetails = false;
  const dayDetails: Record<string, { startTime?: string; notes?: string }> = {};

  const parseDailyDetailsLine = (line: string): void => {
    // Format: `- YYYY-MM-DD | Start: 8:00 AM | Notes: ...`
    const normalized = line.replace(/^-+\s*/, "");
    const [datePartRaw, ...segments] = normalized.split("|").map((part) => part.trim());
    if (!datePartRaw || !/^\d{4}-\d{2}-\d{2}$/.test(datePartRaw)) return;

    let startTime: string | undefined;
    let notes: string | undefined;
    for (const segment of segments) {
      const startMatch = segment.match(/^Start:\s*(.+)$/i);
      if (startMatch?.[1]) {
        startTime = startMatch[1].trim() || undefined;
        continue;
      }
      const notesMatch = segment.match(/^Notes:\s*(.+)$/i);
      if (notesMatch?.[1]) {
        notes = notesMatch[1].trim() || undefined;
      }
    }

    dayDetails[datePartRaw] = {
      ...(startTime ? { startTime } : {}),
      ...(notes ? { notes } : {}),
    };
  };

  for (const line of lines) {
    if (!line) continue;

    const callMatch = line.match(/^Call\s*Time:\s*(.+)$/i);
    if (callMatch) {
      callTime = callMatch[1]?.trim() || undefined;
      readingNotes = false;
      continue;
    }

    if (/^Daily\s*Details:\s*$/i.test(line)) {
      readingDailyDetails = true;
      readingNotes = false;
      continue;
    }

    if (readingDailyDetails) {
      parseDailyDetailsLine(line);
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
    ...(Object.keys(dayDetails).length > 0 ? { dayDetails } : {}),
  };
}

export function parseGigDescription(descriptionRaw?: string): ParsedGigDescription {
  const block = parseDescriptionBlock(descriptionRaw);
  if (block.hasWellFormedBlock && block.blockPayloadRaw) {
    try {
      const parsedJson = JSON.parse(block.blockPayloadRaw) as {
        callTime?: unknown;
        jobTitle?: unknown;
        jobNotes?: unknown;
        dayDetails?: unknown;
      };
      const dayDetails: ParsedGigDescription["dayDetails"] = {};
      if (parsedJson.dayDetails && typeof parsedJson.dayDetails === "object") {
        for (const [date, value] of Object.entries(parsedJson.dayDetails as Record<string, unknown>)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
          if (!value || typeof value !== "object") continue;
          const row = value as { startTime?: unknown; notes?: unknown };
          const startTime = typeof row.startTime === "string" ? row.startTime.trim() : "";
          const notes = typeof row.notes === "string" ? row.notes.trim() : "";
          if (!startTime && !notes) continue;
          dayDetails[date] = {
            ...(startTime ? { startTime } : {}),
            ...(notes ? { notes } : {}),
          };
        }
      }
      const callTime = typeof parsedJson.callTime === "string" ? parsedJson.callTime.trim() : "";
      const jobTitle = typeof parsedJson.jobTitle === "string" ? parsedJson.jobTitle.trim() : "";
      const jobNotes = typeof parsedJson.jobNotes === "string" ? parsedJson.jobNotes.trim() : "";
      return {
        ...(callTime ? { callTime } : {}),
        ...(jobTitle ? { jobTitle } : {}),
        ...(jobNotes ? { jobNotes } : {}),
        ...(Object.keys(dayDetails).length > 0 ? { dayDetails } : {}),
      };
    } catch {
      // Malformed app block payload: keep backward-compatible rendering by
      // parsing the full description as legacy human text.
      return parseLegacyGigDescription(descriptionRaw);
    }
  }

  return parseLegacyGigDescription(descriptionRaw);
}

export function resolveParsedGigDetailForDate(
  parsed: ParsedGigDescription,
  date: string,
): { startTime?: string; notes?: string } {
  const dayDetail = parsed.dayDetails?.[date];
  return {
    ...(dayDetail?.startTime ? { startTime: dayDetail.startTime } : parsed.callTime ? { startTime: parsed.callTime } : {}),
    ...(dayDetail?.notes ? { notes: dayDetail.notes } : parsed.jobNotes ? { notes: parsed.jobNotes } : {}),
  };
}

export interface GigDayDetail {
  date: string;
  startTime?: string;
  notes?: string;
}

export interface GigDayDetailOverride {
  date: string;
  startTime?: string;
  notes?: string;
}

export interface GigDailyDetailsMetadata {
  callTime?: string;
  jobTitle?: string;
  jobNotes?: string;
  dayDetails?: GigDayDetail[];
}

export function enumerateIsoDatesInRange(
  startDate: string,
  endDateInclusive: string,
): string[] {
  const start = DateTime.fromISO(startDate, { zone: "utc" }).startOf("day");
  const end = DateTime.fromISO(endDateInclusive, { zone: "utc" }).startOf("day");
  if (!start.isValid || !end.isValid || end < start) {
    return [];
  }

  const out: string[] = [];
  let day = start;
  while (day <= end) {
    out.push(day.toFormat("yyyy-LL-dd"));
    day = day.plus({ days: 1 });
  }
  return out;
}

export function buildGigDayDetailsForRange(opts: {
  startDate: string;
  endDateInclusive: string;
  defaultStartTime?: string;
  defaultNotes?: string;
  overrides?: GigDayDetailOverride[];
}): GigDayDetail[] {
  const dates = enumerateIsoDatesInRange(opts.startDate, opts.endDateInclusive);
  const defaultStartTime = opts.defaultStartTime?.trim();
  const defaultNotes = opts.defaultNotes?.trim();
  const overrideByDate = new Map<string, GigDayDetailOverride>();
  for (const override of opts.overrides ?? []) {
    const date = override.date.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    overrideByDate.set(date, {
      date,
      ...(override.startTime?.trim() ? { startTime: override.startTime.trim() } : {}),
      ...(override.notes?.trim() ? { notes: override.notes.trim() } : {}),
    });
  }

  return dates.map((date) => {
    const override = overrideByDate.get(date);
    return {
      date,
      ...(override?.startTime
        ? { startTime: override.startTime }
        : defaultStartTime
          ? { startTime: defaultStartTime }
          : {}),
      ...(override?.notes
        ? { notes: override.notes }
        : defaultNotes
          ? { notes: defaultNotes }
          : {}),
    };
  });
}

export function buildGigDescription(
  callTimeRaw?: string,
  jobNotesRaw?: string,
  dayDetails: GigDayDetail[] = [],
  jobTitleRaw?: string,
): string | undefined {
  const callTime = callTimeRaw?.trim();
  const jobTitle = jobTitleRaw?.trim();
  const jobNotes = jobNotesRaw?.trim();
  const normalizedDayDetails = dayDetails
    .map((detail) => ({
      date: detail.date.trim(),
      startTime: detail.startTime?.trim(),
      notes: detail.notes?.trim().replace(/\s+/g, " "),
    }))
    .filter((detail) =>
      /^\d{4}-\d{2}-\d{2}$/.test(detail.date)
      && (!!detail.startTime || !!detail.notes));
  const normalizedDetailsObject = normalizedDayDetails.reduce<Record<string, { startTime?: string; notes?: string }>>(
    (acc, detail) => {
      acc[detail.date] = {
        ...(detail.startTime ? { startTime: detail.startTime } : {}),
        ...(detail.notes ? { notes: detail.notes } : {}),
      };
      return acc;
    },
    {},
  );

  const payload = {
    ...(callTime ? { callTime } : {}),
    ...(jobTitle ? { jobTitle } : {}),
    ...(jobNotes ? { jobNotes } : {}),
    ...(Object.keys(normalizedDetailsObject).length > 0 ? { dayDetails: normalizedDetailsObject } : {}),
  };
  if (Object.keys(payload).length === 0) return undefined;
  return [
    APP_DAILY_DETAILS_BLOCK_START,
    JSON.stringify(payload, null, 2),
    APP_DAILY_DETAILS_BLOCK_END,
  ].join("\n");
}

export function mergeGigDescriptionWithDailyDetailsBlock(
  existingDescriptionRaw: string | undefined,
  metadata: GigDailyDetailsMetadata,
): string | undefined {
  const existingDescription = existingDescriptionRaw ?? "";
  const nextBlock = buildGigDescription(
    metadata.callTime,
    metadata.jobNotes,
    metadata.dayDetails ?? [],
    metadata.jobTitle,
  );
  const parsed = parseDescriptionBlock(existingDescription);

  if (!nextBlock) {
    if (!parsed.hasWellFormedBlock) {
      const asIs = existingDescription.length > 0 ? existingDescription : undefined;
      return asIs;
    }
    // Remove only the app-owned block, preserve all human text.
    return parsed.humanDescription.length > 0 ? parsed.humanDescription : undefined;
  }

  if (parsed.hasWellFormedBlock) {
    const startIndex = existingDescription.indexOf(APP_DAILY_DETAILS_BLOCK_START);
    const endIndex = existingDescription.indexOf(
      APP_DAILY_DETAILS_BLOCK_END,
      startIndex + APP_DAILY_DETAILS_BLOCK_START.length,
    );
    if (startIndex >= 0 && endIndex >= 0) {
      const blockEnd = endIndex + APP_DAILY_DETAILS_BLOCK_END.length;
      const before = existingDescription.slice(0, startIndex);
      const after = existingDescription.slice(blockEnd);
      const glue = before.endsWith("\n") || before.length === 0 ? "" : "\n";
      const suffixGlue = after.startsWith("\n") || after.length === 0 ? "" : "\n";
      return `${before}${glue}${nextBlock}${suffixGlue}${after}`;
    }
  }

  // No replaceable block (or malformed): preserve original verbatim and append.
  if (!existingDescription) return nextBlock;
  const separator = existingDescription.endsWith("\n") ? "\n" : "\n\n";
  return `${existingDescription}${separator}${nextBlock}`;
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
