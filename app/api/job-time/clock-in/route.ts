import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import {
  authorizeEditorRequest,
  isSameOriginEditorMutation,
} from "@/lib/editor-auth";
import {
  getActiveJobTimeEntries,
  closeAllRemainingActiveEntries,
  upsertClockIn,
  isJeffEditorId,
  normalizeEditorProfile,
  normalizeWorkDateFromUnknown,
} from "@/lib/job-time";
import { SupabaseConfigError } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(req, env);

  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (auth.source === "cookie" && !isSameOriginEditorMutation(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isJeffEditorId(auth.editorId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  }

  const { eventId, workDate, laNumber } = body as Record<string, unknown>;
  const eventIdStr = typeof eventId === "string" ? eventId.trim() : "";
  const workDateStr = normalizeWorkDateFromUnknown(workDate);
  const laNumberStr = typeof laNumber === "string" ? laNumber.trim() : undefined;

  if (!eventIdStr) {
    return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  }
  if (!workDateStr) {
    return NextResponse.json({ error: "missing_work_date" }, { status: 400 });
  }

  // TODO: Final production rule: validate workDate === today before allowing clock-in.
  // Deferred until Edit Times/Clear Entry are verified in production.

  console.log("[job-time:clock-in] received", { eventId: eventIdStr, workDate: workDateStr, editor: auth.editorId });

  try {
    const editorProfile = normalizeEditorProfile(auth.editorId);

    // All currently active rows for this editor (across all events).
    const activeEntries = await getActiveJobTimeEntries(editorProfile);

    // Idempotent: already clocked in for this exact event + workDate — return it.
    const exactMatch = activeEntries.find(
      (e) => e.google_event_id === eventIdStr && e.work_date === workDateStr,
    );
    if (exactMatch) {
      console.log("[job-time:clock-in] idempotent — existing row returned", {
        id: exactMatch.id,
        eventId: exactMatch.google_event_id,
        workDate: exactMatch.work_date,
      });
      return NextResponse.json({ entry: exactMatch });
    }

    // Sweep any unrelated active rows before creating the new one so only one
    // row is active at a time. Sweep failure is non-fatal — the new row can
    // still be created; orphaned rows are cleaned up on the next clock-out.
    if (activeEntries.length > 0) {
      const sweepAt = new Date().toISOString();
      try {
        const swept = await closeAllRemainingActiveEntries(editorProfile, sweepAt, null);
        console.log("[job-time:clock-in] swept unrelated active rows", { count: swept });
      } catch (sweepErr) {
        console.warn("[job-time:clock-in] sweep failed (non-fatal)", sweepErr instanceof Error ? sweepErr.message : sweepErr);
      }
    }

    const entry = await upsertClockIn(eventIdStr, editorProfile, workDateStr, laNumberStr);
    console.log("[job-time:clock-in] created row", {
      id: entry.id,
      eventId: entry.google_event_id,
      workDate: entry.work_date,
      clock_in_at: entry.clock_in_at,
      clock_out_at: entry.clock_out_at,
    });
    return NextResponse.json({ entry });
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return NextResponse.json(
        { error: "unavailable", message: "Hours tracking unavailable." },
        { status: 503 },
      );
    }
    console.error("[job-time:clock-in]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
