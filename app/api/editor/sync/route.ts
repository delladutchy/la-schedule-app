import { NextResponse } from "next/server";
import { buildAndPersistSnapshot } from "@/lib/sync";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { appendAuditEvent } from "@/lib/audit-log";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(req, env);
  const editorId = auth.ok ? auth.editorId : "unknown";

  if (!auth.ok) {
    console.info(`[editor:sync] unauthorized editor=${editorId}`);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const result = await buildAndPersistSnapshot();
  const durationMs = Date.now() - started;

  if (result.status === "ok") {
    try {
      await appendAuditEvent(env.BLOBS_STORE_NAME, {
        editorId,
        action: "sync",
        status: "success",
      });
    } catch (auditError) {
      const msg = auditError instanceof Error ? auditError.message : String(auditError);
      console.error("[audit] append failed after manual sync:", msg);
    }
    console.info(`[editor:sync] ok editor=${editorId} ms total=${durationMs}`);
    return NextResponse.json({
      status: "ok",
      durationMs,
      busyBlocks: result.snapshot?.busy.length ?? 0,
      generatedAtUtc: result.snapshot?.generatedAtUtc,
    });
  }

  console.info(`[editor:sync] failed editor=${editorId} ms total=${durationMs}`);
  return NextResponse.json(
    {
      status: "failed",
      durationMs,
      error: result.error,
      erroredCalendarIds: result.erroredCalendarIds ?? [],
    },
    { status: 502 },
  );
}
