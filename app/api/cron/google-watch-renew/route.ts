import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getEnvConfig } from "@/lib/config";
import { WatchConfigError, ensureGoogleCalendarWatch } from "@/lib/google-watch";

export const dynamic = "force-dynamic";

function resolveRuntimeSiteUrl(): string | undefined {
  const value =
    process.env.URL ?? process.env.DEPLOY_URL ?? process.env.DEPLOY_PRIME_URL;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isAuthorized(request: NextRequest, adminToken: string): boolean {
  if (request.headers.get("x-netlify-event") === "scheduled") return true;
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return (match?.[1]?.trim() ?? "") === adminToken;
}

async function runWatchRenew(): Promise<NextResponse> {
  const started = Date.now();
  try {
    const env = getEnvConfig();
    const result = await ensureGoogleCalendarWatch(env, {
      force: false,
      runtimeSiteUrl: resolveRuntimeSiteUrl(),
    });
    const durationMs = Date.now() - started;
    if (result.action === "skipped") {
      console.info(
        `[cron:watch-renew] skipped reason=${result.renewalReason} expiresInMs=${result.expiresInMs ?? "null"} ms=${durationMs}`,
      );
      return NextResponse.json({
        status: "ok",
        action: "skipped",
        expiresInMs: result.expiresInMs,
        durationMs,
      });
    }
    console.info(
      `[cron:watch-renew] renewed expiresInMs=${result.expiresInMs ?? "null"} ms=${durationMs}`,
    );
    return NextResponse.json({
      status: "ok",
      action: "registered",
      expiresInMs: result.expiresInMs,
      durationMs,
    });
  } catch (error) {
    const durationMs = Date.now() - started;
    const errCode =
      error instanceof WatchConfigError
        ? error.code
        : error instanceof Error
          ? error.name || "error"
          : "error";
    console.error(`[cron:watch-renew] failed error=${errCode} ms=${durationMs}`);
    return NextResponse.json(
      { status: "failed", error: "watch_auto_renew_failed", durationMs },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = getEnvConfig();
  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return runWatchRenew();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = getEnvConfig();
  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return runWatchRenew();
}
