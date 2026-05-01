import type { EnvConfig } from "./config";
import { registerCalendarWatch } from "./google";
import {
  readGoogleCalendarWatchMetadataMap,
  writeGoogleCalendarWatchMetadataMap,
  type GoogleCalendarWatchMetadata,
  type GoogleCalendarWatchMetadataMap,
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

export interface CalendarWatchStatus {
  calendarId: string;
  expiresInMs: number | null;
  needsRenewal: boolean;
  renewalReason: WatchRenewalReason;
  channelId?: string;
  resourceId?: string;
  expiration?: string;
  createdAtUtc?: string;
  webhookUrl?: string;
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
  watches?: CalendarWatchStatus[];
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
  previousWatches?: Array<{
    calendarId: string;
    channelId: string;
    resourceId: string;
    expiration?: string;
  }>;
  registeredCalendarIds?: string[];
  skippedCalendarIds?: string[];
}

type WatchEnv = Pick<EnvConfig,
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "GOOGLE_REFRESH_TOKEN"
  | "GOOGLE_CALENDAR_ID"
  | "OVERTURE_CALENDAR_ID"
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

function normalizeCalendarId(calendarId: string): string {
  return calendarId.trim();
}

export function resolveWatchCalendarIds(
  env: Pick<WatchEnv, "GOOGLE_CALENDAR_ID" | "OVERTURE_CALENDAR_ID">,
): string[] {
  const primary = normalizeCalendarId(env.GOOGLE_CALENDAR_ID);
  const overture = env.OVERTURE_CALENDAR_ID?.trim();
  if (overture && overture !== primary) {
    return [primary, overture];
  }
  return [primary];
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

function buildCalendarWatchStatus(
  calendarId: string,
  metadata: GoogleCalendarWatchMetadata | null,
  nowMs: number,
): CalendarWatchStatus {
  const health = evaluateWatchHealth(metadata, nowMs);
  return {
    calendarId,
    ...(metadata
      ? {
          channelId: metadata.channelId,
          resourceId: metadata.resourceId,
          ...(metadata.expiration ? { expiration: metadata.expiration } : {}),
          createdAtUtc: metadata.createdAtUtc,
          webhookUrl: metadata.webhookUrl,
        }
      : {}),
    expiresInMs: health.expiresInMs,
    needsRenewal: health.needsRenewal,
    renewalReason: health.renewalReason,
  };
}

function resolveOverallExpiresInMs(watches: CalendarWatchStatus[]): number | null {
  const finite = watches
    .map((watch) => watch.expiresInMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return Math.min(...finite);
}

const RENEWAL_REASON_PRIORITY: Record<WatchRenewalReason, number> = {
  missing: 0,
  missing_expiration: 1,
  invalid_expiration: 2,
  expiring_soon: 3,
  healthy: 4,
};

function pickMostUrgentRenewalReason(reasons: WatchRenewalReason[]): WatchRenewalReason {
  if (reasons.length === 0) return "healthy";
  return [...reasons].sort((a, b) => RENEWAL_REASON_PRIORITY[a] - RENEWAL_REASON_PRIORITY[b])[0] ?? "healthy";
}

function buildStatusFromMap(
  metadataMap: GoogleCalendarWatchMetadataMap,
  calendarIds: string[],
  nowMs: number,
): GoogleWatchStatusResult {
  const watches = calendarIds.map((calendarId) =>
    buildCalendarWatchStatus(calendarId, metadataMap[calendarId] ?? null, nowMs));
  const primary = watches[0];
  return {
    status: "ok",
    ...(primary
      ? {
          calendarId: primary.calendarId,
          ...(primary.channelId ? { channelId: primary.channelId } : {}),
          ...(primary.resourceId ? { resourceId: primary.resourceId } : {}),
          ...(primary.expiration ? { expiration: primary.expiration } : {}),
          ...(primary.createdAtUtc ? { createdAtUtc: primary.createdAtUtc } : {}),
          ...(primary.webhookUrl ? { webhookUrl: primary.webhookUrl } : {}),
        }
      : {}),
    expiresInMs: resolveOverallExpiresInMs(watches),
    needsRenewal: watches.some((watch) => watch.needsRenewal),
    watches,
  };
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
    ...(metadata
      ? {
          watches: [
            buildCalendarWatchStatus(metadata.calendarId, metadata, nowMs),
          ],
        }
      : {}),
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
  env: Pick<WatchEnv, "BLOBS_STORE_NAME" | "GOOGLE_CALENDAR_ID" | "OVERTURE_CALENDAR_ID">,
  nowMs: number = Date.now(),
): Promise<GoogleWatchStatusResult> {
  const metadataMap = await readGoogleCalendarWatchMetadataMap(env.BLOBS_STORE_NAME);
  const calendarIds = resolveWatchCalendarIds(env);
  return buildStatusFromMap(metadataMap, calendarIds, nowMs);
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
  const metadataMap = await readGoogleCalendarWatchMetadataMap(env.BLOBS_STORE_NAME);
  const calendarIds = resolveWatchCalendarIds(env);

  const channelToken = env.GOOGLE_WEBHOOK_TOKEN?.trim();
  if (!channelToken) {
    throw new WatchConfigError("missing_google_webhook_token");
  }

  const webhookUrl = resolveWebhookUrl({
    publicSiteUrl: env.PUBLIC_SITE_URL,
    requestUrl: opts.requestUrl,
    runtimeSiteUrl: opts.runtimeSiteUrl,
  });

  const registeredCalendarIds: string[] = [];
  const skippedCalendarIds: string[] = [];
  const renewalReasons: WatchRenewalReason[] = [];
  const previousWatches: Array<{
    calendarId: string;
    channelId: string;
    resourceId: string;
    expiration?: string;
  }> = [];
  let didRegister = false;

  for (const calendarId of calendarIds) {
    const existing = metadataMap[calendarId] ?? null;
    const existingHealth = evaluateWatchHealth(existing, nowMs);

    if (!force && existing && !existingHealth.needsRenewal) {
      skippedCalendarIds.push(calendarId);
      renewalReasons.push(existingHealth.renewalReason);
      continue;
    }

    const watch = await registerCalendarWatch({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
      calendarId,
      webhookUrl,
      channelId: generateChannelId(calendarId),
      channelToken,
    });

    if (existing) {
      previousWatches.push({
        calendarId,
        channelId: existing.channelId,
        resourceId: existing.resourceId,
        ...(existing.expiration ? { expiration: existing.expiration } : {}),
      });
    }

    metadataMap[calendarId] = {
      version: 1,
      channelId: watch.channelId,
      resourceId: watch.resourceId,
      ...(watch.resourceUri ? { resourceUri: watch.resourceUri } : {}),
      ...(watch.expiration ? { expiration: watch.expiration } : {}),
      calendarId,
      webhookUrl,
      createdAtUtc: new Date(nowMs).toISOString(),
    };

    registeredCalendarIds.push(calendarId);
    renewalReasons.push(existingHealth.renewalReason);
    didRegister = true;
  }

  if (didRegister) {
    await writeGoogleCalendarWatchMetadataMap(env.BLOBS_STORE_NAME, metadataMap);
  }

  const status = buildStatusFromMap(metadataMap, calendarIds, nowMs);
  const primaryCalendarId = normalizeCalendarId(env.GOOGLE_CALENDAR_ID);
  const primaryPrevious = previousWatches.find((watch) => watch.calendarId === primaryCalendarId);

  return {
    action: registeredCalendarIds.length > 0 ? "registered" : "skipped",
    force,
    renewalReason: pickMostUrgentRenewalReason(renewalReasons),
    registeredCalendarIds,
    skippedCalendarIds,
    ...(primaryPrevious
      ? {
          previous: {
            channelId: primaryPrevious.channelId,
            resourceId: primaryPrevious.resourceId,
            ...(primaryPrevious.expiration ? { expiration: primaryPrevious.expiration } : {}),
          },
        }
      : {}),
    ...(previousWatches.length > 0 ? { previousWatches } : {}),
    ...status,
  };
}
