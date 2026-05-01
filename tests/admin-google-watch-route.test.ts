import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registerCalendarWatch = vi.fn();
const readGoogleCalendarWatchMetadataMap = vi.fn();
const writeGoogleCalendarWatchMetadataMap = vi.fn();

const ADMIN_TOKEN = "admin-token-0123456789abcdef";
const WEBHOOK_TOKEN = "google-webhook-token-0123456789";
const REFRESH_TOKEN = "refresh-token-abcdef";
const NOW_ISO = "2026-04-29T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
let PUBLIC_SITE_URL: string | undefined;
let OVERTURE_CALENDAR_ID: string | undefined;

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    env: {
      ADMIN_TOKEN,
      GOOGLE_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN,
      GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
      OVERTURE_CALENDAR_ID,
      BLOBS_STORE_NAME: "availability-snapshots",
      PUBLIC_SITE_URL,
    },
  }),
}));

vi.mock("@/lib/google", () => ({
  registerCalendarWatch: (...args: unknown[]) => registerCalendarWatch(...args),
}));

vi.mock("@/lib/google-watch-store", () => ({
  readGoogleCalendarWatchMetadataMap: (...args: unknown[]) => readGoogleCalendarWatchMetadataMap(...args),
  writeGoogleCalendarWatchMetadataMap: (...args: unknown[]) => writeGoogleCalendarWatchMetadataMap(...args),
}));

async function loadHandlers() {
  const mod = await import("@/app/api/admin/google-calendar/watch/route");
  return { GET: mod.GET, POST: mod.POST };
}

