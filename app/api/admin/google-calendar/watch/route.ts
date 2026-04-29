import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { registerCalendarWatch } from "@/lib/google";
import {
  readGoogleCalendarWatchMetadata,
  writeGoogleCalendarWatchMetadata,
  type GoogleCalendarWatchMetadata,
} from "@/lib/google-watch-store";

export const dynamic = "force-dynamic";
const RENEWAL_THRESHOLD_MS = 24 * 60 * 60 * 1000;

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

function resolveWebhookUrl(req: Request, publicSiteUrl?: string): string {
  const configured = publicSiteUrl?.trim();
  if (configured) {
    const normalizedBase = configured.replace(/\/+$/, "");
    return `${normalizedBase}/api/google/calendar/webhook`;
  }
  const url = new URL(req.url);
  return `${url.origin}/api/google/calendar/webhook`;
}

function parseForceParam(req: Request): boolean {
  const force = new URL(req.url).searchParams.get("force")?.trim().toLowerCase();
  return force === "1" || force === "true" || force === "yes";
}

function evaluateWatchHealth(
  metadata: GoogleCalendarWatchMetadata | null,
  nowMs: number,
): { expiresInMs: number | null; needsRenewal: boolean } {
  if (!metadata) {
    return { expiresInMs: null, needsRenewal: true };
  }
  if (!metadata.expiration) {
    return { expiresInMs: null, needsRenewal: true };
  }

  const expirationMs = Date.parse(metadata.expiration);
  if (!Number.isFinite(expirationMs)) {
    return { expiresInMs: null, needsRenewal: true };
  }

  const expiresInMs = expirationMs - nowMs;
  return {
    expiresInMs,
    needsRenewal: expiresInMs <= RENEWAL_THRESHOLD_MS,
  };
}

function toWatchStatusPayload(
  metadata: GoogleCalendarWatchMetadata | null,
  nowMs: number,
) {
  const { expiresInMs, needsRenewal } = evaluateWatchHealth(metadata, nowMs);
  return {
    ...(metadata
      ? {
          calendarId: metadata.calendarId,
          channelId: metadata.channelId,
          resourceId: metadata.resourceId,
          ...(metadata.expiration ? { expiration: metadata.expiration } : {}),
          createdAtUtc: metadata.createdAtUtc,
          webhookUrl: metadata.webhookUrl,
        }
      : {}),
    expiresInMs,
    needsRenewal,
  };
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
  const metadata = await readGoogleCalendarWatchMetadata(env.BLOBS_STORE_NAME);
  const nowMs = Date.now();
  return NextResponse.json({
    status: "ok",
    ...toWatchStatusPayload(metadata, nowMs),
  });
}

export async function POST(req: Request) {
  const started = Date.now();
  const auth = ensureAdmin(req);
  if (!auth.ok) return auth.response;

  const { env } = getConfig();
  const nowMs = Date.now();
  const force = parseForceParam(req);
  const existing = await readGoogleCalendarWatchMetadata(env.BLOBS_STORE_NAME);
  const existingHealth = evaluateWatchHealth(existing, nowMs);

  if (!force && existing && !existingHealth.needsRenewal) {
    const durationMs = Date.now() - started;
    console.info(`[google:watch] ok action=skipped ms total=${durationMs}`);
    return NextResponse.json({
      status: "ok",
      action: "skipped",
      force,
      ...toWatchStatusPayload(existing, nowMs),
    });
  }

  const webhookToken = env.GOOGLE_WEBHOOK_TOKEN?.trim();
  if (!webhookToken) {
    return NextResponse.json(
      { error: "missing_google_webhook_token" },
      { status: 503 },
    );
  }

  const webhookUrl = resolveWebhookUrl(req, env.PUBLIC_SITE_URL);
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
    console.info(`[google:watch] ok action=registered ms total=${durationMs}`);

    return NextResponse.json({
      status: "ok",
      action: "registered",
      force,
      ...toWatchStatusPayload(metadata, nowMs),
      ...(existing
        ? {
            previous: {
              channelId: existing.channelId,
              resourceId: existing.resourceId,
              ...(existing.expiration ? { expiration: existing.expiration } : {}),
            },
          }
        : {}),
    });
  } catch {
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
