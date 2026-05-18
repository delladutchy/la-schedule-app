"use client";

import { useEffect, useState } from "react";
import {
  calculateTimeHours,
  formatHoursDisplay,
  formatElapsed,
} from "@/lib/job-time-calculations";

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

function getTodayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
}

function JobTimeDayRow({
  eventId,
  workDate,
  editorToken,
  initialEntry,
  isToday,
  compact,
}: DayRowProps) {
  const [entry, setEntry] = useState<JobTimeEntry | null>(initialEntry);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isActionPending, setIsActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showEditForm, setShowEditForm] = useState(false);
  const [editInTime, setEditInTime] = useState("");
  const [editOutTime, setEditOutTime] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  // Sync when parent's fetch completes and provides an initial entry.
  useEffect(() => {
    setEntry(initialEntry);
    setActionError(null);
    setShowEditForm(false);
  }, [initialEntry]);

  // Running clock — ticks every second while clocked in but not out.
  useEffect(() => {
    if (!entry?.clock_in_at || entry.clock_out_at) return undefined;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [entry]);

  const authHeaders = buildAuthHeaders(editorToken);
  const jsonHeaders = { "Content-Type": "application/json", ...authHeaders };

  const handleClockIn = async () => {
    if (isActionPending) return;
    setIsActionPending(true);
    setActionError(null);
    try {
      const res = await fetch("/api/job-time/clock-in", {
        method: "POST",
        headers: jsonHeaders,
        credentials: "same-origin",
        body: JSON.stringify({ eventId, workDate }),
      });
      if (res.status === 503) { setActionError("Hours tracking unavailable."); return; }
      if (!res.ok) { setActionError("Could not clock in. Try again."); return; }
      const json = await res.json() as { entry: JobTimeEntry };
      setEntry(json.entry);
      setNowMs(Date.now());
    } catch {
      setActionError("Network error. Try again.");
    } finally {
      setIsActionPending(false);
    }
  };

  const handleClockOut = async () => {
    if (isActionPending) return;
    setIsActionPending(true);
    setActionError(null);
    try {
      const res = await fetch("/api/job-time/clock-out", {
        method: "POST",
        headers: jsonHeaders,
        credentials: "same-origin",
        body: JSON.stringify({ eventId, workDate }),
      });
      if (res.status === 503) { setActionError("Hours tracking unavailable."); return; }
      if (!res.ok) {
        if (res.status === 404) {
          // Server says no active clock-in — row may already be completed.
          // Refetch actual state before showing an error.
          try {
            const getRes = await fetch(
              `/api/job-time?eventId=${encodeURIComponent(eventId)}&workDate=${encodeURIComponent(workDate)}`,
              { headers: authHeaders, credentials: "same-origin", cache: "no-store" },
            );
            if (getRes.ok) {
              const getJson = await getRes.json() as { entries: JobTimeEntry[] };
              const found = getJson.entries[0] ?? null;
              if (found?.clock_out_at) { setEntry(found); return; }
            }
          } catch { /* fall through to error */ }
          setActionError("No active clock-in found.");
          return;
        }
        setActionError("Could not clock out. Try again.");
        return;
      }
      const json = await res.json() as { entry: JobTimeEntry };
      setEntry(json.entry);
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
    setIsActionPending(true);
    setActionError(null);
    try {
      const res = await fetch("/api/job-time/clear", {
        method: "POST",
        headers: jsonHeaders,
        credentials: "same-origin",
        body: JSON.stringify({ eventId, workDate }),
      });
      if (res.status === 503) { setActionError("Hours tracking unavailable."); return; }
      if (!res.ok) { setActionError("Could not clear. Try again."); return; }
      setEntry(null);
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
    if (!editInTime) { setEditError("Clock-in time is required."); return; }
    const clockInIso = localTimeToISO(workDate, editInTime);
    const clockOutIso = editOutTime ? localTimeToISO(workDate, editOutTime) : null;
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
        body: JSON.stringify({ eventId, workDate, clockInAt: clockInIso, clockOutAt: clockOutIso }),
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
      const json = await res.json() as { entry: JobTimeEntry };
      setEntry(json.entry);
      setShowEditForm(false);
    } catch {
      setEditError("Network error. Try again.");
    } finally {
      setIsActionPending(false);
    }
  };

  const hasEntry = !!entry;
  const isRunning = !!entry?.clock_in_at && !entry.clock_out_at;
  const isCompleted = !!entry?.clock_in_at && !!entry.clock_out_at;

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

  // ── State: not clocked in ────────────────────────────────────────────────
  if (!entry?.clock_in_at) {
    return (
      <div className={wrapClass}>
        {dateHeader}
        {showEditForm ? editForm : (
          <>
            {!isCompleted && (
              <p className="job-time-status job-time-status--muted">Not clocked in</p>
            )}
            {actionError ? <p className="job-time-error" role="alert">{actionError}</p> : null}
            {/* TODO: Final production rule: disable Clock In for non-today work dates after
                Edit Times/Clear Entry are verified in production. Currently all dates are
                clocked-in-able for testing and correction purposes. */}
            <button
              type="button"
              className={`${btnClass} job-time-button--clock-in`}
              onClick={() => { void handleClockIn(); }}
              disabled={isActionPending}
            >
              {isActionPending ? "Clocking in…" : "Clock In"}
            </button>
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

  const today = getTodayDate();
  const isSingleDay = workDates.length <= 1;

  useEffect(() => {
    if (workDates.length === 0) { setFetchState({ status: "ready" }); return undefined; }

    setFetchState({ status: "loading" });
    setEntriesMap(new Map());
    let cancelled = false;

    console.log("[JobTimeSection] fetching entries for eventId:", eventId);
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
          for (const e of json.entries) map.set(e.work_date, e);
          setEntriesMap(map);
          setFetchState({ status: "ready" });
        }
      })
      .catch(() => { if (!cancelled) setFetchState({ status: "error" }); });

    return () => { cancelled = true; };
  }, [eventId, editorToken]); // workDates intentionally omitted — changes only with eventId

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
        />
      ) : (
        <div className="job-time-days-list">
          {workDates.map((date) => (
            <JobTimeDayRow
              key={date}
              eventId={eventId}
              workDate={date}
              editorToken={editorToken}
              initialEntry={entriesMap.get(date) ?? null}
              isToday={date === today}
              compact={true}
            />
          ))}
        </div>
      )}
    </div>
  );
}
