import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvConfig } from "@/lib/config";

const registerCalendarWatch = vi.fn();
const readGoogleCalendarWatchMetadataMap = vi.fn();
const writeGoogleCalendarWatchMetadataMap = vi.fn();

vi.mock("@/lib/google", () => ({
  registerCalendarWatch: (...args: unknown[]) => registerCalendarWatch(...args),
}));

vi.mock("@/lib/google-watch-store", () => ({
  readGoogleCalendarWatchMetadataMap: (...args: unknown[]) => readGoogleCalendarWatchMetadataMap(...args),
  writeGoogleCalendarWatchMetadataMap: (...args: unknown[]) => writeGoogleCalendarWatchMetadataMap(...args),
}));

const NOW_ISO = "2026-05-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function makeEnv(overrides: Partial<EnvConfig> = {}): Pick<EnvConfig,
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "GOOGLE_REFRESH_TOKEN"
  | "GOOGLE_CALENDAR_ID"
  | "OVERTURE_CALENDAR_ID"
  | "GOOGLE_WEBHOOK_TOKEN"
  | "BLOBS_STORE_NAME"
  | "PUBLIC_SITE_URL"
> {
  return {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REFRESH_TOKEN: "refresh-token",
    GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
    OVERTURE_CALENDAR_ID: "overture@group.calendar.google.com",
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
    readGoogleCalendarWatchMetadataMap.mockReset();
    writeGoogleCalendarWatchMetadataMap.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves watch targets as LA plus optional Overture", async () => {
    const { resolveWatchCalendarIds } = await import("@/lib/google-watch");
    expect(resolveWatchCalendarIds(makeEnv())).toEqual([
      "la-jobs@group.calendar.google.com",
      "overture@group.calendar.google.com",
    ]);
    expect(resolveWatchCalendarIds(makeEnv({
      OVERTURE_CALENDAR_ID: undefined,
    }))).toEqual(["la-jobs@group.calendar.google.com"]);
    expect(resolveWatchCalendarIds(makeEnv({
      OVERTURE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
    }))).toEqual(["la-jobs@group.calendar.google.com"]);
  });

  it("GET-style status returns per-calendar watch health", async () => {
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({
      "la-jobs@group.calendar.google.com": {
        version: 1,
        channelId: "channel-la",
        resourceId: "resource-la",
        expiration: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
        calendarId: "la-jobs@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-30T12:00:00.000Z",
      },
      "overture@group.calendar.google.com": {
        version: 1,
        channelId: "channel-overture",
        resourceId: "resource-overture",
        expiration: new Date(NOW_MS + 6 * 60 * 60 * 1000).toISOString(),
        calendarId: "overture@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-30T12:00:00.000Z",
      },
    });
    const { getGoogleCalendarWatchStatus } = await import("@/lib/google-watch");
    const result = await getGoogleCalendarWatchStatus(makeEnv(), NOW_MS);

    expect(result.status).toBe("ok");
    expect(result.watches).toHaveLength(2);
    expect(result.watches?.map((watch) => watch.calendarId)).toEqual([
      "la-jobs@group.calendar.google.com",
      "overture@group.calendar.google.com",
    ]);
    expect(result.needsRenewal).toBe(true);
  });

  it("registers fresh watches for both LA and Overture when metadata is missing", async () => {
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({});
    registerCalendarWatch
      .mockResolvedValueOnce({
        channelId: "channel-la-new",
        resourceId: "resource-la-new",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        channelId: "channel-overture-new",
        resourceId: "resource-overture-new",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      });
    writeGoogleCalendarWatchMetadataMap.mockImplementation(async (_storeName: string, map: Record<string, unknown>) => map);

    const { ensureGoogleCalendarWatch } = await import("@/lib/google-watch");
    const result = await ensureGoogleCalendarWatch(makeEnv(), { nowMs: NOW_MS });

    expect(result.action).toBe("registered");
    expect(result.registeredCalendarIds).toEqual([
      "la-jobs@group.calendar.google.com",
      "overture@group.calendar.google.com",
    ]);
    expect(registerCalendarWatch).toHaveBeenCalledTimes(2);
    expect(writeGoogleCalendarWatchMetadataMap).toHaveBeenCalledTimes(1);
  });

  it("skips registration when LA and Overture watches are healthy", async () => {
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({
      "la-jobs@group.calendar.google.com": {
        version: 1,
        channelId: "channel-la",
        resourceId: "resource-la",
        expiration: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
        calendarId: "la-jobs@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-30T12:00:00.000Z",
      },
      "overture@group.calendar.google.com": {
        version: 1,
        channelId: "channel-overture",
        resourceId: "resource-overture",
        expiration: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
        calendarId: "overture@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-30T12:00:00.000Z",
      },
    });

    const { ensureGoogleCalendarWatch } = await import("@/lib/google-watch");
    const result = await ensureGoogleCalendarWatch(makeEnv(), { nowMs: NOW_MS });

    expect(result.action).toBe("skipped");
    expect(result.renewalReason).toBe("healthy");
    expect(result.needsRenewal).toBe(false);
    expect(registerCalendarWatch).not.toHaveBeenCalled();
    expect(writeGoogleCalendarWatchMetadataMap).not.toHaveBeenCalled();
  });

  it("registers only expiring Overture watch when LA is healthy", async () => {
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({
      "la-jobs@group.calendar.google.com": {
        version: 1,
        channelId: "channel-la",
        resourceId: "resource-la",
        expiration: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
        calendarId: "la-jobs@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-30T12:00:00.000Z",
      },
      "overture@group.calendar.google.com": {
        version: 1,
        channelId: "channel-overture-old",
        resourceId: "resource-overture-old",
        expiration: new Date(NOW_MS + 6 * 60 * 60 * 1000).toISOString(),
        calendarId: "overture@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-28T12:00:00.000Z",
      },
    });
    registerCalendarWatch.mockResolvedValue({
      channelId: "channel-overture-new",
      resourceId: "resource-overture-new",
      expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    writeGoogleCalendarWatchMetadataMap.mockImplementation(async (_storeName: string, map: Record<string, unknown>) => map);

    const { ensureGoogleCalendarWatch } = await import("@/lib/google-watch");
    const result = await ensureGoogleCalendarWatch(makeEnv(), { nowMs: NOW_MS });

    expect(result.action).toBe("registered");
    expect(result.registeredCalendarIds).toEqual(["overture@group.calendar.google.com"]);
    expect(result.skippedCalendarIds).toEqual(["la-jobs@group.calendar.google.com"]);
    expect(registerCalendarWatch).toHaveBeenCalledTimes(1);
    expect(registerCalendarWatch).toHaveBeenCalledWith(expect.objectContaining({
      calendarId: "overture@group.calendar.google.com",
    }));
  });

  it("registers both calendars with force=true even when healthy", async () => {
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({
      "la-jobs@group.calendar.google.com": {
        version: 1,
        channelId: "channel-la",
        resourceId: "resource-la",
        expiration: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
        calendarId: "la-jobs@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-30T12:00:00.000Z",
      },
      "overture@group.calendar.google.com": {
        version: 1,
        channelId: "channel-overture",
        resourceId: "resource-overture",
        expiration: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
        calendarId: "overture@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-30T12:00:00.000Z",
      },
    });
    registerCalendarWatch
      .mockResolvedValueOnce({
        channelId: "channel-la-forced",
        resourceId: "resource-la-forced",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        channelId: "channel-overture-forced",
        resourceId: "resource-overture-forced",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      });
    writeGoogleCalendarWatchMetadataMap.mockImplementation(async (_storeName: string, map: Record<string, unknown>) => map);

    const { ensureGoogleCalendarWatch } = await import("@/lib/google-watch");
    const result = await ensureGoogleCalendarWatch(makeEnv(), { nowMs: NOW_MS, force: true });

    expect(result.action).toBe("registered");
    expect(result.force).toBe(true);
    expect(result.registeredCalendarIds).toEqual([
      "la-jobs@group.calendar.google.com",
      "overture@group.calendar.google.com",
    ]);
    expect(registerCalendarWatch).toHaveBeenCalledTimes(2);
  });
});
