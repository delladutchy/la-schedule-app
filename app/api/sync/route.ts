/**
 * Manual sync endpoint — POST with `Authorization: Bearer <ADMIN_TOKEN>`.
 *
 * Uses:
 *   - Priming the first snapshot right after deploy
 *   - Force-refresh after changing config
 *   - Health-check from an external uptime monitor
 */

import { NextResponse } from "next/server";
import { buildAndPersistSnapshot } from "@/lib/sync";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  try {
    const { env } = getConfig();
    const header = req.headers.get("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const presented = match[1]?.trim();
    if (!presented || presented.length !== env.ADMIN_TOKEN.length) return false;
    // Constant-time compare
    let diff = 0;
    for (let i = 0; i < presented.length; i++) {
      diff |= presented.charCodeAt(i) ^ env.ADMIN_TOKEN.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const result = await buildAndPersistSnapshot();
  const durationMs = Date.now() - started;
  if (result.status === "ok") {
    return NextResponse.json({
      status: "ok",
      durationMs,
      busyBlocks: result.snapshot?.busy.length ?? 0,
      generatedAtUtc: result.snapshot?.generatedAtUtc,
    });
  }
  return NextResponse.json(
    { status: "failed", durationMs, error: result.error, erroredCalendarIds: result.erroredCalendarIds ?? [] },
    { status: 502 },
  );
}
