import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import {
  getJobTimeEntry,
  isJeffEditorId,
  normalizeEditorProfile,
} from "@/lib/job-time";
import { SupabaseConfigError } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(req, env);

  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isJeffEditorId(auth.editorId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const eventId = url.searchParams.get("eventId")?.trim();
  if (!eventId) {
    return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  }

  try {
    const entry = await getJobTimeEntry(eventId, normalizeEditorProfile(auth.editorId));
    return NextResponse.json({ entry: entry ?? null });
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return NextResponse.json(
        { error: "unavailable", message: "Hours tracking unavailable." },
        { status: 503 },
      );
    }
    console.error("[job-time:get]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
