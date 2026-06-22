import "server-only";
import { google } from "googleapis";
import { DateTime } from "luxon";
import { getConfig } from "./config";
import { buildCalendarAuth } from "./google";
import { parseLaJobSummary, enumerateIsoDatesInRange, parseGigDescription } from "./gigs";
import { getSupabaseServerClient } from "./supabase";
import type { InvoiceStatus } from "./invoice-types";

export interface WorklistEntry {
  eventId: string;
  /** Raw Google Calendar summary, e.g. "LA#1234 — Some Job" */
  summary: string;
  /** Parsed job name (part after LA# prefix, or full summary) */
  gigName: string;
  /** "LA#1234" or null for non-LA events */
  laJobNumber: string | null;
  /** YYYY-MM-DD — first day of the job */
  startDate: string;
  /** YYYY-MM-DD — last day of the job (inclusive) */
  endDate: string;
  /** All work dates in range (start–end inclusive). Used as workDates for InvoiceSection. */
  workDates: string[];
  /** Calendar event location, if set */
  location: string | null;
  /**
   * UTC ISO string of the event's scheduled START time.
   * null for all-day events (which have no specific wall-clock time).
   * Used to seed the default Start time in invoice workday rows.
   */
  startTimeUtc: string | null;
  /**
   * UTC ISO string of the event's scheduled END time.
   * null for all-day events or when no end time is set.
   * Used to seed the default End time in invoice workday rows.
   */
  endTimeUtc: string | null;
  /**
   * callTime value from the app-owned JSON block in the event description,
   * e.g. "6:00 AM". Only populated for all-day/date-only events where
   * startTimeUtc is null. Used as the Start-time default for invoice workday
   * rows when no dateTime is available from the calendar event itself.
   */
  callTimeDefault: string | null;
  /** Invoice status from Supabase (defaults to "none" if no invoice_data row exists) */
  invoiceStatus: InvoiceStatus;
  invoiceNumber: string | null;
  invoiceTotal: number | null;
  invoicePdfUrl: string | null;
  amountPaid: number;
  remainingBalance: number | null;
}

/**
 * Fetch all gig events from the LA Google Calendar for the given UTC-ms window,
 * then merge with Supabase invoice_data to produce a combined worklist.
 *
 * Returned list is sorted newest-first (descending startDate).
 */
