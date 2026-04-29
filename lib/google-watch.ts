import type { EnvConfig } from "./config";
import { registerCalendarWatch } from "./google";
import {
  readGoogleCalendarWatchMetadata,
  writeGoogleCalendarWatchMetadata,
  type GoogleCalendarWatchMetadata,
} from "./google-watch-store";

export const WATCH_RENEWAL_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export type WatchRenewalReason =
  | "missing"
  | "missing_expiration"
  | "invalid_expiration"
  | "expiring_soon"
  | "healthy";

export interface WatchHealthStatus {
  expiresInMs: number | null;
  needsRenewal: boolean;
  renewalReason: WatchRenewalReason;
}

export interface GoogleWatchStatusResult {
  status: "ok";
  expiresInMs: number | null;
  needsRenewal: boolean;
  calendarId?: string;
  channelId?: string;
  resourceId?: string;
  expiration?: string;
  createdAtUtc?: string;
  webhookUrl?: string;
}

export interface EnsureGoogleWatchResult extends GoogleWatchStatusResult {
  action: "registered" | "skipped";
  force: boolean;
  renewalReason: WatchRenewalReason;
  previous?: {
    channelId: string;
    resourceId: string;
    expiration?: string;
  };
}

type WatchEnv = Pick<EnvConfig,
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "GOOGLE_REFRESH_TOKEN"
  | "GOOGLE_CALENDAR_ID"
  | "GOOGLE_WEBHOOK_TOKEN"
  | "BLOBS_STORE_NAME"
  | "PUBLIC_SITE_URL"
>;

export class WatchConfigError extends Error {
  constructor(
    public readonly code:
      | "missing_google_webhook_token"
      | "missing_webhook_base_url",
  ) {
    super(code);
    this.name = "WatchConfigError";
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function resolveWebhookUrl(opts: {
  publicSiteUrl?: string;
  requestUrl?: string;
  runtimeSiteUrl?: string;
}): string {
  const fromPublic = opts.publicSiteUrl?.trim();
  if (fromPublic) {
    return `${normalizeBaseUrl(fromPublic)}/api/google/calendar/webhook`;
  }

  const fromRequest = opts.requestUrl?.trim();
  if (fromRequest) {
    const origin = new URL(fromRequest).origin;
    return `${origin}/api/google/calendar/webhook`;
  }

  const fromRuntime = opts.runtimeSiteUrl?.trim();
  if (fromRuntime) {
    return `${normalizeBaseUrl(fromRuntime)}/api/google/calendar/webhook`;
  }

  throw new WatchConfigError("missing_webhook_base_url");
}

export function evaluateWatchHealth(
  metadata: GoogleCalendarWatchMetadata | null,
  nowMs: number,
): WatchHealthStatus {
  if (!metadata) {
    return { expiresInMs: null, needsRenewal: true, renewalReason: "missing" };
  }
  if (!metadata.expiration) {
    return { expiresInMs: null, needsRenewal: true, renewalReason: "missing_expiration" };
  }

  const expirationMs = Date.parse(metadata.expiration);
  if (!Number.isFinite(expirationMs)) {
    return { expiresInMs: null, needsRenewal: true, renewalReason: "invalid_expiration" };
  }

  const expiresInMs = expirationMs - nowMs;
  if (expiresInMs <= WATCH_RENEWAL_THRESHOLD_MS) {
    return { expiresInMs, needsRenewal: true, renewalReason: "expiring_soon" };
  }

  return { expiresInMs, needsRenewal: false, renewalReason: "healthy" };
}

export function buildWatchStatus(
  metadata: GoogleCalendarWatchMetadata | null,
  nowMs: number,
): GoogleWatchStatusResult {
  const health = evaluateWatchHealth(metadata, nowMs);
  return {
    status: "ok",
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
    expiresInMs: health.expiresInMs,
    needsRenewal: health.needsRenewal,
  };
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

export async function getGoogleCalendarWatchStatus(
  env: Pick<WatchEnv, "BLOBS_STORE_NAME">,
  nowMs: number = Date.now(),
): Promise<GoogleWatchStatusResult> {
  const metadata = await readGoogleCalendarWatchMetadata(env.BLOBS_STORE_NAME);
  return buildWatchStatus(metadata, nowMs);
}

export async function ensureGoogleCalendarWatch(
  env: WatchEnv,
  opts: {
    force?: boolean;
    requestUrl?: string;
    runtimeSiteUrl?: string;
    nowMs?: number;
  } = {},
): Promise<EnsureGoogleWatchResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const force = !!opts.force;
  const existing = await readGoogleCalendarWatchMetadata(env.BLOBS_STORE_NAME);
  const existingHealth = evaluateWatchHealth(existing, nowMs);
  const existingStatus = buildWatchStatus(existing, nowMs);

  if (!force && existing && !existingHealth.needsRenewal) {
    return {
      action: "skipped",
      force,
      renewalReason: existingHealth.renewalReason,
      ...existingStatus,
    };
  }

  const channelToken = env.GOOGLE_WEBHOOK_TOKEN?.trim();
  if (!channelToken) {
    throw new WatchConfigError("missing_google_webhook_token");
  }

  const webhookUrl = resolveWebhookUrl({
    publicSiteUrl: env.PUBLIC_SITE_URL,
    requestUrl: opts.requestUrl,
    runtimeSiteUrl: opts.runtimeSiteUrl,
  });
  const channelId = generateChannelId(env.GOOGLE_CALENDAR_ID);

  const watch = await registerCalendarWatch({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_REFRESH_TOKEN,
    calendarId: env.GOOGLE_CALENDAR_ID,
    webhookUrl,
    channelId,
    channelToken,
  });

  const metadata = await writeGoogleCalendarWatchMetadata(env.BLOBS_STORE_NAME, {
    channelId: watch.channelId,
    resourceId: watch.resourceId,
    ...(watch.resourceUri ? { resourceUri: watch.resourceUri } : {}),
    ...(watch.expiration ? { expiration: watch.expiration } : {}),
    calendarId: env.GOOGLE_CALENDAR_ID,
    webhookUrl,
    createdAtUtc: new Date(nowMs).toISOString(),
  });

  const metadataHealth = evaluateWatchHealth(metadata, nowMs);

  return {
    action: "registered",
    force,
    renewalReason: metadataHealth.renewalReason,
    ...buildWatchStatus(metadata, nowMs),
    ...(existing
      ? {
          previous: {
            channelId: existing.channelId,
            resourceId: existing.resourceId,
            ...(existing.expiration ? { expiration: existing.expiration } : {}),
          },
        }
      : {}),
  };
}
