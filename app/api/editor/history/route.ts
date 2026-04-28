import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { readAuditEvents } from "@/lib/audit-log";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(req, env);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
  const events = await readAuditEvents(env.BLOBS_STORE_NAME, limit);
  return NextResponse.json({
    status: "ok",
    events,
  });
}