export async function listWorklistEntries(opts: {
  timeMinMs: number;
  timeMaxMs: number;
}): Promise<WorklistEntry[]> {
  const { file, env } = getConfig();
  const tz = file.timezone;
  const laCalendarId = env.GOOGLE_CALENDAR_ID;

  // ── Fetch calendar events ─────────────────────────────────────────────────
  const auth = buildCalendarAuth({
    clientId:     env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_REFRESH_TOKEN,
  });
  const calendar = google.calendar({ version: "v3", auth });

  const rawEvents: Array<{
    eventId: string;
    summary: string;
    startMs: number;
    endMs: number;
    location: string | null;
    /** UTC ISO string of the event start time; null for all-day events. */
    startTimeUtc: string | null;
    /** UTC ISO string of the event end time; null for all-day events. */
    endTimeUtc: string | null;
    /** callTime from app-owned description block; only set for all-day events. */
    callTimeDefault: string | null;
  }> = [];

  const TIME_CHUNK_MS = 60 * 24 * 60 * 60 * 1000; // 60-day chunks
  let chunkStart = opts.timeMinMs;
  while (chunkStart < opts.timeMaxMs) {
    const chunkEnd = Math.min(chunkStart + TIME_CHUNK_MS, opts.timeMaxMs);
    let pageToken: string | undefined;
    do {
      const resp = await calendar.events.list({
        calendarId:   laCalendarId,
        timeMin:      new Date(chunkStart).toISOString(),
        timeMax:      new Date(chunkEnd).toISOString(),
        singleEvents: true,
        orderBy:      "startTime",
        maxResults:   2500,
        pageToken,
        timeZone:     tz,
        fields:       "items(id,status,transparency,summary,location,description,start(date,dateTime),end(date,dateTime)),nextPageToken",
      });

      for (const item of resp.data.items ?? []) {
        if (item.status === "cancelled") continue;
        if (item.transparency === "transparent") continue;
        if (!item.id) continue;

        const startMs = parseBoundaryMs(item.start, tz);
        const endMs   = parseBoundaryMs(item.end, tz);
        if (startMs == null || endMs == null || endMs <= startMs) continue;

        // Track whether this is a timed event (has dateTime) or all-day (date only).
        // All-day events have no meaningful wall-clock time — use null so
        // InvoiceSection doesn't default workday rows to "12:00 AM".
        const startTimeUtc = item.start?.dateTime
          ? new Date(startMs).toISOString()
          : null;
        const endTimeUtc = item.end?.dateTime
          ? new Date(endMs).toISOString()
          : null;

        // For all-day events only: parse the app-owned description block to
        // extract callTime (e.g. "6:00 AM") as a start-time default for invoice
        // workday rows. Timed events already provide startTimeUtc for this purpose.
        const callTimeDefault = startTimeUtc == null && item.description
          ? (parseGigDescription(item.description).callTime ?? null)
          : null;

        rawEvents.push({
          eventId:  item.id,
          summary:  (item.summary ?? "").trim() || "Untitled",
          startMs,
          endMs,
          location: (item.location ?? "").trim() || null,
          startTimeUtc,
          endTimeUtc,
          callTimeDefault,
        });
      }
      pageToken = resp.data.nextPageToken ?? undefined;
    } while (pageToken);
    chunkStart = chunkEnd;
  }

  if (rawEvents.length === 0) return [];

  // ── Fetch invoice_data for these events from Supabase ────────────────────
  const eventIds = rawEvents.map((e) => e.eventId);
  const client = getSupabaseServerClient();
  const { data: invoiceRows, error } = await client
    .from("invoice_data")
    .select("google_event_id,invoice_number,invoice_status,invoice_total,invoice_pdf_url,amount_paid,remaining_balance")
    .in("google_event_id", eventIds);
  if (error) {
    console.error("[invoice-worklist] supabase select failed:", error.message);
  }

  const invoiceByEventId = new Map<string, {
    invoice_number: string | null;
    invoice_status: InvoiceStatus;
    invoice_total:  number | null;
    invoice_pdf_url: string | null;
    amount_paid:    number;
    remaining_balance: number | null;
  }>();
  for (const row of (invoiceRows ?? []) as Record<string, unknown>[]) {
    const id = String(row.google_event_id ?? "");
    if (!id) continue;
    invoiceByEventId.set(id, {
      invoice_number:   row.invoice_number   != null ? String(row.invoice_number)   : null,
      invoice_status:   (row.invoice_status  as InvoiceStatus) ?? "none",
      invoice_total:    row.invoice_total    != null ? Number(row.invoice_total)    : null,
      invoice_pdf_url:  row.invoice_pdf_url  != null ? String(row.invoice_pdf_url)  : null,
      amount_paid:      Number(row.amount_paid ?? 0),
      remaining_balance: row.remaining_balance != null ? Number(row.remaining_balance) : null,
    });
  }

  // ── Build WorklistEntry[] ─────────────────────────────────────────────────
  const entries: WorklistEntry[] = rawEvents.map((ev) => {
    const parsed    = parseLaJobSummary(ev.summary);
    const startDate = DateTime.fromMillis(ev.startMs, { zone: tz }).toFormat("yyyy-LL-dd");
    // endMs is exclusive (start of day after last day)
    const endDate   = DateTime.fromMillis(ev.endMs, { zone: tz }).minus({ days: 1 }).toFormat("yyyy-LL-dd");
    const workDates = enumerateIsoDatesInRange(startDate, endDate);
    const inv       = invoiceByEventId.get(ev.eventId);

    return {
      eventId:          ev.eventId,
      summary:          ev.summary,
      gigName:          parsed.jobName || ev.summary,
      laJobNumber:      parsed.jobNumber ?? null,
      startDate,
      endDate,
      workDates,
      location:         ev.location,
      startTimeUtc:     ev.startTimeUtc,
      endTimeUtc:       ev.endTimeUtc,
      invoiceStatus:    inv?.invoice_status   ?? "none",
      invoiceNumber:    inv?.invoice_number   ?? null,
      invoiceTotal:     inv?.invoice_total    ?? null,
      invoicePdfUrl:    inv?.invoice_pdf_url  ?? null,
      amountPaid:       inv?.amount_paid      ?? 0,
      remainingBalance: inv?.remaining_balance ?? null,
      callTimeDefault:  ev.callTimeDefault,
    };
  });

  const dedupedEntries = dedupeWorklistEntries(entries);

  // Newest first
  dedupedEntries.sort((a, b) => b.startDate.localeCompare(a.startDate));
  return dedupedEntries;
}

// ── Pure helpers (exported for testing) ──────────────────────────────────────

/**
 * Collapse duplicate Calendar events that represent the same LA job/invoice.
 *
 * Google Calendar can contain duplicate events with different event IDs but the
 * same LA job number. The invoice worklist is invoice-centric, so LA# is the
 * stable client/job key. If any duplicate already has invoice_data, keep that
 * event ID so opening the row preserves existing invoice state.
 */
export function dedupeWorklistEntries(entries: WorklistEntry[]): WorklistEntry[] {
  const byKey = new Map<string, WorklistEntry[]>();
  const passthrough: WorklistEntry[] = [];

  for (const entry of entries) {
    const key = worklistInvoiceKey(entry);
    if (!key) {
      passthrough.push(entry);
      continue;
    }
    const group = byKey.get(key) ?? [];
    group.push(entry);
    byKey.set(key, group);
  }

  const deduped: WorklistEntry[] = [...passthrough];
  for (const group of byKey.values()) {
    if (group.length === 1) {
      deduped.push(group[0]!);
      continue;
    }

    const primary = chooseCanonicalWorklistEntry(group);
    const startDate = group.reduce(
      (min, entry) => entry.startDate < min ? entry.startDate : min,
      primary.startDate,
    );
    const endDate = group.reduce(
      (max, entry) => entry.endDate > max ? entry.endDate : max,
      primary.endDate,
    );
    const startTimeUtc = chooseEarliestUtc(group.map((entry) => entry.startTimeUtc));
    const endTimeUtc = chooseLatestUtc(group.map((entry) => entry.endTimeUtc));

    deduped.push({
      ...primary,
      startDate,
      endDate,
      workDates: enumerateIsoDatesInRange(startDate, endDate),
      location: primary.location ?? group.find((entry) => entry.location)?.location ?? null,
      startTimeUtc: startTimeUtc ?? primary.startTimeUtc,
      endTimeUtc: endTimeUtc ?? primary.endTimeUtc,
      callTimeDefault: primary.callTimeDefault ?? group.find((e) => e.callTimeDefault)?.callTimeDefault ?? null,
    });
  }

  return deduped;
}

