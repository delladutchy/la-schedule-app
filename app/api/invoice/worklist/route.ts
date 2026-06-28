import { NextRequest, NextResponse } from "next/server";
import { DateTime } from "luxon";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { listWorklistEntries, listWorklistEntriesFromSupabaseOnly } from "@/lib/invoice-worklist";
import { classifyGoogleError } from "@/lib/google-error";

export const dynamic = "force-dynamic";

/**
 * GET /api/invoice/worklist?months=18
 *
 * Jeff-only. Returns all gig events from the LA Google Calendar for the
 * requested date window, merged with Supabase invoice_data.
 *
 * Never touches invoice math, PDFs, emails, or QuickBooks.
 * Read-only. Safe to call repeatedly.
 */
export async function GET(request: NextRequest) {
  const { env, file } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isJeffEditorId(auth.editorId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url    = request.nextUrl;
  const months = Math.max(1, Math.min(60, parseInt(url.searchParams.get("months") ?? "18", 10) || 18));

  const tz     = file.timezone;
  const nowMs  = Date.now();
  const startMs = DateTime.now().setZone(tz).minus({ months }).startOf("day").toUTC().toMillis();

  try {
    const entries = await listWorklistEntries({ timeMinMs: startMs, timeMaxMs: nowMs + 1 });
    return NextResponse.json({ entries, fetchedAt: new Date(nowMs).toISOString() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (calendarErr) {
    const rawMsg = calendarErr instanceof Error ? calendarErr.message : String(calendarErr);
    console.error("[invoice/worklist] calendar failed:", rawMsg);

    // Classify as a Calendar error (not Sheets — different auth system).
    const { isAuthFailure, isRateLimit } = classifyGoogleError(calendarErr);
    const calendarWarning = isAuthFailure
      ? "Google Calendar connection failed — check GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_ID, and GOOGLE_CLIENT_SECRET. Showing saved invoice records only."
      : isRateLimit
        ? "Google Calendar rate-limited — showing saved invoice records only."
        : "Google Calendar unavailable — showing saved invoice records only.";

    // Fallback: return invoice data from Supabase so the list is not empty.
    try {
      const entries = await listWorklistEntriesFromSupabaseOnly();
      return NextResponse.json(
        { entries, fetchedAt: new Date(nowMs).toISOString(), calendarWarning },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (supabaseErr) {
      const supabaseMsg = supabaseErr instanceof Error ? supabaseErr.message : String(supabaseErr);
      console.error("[invoice/worklist] supabase fallback also failed:", supabaseMsg);
      return NextResponse.json(
        { error: "worklist_failed", message: "Invoice list unavailable — Google Calendar and database are both unreachable." },
        { status: 502 },
      );
    }
  }
}
