import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import {
  authorizeEditorRequest,
  isSameOriginEditorMutation,
} from "@/lib/editor-auth";
import {
  upsertClockOut,
  isJeffEditorId,
  normalizeEditorProfile,
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

  const { eventId } = body as Record<string, unknown>;
  const eventIdStr = typeof eventId === "string" ? eventId.trim() : "";
  if (!eventIdStr) {
    return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  }

  try {
    const entry = await upsertClockOut(
      eventIdStr,
      normalizeEditorProfile(auth.editorId),
    );
    if (!entry) {
      return NextResponse.json(
        { error: "not_clocked_in", message: "No active clock-in found for this job." },
        { status: 404 },
      );
    }
    return NextResponse.json({ entry });
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return NextResponse.json(
        { error: "unavailable", message: "Hours tracking unavailable." },
        { status: 503 },
      );
    }
    console.error("[job-time:clock-out]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
