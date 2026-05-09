import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { readCurrentSnapshot } from "@/lib/store";
import { classifySnapshot } from "@/lib/view";
import {
  buildSanitizedBoardWindowPayload,
  parseBoardWindowQuery,
  resolveBoardRequestEditorId,
} from "@/lib/board-window";
import type { Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";

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
    `[perf] board-window total ms readSnapshot=${perfReadSnapshotMs} buildWindow=${perfBuildMs} total=${Date.now() - perfStartedAt} view=${query.viewMode}`,
  );

  return NextResponse.json(payload);
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
