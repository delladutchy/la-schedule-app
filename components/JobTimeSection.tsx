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
  clock_in_at: string | null;
  clock_out_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

type FetchState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error" }
  | { status: "ready"; entry: JobTimeEntry | null };

interface Props {
  eventId: string;
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

export function JobTimeSection({ eventId, editorToken }: Props) {
  const [fetchState, setFetchState] = useState<FetchState>({ status: "loading" });
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isActionPending, setIsActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setFetchState({ status: "loading" });
    setActionError(null);
    let cancelled = false;

    const headers = buildAuthHeaders(editorToken);
    fetch(`/api/job-time?eventId=${encodeURIComponent(eventId)}`, {
      headers,
      credentials: "same-origin",
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 503) { setFetchState({ status: "unavailable" }); return; }
        if (!res.ok) { setFetchState({ status: "error" }); return; }
        const json = await res.json() as { entry: JobTimeEntry | null };
        if (!cancelled) setFetchState({ status: "ready", entry: json.entry });
      })
      .catch(() => { if (!cancelled) setFetchState({ status: "error" }); });

    return () => { cancelled = true; };
  }, [eventId, editorToken]);

  // Running clock — ticks every second while clocked in
  useEffect(() => {
    if (fetchState.status !== "ready") return undefined;
    const entry = fetchState.entry;
    if (!entry?.clock_in_at || entry.clock_out_at) return undefined;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [fetchState]);

  const handleClockIn = async () => {
    if (isActionPending) return;
    setIsActionPending(true);
    setActionError(null);
    try {
      const res = await fetch("/api/job-time/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...buildAuthHeaders(editorToken) },
        credentials: "same-origin",
        body: JSON.stringify({ eventId }),
      });
      if (res.status === 503) { setFetchState({ status: "unavailable" }); return; }
      if (!res.ok) { setActionError("Could not clock in. Try again."); return; }
      const json = await res.json() as { entry: JobTimeEntry };
      setFetchState({ status: "ready", entry: json.entry });
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
        headers: { "Content-Type": "application/json", ...buildAuthHeaders(editorToken) },
        credentials: "same-origin",
        body: JSON.stringify({ eventId }),
      });
      if (res.status === 503) { setFetchState({ status: "unavailable" }); return; }
      if (res.status === 404) { setActionError("No active clock-in found."); return; }
      if (!res.ok) { setActionError("Could not clock out. Try again."); return; }
      const json = await res.json() as { entry: JobTimeEntry };
      setFetchState({ status: "ready", entry: json.entry });
    } catch {
      setActionError("Network error. Try again.");
    } finally {
      setIsActionPending(false);
    }
  };

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
    // Silent failure — don't show errors to surface issues to public users
    return null;
  }

  const entry = fetchState.entry;

  // State 1: Not clocked in
  if (!entry?.clock_in_at) {
    return (
      <div className="job-time-section">
        <p className="board-day-modal-event-label">Hours</p>
        <p className="job-time-status job-time-status--muted">Not clocked in</p>
        {actionError ? (
          <p className="job-time-error" role="alert">{actionError}</p>
        ) : null}
        <button
          type="button"
          className="job-time-button job-time-button--clock-in"
          onClick={() => { void handleClockIn(); }}
          disabled={isActionPending}
        >
          {isActionPending ? "Clocking in…" : "Clock In"}
        </button>
      </div>
    );
  }

  // State 2: Clocked in, running
  if (!entry.clock_out_at) {
    const { totalHours } = calculateTimeHours(
      entry.clock_in_at,
      null,
      new Date(nowMs).toISOString(),
    );
    return (
      <div className="job-time-section">
        <p className="board-day-modal-event-label">Hours</p>
        <p className="job-time-status">
          Clocked in at {formatClockTime(entry.clock_in_at)}
        </p>
        <p className="job-time-elapsed" aria-live="polite" aria-atomic="true">
          {formatElapsed(totalHours)}
        </p>
        {actionError ? (
          <p className="job-time-error" role="alert">{actionError}</p>
        ) : null}
        <button
          type="button"
          className="job-time-button job-time-button--clock-out"
          onClick={() => { void handleClockOut(); }}
          disabled={isActionPending}
        >
          {isActionPending ? "Clocking out…" : "Clock Out"}
        </button>
      </div>
    );
  }

  // State 3: Clocked out
  const { totalHours, regularHours, overtimeHours } = calculateTimeHours(
    entry.clock_in_at,
    entry.clock_out_at,
  );
  return (
    <div className="job-time-section">
      <p className="board-day-modal-event-label">Hours</p>
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
    </div>
  );
}
