import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { readCurrentSnapshot } from "@/lib/store";
import { classifySnapshot } from "@/lib/view";
import {
  buildSanitizedBoardWindowPayload,
  parseBoardWindowQuery,
  resolveBoardRequestEditorId,
} from "@/lib/board-window";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { file, env } = getConfig();
  const nowMs = Date.now();

  const snapshot = await readCurrentSnapshot(env.BLOBS_STORE_NAME);
  const state = classifySnapshot(snapshot, nowMs, {
    freshTtlMinutes: file.freshTtlMinutes,
    hardTtlMinutes: file.hardTtlMinutes,
  });

  if (!state.snapshot || state.status === "unavailable") {
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
  const payload = buildSanitizedBoardWindowPayload({
    snapshot: state.snapshot,
    snapshotStatus: state.status,
    file,
    env,
    query,
    resolvedEditorId,
    nowMs,
  });

  return NextResponse.json(payload);
}
