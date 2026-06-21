import { NextRequest, NextResponse } from "next/server";
import { DateTime } from "luxon";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { listWorklistEntries } from "@/lib/invoice-worklist";
import { classifySheetsError } from "@/lib/google-error";

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
  } catch (err) {
    const rawMsg      = err instanceof Error ? err.message : String(err);
    const friendlyMsg = classifySheetsError(err, env.GOOGLE_CALENDAR_ID, "LA calendar");
    console.error("[invoice/worklist] failed:", rawMsg);
    return NextResponse.json(
      { error: "worklist_failed", message: friendlyMsg },
      { status: 502 },
    );
  }
}
