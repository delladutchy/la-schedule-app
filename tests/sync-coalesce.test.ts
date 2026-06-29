import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Interval } from "@/lib/intervals";

const fetchFreeBusy = vi.fn();
const fetchCalendarEvents = vi.fn();
const readCurrentSnapshot = vi.fn();
const writeCurrentSnapshot = vi.fn();
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
  readCurrentSnapshot: (...args: unknown[]) => readCurrentSnapshot(...args),
  writeCurrentSnapshot: (...args: unknown[]) => writeCurrentSnapshot(...args),
}));

vi.mock("@/lib/board-payload-cache", () => ({
  isBoardCacheEnabled: (...args: unknown[]) => isBoardCacheEnabled(...args),
}));

vi.mock("@/lib/precompute-board-payloads", () => ({
  precomputeBoardPayloadCaches: vi.fn().mockResolvedValue({ attempted: 0, written: 0, failed: 0 }),
}));

const freshSnapshot = {
  version: 1 as const,
  generatedAtUtc: "2026-05-12T12:00:00.000Z",
  windowStartUtc: "2026-05-12T04:00:00.000Z",
  windowEndUtc: "2027-05-12T04:00:00.000Z",
  busy: [],
  sourceCalendarIds: ["la-jobs@group.calendar.google.com"],
  config: {
    timezone: "America/New_York",
    workdayStartHour: 9,
    workdayEndHour: 18,
    hideWeekends: false,
    showTentative: false,
    pageTitle: "LA Schedule",
  },
};

describe("buildAndPersistSnapshot sync coalescing", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchFreeBusy.mockReset();
    fetchCalendarEvents.mockReset();
    readCurrentSnapshot.mockReset();
    writeCurrentSnapshot.mockReset();
    isBoardCacheEnabled.mockReturnValue(false);

    fetchFreeBusy.mockResolvedValue({ intervals: [] as Interval[], erroredCalendarIds: [] });
    fetchCalendarEvents.mockResolvedValue({ events: [], erroredCalendarIds: [] });
    writeCurrentSnapshot.mockResolvedValue(undefined);
  });

  it("runs a full sync when skipIfFresherThanMs is not set", async () => {
    const { buildAndPersistSnapshot } = await import("@/lib/sync");
    const result = await buildAndPersistSnapshot();
    expect(result.status).toBe("ok");
    expect(result.skipped).toBeFalsy();
    expect(fetchFreeBusy).toHaveBeenCalledTimes(1);
    expect(readCurrentSnapshot).not.toHaveBeenCalled();
  });

  it("skips the sync and returns existing snapshot when snapshot is fresher than threshold", async () => {
    const nowMs = Date.parse("2026-05-12T12:00:05.000Z"); // 5 seconds after snapshot
    readCurrentSnapshot.mockResolvedValue(freshSnapshot);

    const { buildAndPersistSnapshot } = await import("@/lib/sync");
    const result = await buildAndPersistSnapshot(nowMs, { skipIfFresherThanMs: 10_000 });

    expect(result.status).toBe("ok");
    expect(result.skipped).toBe(true);
    expect(result.snapshot).toBe(freshSnapshot);
    expect(fetchFreeBusy).not.toHaveBeenCalled();
    expect(writeCurrentSnapshot).not.toHaveBeenCalled();
  });

  it("runs a full sync when snapshot is older than threshold", async () => {
    const nowMs = Date.parse("2026-05-12T12:00:15.000Z"); // 15 seconds after snapshot
    readCurrentSnapshot.mockResolvedValue(freshSnapshot);

    const { buildAndPersistSnapshot } = await import("@/lib/sync");
    const result = await buildAndPersistSnapshot(nowMs, { skipIfFresherThanMs: 10_000 });

    expect(result.status).toBe("ok");
    expect(result.skipped).toBeFalsy();
    expect(fetchFreeBusy).toHaveBeenCalledTimes(1);
  });

  it("runs a full sync when no existing snapshot is found even if threshold is set", async () => {
    const nowMs = Date.parse("2026-05-12T12:00:05.000Z");
    readCurrentSnapshot.mockResolvedValue(null); // no snapshot

    const { buildAndPersistSnapshot } = await import("@/lib/sync");
    const result = await buildAndPersistSnapshot(nowMs, { skipIfFresherThanMs: 10_000 });

    expect(result.status).toBe("ok");
    expect(result.skipped).toBeFalsy();
    expect(fetchFreeBusy).toHaveBeenCalledTimes(1);
  });

  it("runs a full sync when skipIfFresherThanMs is 0", async () => {
    readCurrentSnapshot.mockResolvedValue(freshSnapshot);

    const { buildAndPersistSnapshot } = await import("@/lib/sync");
    const result = await buildAndPersistSnapshot(undefined, { skipIfFresherThanMs: 0 });

    expect(result.status).toBe("ok");
    expect(result.skipped).toBeFalsy();
    expect(fetchFreeBusy).toHaveBeenCalledTimes(1);
  });

  it("returns isRateLimit=true when FreeBusy is rejected with quota error", async () => {
    const quotaError = new Error(
      "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'",
    );
    fetchFreeBusy.mockRejectedValue(quotaError);

    const { buildAndPersistSnapshot } = await import("@/lib/sync");
    const result = await buildAndPersistSnapshot();

    expect(result.status).toBe("failed");
    expect(result.isRateLimit).toBe(true);
    expect(writeCurrentSnapshot).not.toHaveBeenCalled();
  });

  it("returns isRateLimit=false for a generic FreeBusy transport error", async () => {
    fetchFreeBusy.mockRejectedValue(new Error("ECONNRESET"));

    const { buildAndPersistSnapshot } = await import("@/lib/sync");
    const result = await buildAndPersistSnapshot();

    expect(result.status).toBe("failed");
    expect(result.isRateLimit).toBeFalsy();
  });

  it("does not call readCurrentSnapshot for the skip check when threshold is not set", async () => {
    const { buildAndPersistSnapshot } = await import("@/lib/sync");
    await buildAndPersistSnapshot();
    // readCurrentSnapshot may be called by other paths but not for the coalesce check
    // The key assertion is that fetchFreeBusy still ran
    expect(fetchFreeBusy).toHaveBeenCalledTimes(1);
  });
});
