import "server-only";

import { DateTime } from "luxon";
import { applyBuffers, type Interval } from "./intervals";
import { isBoardCacheEnabled } from "./board-payload-cache";
import {
  precomputeBoardPayloadCaches,
  type PrecomputeBoardPayloadCacheResult,
} from "./precompute-board-payloads";
import { buildAndPersistSnapshot, type BuildResult } from "./sync";
import {
  writeCurrentSnapshot,
  type SnapshotWriteResult,
} from "./store";
import type { EnvConfig, FileConfig } from "./config";
import type { CalendarDisplayMode, NamedEvent, Snapshot } from "./types";

export interface MutationEventRecord {
  eventId: string;
  calendarId: string;
  summary: string;
  description?: string;
  ownerEditor?: string;
  startDate: string;
  endDateExclusive: string;
}

export type SnapshotMutation =
  | { action: "create" | "edit"; event: MutationEventRecord }
  | { action: "delete"; eventId: string; calendarId: string };

export interface PostMutationSnapshotRefreshOptions {
  storeName: string;
  baselineSnapshot: Snapshot | null;
  mutation: SnapshotMutation;
  file: Pick<
    FileConfig,
    "timezone" | "preBufferMinutes" | "postBufferMinutes" | "workdayStartHour" | "workdayEndHour"
  >;
  env: Pick<
    EnvConfig,
    "CALENDAR_DISPLAY_MODES" | "GOOGLE_CALENDAR_ID" | "OVERTURE_CALENDAR_ID"
  >;
  nowMs?: number;
}

export interface PostMutationSnapshotRefreshResult {
  status: "ok" | "failed";
  snapshot?: Snapshot;
  error?: string;
  erroredCalendarIds?: string[];
  skipped?: boolean;
  mode: "fast_patch" | "full_sync_fallback";
  writeResult?: SnapshotWriteResult;
  precomputeResult?: PrecomputeBoardPayloadCacheResult;
}

interface ReconciliationScheduleOptions {
  requestUrl: string;
  adminToken: string;
  reason: string;
  editorId: string;
  generatedAtUtc: string;
  action: "create" | "patch" | "delete";
}

interface ReconciliationScheduleResult {
  queued: boolean;
  statusCode?: number;
  message?: string;
}

