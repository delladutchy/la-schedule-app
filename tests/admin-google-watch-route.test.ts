import { beforeEach, describe, expect, it, vi } from "vitest";

const registerCalendarWatch = vi.fn();
const writeGoogleCalendarWatchMetadata = vi.fn();

const ADMIN_TOKEN = "admin-token-0123456789abcdef";
const WEBHOOK_TOKEN = "google-webhook-token-0123456789";
const REFRESH_TOKEN = "refresh-token-abcdef";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    env: {
      ADMIN_TOKEN,
      GOOGLE_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN,
      GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
      BLOBS_STORE_NAME: "availability-snapshots",
    },
  }),
}));

vi.mock("@/lib/google", () => ({
  registerCalendarWatch: (...args: unknown[]) => registerCalendarWatch(...args),
}));

vi.mock("@/lib/google-watch-store", () => ({
  writeGoogleCalendarWatchMetadata: (...args: unknown[]) => writeGoogleCalendarWatchMetadata(...args),
}));

async function loadPost() {
  const mod = await import("@/app/api/admin/google-calendar/watch/route");
  return mod.POST;
}

describe("/api/admin/google-calendar/watch", () => {
  beforeEach(() => {
    registerCalendarWatch.mockReset();
    writeGoogleCalendarWatchMetadata.mockReset();
  });

  it("returns 401 when admin token is missing", async () => {
    const POST = await loadPost();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(registerCalendarWatch).not.toHaveBeenCalled();
    expect(writeGoogleCalendarWatchMetadata).not.toHaveBeenCalled();
  });

  it("returns 401 when admin token is invalid", async () => {
    const POST = await loadPost();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      method: "POST",
      headers: { Authorization: "Bearer invalid-token-0000000000000000" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(registerCalendarWatch).not.toHaveBeenCalled();
    expect(writeGoogleCalendarWatchMetadata).not.toHaveBeenCalled();
  });

  it("registers watch and writes metadata for valid admin token", async () => {
    registerCalendarWatch.mockResolvedValue({
      channelId: "channel-123",
      resourceId: "resource-123",
      expiration: "2026-05-01T00:00:00.000Z",
    });
    writeGoogleCalendarWatchMetadata.mockResolvedValue({
      version: 1,
      channelId: "channel-123",
      resourceId: "resource-123",
      expiration: "2026-05-01T00:00:00.000Z",
      calendarId: "la-jobs@group.calendar.google.com",
      webhookUrl: "https://la-schedule-app.netlify.app/api/google/calendar/webhook",
      createdAtUtc: "2026-04-29T00:00:00.000Z",
    });

    const POST = await loadPost();
    const req = new Request("https://la-schedule-app.netlify.app/api/admin/google-calendar/watch", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.calendarId).toBe("la-jobs@group.calendar.google.com");
    expect(body.channelId).toBe("channel-123");
    expect(body.resourceId).toBe("resource-123");

    expect(registerCalendarWatch).toHaveBeenCalledTimes(1);
    const registerArgs = registerCalendarWatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(registerArgs.calendarId).toBe("la-jobs@group.calendar.google.com");
    expect(registerArgs.webhookUrl).toBe("https://la-schedule-app.netlify.app/api/google/calendar/webhook");
    expect(registerArgs.channelToken).toBe(WEBHOOK_TOKEN);

    expect(writeGoogleCalendarWatchMetadata).toHaveBeenCalledTimes(1);
    const [storeName, metadata] = writeGoogleCalendarWatchMetadata.mock.calls[0] as [string, Record<string, unknown>];
    expect(storeName).toBe("availability-snapshots");
    expect(metadata.calendarId).toBe("la-jobs@group.calendar.google.com");
    expect(metadata.webhookUrl).toBe("https://la-schedule-app.netlify.app/api/google/calendar/webhook");
  });

  it("returns safe failure response when Google watch registration fails", async () => {
    registerCalendarWatch.mockRejectedValue(new Error("google api error"));

    const POST = await loadPost();
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
    expect(writeGoogleCalendarWatchMetadata).not.toHaveBeenCalled();
  });
});
