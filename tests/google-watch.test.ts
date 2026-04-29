import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvConfig } from "@/lib/config";

const registerCalendarWatch = vi.fn();
const readGoogleCalendarWatchMetadata = vi.fn();
const writeGoogleCalendarWatchMetadata = vi.fn();

vi.mock("@/lib/google", () => ({
  registerCalendarWatch: (...args: unknown[]) => registerCalendarWatch(...args),
}));

vi.mock("@/lib/google-watch-store", () => ({
  readGoogleCalendarWatchMetadata: (...args: unknown[]) => readGoogleCalendarWatchMetadata(...args),
  writeGoogleCalendarWatchMetadata: (...args: unknown[]) => writeGoogleCalendarWatchMetadata(...args),
}));

const NOW_ISO = "2026-05-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function makeEnv(overrides: Partial<EnvConfig> = {}): Pick<EnvConfig,
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "GOOGLE_REFRESH_TOKEN"
  | "GOOGLE_CALENDAR_ID"
  | "GOOGLE_WEBHOOK_TOKEN"
  | "BLOBS_STORE_NAME"
  | "PUBLIC_SITE_URL"
> {
  return {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REFRESH_TOKEN: "refresh-token",
    GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
    GOOGLE_WEBHOOK_TOKEN: "google-webhook-token-0123456789",
    BLOBS_STORE_NAME: "availability-snapshots",
    PUBLIC_SITE_URL: "https://la-schedule-app.netlify.app",
    ...overrides,
  };
}

describe("lib/google-watch ensureGoogleCalendarWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    registerCalendarWatch.mockReset();
    readGoogleCalendarWatchMetadata.mockReset();
    writeGoogleCalendarWatchMetadata.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips registration when an existing watch is healthy", async () => {
    readGoogleCalendarWatchMetadata.mockResolvedValue({
      version: 1,
      channelId: "channel-healthy",
      resourceId: "resource-healthy",
      expiration: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
      calendarId: "la-jobs@group.calendar.google.com",
      webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
      createdAtUtc: "2026-04-30T12:00:00.000Z",
    });

    const { ensureGoogleCalendarWatch } = await import("@/lib/google-watch");
    const result = await ensureGoogleCalendarWatch(makeEnv(), { nowMs: NOW_MS });

    expect(result.action).toBe("skipped");
    expect(result.renewalReason).toBe("healthy");
    expect(result.needsRenewal).toBe(false);
    expect(registerCalendarWatch).not.toHaveBeenCalled();
    expect(writeGoogleCalendarWatchMetadata).not.toHaveBeenCalled();
  });

  it("registers a fresh watch when no metadata exists", async () => {
    readGoogleCalendarWatchMetadata.mockResolvedValue(null);
    registerCalendarWatch.mockResolvedValue({
      channelId: "channel-new",
      resourceId: "resource-new",
      expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    writeGoogleCalendarWatchMetadata.mockResolvedValue({
      version: 1,
      channelId: "channel-new",
      resourceId: "resource-new",
      expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      calendarId: "la-jobs@group.calendar.google.com",
      webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
      createdAtUtc: NOW_ISO,
    });

    const { ensureGoogleCalendarWatch } = await import("@/lib/google-watch");
    const result = await ensureGoogleCalendarWatch(makeEnv(), { nowMs: NOW_MS });

    expect(result.action).toBe("registered");
    expect(registerCalendarWatch).toHaveBeenCalledTimes(1);
    expect(writeGoogleCalendarWatchMetadata).toHaveBeenCalledTimes(1);
  });

  it("registers a fresh watch when existing metadata expires within 24 hours", async () => {
    readGoogleCalendarWatchMetadata.mockResolvedValue({
      version: 1,
      channelId: "channel-old",
      resourceId: "resource-old",
      expiration: new Date(NOW_MS + 6 * 60 * 60 * 1000).toISOString(),
      calendarId: "la-jobs@group.calendar.google.com",
      webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
      createdAtUtc: "2026-04-28T12:00:00.000Z",
    });
    registerCalendarWatch.mockResolvedValue({
      channelId: "channel-newer",
      resourceId: "resource-newer",
      expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    writeGoogleCalendarWatchMetadata.mockResolvedValue({
      version: 1,
      channelId: "channel-newer",
      resourceId: "resource-newer",
      expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      calendarId: "la-jobs@group.calendar.google.com",
      webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
      createdAtUtc: NOW_ISO,
    });

    const { ensureGoogleCalendarWatch } = await import("@/lib/google-watch");
    const result = await ensureGoogleCalendarWatch(makeEnv(), { nowMs: NOW_MS });

    expect(result.action).toBe("registered");
    expect(result.previous?.channelId).toBe("channel-old");
    expect(registerCalendarWatch).toHaveBeenCalledTimes(1);
  });

  it("registers a fresh watch when force=true even if watch is healthy", async () => {
    readGoogleCalendarWatchMetadata.mockResolvedValue({
      version: 1,
      channelId: "channel-healthy",
      resourceId: "resource-healthy",
      expiration: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
      calendarId: "la-jobs@group.calendar.google.com",
      webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
      createdAtUtc: "2026-04-30T12:00:00.000Z",
    });
    registerCalendarWatch.mockResolvedValue({
      channelId: "channel-forced",
      resourceId: "resource-forced",
      expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    writeGoogleCalendarWatchMetadata.mockResolvedValue({
      version: 1,
      channelId: "channel-forced",
      resourceId: "resource-forced",
      expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      calendarId: "la-jobs@group.calendar.google.com",
      webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
      createdAtUtc: NOW_ISO,
    });

    const { ensureGoogleCalendarWatch } = await import("@/lib/google-watch");
    const result = await ensureGoogleCalendarWatch(makeEnv(), { nowMs: NOW_MS, force: true });

    expect(result.action).toBe("registered");
    expect(result.force).toBe(true);
    expect(registerCalendarWatch).toHaveBeenCalledTimes(1);
  });
});