describe("/api/admin/google-calendar/watch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    registerCalendarWatch.mockReset();
    readGoogleCalendarWatchMetadataMap.mockReset();
    writeGoogleCalendarWatchMetadataMap.mockReset();
    PUBLIC_SITE_URL = undefined;
    OVERTURE_CALENDAR_ID = "overture@group.calendar.google.com";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("GET returns 401 when admin token is missing", async () => {
    const { GET } = await loadHandlers();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch");
    const res = await GET(req);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("GET returns 401 when admin token is invalid", async () => {
    const { GET } = await loadHandlers();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      headers: { Authorization: "Bearer invalid-token-0000000000000000" },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("GET returns safe empty status when no watch metadata exists", async () => {
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({});
    const { GET } = await loadHandlers();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.expiresInMs).toBeNull();
    expect(body.needsRenewal).toBe(true);
    expect((body.watches as unknown[] | undefined)?.length).toBe(2);
  });

  it("GET returns stored metadata and computed expiresInMs/needsRenewal", async () => {
    const expiration = new Date(NOW_MS + 2 * 24 * 60 * 60 * 1000).toISOString();
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({
      "la-jobs@group.calendar.google.com": {
        version: 1,
        channelId: "channel-healthy",
        resourceId: "resource-healthy",
        expiration,
        calendarId: "la-jobs@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-28T12:00:00.000Z",
      },
    });
    const { GET } = await loadHandlers();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.channelId).toBe("channel-healthy");
    expect(body.resourceId).toBe("resource-healthy");
    expect(body.expiration).toBe(expiration);
    expect(typeof body.expiresInMs).toBe("number");
    expect((body.expiresInMs as number) > 0).toBe(true);
    expect(body.needsRenewal).toBe(true);
    expect((body.watches as unknown[] | undefined)?.length).toBe(2);
  });

  it("POST returns 401 when admin token is missing", async () => {
    const { POST } = await loadHandlers();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("POST returns 401 when admin token is invalid", async () => {
    const { POST } = await loadHandlers();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      method: "POST",
      headers: { Authorization: "Bearer invalid-token-0000000000000000" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("POST registers when no metadata exists", async () => {
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({});
    registerCalendarWatch
      .mockResolvedValueOnce({
        channelId: "channel-la",
        resourceId: "resource-la",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        channelId: "channel-overture",
        resourceId: "resource-overture",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      });
    writeGoogleCalendarWatchMetadataMap.mockImplementation(async (_storeName: string, map: Record<string, unknown>) => map);

    const { POST } = await loadHandlers();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.action).toBe("registered");
    expect(body.registeredCalendarIds).toEqual([
      "la-jobs@group.calendar.google.com",
      "overture@group.calendar.google.com",
    ]);
    expect(registerCalendarWatch).toHaveBeenCalledTimes(2);
    expect(registerCalendarWatch.mock.calls.map((call) =>
      (call[0] as Record<string, unknown>).calendarId)).toEqual([
      "la-jobs@group.calendar.google.com",
      "overture@group.calendar.google.com",
    ]);
    expect(writeGoogleCalendarWatchMetadataMap).toHaveBeenCalledTimes(1);
  });

  it("POST uses PUBLIC_SITE_URL when provided", async () => {
    PUBLIC_SITE_URL = "https://la-schedule-app.netlify.app";
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({});
    registerCalendarWatch
      .mockResolvedValueOnce({
        channelId: "channel-canonical-la",
        resourceId: "resource-canonical-la",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        channelId: "channel-canonical-overture",
        resourceId: "resource-canonical-overture",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      });
    writeGoogleCalendarWatchMetadataMap.mockImplementation(async (_storeName: string, map: Record<string, unknown>) => map);

    const { POST } = await loadHandlers();
    const req = new Request("https://main--la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const registerArgs = registerCalendarWatch.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(registerArgs).toHaveLength(2);
    for (const args of registerArgs) {
      expect(args.webhookUrl).toBe("https://la-schedule-app.netlify.app/api/google/calendar/webhook");
    }
  });

  it("POST normalizes trailing slash in PUBLIC_SITE_URL", async () => {
    PUBLIC_SITE_URL = "https://la-schedule-app.netlify.app/";
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({});
    registerCalendarWatch
      .mockResolvedValueOnce({
        channelId: "channel-trailing-la",
        resourceId: "resource-trailing-la",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        channelId: "channel-trailing-overture",
        resourceId: "resource-trailing-overture",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      });
    writeGoogleCalendarWatchMetadataMap.mockImplementation(async (_storeName: string, map: Record<string, unknown>) => map);

    const { POST } = await loadHandlers();
    const req = new Request("https://main--la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const registerArgs = registerCalendarWatch.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(registerArgs).toHaveLength(2);
    for (const args of registerArgs) {
      expect(args.webhookUrl).toBe("https://la-schedule-app.netlify.app/api/google/calendar/webhook");
    }
  });

  it("POST falls back to request origin when PUBLIC_SITE_URL is missing", async () => {
    PUBLIC_SITE_URL = undefined;
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({});
    registerCalendarWatch
      .mockResolvedValueOnce({
        channelId: "channel-fallback-la",
        resourceId: "resource-fallback-la",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        channelId: "channel-fallback-overture",
        resourceId: "resource-fallback-overture",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      });
    writeGoogleCalendarWatchMetadataMap.mockImplementation(async (_storeName: string, map: Record<string, unknown>) => map);

    const { POST } = await loadHandlers();
    const req = new Request("https://main--la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const registerArgs = registerCalendarWatch.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(registerArgs).toHaveLength(2);
    for (const args of registerArgs) {
      expect(args.webhookUrl).toBe("https://main--la-schedule-app.netlify.app/api/google/calendar/webhook");
    }
  });

  it("POST registers when existing metadata expires within 24 hours", async () => {
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({
      "la-jobs@group.calendar.google.com": {
        version: 1,
        channelId: "channel-old",
        resourceId: "resource-old",
        expiration: new Date(NOW_MS + 6 * 60 * 60 * 1000).toISOString(),
        calendarId: "la-jobs@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-20T12:00:00.000Z",
      },
      "overture@group.calendar.google.com": {
        version: 1,
        channelId: "channel-overture-healthy",
        resourceId: "resource-overture-healthy",
        expiration: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
        calendarId: "overture@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-20T12:00:00.000Z",
      },
    });
    registerCalendarWatch.mockResolvedValue({
      channelId: "channel-new",
      resourceId: "resource-new",
      expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    writeGoogleCalendarWatchMetadataMap.mockImplementation(async (_storeName: string, map: Record<string, unknown>) => map);

    const { POST } = await loadHandlers();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.action).toBe("registered");
    expect((body.previous as Record<string, unknown>).channelId).toBe("channel-old");
    expect(registerCalendarWatch).toHaveBeenCalledTimes(1);
  });

  it("POST skips registration when watch is healthy and force is not set", async () => {
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({
      "la-jobs@group.calendar.google.com": {
        version: 1,
        channelId: "channel-healthy",
        resourceId: "resource-healthy",
        expiration: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
        calendarId: "la-jobs@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-28T12:00:00.000Z",
      },
      "overture@group.calendar.google.com": {
        version: 1,
        channelId: "channel-overture-healthy",
        resourceId: "resource-overture-healthy",
        expiration: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
        calendarId: "overture@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-28T12:00:00.000Z",
      },
    });

    const { POST } = await loadHandlers();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.action).toBe("skipped");
    expect(body.needsRenewal).toBe(false);
    expect(registerCalendarWatch).not.toHaveBeenCalled();
    expect(writeGoogleCalendarWatchMetadataMap).not.toHaveBeenCalled();
  });

  it("POST with force=true registers even when watch is healthy", async () => {
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({
      "la-jobs@group.calendar.google.com": {
        version: 1,
        channelId: "channel-healthy",
        resourceId: "resource-healthy",
        expiration: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
        calendarId: "la-jobs@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-28T12:00:00.000Z",
      },
      "overture@group.calendar.google.com": {
        version: 1,
        channelId: "channel-overture-healthy",
        resourceId: "resource-overture-healthy",
        expiration: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
        calendarId: "overture@group.calendar.google.com",
        webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
        createdAtUtc: "2026-04-28T12:00:00.000Z",
      },
    });
    registerCalendarWatch
      .mockResolvedValueOnce({
        channelId: "channel-forced-la",
        resourceId: "resource-forced-la",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        channelId: "channel-forced-overture",
        resourceId: "resource-forced-overture",
        expiration: new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000).toISOString(),
      });
    writeGoogleCalendarWatchMetadataMap.mockImplementation(async (_storeName: string, map: Record<string, unknown>) => map);

    const { POST } = await loadHandlers();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch?force=true", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.action).toBe("registered");
    expect(body.force).toBe(true);
    expect(body.registeredCalendarIds).toEqual([
      "la-jobs@group.calendar.google.com",
      "overture@group.calendar.google.com",
    ]);
    expect(registerCalendarWatch).toHaveBeenCalledTimes(2);
    expect(writeGoogleCalendarWatchMetadataMap).toHaveBeenCalledTimes(1);
  });

  it("POST returns safe failure response when Google watch registration fails", async () => {
    readGoogleCalendarWatchMetadataMap.mockResolvedValue({});
    registerCalendarWatch.mockRejectedValue(new Error("google api error"));

    const { POST } = await loadHandlers();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const res = await POST(req);
    expect(res.status).toBe(502);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("failed");
    expect(body.error).toBe("watch_registration_failed");
    expect(JSON.stringify(body)).not.toContain(WEBHOOK_TOKEN);
    expect(JSON.stringify(body)).not.toContain(ADMIN_TOKEN);
    expect(JSON.stringify(body)).not.toContain(REFRESH_TOKEN);
    expect(writeGoogleCalendarWatchMetadataMap).not.toHaveBeenCalled();
  });
});
