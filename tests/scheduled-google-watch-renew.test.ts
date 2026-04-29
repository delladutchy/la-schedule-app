import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerResponse } from "@netlify/functions";

const getEnvConfig = vi.fn();
const ensureGoogleCalendarWatch = vi.fn();

vi.mock("../lib/config", () => ({
  getEnvConfig: (...args: unknown[]) => getEnvConfig(...args),
}));

vi.mock("../lib/google-watch", () => ({
  ensureGoogleCalendarWatch: (...args: unknown[]) => ensureGoogleCalendarWatch(...args),
  WatchConfigError: class WatchConfigError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.name = "WatchConfigError";
      this.code = code;
    }
  },
}));

async function loadHandler() {
  const mod = await import("../netlify/functions/scheduled-google-watch-renew");
  return mod.handler;
}

function requireResponse(result: void | HandlerResponse): HandlerResponse {
  if (!result) {
    throw new Error("Expected handler response");
  }
  return result;
}

describe("scheduled-google-watch-renew function", () => {
  beforeEach(() => {
    getEnvConfig.mockReset();
    ensureGoogleCalendarWatch.mockReset();
    process.env.URL = "https://la-schedule-app.netlify.app";
  });

  afterEach(() => {
    delete process.env.URL;
  });

  it("logs skipped when watch is healthy", async () => {
    getEnvConfig.mockReturnValue({
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REFRESH_TOKEN: "refresh-token",
      GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
      GOOGLE_WEBHOOK_TOKEN: "google-webhook-token",
      BLOBS_STORE_NAME: "availability-snapshots",
      PUBLIC_SITE_URL: "https://la-schedule-app.netlify.app",
    });
    ensureGoogleCalendarWatch.mockResolvedValue({
      status: "ok",
      action: "skipped",
      force: false,
      renewalReason: "healthy",
      needsRenewal: false,
      expiresInMs: 172800000,
    });

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const handler = await loadHandler();
      const result = requireResponse(await handler({} as never, {} as never));
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body ?? "{}")).toMatchObject({
        status: "ok",
        action: "skipped",
        expiresInMs: 172800000,
      });
      expect(ensureGoogleCalendarWatch).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          force: false,
          runtimeSiteUrl: "https://la-schedule-app.netlify.app",
        }),
      );
      const logs = infoSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logs).toContain("[google:watch:auto-renew] skipped");
      expect(logs).toContain("reason=healthy");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("logs renewed when a fresh watch is registered", async () => {
    getEnvConfig.mockReturnValue({
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REFRESH_TOKEN: "refresh-token",
      GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
      GOOGLE_WEBHOOK_TOKEN: "google-webhook-token",
      BLOBS_STORE_NAME: "availability-snapshots",
      PUBLIC_SITE_URL: "https://la-schedule-app.netlify.app",
    });
    ensureGoogleCalendarWatch.mockResolvedValue({
      status: "ok",
      action: "registered",
      force: false,
      renewalReason: "healthy",
      needsRenewal: false,
      expiresInMs: 432000000,
    });

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const handler = await loadHandler();
      const result = requireResponse(await handler({} as never, {} as never));
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body ?? "{}")).toMatchObject({
        status: "ok",
        action: "registered",
      });
      const logs = infoSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logs).toContain("[google:watch:auto-renew] renewed");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("logs safe failures when renewal throws", async () => {
    getEnvConfig.mockReturnValue({
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REFRESH_TOKEN: "refresh-token",
      GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
      GOOGLE_WEBHOOK_TOKEN: "google-webhook-token",
      BLOBS_STORE_NAME: "availability-snapshots",
      PUBLIC_SITE_URL: "https://la-schedule-app.netlify.app",
    });
    ensureGoogleCalendarWatch.mockRejectedValue(new Error("google blew up"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const handler = await loadHandler();
      const result = requireResponse(await handler({} as never, {} as never));
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body ?? "{}")).toMatchObject({
        status: "failed",
        error: "watch_auto_renew_failed",
      });
      const logs = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logs).toContain("[google:watch:auto-renew] failed");
      expect(logs).not.toContain("google-webhook-token");
      expect(logs).not.toContain("refresh-token");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
