import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import {
  authorizeEditorRequest,
  isSameOriginEditorMutation,
} from "@/lib/editor-auth";
import {
  upsertEditTimes,
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
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { eventId, workDate, clockInAt, clockOutAt } = body as Record<string, unknown>;
  const eventIdStr = typeof eventId === "string" ? eventId.trim() : "";
  const workDateStr = normalizeWorkDateFromUnknown(workDate);
  const clockInAtStr = typeof clockInAt === "string" ? clockInAt.trim() : "";
  const clockOutAtStr = typeof clockOutAt === "string" && clockOutAt.trim() ? clockOutAt.trim() : null;

  if (!eventIdStr) {
    return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  }
  if (!workDateStr) {
    return NextResponse.json({ error: "missing_work_date" }, { status: 400 });
  }
  if (!clockInAtStr || Number.isNaN(Date.parse(clockInAtStr))) {
    return NextResponse.json({ error: "invalid_clock_in_at" }, { status: 400 });
  }
  if (clockOutAtStr !== null && Number.isNaN(Date.parse(clockOutAtStr))) {
    return NextResponse.json({ error: "invalid_clock_out_at" }, { status: 400 });
  }
  if (clockOutAtStr && Date.parse(clockOutAtStr) <= Date.parse(clockInAtStr)) {
    return NextResponse.json(
      { error: "clock_out_before_clock_in", message: "Clock-out must be after clock-in." },
      { status: 422 },
    );
  }

  console.log("[job-time:edit-times] eventId:", eventIdStr, "workDate:", workDateStr, "editor:", auth.editorId);

  try {
    const entry = await upsertEditTimes(
      eventIdStr,
      normalizeEditorProfile(auth.editorId),
      workDateStr,
      clockInAtStr,
      clockOutAtStr,
    );
    return NextResponse.json({ entry });
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return NextResponse.json(
        { error: "unavailable", message: "Hours tracking unavailable." },
        { status: 503 },
      );
    }
    console.error("[job-time:edit-times]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