function worklistInvoiceKey(entry: WorklistEntry): string | null {
  const laDigits = entry.laJobNumber?.replace(/\D/g, "") ?? "";
  if (laDigits) return `la:${laDigits}`;
  return null;
}

function chooseCanonicalWorklistEntry(entries: WorklistEntry[]): WorklistEntry {
  return [...entries].sort((a, b) => {
    const invoiceRankDelta = invoiceDataRank(b) - invoiceDataRank(a);
    if (invoiceRankDelta !== 0) return invoiceRankDelta;

    const statusRankDelta = invoiceStatusRank(b.invoiceStatus) - invoiceStatusRank(a.invoiceStatus);
    if (statusRankDelta !== 0) return statusRankDelta;

    const dateDelta = a.startDate.localeCompare(b.startDate);
    if (dateDelta !== 0) return dateDelta;

    return a.eventId.localeCompare(b.eventId);
  })[0]!;
}

function invoiceDataRank(entry: WorklistEntry): number {
  let rank = 0;
  if (entry.invoiceNumber) rank += 100;
  if (entry.invoicePdfUrl) rank += 40;
  if (entry.invoiceTotal != null) rank += 30;
  if (entry.amountPaid > 0) rank += 20;
  if (entry.remainingBalance != null) rank += 10;
  return rank;
}

function invoiceStatusRank(status: InvoiceStatus): number {
  switch (status) {
    case "paid": return 60;
    case "partially_paid": return 50;
    case "sent": return 40;
    case "sheet_synced": return 30;
    case "draft_created": return 20;
    case "ready": return 10;
    case "none": return 0;
    case "void": return -10;
    default: return 0;
  }
}

function chooseEarliestUtc(values: Array<string | null>): string | null {
  let best: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms >= bestMs) continue;
    best = value;
    bestMs = ms;
  }
  return best;
}

function chooseLatestUtc(values: Array<string | null>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms <= bestMs) continue;
    best = value;
    bestMs = ms;
  }
  return best;
}

/**
 * Returns true when the entry matches the given search term.
 * Matches: LA#, gig name, startDate, endDate, invoice#.
 */
export function worklistEntryMatchesSearch(entry: WorklistEntry, term: string): boolean {
  if (!term.trim()) return true;
  const q = term.trim().toLowerCase();
  const la = (entry.laJobNumber ?? "").toLowerCase();
  const name = entry.gigName.toLowerCase();
  const summary = entry.summary.toLowerCase();
  const inv = (entry.invoiceNumber ?? "").toLowerCase();
  return (
    la.includes(q) ||
    name.includes(q) ||
    summary.includes(q) ||
    inv.includes(q) ||
    entry.startDate.includes(q) ||
    entry.endDate.includes(q)
  );
}

export type WorklistFilter = "all" | "none" | "draft" | "sent" | "paid";

/**
 * Returns true when the entry matches the given filter tab.
 */
export function worklistEntryMatchesFilter(entry: WorklistEntry, filter: WorklistFilter): boolean {
  if (filter === "all") return true;
  if (filter === "none") return entry.invoiceStatus === "none" || entry.invoiceStatus === "ready";
  if (filter === "draft") return entry.invoiceStatus === "draft_created" || entry.invoiceStatus === "sheet_synced";
  if (filter === "sent") return entry.invoiceStatus === "sent" || entry.invoiceStatus === "partially_paid";
  if (filter === "paid") return entry.invoiceStatus === "paid";
  return true;
}

/**
 * Returns true if the job is a past job (endDate is before today) and today
 * is NOT one of the work dates. When true, clock-in should be disabled.
 */
export function isClockInDisabled(workDates: string[], todayIso: string): boolean {
  return !workDates.includes(todayIso);
}

// ── Private helpers ───────────────────────────────────────────────────────────

function parseBoundaryMs(
  boundary: { date?: string | null; dateTime?: string | null } | null | undefined,
  displayTimezone: string,
): number | null {
  if (!boundary) return null;
  if (boundary.dateTime) {
    const ms = Date.parse(boundary.dateTime);
    return Number.isFinite(ms) ? ms : null;
  }
  if (boundary.date) {
    const dt = DateTime.fromISO(boundary.date, { zone: displayTimezone }).startOf("day");
    return dt.isValid ? dt.toUTC().toMillis() : null;
  }
  return null;
}
