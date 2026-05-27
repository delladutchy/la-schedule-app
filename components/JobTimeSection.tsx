"use client";

import { useEffect, useState } from "react";
import {
  calculateTimeHours,
  formatHoursDisplay,
  formatElapsed,
} from "@/lib/job-time-calculations";

const LIVE_CLOCK_TIMEZONE = "America/New_York";
const WORK_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface JobTimeEntry {
  id: string;
  google_event_id: string;
  la_number: string | null;
  editor_profile: string;
  work_date: string; // YYYY-MM-DD
  clock_in_at: string | null;
  clock_out_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

type SectionFetchState =
  | { status: "loading"; requestKey: string }
  | { status: "unavailable"; requestKey: string }
  | { status: "error"; requestKey: string }
  | { status: "ready"; requestKey: string };

interface Props {
  eventId: string;
  workDates: string[]; // YYYY-MM-DD, at least 1
  editorToken: string | null;
  scheduledStartTimesByWorkDate?: Record<string, string | null | undefined>;
  eventIdsByWorkDate?: Record<string, string | null | undefined>;
}

export function resolveJobTimeDisplayRows(workDates: string[], today: string): {
  isSingleDay: boolean;
  hasTodayInWorkDates: boolean;
  orderedWorkDates: string[];
  primaryLiveWorkDate: string | null;
} {
  const isSingleDay = workDates.length <= 1;
  const hasTodayInWorkDates = workDates.includes(today);
  const orderedWorkDates = !isSingleDay && hasTodayInWorkDates
    ? [today, ...workDates.filter((date) => date !== today)]
    : workDates;
  const primaryLiveWorkDate = isSingleDay
    ? (workDates[0] ?? null)
    : (hasTodayInWorkDates ? today : null);
  return { isSingleDay, hasTodayInWorkDates, orderedWorkDates, primaryLiveWorkDate };
}

function buildJobTimeRequestKey(eventId: string, workDates: string[]): string {
  return `${eventId.trim()}::${workDates.join("|")}`;
}

export function resolveScheduledStartTimeForWorkDate(
  workDate: string,
  scheduledStartTimesByWorkDate?: Record<string, string | null | undefined>,
): string | null {
  if (!scheduledStartTimesByWorkDate) return null;
  const normalizedWorkDate = normalizeWorkDate(workDate);
  if (!normalizedWorkDate) return null;
  const raw = scheduledStartTimesByWorkDate[normalizedWorkDate];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveEventIdForWorkDate(
  workDate: string,
  defaultEventId: string,
  eventIdsByWorkDate?: Record<string, string | null | undefined>,
): string {
  const normalizedWorkDate = normalizeWorkDate(workDate);
  if (!normalizedWorkDate || !eventIdsByWorkDate) return defaultEventId.trim();
  const mapped = eventIdsByWorkDate[normalizedWorkDate];
  if (typeof mapped !== "string") return defaultEventId.trim();
  const trimmed = mapped.trim();
  return trimmed.length > 0 ? trimmed : defaultEventId.trim();
}

function buildFetchEventIds(
  defaultEventId: string,
  workDates: string[],
  eventIdsByWorkDate?: Record<string, string | null | undefined>,
): string[] {
  const ids = new Set<string>();
  const fallback = defaultEventId.trim();
  if (fallback) ids.add(fallback);
  for (const workDate of workDates) {
    const mapped = resolveEventIdForWorkDate(workDate, fallback, eventIdsByWorkDate).trim();
    if (mapped) ids.add(mapped);
  }
  return [...ids];
}

export function parseScheduledStartTimeToHHMM(rawStartTime: string | null | undefined): string {
  if (!rawStartTime) return "";
  const trimmed = rawStartTime.trim();
  if (!trimmed) return "";

  const twentyFourHourMatch = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  if (twentyFourHourMatch) {
    const hours = Number(twentyFourHourMatch[1] ?? 0);
    const minutes = Number(twentyFourHourMatch[2] ?? 0);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  const twelveHourMatch = /^(\d{1,2})(?::([0-5]\d))?\s*([AaPp][Mm])$/.exec(trimmed);
  if (!twelveHourMatch) return "";

  const rawHours = Number(twelveHourMatch[1] ?? 0);
  const rawMinutes = Number(twelveHourMatch[2] ?? "00");
  const meridiem = (twelveHourMatch[3] ?? "").toUpperCase();
  if (!Number.isFinite(rawHours) || rawHours < 1 || rawHours > 12) return "";
  if (!Number.isFinite(rawMinutes) || rawMinutes < 0 || rawMinutes > 59) return "";

  let hours24 = rawHours % 12;
  if (meridiem === "PM") hours24 += 12;
  return `${String(hours24).padStart(2, "0")}:${String(rawMinutes).padStart(2, "0")}`;
}

export function resolveEditFormDefaults(
  entry: JobTimeEntry | null,
  scheduledStartTime: string | null | undefined,
): { inTime: string; outTime: string } {
  if (entry?.clock_in_at) {
    return {
      inTime: isoToLocalHHMM(entry.clock_in_at),
      outTime: entry.clock_out_at ? isoToLocalHHMM(entry.clock_out_at) : "",
    };
  }
  return {
    inTime: parseScheduledStartTimeToHHMM(scheduledStartTime),
    outTime: "",
  };
}

interface RowControlState {
  showClockIn: boolean;
  showClockOut: boolean;
  showEditTimes: boolean;
  showClear: boolean;
}

export function buildClockMutationPayload(
  eventId: string,
  workDate: string,
  entry: JobTimeEntry | null,
): { eventId: string; workDate: string; entryId?: string } {
  const payload: { eventId: string; workDate: string; entryId?: string } = {
    eventId,
    workDate,
  };
  const entryId = entry?.id?.trim();
  if (entryId) payload.entryId = entryId;
  return payload;
}

export function resolveRowControlState(
  entry: JobTimeEntry | null,
  allowClockInWhenEmpty: boolean,
): RowControlState {
  const hasClockIn = !!entry?.clock_in_at;
  const isRunning = hasClockIn && !entry?.clock_out_at;
  return {
    showClockIn: !hasClockIn && allowClockInWhenEmpty,
    showClockOut: isRunning,
    showEditTimes: true,
    showClear: !!entry,
  };
}

export function resolveRowInitialEntry(
  initialEntry: JobTimeEntry | null,
  eventId: string,
  workDate: string,
): JobTimeEntry | null {
  const normalizedWorkDate = normalizeWorkDate(workDate);
  if (!initialEntry || !normalizedWorkDate) return null;
  return isEntryForWorkDate(initialEntry, eventId.trim(), normalizedWorkDate)
    ? initialEntry
    : null;
}

export function buildEntriesMapFromResponse(entries: JobTimeEntry[]): Map<string, JobTimeEntry> {
  const map = new Map<string, JobTimeEntry>();
  for (const entry of entries) {
    const normalized = normalizeWorkDate(entry.work_date);
    if (!normalized) continue;
    map.set(normalized, { ...entry, work_date: normalized });
  }
  return map;
}

function buildAuthHeaders(editorToken: string | null): Record<string, string> {
  if (editorToken) return { Authorization: `Bearer ${editorToken}` };
  return {};
}

function formatClockTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatWorkDate(isoDate: string): string {
  const parts = isoDate.split("-").map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function normalizeWorkDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = trimmed.length >= 10 ? trimmed.slice(0, 10) : trimmed;
  const match = WORK_DATE_PATTERN.exec(candidate);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getTodayDateInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function isEntryForWorkDate(entry: JobTimeEntry, eventId: string, workDate: string): boolean {
  const normalizedEntryDate = normalizeWorkDate(entry.work_date);
  return normalizedEntryDate === workDate && entry.google_event_id === eventId;
}

/** Combine a YYYY-MM-DD work date and "HH:MM" time into a local-timezone ISO timestamp. */
function localTimeToISO(workDate: string, hhMm: string): string {
  const parts = hhMm.split(":").map(Number);
  const dateParts = workDate.split("-").map(Number);
  const hh = parts[0] ?? 0;
  const mm = parts[1] ?? 0;
  const y = dateParts[0] ?? 1970;
  const mo = dateParts[1] ?? 1;
  const d = dateParts[2] ?? 1;
  return new Date(y, mo - 1, d, hh, mm, 0, 0).toISOString();
}

/** Format an ISO timestamp as "HH:MM" in local time for a <input type="time"> value. */
function isoToLocalHHMM(isoString: string): string {
  const date = new Date(isoString);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// JobTimeDayRow — state + controls for one work date
// ---------------------------------------------------------------------------

interface DayRowProps {
  eventId: string;
  workDate: string;
  editorToken: string | null;
  initialEntry: JobTimeEntry | null;
  scheduledStartTime: string | null;
  isToday: boolean;
  compact: boolean; // false = single-day full-size; true = multi-day compact card
  allowClockInWhenEmpty: boolean;
}

function JobTimeDayRow({
  eventId,
  workDate,
  editorToken,
  initialEntry,
  scheduledStartTime,
  isToday,
  compact,
  allowClockInWhenEmpty,
}: DayRowProps) {
  const [entry, setEntry] = useState<JobTimeEntry | null>(() => (
    resolveRowInitialEntry(initialEntry, eventId, workDate)
  ));
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isActionPending, setIsActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showEditForm, setShowEditForm] = useState(false);
  const [editInTime, setEditInTime] = useState("");
  const [editOutTime, setEditOutTime] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const normalizedEventId = eventId.trim();
  const normalizedWorkDate = normalizeWorkDate(workDate);
  const hasValidContext = normalizedEventId.length > 0 && !!normalizedWorkDate;
  const invalidContextError = "Hours error: invalid job context for this date.";
  const rowStateDiagnostic = entry
    ? {
        id: entry.id,
        work_date: entry.work_date,
        clock_in_at: entry.clock_in_at,
        clock_out_at: entry.clock_out_at,
      }
    : null;

  // Sync when parent's fetch completes and provides an initial entry.
  useEffect(() => {
    setEntry(resolveRowInitialEntry(initialEntry, normalizedEventId, workDate));
    setActionError(null);
    setShowEditForm(false);
  }, [initialEntry, normalizedEventId, normalizedWorkDate, workDate]);

  useEffect(() => {
    console.log("[job-time:row] render", {
      eventId: normalizedEventId,
      workDate: normalizedWorkDate ?? workDate,
      entry: rowStateDiagnostic,
    });
  }, [
    normalizedEventId,
    normalizedWorkDate,
    workDate,
    rowStateDiagnostic?.id,
    rowStateDiagnostic?.work_date,
    rowStateDiagnostic?.clock_in_at,
    rowStateDiagnostic?.clock_out_at,
  ]);

  // Running clock — ticks every second while clocked in but not out.
  useEffect(() => {
    if (!entry?.clock_in_at || entry.clock_out_at) return undefined;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [entry]);

  const authHeaders = buildAuthHeaders(editorToken);
  const jsonHeaders = { "Content-Type": "application/json", ...authHeaders };

  const fetchExactWorkDateEntry = async (): Promise<JobTimeEntry | null> => {
    if (!normalizedWorkDate || !normalizedEventId) return null;
    const getRes = await fetch(
      `/api/job-time?eventId=${encodeURIComponent(normalizedEventId)}&workDate=${encodeURIComponent(normalizedWorkDate)}`,
      { headers: authHeaders, credentials: "same-origin", cache: "no-store" },
    );
    if (getRes.status === 503) {
      throw new Error("unavailable");
    }
    if (!getRes.ok) {
      throw new Error("failed");
    }
    const getJson = await getRes.json() as { entries?: JobTimeEntry[] };
    const entries = Array.isArray(getJson.entries) ? getJson.entries : [];
    console.log("[job-time:get-refetch] result", {
      eventId: normalizedEventId,
      workDate: normalizedWorkDate,
      rowCount: entries.length,
      rows: entries.map((candidate) => ({
        id: candidate.id,
        work_date: candidate.work_date,
        clock_out_at: candidate.clock_out_at,
      })),
    });
    return entries.find((candidate) => isEntryForWorkDate(candidate, normalizedEventId, normalizedWorkDate)) ?? null;
  };

  const fetchActiveEntryById = async (entryId: string): Promise<JobTimeEntry | null> => {
    const activeRes = await fetch("/api/job-time/active", {
      headers: authHeaders,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (activeRes.status === 503) {
      throw new Error("unavailable");
    }
    if (!activeRes.ok) {
      throw new Error("failed");
    }
    const activeJson = await activeRes.json() as { entries?: JobTimeEntry[] };
    const activeEntries = Array.isArray(activeJson.entries) ? activeJson.entries : [];
    console.log("[job-time:clock-in:active-refetch] result", {
      eventId: normalizedEventId,
      workDate: normalizedWorkDate,
      rowCount: activeEntries.length,
      rows: activeEntries.map((candidate) => ({
        id: candidate.id,
        eventId: candidate.google_event_id,
        work_date: candidate.work_date,
        clock_in_at: candidate.clock_in_at,
        clock_out_at: candidate.clock_out_at,
      })),
    });
    return activeEntries.find((candidate) => candidate.id === entryId) ?? null;
  };

  const handleClockIn = async () => {
    if (isActionPending) return;
    if (!normalizedWorkDate || !normalizedEventId) {
      setActionError(invalidContextError);
      return;
    }
    console.log("[job-time:clock-in-click]", {
      eventId: normalizedEventId,
      workDate: normalizedWorkDate,
    });
    setIsActionPending(true);
    setActionError(null);
    try {
      const res = await fetch("/api/job-time/clock-in", {
        method: "POST",
        headers: jsonHeaders,
        credentials: "same-origin",
        body: JSON.stringify({ eventId: normalizedEventId, workDate: normalizedWorkDate }),
      });
      if (res.status === 503) { setActionError("Hours tracking unavailable."); return; }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
        console.log("[job-time:clock-in-response]", {
          status: res.status,
          error: errBody?.error ?? "unknown",
          eventId: normalizedEventId,
          workDate: normalizedWorkDate,
        });
        if (res.status === 400 && errBody.error === "missing_work_date") {
          setActionError(invalidContextError);
        } else {
          setActionError("Could not clock in. Try again.");
        }
        return;
      }
      const json = await res.json() as { entry?: JobTimeEntry };
      const returnedEntry = json.entry;
      console.log("[job-time:clock-in-response]", {
        status: res.status,
        hasEntry: !!returnedEntry,
        id: returnedEntry?.id ?? null,
        eventId: returnedEntry?.google_event_id ?? null,
        workDate: returnedEntry?.work_date ?? null,
        clock_in_at: returnedEntry?.clock_in_at ?? null,
        clock_out_at: returnedEntry?.clock_out_at ?? null,
      });
      if (returnedEntry && !!returnedEntry.clock_in_at && !returnedEntry.clock_out_at) {
        const returnedEntryId = returnedEntry.id.trim();
        setEntry(returnedEntry);
        setNowMs(Date.now());

        if (!returnedEntryId) return;

        try {
          const confirmed = await fetchExactWorkDateEntry();
          if (
            confirmed
            && confirmed.id.trim() === returnedEntryId
            && !!confirmed.clock_in_at
            && !confirmed.clock_out_at
          ) {
            setEntry(confirmed);
            return;
          }
          const activeConfirmed = await fetchActiveEntryById(returnedEntryId);
          if (activeConfirmed && !!activeConfirmed.clock_in_at && !activeConfirmed.clock_out_at) {
            setEntry(activeConfirmed);
            return;
          }
          // Neither GET nor active route confirmed the row — revert to not-clocked-in.
          console.warn("[job-time:clock-in] server confirmation failed after write", {
            eventId: normalizedEventId,
            workDate: normalizedWorkDate,
            entryId: returnedEntryId,
          });
          setEntry(null);
          setActionError("Could not confirm clock-in. Try again.");
        } catch (error) {
          console.warn("[job-time:clock-in] confirmation refetch threw", {
            eventId: normalizedEventId,
            workDate: normalizedWorkDate,
            entryId: returnedEntryId,
            error: error instanceof Error ? error.message : String(error),
          });
          setEntry(null);
          setActionError("Could not confirm clock-in. Try again.");
        }
        return;
      }
      const confirmed = await fetchExactWorkDateEntry();
      if (
        confirmed
        && isEntryForWorkDate(confirmed, normalizedEventId, normalizedWorkDate)
        && !!confirmed.clock_in_at
        && !confirmed.clock_out_at
      ) {
        setEntry(confirmed);
        setNowMs(Date.now());
        return;
      }
      setActionError("Could not confirm clock-in. Try again.");
    } catch {
      setActionError("Network error. Try again.");
    } finally {
      setIsActionPending(false);
    }
  };

  const handleClockOut = async () => {
    if (isActionPending) return;
    if (!normalizedWorkDate || !normalizedEventId) {
      setActionError(invalidContextError);
      return;
    }
    setIsActionPending(true);
    setActionError(null);
    try {
      const payload = buildClockMutationPayload(normalizedEventId, normalizedWorkDate, entry);
      console.log("[job-time:clock-out-client]", {
        entryId: payload.entryId ?? null,
        eventId: normalizedEventId,
        workDate: normalizedWorkDate,
      });
      const res = await fetch("/api/job-time/clock-out", {
        method: "POST",
        headers: jsonHeaders,
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      if (res.status === 503) { setActionError("Hours tracking unavailable."); return; }
      if (!res.ok) {
        if (res.status === 404) {
          try {
            const confirmed = await fetchExactWorkDateEntry();
            if (!confirmed) {
              setEntry(null);
              setShowEditForm(false);
              return;
            }
            if (confirmed?.clock_out_at) {
              setEntry(confirmed);
              return;
            }
            if (confirmed.clock_in_at && !confirmed.clock_out_at) {
              setEntry(confirmed);
              setActionError("Diagnostic: server still shows an active entry for this date.");
              return;
            }
          } catch { /* fall through to error */ }
          setActionError("No active clock-in found.");
          return;
        }
        const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
        if (res.status === 400 && errBody.error === "missing_work_date") {
          setActionError(invalidContextError);
        } else {
          setActionError("Could not clock out. Try again.");
        }
        return;
      }
      const json = await res.json() as { entry?: JobTimeEntry; activeCount?: number; activeIds?: string[] };
      const returnedEntry = json.entry;
      const serverActiveCount = typeof json.activeCount === "number" ? json.activeCount : null;
      console.log("[job-time:clock-out] response", {
        eventId: normalizedEventId,
        workDate: normalizedWorkDate,
        entryId: returnedEntry?.id ?? null,
        clock_out_at: returnedEntry?.clock_out_at ?? null,
        serverActiveCount,
      });
      const confirmed = await fetchExactWorkDateEntry();
      if (confirmed?.clock_out_at) {
        setEntry(confirmed);
        try {
          const activeRes = await fetch("/api/job-time/active", {
            headers: authHeaders,
            credentials: "same-origin",
            cache: "no-store",
          });
          let activeRows: JobTimeEntry[] = [];
          if (activeRes.ok) {
            const activeJson = await activeRes.json() as { entries?: JobTimeEntry[] };
            if (Array.isArray(activeJson.entries)) {
              activeRows = activeJson.entries;
            }
          }
          const activeCount = activeRows.filter((e) => !!e.clock_in_at && !e.clock_out_at).length;
          console.log("[job-time:active-after-clock-out]", {
            eventId: normalizedEventId,
            workDate: normalizedWorkDate,
            activeCount,
            activeIds: activeRows.map((e) => e.id),
            serverActiveCount,
          });
          window.dispatchEvent(new CustomEvent("job-time:clock-out-completed"));
          if (activeCount > 0) {
            setActionError(`Diagnostic: ${activeCount} active entr${activeCount === 1 ? "y" : "ies"} still running after clock-out.`);
          }
        } catch {
          window.dispatchEvent(new CustomEvent("job-time:clock-out-completed"));
        }
        return;
      }
      if (confirmed?.clock_in_at && !confirmed.clock_out_at) {
        console.warn("[job-time:clock-out] diagnostic active row still running after clock-out", {
          eventId: normalizedEventId,
          workDate: normalizedWorkDate,
          entryId: confirmed.id,
        });
        setEntry(confirmed);
        setActionError("Diagnostic: server still shows an active entry for this date.");
        return;
      }
      if (returnedEntry && isEntryForWorkDate(returnedEntry, normalizedEventId, normalizedWorkDate)) {
        setEntry(returnedEntry);
        return;
      }
      setActionError("Could not confirm clock-out. Try again.");
    } catch {
      setActionError("Network error. Try again.");
    } finally {
      setIsActionPending(false);
    }
  };

  const handleClear = async () => {
    const label = compact ? formatWorkDate(workDate) : "this job";
    if (!window.confirm(`Clear time entry for ${label}? This cannot be undone.`)) return;
    if (isActionPending) return;
    if (!normalizedWorkDate || !normalizedEventId) {
      setActionError(invalidContextError);
      return;
    }
    setIsActionPending(true);
    setActionError(null);
    try {
      const payload = buildClockMutationPayload(normalizedEventId, normalizedWorkDate, entry);
      console.log("[job-time:clear] request", payload);
      const res = await fetch("/api/job-time/clear", {
        method: "POST",
        headers: jsonHeaders,
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      if (res.status === 503) { setActionError("Hours tracking unavailable."); return; }
      if (!res.ok) {
        if (res.status === 404) {
          try {
            const confirmed = await fetchExactWorkDateEntry();
            if (!confirmed) {
              setEntry(null);
              setShowEditForm(false);
              return;
            }
            if (confirmed.clock_in_at && !confirmed.clock_out_at) {
              setEntry(confirmed);
              setActionError("Diagnostic: server still shows an active entry for this date.");
              return;
            }
            setEntry(confirmed);
            setActionError("Could not confirm clear. Try again.");
            return;
          } catch { /* fall through */ }
        }
        const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
        if (res.status === 400 && errBody.error === "missing_work_date") {
          setActionError(invalidContextError);
        } else {
          setActionError("Could not clear. Try again.");
        }
        return;
      }
      const json = await res.json().catch(() => null) as { success?: boolean; workDate?: string; entryId?: string } | null;
      console.log("[job-time:clear] response", {
        eventId: normalizedEventId,
        workDate: normalizedWorkDate,
        success: !!json?.success,
        returnedEntryId: json?.entryId ?? null,
        returnedWorkDate: json?.workDate ?? null,
      });
      const clearedDate = typeof json?.workDate === "string" ? normalizeWorkDate(json.workDate) : null;
      if (json?.success && (!clearedDate || clearedDate === normalizedWorkDate)) {
        const confirmed = await fetchExactWorkDateEntry();
        if (!confirmed) {
          setEntry(null);
          setShowEditForm(false);
          return;
        }
        if (confirmed.clock_in_at && !confirmed.clock_out_at) {
          console.warn("[job-time:clear] diagnostic active row still running after clear", {
            eventId: normalizedEventId,
            workDate: normalizedWorkDate,
            entryId: confirmed.id,
          });
          setEntry(confirmed);
          setActionError("Diagnostic: server still shows an active entry for this date.");
          return;
        }
        setEntry(confirmed);
        setActionError("Could not confirm clear. Try again.");
        return;
      }
      setActionError("Could not confirm clear. Try again.");
    } catch {
      setActionError("Network error. Try again.");
    } finally {
      setIsActionPending(false);
    }
  };

  const openEditForm = () => {
    const defaults = resolveEditFormDefaults(entry, scheduledStartTime);
    setEditInTime(defaults.inTime);
    setEditOutTime(defaults.outTime);
    setEditError(null);
    setShowEditForm(true);
  };

  const handleEditSave = async () => {
    if (!normalizedWorkDate || !normalizedEventId) {
      setEditError(invalidContextError);
      return;
    }
    if (!editInTime) { setEditError("Clock-in time is required."); return; }
    const clockInIso = localTimeToISO(normalizedWorkDate, editInTime);
    const clockOutIso = editOutTime ? localTimeToISO(normalizedWorkDate, editOutTime) : null;
    if (clockOutIso && Date.parse(clockOutIso) <= Date.parse(clockInIso)) {
      setEditError("Clock-out must be after clock-in.");
      return;
    }
    setEditError(null);
    setIsActionPending(true);
    try {
      const res = await fetch("/api/job-time/edit-times", {
        method: "POST",
        headers: jsonHeaders,
        credentials: "same-origin",
        body: JSON.stringify({
          eventId: normalizedEventId,
          workDate: normalizedWorkDate,
          clockInAt: clockInIso,
          clockOutAt: clockOutIso,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as Record<string, unknown>;
        if (res.status === 422) {
          setEditError("Clock-out must be after clock-in.");
        } else {
          setEditError((json.message as string | undefined) ?? "Could not save. Try again.");
        }
        return;
      }
      const json = await res.json() as { entry?: JobTimeEntry };
      const returnedEntry = json.entry;
      const shouldBeCompleted = !!clockOutIso;
      if (
        returnedEntry
        && isEntryForWorkDate(returnedEntry, normalizedEventId, normalizedWorkDate)
        && !!returnedEntry.clock_in_at
        && (shouldBeCompleted ? !!returnedEntry.clock_out_at : !returnedEntry.clock_out_at)
      ) {
        setEntry(returnedEntry);
        setShowEditForm(false);
        return;
      }
      const confirmed = await fetchExactWorkDateEntry();
      if (
        confirmed
        && !!confirmed.clock_in_at
        && (shouldBeCompleted ? !!confirmed.clock_out_at : !confirmed.clock_out_at)
      ) {
        setEntry(confirmed);
        setShowEditForm(false);
        return;
      }
      setEditError("Could not confirm saved times. Try again.");
      return;
    } catch {
      setEditError("Network error. Try again.");
    } finally {
      setIsActionPending(false);
    }
  };

  const isRunning = !!entry?.clock_in_at && !entry.clock_out_at;
  const rowControls = resolveRowControlState(entry, allowClockInWhenEmpty);

  const wrapClass = compact
    ? `job-time-day-row${isToday ? " job-time-day-row--today" : ""}`
    : "";

  const dateHeader = compact ? (
    <p className={`job-time-day-label${isToday ? " job-time-day-label--today" : ""}`}>
      {formatWorkDate(workDate)}{isToday ? " · today" : ""}
    </p>
  ) : null;

  const editForm = (
    <div className="job-time-edit-form">
      {editError ? <p className="job-time-error" role="alert">{editError}</p> : null}
      <div className="job-time-edit-row">
        <label htmlFor={`jt-in-${workDate}`}>In</label>
        <input
          id={`jt-in-${workDate}`}
          type="time"
          className="job-time-edit-input"
          value={editInTime}
          onChange={(e) => setEditInTime(e.target.value)}
        />
      </div>
      <div className="job-time-edit-row">
        <label htmlFor={`jt-out-${workDate}`}>Out</label>
        <input
          id={`jt-out-${workDate}`}
          type="time"
          className="job-time-edit-input"
          value={editOutTime}
          onChange={(e) => setEditOutTime(e.target.value)}
        />
        <span className="job-time-edit-optional">optional</span>
      </div>
      <div className="job-time-edit-actions">
        <button
          type="button"
          className="job-time-edit-save"
          onClick={() => { void handleEditSave(); }}
          disabled={isActionPending || !editInTime}
        >
          {isActionPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="job-time-edit-cancel"
          onClick={() => setShowEditForm(false)}
          disabled={isActionPending}
        >
          Cancel
        </button>
      </div>
    </div>
  );

  const correctionButtons = (
    <div className="job-time-correction-buttons">
      {rowControls.showEditTimes ? (
        <button
          type="button"
          className="job-time-correction-link"
          onClick={openEditForm}
          disabled={isActionPending}
        >
          Edit times
        </button>
      ) : null}
      {rowControls.showClear ? (
        <button
          type="button"
          className="job-time-correction-link job-time-correction-link--danger"
          onClick={() => { void handleClear(); }}
          disabled={isActionPending}
        >
          Clear
        </button>
      ) : null}
    </div>
  );

  const btnClass = `job-time-button${compact ? " job-time-button--sm" : ""}`;

  if (!hasValidContext) {
    return (
      <div className={wrapClass}>
        {dateHeader}
        <p className="job-time-error" role="alert">{invalidContextError}</p>
      </div>
    );
  }

  // ── State: not clocked in ────────────────────────────────────────────────
  if (!entry?.clock_in_at) {
    return (
      <div className={wrapClass}>
        {dateHeader}
        {showEditForm ? editForm : (
          <>
            <p className="job-time-status job-time-status--muted">
              {allowClockInWhenEmpty ? "Not clocked in" : "No entry for this day"}
            </p>
            {actionError ? <p className="job-time-error" role="alert">{actionError}</p> : null}
            {rowControls.showClockIn ? (
              <>
                {/* TODO: Final production rule: limit live Clock In to NY "today" only after
                    correction flow is fully verified in production. */}
                <button
                  type="button"
                  className={`${btnClass} job-time-button--clock-in`}
                  onClick={() => { void handleClockIn(); }}
                  disabled={isActionPending}
                >
                  {isActionPending ? "Clocking in…" : "Clock In"}
                </button>
              </>
            ) : null}
            {correctionButtons}
          </>
        )}
      </div>
    );
  }

  // ── State: clocked in, running ───────────────────────────────────────────
  if (isRunning) {
    const { totalHours } = calculateTimeHours(
      entry.clock_in_at,
      null,
      new Date(nowMs).toISOString(),
    );
    return (
      <div className={wrapClass}>
        {dateHeader}
        {showEditForm ? editForm : (
          <>
            <p className="job-time-status">
              Clocked in at {formatClockTime(entry.clock_in_at)}
            </p>
            <p className="job-time-elapsed" aria-live="polite" aria-atomic="true">
              {formatElapsed(totalHours)}
            </p>
            {actionError ? <p className="job-time-error" role="alert">{actionError}</p> : null}
            {rowControls.showClockOut ? (
              <button
                type="button"
                className={`${btnClass} job-time-button--clock-out`}
                onClick={() => { void handleClockOut(); }}
                disabled={isActionPending}
              >
                {isActionPending ? "Clocking out…" : "Clock Out"}
              </button>
            ) : null}
            {correctionButtons}
          </>
        )}
      </div>
    );
  }

  // ── State: completed ─────────────────────────────────────────────────────
  // Guard narrows clock_in_at / clock_out_at to string for TypeScript.
  if (!entry.clock_in_at || !entry.clock_out_at) return null;
  const { totalHours, regularHours, overtimeHours } = calculateTimeHours(
    entry.clock_in_at,
    entry.clock_out_at,
  );
  return (
    <div className={wrapClass}>
      {dateHeader}
      {showEditForm ? editForm : (
        <>
          <dl className="job-time-summary">
            <div className="job-time-row">
              <dt>In</dt>
              <dd>{formatClockTime(entry.clock_in_at)}</dd>
            </div>
            <div className="job-time-row">
              <dt>Out</dt>
              <dd>{formatClockTime(entry.clock_out_at)}</dd>
            </div>
            <div className="job-time-row job-time-row--total">
              <dt>Total</dt>
              <dd>{formatHoursDisplay(totalHours)} hrs</dd>
            </div>
            {overtimeHours > 0 ? (
              <>
                <div className="job-time-row">
                  <dt>Regular</dt>
                  <dd>{formatHoursDisplay(regularHours)} hrs</dd>
                </div>
                <div className="job-time-row job-time-row--ot">
                  <dt>OT</dt>
                  <dd>{formatHoursDisplay(overtimeHours)} hrs</dd>
                </div>
              </>
            ) : null}
          </dl>
          {correctionButtons}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// JobTimeSection — outer container, bulk-fetches then renders day rows
// ---------------------------------------------------------------------------

export function JobTimeSection({
  eventId,
  workDates,
  editorToken,
  scheduledStartTimesByWorkDate,
  eventIdsByWorkDate,
}: Props) {
  const requestKey = buildJobTimeRequestKey(eventId, workDates);
  const fetchEventIdsKey = buildFetchEventIds(eventId, workDates, eventIdsByWorkDate).join("|");
  const fetchEventIdsForLog = fetchEventIdsKey ? fetchEventIdsKey.split("|") : [];
  const [fetchState, setFetchState] = useState<SectionFetchState>({
    status: "loading",
    requestKey,
  });
  const [entriesMap, setEntriesMap] = useState<Map<string, JobTimeEntry>>(() => new Map());

  const today = getTodayDateInTimeZone(LIVE_CLOCK_TIMEZONE);
  const {
    isSingleDay,
    hasTodayInWorkDates,
    orderedWorkDates,
    primaryLiveWorkDate,
  } = resolveJobTimeDisplayRows(workDates, today);

  useEffect(() => {
    if (workDates.length === 0) {
      setEntriesMap(new Map());
      setFetchState({ status: "ready", requestKey });
      return undefined;
    }

    setFetchState({ status: "loading", requestKey });
    setEntriesMap(new Map());
    let cancelled = false;
    const fetchEventIds = fetchEventIdsKey ? fetchEventIdsKey.split("|") : [];
    Promise.all(
      fetchEventIds.map(async (queryEventId) => {
        const res = await fetch(`/api/job-time?eventId=${encodeURIComponent(queryEventId)}`, {
          headers: buildAuthHeaders(editorToken),
          credentials: "same-origin",
          cache: "no-store",
        });
        return { queryEventId, res };
      }),
    )
      .then(async (responses) => {
        if (cancelled) return;
        let unavailable = false;
        let failed = false;
        const allEntries: JobTimeEntry[] = [];

        for (const { queryEventId, res } of responses) {
          if (res.status === 503) {
            unavailable = true;
            break;
          }
          if (!res.ok) {
            failed = true;
            break;
          }
          const json = await res.json() as { entries: JobTimeEntry[] };
          const entries = Array.isArray(json.entries) ? json.entries : [];
          allEntries.push(...entries);
          console.log("[job-time:get-initial] result", {
            eventId: queryEventId,
            requestKey,
            rowCount: entries.length,
            rows: entries.map((candidate) => ({
              id: candidate.id,
              eventId: candidate.google_event_id,
              work_date: candidate.work_date,
              clock_in_at: candidate.clock_in_at,
              clock_out_at: candidate.clock_out_at,
            })),
          });
        }

        if (cancelled) return;
        if (unavailable) {
          setFetchState({ status: "unavailable", requestKey });
          return;
        }
        if (failed) {
          setFetchState({ status: "error", requestKey });
          return;
        }

        setEntriesMap(buildEntriesMapFromResponse(allEntries));
        setFetchState({ status: "ready", requestKey });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.error("[JobTimeSection] GET fetch error:", err);
          setEntriesMap(new Map());
          setFetchState({ status: "error", requestKey });
        }
      });

    return () => { cancelled = true; };
  }, [editorToken, fetchEventIdsKey, requestKey]);

  const runningRendered = Array.from(entriesMap.values()).some(
    (entry) => !!entry.clock_in_at && !entry.clock_out_at,
  );

  useEffect(() => {
    console.log("[job-time:section-render]", {
      source: "server",
      eventId: eventId.trim(),
      workDates,
      fetchEventIds: fetchEventIdsForLog,
      eventIdsByWorkDate,
      entriesLength: entriesMap.size,
      fetchStatus: fetchState.status,
      runningRendered: fetchState.status === "ready" ? runningRendered : false,
    });
  }, [
    eventId,
    workDates,
    fetchEventIdsKey,
    eventIdsByWorkDate,
    entriesMap.size,
    fetchState.status,
    runningRendered,
  ]);

  useEffect(() => {
    if (fetchState.requestKey !== requestKey || fetchState.status !== "ready") return;
    const mapKeys = Array.from(entriesMap.keys());
    console.log("[JobTimeSection reopen]", {
      source: "server",
      eventId: eventId.trim(),
      workDates,
      entriesLength: entriesMap.size,
      mapKeys,
      rows: Array.from(entriesMap.values()).map((entry) => ({
        id: entry.id,
        eventId: entry.google_event_id,
        workDate: entry.work_date,
        clockInAt: entry.clock_in_at,
        clockOutAt: entry.clock_out_at,
      })),
    });
  }, [entriesMap, eventId, fetchState.requestKey, fetchState.status, requestKey, workDates]);

  if (fetchState.requestKey !== requestKey || fetchState.status === "loading") {
    return (
      <div className="job-time-section">
        <p className="board-day-modal-event-label">Hours</p>
        <p className="job-time-status job-time-status--muted">Loading…</p>
      </div>
    );
  }

  if (fetchState.status === "unavailable") {
    return (
      <div className="job-time-section">
        <p className="board-day-modal-event-label">Hours</p>
        <p className="job-time-status job-time-status--muted">Hours tracking unavailable.</p>
      </div>
    );
  }

  if (fetchState.status === "error") {
    return (
      <div className="job-time-section">
        <p className="board-day-modal-event-label">Hours</p>
        <p className="job-time-error" role="alert">
          Could not load hours. Check connection and try reopening.
        </p>
      </div>
    );
  }

  if (workDates.length === 0) return null;

  const singleDayEntry = workDates[0] ? (entriesMap.get(workDates[0]) ?? null) : null;
  const singleDayEventId = workDates[0]
    ? resolveEventIdForWorkDate(workDates[0], eventId, eventIdsByWorkDate)
    : eventId.trim();
  const singleDayStatus = singleDayEntry?.clock_out_at
    ? "completed"
    : singleDayEntry?.clock_in_at
      ? "running"
      : "empty";
  const singleDayResolvedEventId = singleDayEntry?.google_event_id ?? singleDayEventId;
  const singleDayKey = `${singleDayResolvedEventId}:${workDates[0] ?? "none"}:${singleDayEntry?.id ?? "none"}:${singleDayStatus}`;
  const singleDayScheduledStart = workDates[0]
    ? resolveScheduledStartTimeForWorkDate(workDates[0], scheduledStartTimesByWorkDate)
    : null;

  return (
    <div className="job-time-section">
      <p className="board-day-modal-event-label">Hours</p>
      {isSingleDay ? (
        <JobTimeDayRow
          key={singleDayKey}
          eventId={singleDayResolvedEventId}
          workDate={workDates[0]!}
          editorToken={editorToken}
          initialEntry={singleDayEntry}
          scheduledStartTime={singleDayScheduledStart}
          isToday={workDates[0] === today}
          compact={false}
          allowClockInWhenEmpty={workDates[0] === today}
        />
      ) : (
        <div className="job-time-days-list">
          {!hasTodayInWorkDates ? (
            <p className="job-time-status job-time-status--muted">No live clock-in available today.</p>
          ) : null}
          {orderedWorkDates.map((date) => {
            const rowEntry = entriesMap.get(date) ?? null;
            const rowEventId = resolveEventIdForWorkDate(date, eventId, eventIdsByWorkDate);
            const rowResolvedEventId = rowEntry?.google_event_id ?? rowEventId;
            const rowStatus = rowEntry?.clock_out_at
              ? "completed"
              : rowEntry?.clock_in_at
                ? "running"
                : "empty";
            const rowKey = `${rowResolvedEventId}:${date}:${rowEntry?.id ?? "none"}:${rowStatus}`;
            return (
              <JobTimeDayRow
                key={rowKey}
                eventId={rowResolvedEventId}
                workDate={date}
                editorToken={editorToken}
                initialEntry={rowEntry}
                scheduledStartTime={resolveScheduledStartTimeForWorkDate(date, scheduledStartTimesByWorkDate)}
                isToday={date === today}
                compact={true}
                allowClockInWhenEmpty={date === primaryLiveWorkDate}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
