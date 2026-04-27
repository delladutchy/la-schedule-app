/**
 * Domain types for the availability system.
 *
 * Data flow:
 *   Google FreeBusy + Events  ──►  BusyInterval[] + NamedEvent[]
 *                                 ──► normalized + merged  ──► Snapshot
 *                                                                  │
 *                                                                  ▼
 *                                                        Public/internal rendering
 *
 * All timestamps in the snapshot are stored as ISO-8601 strings in UTC.
 * Rendering converts to the display timezone at the edge.
 */

import { z } from "zod";

export const CalendarDisplayModeSchema = z.enum(["details", "private"]);
export type CalendarDisplayMode = z.infer<typeof CalendarDisplayModeSchema>;

// ---------- Snapshot (what lives in Netlify Blobs) ----------

export const SnapshotStatusSchema = z.enum(["ok", "stale", "unavailable"]);
export type SnapshotStatus = z.infer<typeof SnapshotStatusSchema>;

/**
 * A busy block, already merged across source calendars.
 * Half-open interval [startUtc, endUtc).
 */
export const BusyBlockSchema = z.object({
  startUtc: z.string().datetime({ offset: true }),
  endUtc: z.string().datetime({ offset: true }),
  // "tentative" is optional and only populated if tentative handling is enabled.
  tentative: z.boolean().optional(),
});
export type BusyBlock = z.infer<typeof BusyBlockSchema>;

/**
 * Internal schedule details: event titles with UTC boundaries.
 *
 * Only included in snapshots when event details are successfully fetched.
 */
export const NamedEventSchema = z.object({
  startUtc: z.string().datetime({ offset: true }),
  endUtc: z.string().datetime({ offset: true }),
  summary: z.string().min(1),
  // Optional for backward compatibility with older snapshots.
  calendarId: z.string().optional(),
  // Optional for backward compatibility; defaults to "details" in view logic.
  displayMode: CalendarDisplayModeSchema.optional(),
});
export type NamedEvent = z.infer<typeof NamedEventSchema>;

export const SnapshotSchema = z.object({
  // Snapshot format version — bump if the shape changes.
  version: z.literal(1),
  // When this snapshot was produced.
  generatedAtUtc: z.string().datetime({ offset: true }),
  // Window that this snapshot covers, in UTC.
  windowStartUtc: z.string().datetime({ offset: true }),
  windowEndUtc: z.string().datetime({ offset: true }),
  // Merged busy intervals, sorted ascending, non-overlapping.
  busy: z.array(BusyBlockSchema),
  // Optional per-event summaries for internal schedule rendering.
  namedEvents: z.array(NamedEventSchema).optional(),
  // Calendars that contributed to this snapshot (by id only, never titles).
  sourceCalendarIds: z.array(z.string()),
  // Surfaces config echo so the page can display workday start/end, tz, etc.
  config: z.object({
    timezone: z.string(),
    workdayStartHour: z.number().int().min(0).max(23),
    workdayEndHour: z.number().int().min(1).max(24),
    hideWeekends: z.boolean(),
    showTentative: z.boolean(),
    pageTitle: z.string(),
    pageSubtitle: z.string().optional(),
  }),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

// ---------- Derived view model (what the page renders) ----------

/**
 * A single weekday's overall status for the employer-facing board.
 *
 * One status per day. No times, no partial-day states. Conservative:
 * if ANY blocker-calendar event (including tentative) overlaps the
 * workday window for this date, status is "booked".
 */
export interface DayStatus {
  /** YYYY-MM-DD in display timezone. */
  date: string;
  /** e.g. "Monday, Apr 21". */
  label: string;
  /** True iff this weekday is today in the display zone. */
  isToday: boolean;
  /** True for weekend marker rows (used only when weekend is "today"). */
  isWeekend: boolean;
  status: "available" | "booked";
  /** Event titles overlapping this day window (internal schedule only). */
  eventNames?: string[];
  /** Event details overlapping this day window (internal schedule only). */
  eventDetails?: DayEventDetail[];
  /** Display treatment for this booked row. */
  bookedDisplay?: "details" | "private" | "mixed";
}

export interface DayEventDetail {
  summary: string;
  startUtc: string;
  endUtc: string;
  dateRangeLabel: string;
  timeRangeLabel?: string;
  calendarId?: string;
  displayMode?: CalendarDisplayMode;
}

export interface DaySlot {
  /** Start of this slot in display timezone, ISO. */
  startIso: string;
  /** End of this slot in display timezone, ISO. */
  endIso: string;
  status: "available" | "busy" | "tentative" | "outside-hours";
}

export interface DayView {
  /** YYYY-MM-DD in display timezone. */
  date: string;
  /** Human label, e.g. "Mon, Oct 14". */
  label: string;
  /** Whether this is a weekend. */
  isWeekend: boolean;
  /** Consecutive slots across the workday (30-min granularity by default). */
  slots: DaySlot[];
  /** Summary: "Fully booked", "Mostly free", etc. */
  summary: string;
}

export interface RenderState {
  status: SnapshotStatus;
  snapshot: Snapshot | null;
  ageMinutes: number | null;
  // When status === "unavailable", the page renders the fail-closed message.
  reason?: string;
}
