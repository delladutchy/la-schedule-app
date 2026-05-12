import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@/lib/types";

const writeCurrentSnapshot = vi.fn();
const buildAndPersistSnapshot = vi.fn();
const precomputeBoardPayloadCaches = vi.fn();
const isBoardCacheEnabled = vi.fn();

vi.mock("@/lib/store", () => ({
  writeCurrentSnapshot: (...args: unknown[]) => writeCurrentSnapshot(...args),
}));

vi.mock("@/lib/sync", () => ({
  buildAndPersistSnapshot: (...args: unknown[]) => buildAndPersistSnapshot(...args),
}));

vi.mock("@/lib/precompute-board-payloads", () => ({
  precomputeBoardPayloadCaches: (...args: unknown[]) => precomputeBoardPayloadCaches(...args),
}));

vi.mock("@/lib/board-payload-cache", () => ({
  isBoardCacheEnabled: (...args: unknown[]) => isBoardCacheEnabled(...args),
}));

const baselineSnapshot: Snapshot = {
  version: 1,
  generatedAtUtc: "2026-05-12T10:00:00.000Z",
  windowStartUtc: "2026-05-01T00:00:00.000Z",
  windowEndUtc: "2026-06-30T00:00:00.000Z",
  busy: [
    {
      startUtc: "2026-05-18T04:00:00.000Z",
      endUtc: "2026-05-19T04:00:00.000Z",
    },
  ],
  namedEvents: [
    {
      startUtc: "2026-05-18T04:00:00.000Z",
      endUtc: "2026-05-19T04:00:00.000Z",
      summary: "LA#1000 — Existing",
      eventId: "evt-existing",
      calendarId: "la-jobs@group.calendar.google.com",
      displayMode: "details",
    },
  ],
  sourceCalendarIds: ["la-jobs@group.calendar.google.com"],
  config: {
    timezone: "America/New_York",
    workdayStartHour: 9,
    workdayEndHour: 18,
    hideWeekends: true,
    showTentative: false,
    pageTitle: "Availability",
  },
};

const fullSyncSnapshot: Snapshot = {
  ...baselineSnapshot,
  generatedAtUtc: "2026-05-12T10:05:00.000Z",
};

describe("mutation post-sync helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    writeCurrentSnapshot.mockReset();
    buildAndPersistSnapshot.mockReset();
    precomputeBoardPayloadCaches.mockReset();
    isBoardCacheEnabled.mockReset();

    writeCurrentSnapshot.mockResolvedValue({
      supabaseWriteAttempted: true,
      supabaseWriteSucceeded: true,
    });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot: fullSyncSnapshot });
    precomputeBoardPayloadCaches.mockResolvedValue({ attempted: 14, written: 14, failed: 0 });
    isBoardCacheEnabled.mockReturnValue(true);
  });

  it("uses fast patch path for create and precomputes selected scope only", async () => {
    const { refreshSnapshotAfterMutation } = await import("@/lib/mutation-postsync");

    const result = await refreshSnapshotAfterMutation({
      storeName: "availability-snapshots",
      baselineSnapshot,
      mutation: {
        action: "create",
        event: {
          eventId: "evt-created",
          calendarId: "la-jobs@group.calendar.google.com",
          summary: "LA#2000 — New Job",
          description: "Call Time: 9:00 AM",
          ownerEditor: "jeff",
          startDate: "2026-05-20",
          endDateExclusive: "2026-05-21",
        },
      },
      file: {
        timezone: "America/New_York",
        preBufferMinutes: 0,
        postBufferMinutes: 0,
        workdayStartHour: 9,
        workdayEndHour: 18,
      },
      env: {
        CALENDAR_DISPLAY_MODES: {},
        GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
        OVERTURE_CALENDAR_ID: "overture@group.calendar.google.com",
      },
      nowMs: Date.parse("2026-05-12T10:03:00.000Z"),
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("fast_patch");
    expect(buildAndPersistSnapshot).not.toHaveBeenCalled();
    expect(writeCurrentSnapshot).toHaveBeenCalledTimes(1);
    expect(precomputeBoardPayloadCaches).toHaveBeenCalledTimes(1);
    expect(precomputeBoardPayloadCaches).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["selected"] }),
    );

    const writtenSnapshot = writeCurrentSnapshot.mock.calls[0]?.[1] as Snapshot;
    expect(writtenSnapshot.generatedAtUtc).toBe("2026-05-12T10:03:00.000Z");
    expect(writtenSnapshot.namedEvents?.some((event) => event.eventId === "evt-created")).toBe(true);
  });

  it("falls back to full sync when edit target cannot be safely patched", async () => {
    const { refreshSnapshotAfterMutation } = await import("@/lib/mutation-postsync");

    const result = await refreshSnapshotAfterMutation({
      storeName: "availability-snapshots",
      baselineSnapshot,
      mutation: {
        action: "edit",
        event: {
          eventId: "evt-missing",
          calendarId: "la-jobs@group.calendar.google.com",
          summary: "LA#2001 — Missing",
          startDate: "2026-05-22",
          endDateExclusive: "2026-05-23",
        },
      },
      file: {
        timezone: "America/New_York",
        preBufferMinutes: 0,
        postBufferMinutes: 0,
        workdayStartHour: 9,
        workdayEndHour: 18,
      },
      env: {
        CALENDAR_DISPLAY_MODES: {},
        GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
        OVERTURE_CALENDAR_ID: "overture@group.calendar.google.com",
      },
    });

    expect(result.mode).toBe("full_sync_fallback");
    expect(buildAndPersistSnapshot).toHaveBeenCalledTimes(1);
    expect(writeCurrentSnapshot).not.toHaveBeenCalled();
  });

  it("skips selected board precompute when snapshot_cache write-through fails", async () => {
    writeCurrentSnapshot.mockResolvedValueOnce({
      supabaseWriteAttempted: true,
      supabaseWriteSucceeded: false,
      supabaseWriteErrorCode: "42501",
      supabaseWriteErrorMessage: "permission denied",
    });

    const { refreshSnapshotAfterMutation } = await import("@/lib/mutation-postsync");

    const result = await refreshSnapshotAfterMutation({
      storeName: "availability-snapshots",
      baselineSnapshot,
      mutation: {
        action: "delete",
        eventId: "evt-existing",
        calendarId: "la-jobs@group.calendar.google.com",
      },
      file: {
        timezone: "America/New_York",
        preBufferMinutes: 0,
        postBufferMinutes: 0,
        workdayStartHour: 9,
        workdayEndHour: 18,
      },
      env: {
        CALENDAR_DISPLAY_MODES: {},
        GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
        OVERTURE_CALENDAR_ID: "overture@group.calendar.google.com",
      },
    });

    expect(result.status).toBe("ok");
    expect(precomputeBoardPayloadCaches).not.toHaveBeenCalled();
  });

  it("queues deferred reconciliation when not running tests", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { scheduleDeferredReconciliationSync } = await import("@/lib/mutation-postsync");
      const result = await scheduleDeferredReconciliationSync({
        requestUrl: "https://la-schedule-app.netlify.app/api/gigs/create",
        adminToken: "admin-token-0123456789",
        reason: "gigs_create_post_google_write",
        editorId: "jeff",
        generatedAtUtc: "2026-05-12T10:03:00.000Z",
        action: "create",
      });

      expect(result.queued).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://la-schedule-app.netlify.app/.netlify/functions/reconcile-snapshot-background",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            authorization: "Bearer admin-token-0123456789",
          }),
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
