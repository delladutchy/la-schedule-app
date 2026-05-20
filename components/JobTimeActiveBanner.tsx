"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { calculateTimeHours, formatElapsed } from "@/lib/job-time-calculations";
import type { JobTimeEntry } from "@/components/JobTimeSection";

const ACTIVE_CLOCK_REFRESH_MS = 5000;

interface ActiveEntriesResponse {
  entries?: JobTimeEntry[];
}

interface Props {
  isJeffEditor: boolean;
  editorToken: string | null;
  suppressed?: boolean;
}

type ActiveBannerFetchState =
  | { status: "loading"; requestKey: string }
  | { status: "error"; requestKey: string }
  | { status: "ready"; requestKey: string };

function buildAuthHeaders(editorToken: string | null): Record<string, string> {
  if (editorToken) return { Authorization: `Bearer ${editorToken}` };
  return {};
}

function isRunningEntry(entry: JobTimeEntry): boolean {
  return !!entry.clock_in_at && !entry.clock_out_at;
}

function parseSortableTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resolvePrimaryActiveEntry(entries: JobTimeEntry[]): JobTimeEntry | null {
  const running = entries.filter(isRunningEntry);
  if (running.length === 0) return null;
  const sorted = [...running].sort((a, b) => {
    const updatedDiff = parseSortableTimestamp(b.updated_at) - parseSortableTimestamp(a.updated_at);
    if (updatedDiff !== 0) return updatedDiff;
    const createdDiff = parseSortableTimestamp(b.created_at) - parseSortableTimestamp(a.created_at);
    if (createdDiff !== 0) return createdDiff;
    const clockInDiff = parseSortableTimestamp(b.clock_in_at) - parseSortableTimestamp(a.clock_in_at);
    if (clockInDiff !== 0) return clockInDiff;
    return b.id.localeCompare(a.id);
  });
  return sorted[0] ?? null;
}

export function shouldRenderActiveClockBanner(
  isJeffEditor: boolean,
  hasFreshServerSnapshot: boolean,
  suppressed: boolean,
  primaryEntry: JobTimeEntry | null,
): boolean {
  return !!(
    isJeffEditor
    && hasFreshServerSnapshot
    && !suppressed
    && primaryEntry?.clock_in_at
    && !primaryEntry.clock_out_at
  );
}

