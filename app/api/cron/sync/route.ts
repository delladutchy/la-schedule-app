import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getEnvConfig } from "@/lib/config";
import { buildAndPersistSnapshot } from "@/lib/sync";

export const dynamic = "force-dynamic";

// Netlify cron scheduler sends GET with x-netlify-event: scheduled.
// ADMIN_TOKEN bearer auth is accepted for manual/dev triggers.
function isAuthorized(request: NextRequest, adminToken: string): boolean {
  if (request.headers.get("x-netlify-event") === "scheduled") return true;
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return (match?.[1]?.trim() ?? "") === adminToken;
}

async function runSync(): Promise<NextResponse> {
  const started = Date.now();
  try {
    const result = await buildAndPersistSnapshot();
    const durMs = Date.now() - started;
    if (result.status === "ok") {
      console.log(
        `[cron:sync] ok in ${durMs}ms, ${result.snapshot?.busy.length ?? 0} busy blocks`,
      );
      return NextResponse.json({ status: "ok", durationMs: durMs });
    }
    console.error(`[cron:sync] failed in ${durMs}ms: ${result.error}`);
    return NextResponse.json(
      { status: "failed", error: result.error, durationMs: durMs },
      { status: 500 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cron:sync] exception: ${msg}`);
    return NextResponse.json({ status: "error", error: msg }, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = getEnvConfig();
  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return runSync();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = getEnvConfig();
  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return runSync();
}
