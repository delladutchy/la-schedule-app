import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import {
  WatchConfigError,
  ensureGoogleCalendarWatch,
  getGoogleCalendarWatchStatus,
} from "@/lib/google-watch";

export const dynamic = "force-dynamic";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorizedAdmin(req: Request, adminToken: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const presented = match[1]?.trim() ?? "";
  return constantTimeEquals(presented, adminToken);
}

function parseForceParam(req: Request): boolean {
  const force = new URL(req.url).searchParams.get("force")?.trim().toLowerCase();
  return force === "1" || force === "true" || force === "yes";
}

function ensureAdmin(req: Request): { ok: true } | { ok: false; response: NextResponse } {
  const { env } = getConfig();
  if (!isAuthorizedAdmin(req, env.ADMIN_TOKEN)) {
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  return { ok: true };
}

export async function GET(req: Request) {
  const auth = ensureAdmin(req);
  if (!auth.ok) return auth.response;

  const { env } = getConfig();
  const status = await getGoogleCalendarWatchStatus(env);
  return NextResponse.json(status);
}

export async function POST(req: Request) {
  const started = Date.now();
  const auth = ensureAdmin(req);
  if (!auth.ok) return auth.response;

  const { env } = getConfig();
  const force = parseForceParam(req);
  const runtimeSiteUrl = process.env.URL ?? process.env.DEPLOY_URL ?? process.env.DEPLOY_PRIME_URL;

  try {
    const result = await ensureGoogleCalendarWatch(env, {
      force,
      requestUrl: req.url,
      runtimeSiteUrl,
    });
    const durationMs = Date.now() - started;
    if (result.action === "skipped") {
      console.info(
        `[google:watch] ok action=skipped reason=${result.renewalReason} ms total=${durationMs}`,
      );
    } else {
      console.info(`[google:watch] ok action=registered ms total=${durationMs}`);
    }
    return NextResponse.json(result);
  } catch (error) {
    const durationMs = Date.now() - started;
    if (error instanceof WatchConfigError) {
      console.info(`[google:watch] failed code=${error.code} ms total=${durationMs}`);
      return NextResponse.json(
        { error: error.code },
        { status: 503 },
      );
    }
    console.info(`[google:watch] failed ms total=${durationMs}`);
    return NextResponse.json(
      {
        status: "failed",
        durationMs,
        error: "watch_registration_failed",
      },
      { status: 502 },
    );
  }
}
