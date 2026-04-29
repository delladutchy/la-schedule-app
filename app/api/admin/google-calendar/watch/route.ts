import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { registerCalendarWatch } from "@/lib/google";
import { writeGoogleCalendarWatchMetadata } from "@/lib/google-watch-store";

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

function generateChannelId(calendarId: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  const timePart = Date.now().toString(36);
  const safeCalendar = calendarId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "calendar";
  return `la-watch-${safeCalendar}-${timePart}-${suffix}`;
}

function resolveWebhookUrl(req: Request): string {
  const url = new URL(req.url);
  return `${url.origin}/api/google/calendar/webhook`;
}

export async function POST(req: Request) {
  const started = Date.now();
  const { env } = getConfig();

  if (!isAuthorizedAdmin(req, env.ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const webhookToken = env.GOOGLE_WEBHOOK_TOKEN?.trim();
  if (!webhookToken) {
    return NextResponse.json(
      { error: "missing_google_webhook_token" },
      { status: 503 },
    );
  }

  const webhookUrl = resolveWebhookUrl(req);
  const channelId = generateChannelId(env.GOOGLE_CALENDAR_ID);

  try {
    const watch = await registerCalendarWatch({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
      calendarId: env.GOOGLE_CALENDAR_ID,
      webhookUrl,
      channelId,
      channelToken: webhookToken,
    });

    const metadata = await writeGoogleCalendarWatchMetadata(env.BLOBS_STORE_NAME, {
      channelId: watch.channelId,
      resourceId: watch.resourceId,
      ...(watch.resourceUri ? { resourceUri: watch.resourceUri } : {}),
      ...(watch.expiration ? { expiration: watch.expiration } : {}),
      calendarId: env.GOOGLE_CALENDAR_ID,
      webhookUrl,
      createdAtUtc: new Date().toISOString(),
    });

    const durationMs = Date.now() - started;
    console.info(`[google:watch] ok ms total=${durationMs}`);

    return NextResponse.json({
      status: "ok",
      calendarId: metadata.calendarId,
      channelId: metadata.channelId,
      resourceId: metadata.resourceId,
      ...(metadata.expiration ? { expiration: metadata.expiration } : {}),
    });
  } catch (error) {
    const durationMs = Date.now() - started;
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
