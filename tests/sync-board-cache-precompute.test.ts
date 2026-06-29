import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Interval } from "@/lib/intervals";

const fetchFreeBusy = vi.fn();
const fetchCalendarEvents = vi.fn();
const writeCurrentSnapshot = vi.fn();
const precomputeBoardPayloadCaches = vi.fn();
const isBoardCacheEnabled = vi.fn();

const file = {
  timezone: "America/New_York",
  workdayStartHour: 9,
  workdayEndHour: 18,
  hideWeekends: false,
  showTentative: false,
  pageTitle: "LA Schedule",
  pageSubtitle: "Team availability",
  horizonDays: 60,
  preBufferMinutes: 0,
  postBufferMinutes: 0,
};

const env = {
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GOOGLE_REFRESH_TOKEN: "google-refresh-token",
  BLOCKER_CALENDAR_IDS: ["la-jobs@group.calendar.google.com"],
  CALENDAR_DISPLAY_MODES: {},
  GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
  OVERTURE_CALENDAR_ID: "overture@group.calendar.google.com",
  BLOBS_STORE_NAME: "availability-snapshots",
};

vi.mock("@/lib/google", () => ({
  fetchFreeBusy: (...args: unknown[]) => fetchFreeBusy(...args),
  fetchCalendarEvents: (...args: unknown[]) => fetchCalendarEvents(...args),
  buildCalendarAuth: () => ({
    getAccessToken: () => Promise.resolve({ token: "mock-access-token" }),
  }),
  buildCalendarServiceAccountAuth: () => Promise.resolve(null),
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ file, env }),
}));

vi.mock("@/lib/store", () => ({
  writeCurrentSnapshot: (...args: unknown[]) => writeCurrentSnapshot(...args),
}));

vi.mock("@/lib/board-payload-cache", () => ({
  isBoardCacheEnabled: (...args: unknown[]) => isBoardCacheEnabled(...args),
}));

vi.mock("@/lib/precompute-board-payloads", () => ({
  precomputeBoardPayloadCaches: (...args: unknown[]) => precomputeBoardPayloadCaches(...args),
}));

describe("lib/sync board cache precompute integration", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchFreeBusy.mockReset();
    fetchCalendarEvents.mockReset();
    writeCurrentSnapshot.mockReset();
    precomputeBoardPayloadCaches.mockReset();
    isBoardCacheEnabled.mockReset();

    fetchFreeBusy.mockResolvedValue({
      intervals: [] as Interval[],
      erroredCalendarIds: [],
    });
    fetchCalendarEvents.mockResolvedValue({
      events: [],
      erroredCalendarIds: [],
    });
    writeCurrentSnapshot.mockResolvedValue({
      supabaseWriteAttempted: false,
      supabaseWriteSucceeded: false,
    });
    precomputeBoardPayloadCaches.mockResolvedValue({
      attempted: 28,
      written: 28,
      failed: 0,
    });
    isBoardCacheEnabled.mockReturnValue(false);
  });

  it("with BOARD_CACHE_ENABLED=false, behavior is unchanged and precompute is skipped", async () => {
    const { buildAndPersistSnapshot } = await import("@/lib/sync");
    const nowMs = Date.parse("2026-05-11T12:00:00.000Z");

    const result = await buildAndPersistSnapshot(nowMs);

    expect(result.status).toBe("ok");
    expect(writeCurrentSnapshot).toHaveBeenCalledTimes(1);
    expect(precomputeBoardPayloadCaches).not.toHaveBeenCalled();
  });

  it("with BOARD_CACHE_ENABLED=true, runs precompute after snapshot write", async () => {
    isBoardCacheEnabled.mockReturnValue(true);
    writeCurrentSnapshot.mockResolvedValueOnce({
      supabaseWriteAttempted: true,
      supabaseWriteSucceeded: true,
    });
    const { buildAndPersistSnapshot } = await import("@/lib/sync");
    const nowMs = Date.parse("2026-05-11T12:00:00.000Z");

    const result = await buildAndPersistSnapshot(nowMs);

    expect(result.status).toBe("ok");
    expect(writeCurrentSnapshot).toHaveBeenCalledTimes(1);
    expect(precomputeBoardPayloadCaches).toHaveBeenCalledTimes(1);
    const args = precomputeBoardPayloadCaches.mock.calls[0]?.[0] as
      | {
        snapshot: { version: number; generatedAtUtc: string };
        file: { timezone: string };
        env: { GOOGLE_CALENDAR_ID: string };
        nowMs: number;
      }
      | undefined;
    expect(args?.snapshot.version).toBe(1);
    expect(args?.file.timezone).toBe(file.timezone);
    expect(args?.env.GOOGLE_CALENDAR_ID).toBe(env.GOOGLE_CALENDAR_ID);
    expect(args?.nowMs).toBe(nowMs);
    expect(args?.snapshot.generatedAtUtc).toBe(new Date(nowMs).toISOString());
  });

  it("precompute failures are swallowed and do not fail sync", async () => {
    isBoardCacheEnabled.mockReturnValue(true);
    writeCurrentSnapshot.mockResolvedValueOnce({
      supabaseWriteAttempted: true,
      supabaseWriteSucceeded: true,
    });
    precomputeBoardPayloadCaches.mockRejectedValueOnce(new Error("supabase unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { buildAndPersistSnapshot } = await import("@/lib/sync");
      const result = await buildAndPersistSnapshot(Date.parse("2026-05-11T12:00:00.000Z"));
      expect(result.status).toBe("ok");
      expect(writeCurrentSnapshot).toHaveBeenCalledTimes(1);
      expect(precomputeBoardPayloadCaches).toHaveBeenCalledTimes(1);
      expect(fetchFreeBusy).toHaveBeenCalledTimes(1);
      expect(fetchCalendarEvents).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("skips board-cache precompute when snapshot_cache write-through fails", async () => {
    isBoardCacheEnabled.mockReturnValue(true);
    writeCurrentSnapshot.mockResolvedValueOnce({
      supabaseWriteAttempted: true,
      supabaseWriteSucceeded: false,
      supabaseWriteErrorCode: "42501",
      supabaseWriteErrorMessage: "permission denied",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { buildAndPersistSnapshot } = await import("@/lib/sync");
      const result = await buildAndPersistSnapshot(Date.parse("2026-05-11T12:00:00.000Z"));
      expect(result.status).toBe("ok");
      expect(writeCurrentSnapshot).toHaveBeenCalledTimes(1);
      expect(precomputeBoardPayloadCaches).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        "[sync] board-cache precompute skipped because snapshot_cache write-through failed store=availability-snapshots generatedAtUtc=2026-05-11T12:00:00.000Z code=42501 message=permission denied",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
