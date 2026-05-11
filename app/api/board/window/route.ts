import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { readCurrentSnapshot } from "@/lib/store";
import {
  classifySnapshot,
  resolveMonthNavigation,
  resolveWeekNavigation,
} from "@/lib/view";
import {
  buildSanitizedBoardWindowPayload,
  parseBoardWindowQuery,
  resolveBoardRequestEditorId,
} from "@/lib/board-window";
import {
  isBoardCacheEnabled,
  readBoardPayloadCache,
  resolveBoardPayloadEditorBucket,
} from "@/lib/board-payload-cache";
import { parseBoardWindowPayload } from "@/lib/board-window-payload-schema";
import { todayInZone } from "@/lib/time";
import type { Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";
const TODAY_TIMEZONE = "America/New_York";

export async function GET(req: Request) {
  const { file, env } = getConfig();
  const nowMs = Date.now();
  // [perf] temporary instrumentation — remove once perf review concludes.
  const perfStartedAt = Date.now();

  const perfReadSnapshotStartedAt = Date.now();
  const snapshot = await readCurrentSnapshot(env.BLOBS_STORE_NAME);
  const perfReadSnapshotMs = Date.now() - perfReadSnapshotStartedAt;
  let state = classifySnapshot(snapshot, nowMs, {
    freshTtlMinutes: file.freshTtlMinutes,
    hardTtlMinutes: file.hardTtlMinutes,
  });

  // Mirror page render: prefer last-known-good stale snapshot over 503 when
  // the snapshot is parseable and its window still covers the present.
  if (state.status === "unavailable" && snapshot) {
    const rescued = rescueStaleSnapshot(snapshot, nowMs);
    if (rescued) {
      console.warn(
        `[board-window] last-known-good fallback age=${rescued.ageMinutes !== null ? Math.round(rescued.ageMinutes) : "?"}m generatedAt=${snapshot.generatedAtUtc}`,
      );
      state = rescued;
    }
  }

  if (!state.snapshot || state.status === "unavailable") {
    console.warn(
      `[board-window] unavailable hadParseableSnapshot=${snapshot != null} reason=${state.reason ?? "snapshot_unavailable"}`,
    );
    return NextResponse.json(
      {
        status: "unavailable",
        reason: state.reason ?? "snapshot_unavailable",
      },
      { status: 503 },
    );
  }

  const query = parseBoardWindowQuery(new URL(req.url));
  const resolvedEditorId = resolveBoardRequestEditorId(req, env);

  if (isBoardCacheEnabled() && query.scope === "selected" && state.status === "ok") {
    const cacheSelected = resolveSelectedCacheCoordinates({
      query,
      snapshot: state.snapshot,
      timezone: file.timezone,
      nowMs,
    });
    const editorBucket = resolveBoardPayloadEditorBucket(resolvedEditorId);

    try {
      const cached = await readBoardPayloadCache({
        viewMode: query.viewMode,
        weekStart: cacheSelected.weekStart,
        monthKey: cacheSelected.monthKey,
        editorBucket,
        scope: "selected",
      });

      if (cached) {
        const parsedPayload = parseBoardWindowPayload(cached.payload);
        const snapshotGeneratedMs = Date.parse(state.snapshot.generatedAtUtc);
        const cachedGeneratedMs = Date.parse(cached.generatedAtUtc);
        const cachedPayloadGeneratedMs = Date.parse(parsedPayload?.generatedAtUtc ?? "");
        const payloadBucket = resolveBoardPayloadEditorBucket(
          parsedPayload?.resolvedEditorId ?? null,
        );

        if (
          parsedPayload
          && payloadBucket === editorBucket
          && parsedPayload.selected.view === query.viewMode
          && parsedPayload.selected.weekStart === cacheSelected.weekStart
          && parsedPayload.selected.monthKey === cacheSelected.monthKey
          && Number.isFinite(snapshotGeneratedMs)
          && Number.isFinite(cachedGeneratedMs)
          && Number.isFinite(cachedPayloadGeneratedMs)
          && cachedGeneratedMs >= snapshotGeneratedMs
          && cachedPayloadGeneratedMs >= snapshotGeneratedMs
        ) {
          console.info(
            `[board-window] cache hit scope=selected view=${query.viewMode} editor=${editorBucket} week=${cacheSelected.weekStart} month=${cacheSelected.monthKey}`,
          );
          return NextResponse.json(parsedPayload);
        }

        console.info(
          `[board-window] cache bypass scope=selected view=${query.viewMode} editor=${editorBucket} reason=validation_or_staleness`,
        );
      } else {
        console.info(
          `[board-window] cache miss scope=selected view=${query.viewMode} editor=${editorBucket} week=${cacheSelected.weekStart} month=${cacheSelected.monthKey}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[board-window] cache read failed scope=selected view=${query.viewMode} message=${msg}`,
      );
    }
  }

  const perfBuildStartedAt = Date.now();
  const payload = buildSanitizedBoardWindowPayload({
    snapshot: state.snapshot,
    snapshotStatus: state.status,
    file,
    env,
    query,
    resolvedEditorId,
    nowMs,
  });
  const perfBuildMs = Date.now() - perfBuildStartedAt;
  console.info(
    `[perf] board-window total ms readSnapshot=${perfReadSnapshotMs} buildWindow=${perfBuildMs} total=${Date.now() - perfStartedAt} view=${query.viewMode} scope=${query.scope}`,
  );

  return NextResponse.json(payload);
}

function resolveSelectedCacheCoordinates(opts: {
  query: ReturnType<typeof parseBoardWindowQuery>;
  snapshot: Snapshot;
  timezone: string;
  nowMs: number;
}): { weekStart: string; monthKey: string } {
  const todayKey = todayInZone(TODAY_TIMEZONE, opts.nowMs);
  const todayMonthKey = todayKey.slice(0, 7);

  const requestedWeek = opts.query.requestedWeek ?? todayKey;
  const clampedRequestedWeek = requestedWeek < todayKey ? todayKey : requestedWeek;
  const weekStart = resolveWeekNavigation({
    requestedDate: clampedRequestedWeek,
    fallbackDate: todayKey,
    windowStartUtc: opts.snapshot.windowStartUtc,
    windowEndUtc: opts.snapshot.windowEndUtc,
    timezone: opts.timezone,
  }).weekStart;

  const requestedMonth = opts.query.requestedMonth ?? todayMonthKey;
  const clampedRequestedMonth = requestedMonth < todayMonthKey
    ? todayMonthKey
    : requestedMonth;
  const monthKey = resolveMonthNavigation({
    requestedMonth: clampedRequestedMonth,
    fallbackDate: todayKey,
    windowStartUtc: opts.snapshot.windowStartUtc,
    windowEndUtc: opts.snapshot.windowEndUtc,
    timezone: opts.timezone,
  }).monthKey;

  return { weekStart, monthKey };
}

function rescueStaleSnapshot(
  snapshot: Snapshot,
  nowMs: number,
): ReturnType<typeof classifySnapshot> | null {
  const generatedMs = Date.parse(snapshot.generatedAtUtc);
  const windowEndMs = Date.parse(snapshot.windowEndUtc);
  if (!Number.isFinite(generatedMs) || !Number.isFinite(windowEndMs)) return null;
  if (windowEndMs <= nowMs) return null;
  return {
    status: "stale",
    snapshot,
    ageMinutes: Math.max(0, (nowMs - generatedMs) / 60000),
  };
}
