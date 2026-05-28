import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import {
  authorizeEditorRequest,
  isSameOriginEditorMutation,
} from "@/lib/editor-auth";
import {
  closeAllRemainingActiveEntries,
  isJeffEditorId,
  normalizeEditorProfile,
} from "@/lib/job-time";
import { SupabaseConfigError } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/job-time/clear-active
 *
 * Closes all active (clock_in_at set, clock_out_at null) Jeff rows.
 * Sets clock_out_at = now and updated_at = now. Does not delete rows.
 * Jeff-only. Returns { closed: number }.
 *
 * Use from browser devtools (no CSRF risk — same-origin cookie or bearer):
 *   fetch('/api/job-time/clear-active', {
 *     method: 'POST',
 *     headers: { Authorization: 'Bearer <jeff-token>' }
 *   }).then(r => r.json()).then(console.log)
 */
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

  try {
    const editorProfile = normalizeEditorProfile(auth.editorId);
    const now = new Date().toISOString();
    const closed = await closeAllRemainingActiveEntries(editorProfile, now, null);
    console.log("[job-time:clear-active]", { editor: editorProfile, closed, clearedAt: now });
    return NextResponse.json({ closed });
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return NextResponse.json(
        { error: "unavailable", message: "Hours tracking unavailable." },
        { status: 503 },
      );
    }
    console.error("[job-time:clear-active]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
