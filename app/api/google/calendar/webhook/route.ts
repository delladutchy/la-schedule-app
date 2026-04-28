import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { buildAndPersistSnapshot } from "@/lib/sync";

export const dynamic = "force-dynamic";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function resolvePresentedToken(req: Request): string | null {
  const url = new URL(req.url);
  const queryToken = url.searchParams.get("token")?.trim();
  if (queryToken) return queryToken;
  const headerToken = req.headers.get("x-goog-channel-token")?.trim();
  if (headerToken) return headerToken;
  return null;
}

function isAuthorizedWebhook(req: Request, configuredToken?: string): boolean {
  const expected = configuredToken?.trim();
  if (!expected) return false;
  const presented = resolvePresentedToken(req);
  if (!presented) return false;
  return constantTimeEquals(presented, expected);
}

export async function POST(req: Request) {
  const started = Date.now();
  const { env } = getConfig();

  if (!isAuthorizedWebhook(req, env.GOOGLE_WEBHOOK_TOKEN)) {
    console.info("[google:webhook] unauthorized");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await buildAndPersistSnapshot();
  const durationMs = Date.now() - started;

  if (result.status === "ok") {
    console.info(`[google:webhook] ok ms total=${durationMs}`);
    return NextResponse.json({ status: "ok", durationMs });
  }

  console.info(`[google:webhook] failed ms total=${durationMs}`);
  return NextResponse.json(
    {
      status: "failed",
      durationMs,
      error: result.error ?? "sync_failed",
      erroredCalendarIds: result.erroredCalendarIds ?? [],
    },
    { status: 502 },
  );
}
