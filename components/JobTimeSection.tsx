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
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error" }
  | { status: "ready" };

interface Props {
  eventId: string;
  workDates: string[]; // YYYY-MM-DD, at least 1
  editorToken: string | null;
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
  isToday: boolean;
  compact: boolean; // false = single-day full-size; true = multi-day compact card
  allowClockInWhenEmpty: boolean;
}

function JobTimeDayRow({
  eventId,
  workDate,
  editorToken,
  initialEntry,
  isToday,
  compact,
  allowClockInWhenEmpty,
}: DayRowProps) {
  const [entry, setEntry] = useState<JobTimeEntry | null>(initialEntry);
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
    if (
      initialEntry
      && normalizedWorkDate
      && isEntryForWorkDate(initialEntry, normalizedEventId, normalizedWorkDate)
    ) {
      setEntry(initialEntry);
    } else {
      setEntry(null);
    }
    setActionError(null);
    setShowEditForm(false);
  }, [initialEntry, normalizedEventId, normalizedWorkDate]);

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

  const handleClockIn = async () => {
    if (isActionPending) return;
    if (!normalizedWorkDate || !normalizedEventId) {
      setActionError(invalidContextError);
      return;
    }
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
        if (res.status === 400 && errBody.error === "missing_work_date") {
          setActionError(invalidContextError);
        } else {
          setActionError("Could not clock in. Try again.");
        }
        return;
      }
      const json = await res.json() as { entry?: JobTimeEntry };
      const returnedEntry = json.entry;
      if (
        returnedEntry
        && isEntryForWorkDate(returnedEntry, normalizedEventId, normalizedWorkDate)
        && !!returnedEntry.clock_in_at
        && !returnedEntry.clock_out_at
      ) {
        setEntry(returnedEntry);
        setNowMs(Date.now());
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
      const res = await fetch("/api/job-time/clock-out", {
        method: "POST",
        headers: jsonHeaders,
        credentials: "same-origin",
        body: JSON.stringify({ eventId: normalizedEventId, workDate: normalizedWorkDate }),
      });
      if (res.status === 503) { setActionError("Hours tracking unavailable."); return; }
      if (!res.ok) {
        if (res.status === 404) {
          try {
            const confirmed = await fetchExactWorkDateEntry();
            if (confirmed?.clock_out_at) {
              setEntry(confirmed);
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
      const json = await res.json() as { entry?: JobTimeEntry };
      const returnedEntry = json.entry;
      console.log("[job-time:clock-out] response", {
        eventId: normalizedEventId,
        workDate: normalizedWorkDate,
        entryId: returnedEntry?.id ?? null,
        clock_out_at: returnedEntry?.clock_out_at ?? null,
      });
      const confirmed = await fetchExactWorkDateEntry();
      if (confirmed?.clock_out_at) {
        setEntry(confirmed);
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
      const res = await fetch("/api/job-time/clear", {
        method: "POST",
        headers: jsonHeaders,
        credentials: "same-origin",
        body: JSON.stringify({ eventId: normalizedEventId, workDate: normalizedWorkDate }),
      });
      if (res.status === 503) { setActionError("Hours tracking unavailable."); return; }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
        if (res.status === 400 && errBody.error === "missing_work_date") {
          setActionError(invalidContextError);
        } else {
          setActionError("Could not clear. Try again.");
        }
        return;
      }
      const json = await res.json().catch(() => null) as { success?: boolean; workDate?: string } | null;
      console.log("[job-time:clear] response", {
        eventId: normalizedEventId,
        workDate: normalizedWorkDate,
        success: !!json?.success,
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
    setEditInTime(entry?.clock_in_at ? isoToLocalHHMM(entry.clock_in_at) : "");
    setEditOutTime(entry?.clock_out_at ? isoToLocalHHMM(entry.clock_out_at) : "");
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

  const hasEntry = !!entry;
  const isRunning = !!entry?.clock_in_at && !entry.clock_out_at;

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
      <button
        type="button"
        className="job-time-correction-link"
        onClick={openEditForm}
        disabled={isActionPending}
      >
        Edit times
      </button>
      {hasEntry ? (
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
            {allowClockInWhenEmpty ? (
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
            <button
              type="button"
              className={`${btnClass} job-time-button--clock-out`}
              onClick={() => { void handleClockOut(); }}
              disabled={isActionPending}
            >
              {isActionPending ? "Clocking out…" : "Clock Out"}
            </button>
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

export function JobTimeSection({ eventId, workDates, editorToken }: Props) {
  const [fetchState, setFetchState] = useState<SectionFetchState>({ status: "loading" });
  const [entriesMap, setEntriesMap] = useState<Map<string, JobTimeEntry>>(() => new Map());

  const today = getTodayDateInTimeZone(LIVE_CLOCK_TIMEZONE);
  const {
    isSingleDay,
    hasTodayInWorkDates,
    orderedWorkDates,
    primaryLiveWorkDate,
  } = resolveJobTimeDisplayRows(workDates, today);

  useEffect(() => {
    if (workDates.length === 0) { setFetchState({ status: "ready" }); return undefined; }

    setFetchState({ status: "loading" });
    setEntriesMap(new Map());
    let cancelled = false;

    fetch(`/api/job-time?eventId=${encodeURIComponent(eventId)}`, {
      headers: buildAuthHeaders(editorToken),
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 503) { setFetchState({ status: "unavailable" }); return; }
        if (!res.ok) { setFetchState({ status: "error" }); return; }
        const json = await res.json() as { entries: JobTimeEntry[] };
        if (!cancelled) {
          const map = new Map<string, JobTimeEntry>();
          for (const e of json.entries) {
            const normalized = normalizeWorkDate(e.work_date);
            if (!normalized) continue;
            map.set(normalized, { ...e, work_date: normalized });
          }
          setEntriesMap(map);
          setFetchState({ status: "ready" });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.error("[JobTimeSection] GET fetch error:", err);
          setFetchState({ status: "error" });
        }
      });

    return () => { cancelled = true; };
  }, [eventId, editorToken, workDates]);

  if (fetchState.status === "loading") {
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

  return (
    <div className="job-time-section">
      <p className="board-day-modal-event-label">Hours</p>
      {isSingleDay ? (
        <JobTimeDayRow
          key={workDates[0]}
          eventId={eventId}
          workDate={workDates[0]!}
          editorToken={editorToken}
          initialEntry={entriesMap.get(workDates[0]!) ?? null}
          isToday={workDates[0] === today}
          compact={false}
          allowClockInWhenEmpty={true}
        />
      ) : (
        <div className="job-time-days-list">
          {!hasTodayInWorkDates ? (
            <p className="job-time-status job-time-status--muted">No live clock-in available today.</p>
          ) : null}
          {orderedWorkDates.map((date) => (
            <JobTimeDayRow
              key={date}
              eventId={eventId}
              workDate={date}
              editorToken={editorToken}
              initialEntry={entriesMap.get(date) ?? null}
              isToday={date === today}
              compact={true}
              allowClockInWhenEmpty={date === primaryLiveWorkDate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