function parseSafeMs(iso: string): number | null {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function trimToNonEmpty(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOwnerEditor(value: string | undefined): string | undefined {
  const trimmed = trimToNonEmpty(value);
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(normalized)) return undefined;
  return normalized;
}

function clampNamedEventToWindow(
  event: NamedEvent,
  windowStartMs: number,
  windowEndMs: number,
): NamedEvent | null {
  const startMs = parseSafeMs(event.startUtc);
  const endMs = parseSafeMs(event.endUtc);
  if (startMs === null || endMs === null || endMs <= startMs) return null;

  const clippedStart = Math.max(startMs, windowStartMs);
  const clippedEnd = Math.min(endMs, windowEndMs);
  if (clippedEnd <= clippedStart) return null;

  const summary = event.summary.trim();
  if (!summary) return null;

  return {
    ...event,
    startUtc: new Date(clippedStart).toISOString(),
    endUtc: new Date(clippedEnd).toISOString(),
    summary,
    ...(trimToNonEmpty(event.description) ? { description: trimToNonEmpty(event.description) } : {}),
    ...(normalizeOwnerEditor(event.ownerEditor) ? { ownerEditor: normalizeOwnerEditor(event.ownerEditor) } : {}),
  };
}

function dedupeAndSortNamedEvents(events: NamedEvent[]): NamedEvent[] {
  const deduped = new Map<string, NamedEvent>();

  for (const event of events) {
    const startMs = parseSafeMs(event.startUtc);
    const endMs = parseSafeMs(event.endUtc);
    if (startMs === null || endMs === null || endMs <= startMs) continue;

    const eventId = trimToNonEmpty(event.eventId);
    const calendarId = trimToNonEmpty(event.calendarId);
    const summary = event.summary.trim();
    if (!summary) continue;

    const key = eventId
      ? `${calendarId ?? ""}|id|${eventId}`
      : `${calendarId ?? ""}|${event.startUtc}|${event.endUtc}|${summary}`;

    deduped.set(key, {
      ...event,
      ...(eventId ? { eventId } : {}),
      ...(calendarId ? { calendarId } : {}),
      summary,
    });
  }

  return [...deduped.values()].sort((a, b) => {
    const aStart = parseSafeMs(a.startUtc) ?? 0;
    const bStart = parseSafeMs(b.startUtc) ?? 0;
    if (aStart !== bStart) return aStart - bStart;
    const aEnd = parseSafeMs(a.endUtc) ?? 0;
    const bEnd = parseSafeMs(b.endUtc) ?? 0;
    if (aEnd !== bEnd) return aEnd - bEnd;
    return a.summary.localeCompare(b.summary);
  });
}

function namedEventToInterval(event: NamedEvent): Interval | null {
  const startMs = parseSafeMs(event.startUtc);
  const endMs = parseSafeMs(event.endUtc);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return {
    startMs,
    endMs,
    tentative: false,
  };
}

function deriveBusyFromNamedEvents(
  namedEvents: NamedEvent[],
  opts: {
    preBufferMinutes: number;
    postBufferMinutes: number;
    windowStartMs: number;
    windowEndMs: number;
  },
): Snapshot["busy"] {
  const baseIntervals = namedEvents
    .map((event) => namedEventToInterval(event))
    .filter((interval): interval is Interval => interval != null);

  const buffered = applyBuffers(
    baseIntervals,
    opts.preBufferMinutes * 60 * 1000,
    opts.postBufferMinutes * 60 * 1000,
  );

  const clipped = buffered
    .map((interval) => ({
      startMs: Math.max(interval.startMs, opts.windowStartMs),
      endMs: Math.min(interval.endMs, opts.windowEndMs),
      tentative: interval.tentative,
    }))
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  return clipped.map((interval) => ({
    startUtc: new Date(interval.startMs).toISOString(),
    endUtc: new Date(interval.endMs).toISOString(),
    ...(interval.tentative ? { tentative: true } : {}),
  }));
}

function toEventUtcBounds(
  timezone: string,
  startDate: string,
  endDateExclusive: string,
): { startUtc: string; endUtc: string } | null {
  const start = DateTime.fromISO(startDate, { zone: timezone }).startOf("day");
  const end = DateTime.fromISO(endDateExclusive, { zone: timezone }).startOf("day");
  if (!start.isValid || !end.isValid || end <= start) return null;
  const startUtc = start.toUTC().toISO();
  const endUtc = end.toUTC().toISO();
  if (!startUtc || !endUtc) return null;
  return { startUtc, endUtc };
}

function resolveDisplayModeForCalendar(
  calendarId: string,
  env: Pick<EnvConfig, "CALENDAR_DISPLAY_MODES">,
): CalendarDisplayMode {
  return env.CALENDAR_DISPLAY_MODES[calendarId] ?? "details";
}

function buildNamedEventFromMutationEvent(
  event: MutationEventRecord,
  timezone: string,
  env: Pick<EnvConfig, "CALENDAR_DISPLAY_MODES">,
): NamedEvent | null {
  const bounds = toEventUtcBounds(timezone, event.startDate, event.endDateExclusive);
  if (!bounds) return null;

  const summary = event.summary.trim();
  if (!summary) return null;

  const calendarId = trimToNonEmpty(event.calendarId);
  if (!calendarId) return null;

  const displayMode = resolveDisplayModeForCalendar(calendarId, env);

  return {
    startUtc: bounds.startUtc,
    endUtc: bounds.endUtc,
    summary: displayMode === "private" ? "Unavailable" : summary,
    eventId: event.eventId,
    ...(trimToNonEmpty(event.description) ? { description: trimToNonEmpty(event.description) } : {}),
    ...(normalizeOwnerEditor(event.ownerEditor) ? { ownerEditor: normalizeOwnerEditor(event.ownerEditor) } : {}),
    calendarId,
    displayMode,
  };
}

function removeMatchingEvent(
  namedEvents: NamedEvent[],
  eventId: string,
  calendarId: string,
): { remaining: NamedEvent[]; removed: boolean } {
  let removed = false;
  const remaining = namedEvents.filter((event) => {
    const matches = event.eventId === eventId && (event.calendarId ?? "") === calendarId;
    if (matches) removed = true;
    return !matches;
  });
  return { remaining, removed };
}

function buildFastPatchedSnapshot(
  opts: PostMutationSnapshotRefreshOptions,
): { snapshot: Snapshot | null; reason?: string } {
  const baseline = opts.baselineSnapshot;
  if (!baseline) {
    return { snapshot: null, reason: "missing_baseline_snapshot" };
  }

  const windowStartMs = parseSafeMs(baseline.windowStartUtc);
  const windowEndMs = parseSafeMs(baseline.windowEndUtc);
  if (windowStartMs === null || windowEndMs === null || windowEndMs <= windowStartMs) {
    return { snapshot: null, reason: "invalid_snapshot_window" };
  }

  if ((opts.mutation.action === "edit" || opts.mutation.action === "delete") && !baseline.namedEvents) {
    return { snapshot: null, reason: "missing_named_events_for_mutation" };
  }

  const existingNamedEvents = baseline.namedEvents ? [...baseline.namedEvents] : [];
  let nextNamedEvents = existingNamedEvents;

  if (opts.mutation.action === "delete") {
    const removed = removeMatchingEvent(
      existingNamedEvents,
      opts.mutation.eventId,
      opts.mutation.calendarId,
    );
    if (!removed.removed) {
      return { snapshot: null, reason: "delete_event_not_found_in_snapshot" };
    }
    nextNamedEvents = removed.remaining;
  }

  if (opts.mutation.action === "edit") {
    const removed = removeMatchingEvent(
      existingNamedEvents,
      opts.mutation.event.eventId,
      opts.mutation.event.calendarId,
    );
    if (!removed.removed) {
      return { snapshot: null, reason: "edit_event_not_found_in_snapshot" };
    }
    const replacement = buildNamedEventFromMutationEvent(
      opts.mutation.event,
      opts.file.timezone,
      opts.env,
    );
    if (!replacement) {
      return { snapshot: null, reason: "invalid_edit_event" };
    }
    nextNamedEvents = [...removed.remaining, replacement];
  }

  if (opts.mutation.action === "create") {
    const created = buildNamedEventFromMutationEvent(
      opts.mutation.event,
      opts.file.timezone,
      opts.env,
    );
    if (!created) {
      return { snapshot: null, reason: "invalid_create_event" };
    }
    const removed = removeMatchingEvent(
      existingNamedEvents,
      created.eventId ?? "",
      created.calendarId ?? "",
    );
    nextNamedEvents = [...removed.remaining, created];
  }

  const normalizedEvents = dedupeAndSortNamedEvents(
    nextNamedEvents
      .map((event) => clampNamedEventToWindow(event, windowStartMs, windowEndMs))
      .filter((event): event is NamedEvent => event != null),
  );

  const nextBusy = deriveBusyFromNamedEvents(normalizedEvents, {
    preBufferMinutes: opts.file.preBufferMinutes,
    postBufferMinutes: opts.file.postBufferMinutes,
    windowStartMs,
    windowEndMs,
  });

  const nowMs = opts.nowMs ?? Date.now();
  const generatedAtUtc = new Date(nowMs).toISOString();

  return {
    snapshot: {
      ...baseline,
      generatedAtUtc,
      busy: nextBusy,
      ...(normalizedEvents.length > 0 ? { namedEvents: normalizedEvents } : {}),
    },
  };
}

function summarizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function refreshSnapshotAfterMutation(
  opts: PostMutationSnapshotRefreshOptions,
): Promise<PostMutationSnapshotRefreshResult> {
  const fastPatch = buildFastPatchedSnapshot(opts);
  if (!fastPatch.snapshot) {
    const fallback = await buildAndPersistSnapshot(opts.nowMs ?? Date.now());
    return {
      status: fallback.status,
      ...(fallback.snapshot ? { snapshot: fallback.snapshot } : {}),
      ...(fallback.error ? { error: fallback.error } : {}),
      ...(fallback.erroredCalendarIds ? { erroredCalendarIds: fallback.erroredCalendarIds } : {}),
      ...(fallback.skipped != null ? { skipped: fallback.skipped } : {}),
      mode: "full_sync_fallback",
    };
  }

  try {
    const writeResult = await writeCurrentSnapshot(opts.storeName, fastPatch.snapshot);

    let precomputeResult: PrecomputeBoardPayloadCacheResult | undefined;
    if (isBoardCacheEnabled()) {
      if (writeResult.supabaseWriteAttempted && !writeResult.supabaseWriteSucceeded) {
        const codePart = writeResult.supabaseWriteErrorCode
          ? ` code=${writeResult.supabaseWriteErrorCode}`
          : "";
        const messagePart = writeResult.supabaseWriteErrorMessage
          ? ` message=${writeResult.supabaseWriteErrorMessage}`
          : "";
        console.error(
          `[sync] board-cache precompute skipped because snapshot_cache write-through failed store=${opts.storeName} generatedAtUtc=${fastPatch.snapshot.generatedAtUtc}${codePart}${messagePart}`,
        );
      } else {
        try {
          precomputeResult = await precomputeBoardPayloadCaches({
            snapshot: fastPatch.snapshot,
            file: {
              timezone: opts.file.timezone,
              workdayStartHour: opts.file.workdayStartHour,
              workdayEndHour: opts.file.workdayEndHour,
            },
            env: {
              GOOGLE_CALENDAR_ID: opts.env.GOOGLE_CALENDAR_ID,
              OVERTURE_CALENDAR_ID: opts.env.OVERTURE_CALENDAR_ID,
            },
            nowMs: opts.nowMs,
            scopes: ["selected"],
          });
        } catch (error) {
          console.error(
            `[sync] board-cache selected precompute failed (continuing): ${summarizeError(error)}`,
          );
        }
      }
    }

    return {
      status: "ok",
      snapshot: fastPatch.snapshot,
      mode: "fast_patch",
      writeResult,
      ...(precomputeResult ? { precomputeResult } : {}),
    };
  } catch (error) {
    const message = summarizeError(error);
    console.error(`[snapshot] fast mutation patch write failed: ${message}`);

    const fallback = await buildAndPersistSnapshot(opts.nowMs ?? Date.now());
    return {
      status: fallback.status,
      ...(fallback.snapshot ? { snapshot: fallback.snapshot } : {}),
      ...(fallback.error ? { error: fallback.error } : {}),
      ...(fallback.erroredCalendarIds ? { erroredCalendarIds: fallback.erroredCalendarIds } : {}),
      ...(fallback.skipped != null ? { skipped: fallback.skipped } : {}),
      mode: "full_sync_fallback",
    };
  }
}

function buildBackgroundSyncUrl(requestUrl: string): string {
  const origin = new URL(requestUrl).origin;
  return `${origin}/.netlify/functions/reconcile-snapshot-background`;
}

export async function scheduleDeferredReconciliationSync(
  opts: ReconciliationScheduleOptions,
): Promise<ReconciliationScheduleResult> {
  if (process.env.NODE_ENV === "test") {
    return { queued: false, message: "test_environment" };
  }

  const targetUrl = buildBackgroundSyncUrl(opts.requestUrl);
  const payload = {
    reason: opts.reason,
    editorId: opts.editorId,
    generatedAtUtc: opts.generatedAtUtc,
    action: opts.action,
    requestedAtUtc: new Date().toISOString(),
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 800);

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.adminToken}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok && response.status !== 202) {
      return {
        queued: false,
        statusCode: response.status,
        message: "background_sync_not_accepted",
      };
    }

    return {
      queued: true,
      statusCode: response.status,
    };
  } catch (error) {
    return {
      queued: false,
      message: summarizeError(error),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export type { BuildResult };