function formatBannerWorkDate(isoDate: string): string {
  const [yRaw, mRaw, dRaw] = isoDate.split("-").map(Number);
  const y = yRaw ?? 1970;
  const m = mRaw ?? 1;
  const d = dRaw ?? 1;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function resolveBannerLabel(entry: JobTimeEntry): string {
  if (entry.la_number?.trim()) return `LA#${entry.la_number.trim()}`;
  return "Clocked in";
}

export function JobTimeActiveBanner({
  isJeffEditor,
  editorToken,
  suppressed = false,
}: Props) {
  const requestKey = `${isJeffEditor ? "jeff" : "other"}::${editorToken ?? "none"}`;
  const [entries, setEntries] = useState<JobTimeEntry[]>([]);
  const [fetchState, setFetchState] = useState<ActiveBannerFetchState>({
    status: "loading",
    requestKey,
  });
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  // Holds the latest fetch function so suppression-lift effect can call it
  // without adding it as a dependency (avoids restarting the interval).
  const latestFetchRef = useRef<(() => Promise<void>) | null>(null);
  const prevSuppressedRef = useRef(suppressed);
  // Set to true by the clock-out event so the next fetch logs the post-clock-out state.
  const clockOutTriggerRef = useRef(false);

  useEffect(() => {
    if (!isJeffEditor) {
      setEntries([]);
      setFetchState({ status: "ready", requestKey });
      return undefined;
    }

    let cancelled = false;

    const fetchActiveEntries = async () => {
      try {
        const res = await fetch("/api/job-time/active", {
          headers: buildAuthHeaders(editorToken),
          credentials: "same-origin",
          cache: "no-store",
        });

        if (cancelled) return;

        if (res.status === 401 || res.status === 403) {
          setEntries([]);
          setFetchState({ status: "error", requestKey });
          console.warn("[job-time:active-banner:get]", {
            source: "server",
            requestKey,
            entriesLength: 0,
            status: res.status,
            runningRendered: false,
          });
          return;
        }
        if (!res.ok) {
          setEntries([]);
          setFetchState({ status: "error", requestKey });
          console.warn("[job-time:active-banner:get]", {
            source: "server",
            requestKey,
            entriesLength: 0,
            status: res.status,
            runningRendered: false,
          });
          return;
        }

        const json = await res.json() as ActiveEntriesResponse;
        const rows = Array.isArray(json.entries) ? json.entries : [];
        const activeRows = rows.filter(isRunningEntry);
        const firstActive = activeRows[0] ?? null;
        setEntries(activeRows);
        setFetchState({ status: "ready", requestKey });
        if (clockOutTriggerRef.current) {
          clockOutTriggerRef.current = false;
          console.log("[job-time:active-banner-after-clock-out]", {
            source: "server",
            requestKey,
            activeCount: activeRows.length,
            runningRendered: activeRows.length > 0,
          });
        }
        console.log("[job-time:active-banner:get]", {
          source: "server",
          requestKey,
          entriesLength: activeRows.length,
          firstActiveEventId: firstActive?.google_event_id ?? null,
          firstActiveWorkDate: firstActive?.work_date ?? null,
          status: res.status,
          runningRendered: activeRows.length > 0,
          rows: activeRows.map((entry) => ({
            eventId: entry.google_event_id,
            workDate: entry.work_date,
            id: entry.id,
          })),
        });
      } catch {
        if (!cancelled) {
          setEntries([]);
          setFetchState({ status: "error", requestKey });
          console.warn("[job-time:active-banner:get]", {
            source: "server",
            requestKey,
            entriesLength: 0,
            status: "network_error",
            runningRendered: false,
          });
        }
      }
    };

    latestFetchRef.current = fetchActiveEntries;
    setEntries([]);
    setFetchState({ status: "loading", requestKey });
    void fetchActiveEntries();
    const intervalId = window.setInterval(() => {
      void fetchActiveEntries();
    }, ACTIVE_CLOCK_REFRESH_MS);

    const handleVisibilityRefresh = () => {
      if (document.visibilityState === "visible") {
        void fetchActiveEntries();
      }
    };

    const handleClockOutCompleted = () => {
      clockOutTriggerRef.current = true;
      void latestFetchRef.current?.();
    };

    window.addEventListener("focus", handleVisibilityRefresh);
    document.addEventListener("visibilitychange", handleVisibilityRefresh);
    window.addEventListener("job-time:clock-out-completed", handleClockOutCompleted);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleVisibilityRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityRefresh);
      window.removeEventListener("job-time:clock-out-completed", handleClockOutCompleted);
    };
  }, [editorToken, isJeffEditor, requestKey]);

  // Trigger an immediate refetch the moment the modal suppression lifts so the
  // banner appears without waiting for the next 5-second poll interval.
  useEffect(() => {
    const wasSuppressed = prevSuppressedRef.current;
    prevSuppressedRef.current = suppressed;
    if (wasSuppressed && !suppressed && isJeffEditor) {
      void latestFetchRef.current?.();
    }
  }, [suppressed, isJeffEditor]);

  const primaryEntry = useMemo(() => resolvePrimaryActiveEntry(entries), [entries]);
  const hasFreshServerSnapshot = fetchState.status === "ready" && fetchState.requestKey === requestKey;
  const runningRendered = hasFreshServerSnapshot && !!primaryEntry?.clock_in_at && !primaryEntry?.clock_out_at;

  useEffect(() => {
    console.log("[job-time:active-banner:render]", {
      source: "server",
      requestKey,
      entriesLength: entries.length,
      fetchStatus: fetchState.status,
      primaryEventId: primaryEntry?.google_event_id ?? null,
      primaryWorkDate: primaryEntry?.work_date ?? null,
      runningRendered,
    });
  }, [
    requestKey,
    entries.length,
    fetchState.status,
    primaryEntry?.google_event_id,
    primaryEntry?.work_date,
    runningRendered,
  ]);

  useEffect(() => {
    if (!primaryEntry?.clock_in_at || primaryEntry.clock_out_at) return undefined;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [primaryEntry?.id, primaryEntry?.clock_in_at, primaryEntry?.clock_out_at]);

  if (!shouldRenderActiveClockBanner(isJeffEditor, hasFreshServerSnapshot, suppressed, primaryEntry)) {
    return null;
  }
  const activeEntry = primaryEntry;
  if (!activeEntry?.clock_in_at) return null;

  const elapsed = formatElapsed(
    calculateTimeHours(activeEntry.clock_in_at, null, new Date(nowMs).toISOString()).totalHours,
  );
  const extraCount = Math.max(0, entries.length - 1);
  const workDateLabel = formatBannerWorkDate(activeEntry.work_date);
  const headline = resolveBannerLabel(activeEntry);

  return (
    <div className="active-clock-row" aria-live="polite" aria-label="Active clock status">
      <div className="active-clock-pill">
        <div className="active-clock-pill__dot" aria-hidden="true" />
        <span className="active-clock-pill__primary">
          {headline}{extraCount > 0 ? ` (+${extraCount})` : ""} · {elapsed}
        </span>
        <span className="active-clock-pill__date">{workDateLabel}</span>
      </div>
    </div>
  );
}
