import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@/lib/types";
import { BoardWindowPayloadSchema } from "@/lib/board-window-payload-schema";

const writeBoardPayloadCache = vi.fn();

vi.mock("@/lib/board-payload-cache", async () => {
  const actual = await vi.importActual<typeof import("@/lib/board-payload-cache")>(
    "@/lib/board-payload-cache",
  );
  return {
    ...actual,
    writeBoardPayloadCache: (...args: unknown[]) => writeBoardPayloadCache(...args),
  };
});

const snapshot: Snapshot = {
  version: 1,
  generatedAtUtc: "2026-05-01T12:00:00.000Z",
  windowStartUtc: "2026-05-01T00:00:00.000Z",
  windowEndUtc: "2026-08-01T00:00:00.000Z",
  busy: [],
  namedEvents: [
    {
      startUtc: "2026-05-12T04:00:00.000Z",
      endUtc: "2026-05-13T04:00:00.000Z",
      summary: "LA#10001 - Dave LA Job",
      eventId: "evt-la-dave",
      description: "LA_NOTE_DAVE",
      ownerEditor: "dave",
      calendarId: "la-jobs@group.calendar.google.com",
      displayMode: "details",
    },
  ],
  sourceCalendarIds: [
    "la-jobs@group.calendar.google.com",
    "overture@group.calendar.google.com",
  ],
  config: {
    timezone: "America/New_York",
    workdayStartHour: 9,
    workdayEndHour: 18,
    hideWeekends: false,
    showTentative: false,
    pageTitle: "LA Schedule",
  },
};

const file = {
  timezone: "America/New_York",
  workdayStartHour: 9,
  workdayEndHour: 18,
};

const env = {
  GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
  OVERTURE_CALENDAR_ID: "overture@group.calendar.google.com",
};

describe("lib/precompute-board-payloads", () => {
  beforeEach(() => {
    vi.resetModules();
    writeBoardPayloadCache.mockReset();
    writeBoardPayloadCache.mockResolvedValue(undefined);
  });

  it("writes selected/full list/month payloads for required editor buckets", async () => {
    const { precomputeBoardPayloadCaches } = await import("@/lib/precompute-board-payloads");
    const result = await precomputeBoardPayloadCaches({
      snapshot,
      file,
      env,
      nowMs: Date.parse("2026-05-11T12:00:00.000Z"),
    });

    expect(result).toEqual({
      attempted: 28,
      written: 28,
      failed: 0,
    });
    expect(writeBoardPayloadCache).toHaveBeenCalledTimes(28);

    const editorBuckets = new Set<string>();
    const views = new Set<string>();
    const scopes = new Set<string>();
    for (const [key, payload] of writeBoardPayloadCache.mock.calls as Array<
      [{ editorBucket: string; viewMode: string; scope: string }, unknown]
    >) {
      editorBuckets.add(key.editorBucket);
      views.add(key.viewMode);
      scopes.add(key.scope);
      const parsed = BoardWindowPayloadSchema.safeParse(payload);
      expect(parsed.success).toBe(true);
      const boardPayload = parsed.success ? parsed.data : null;
      if (boardPayload) {
        expect(boardPayload.generatedAtUtc).toBe(snapshot.generatedAtUtc);
        if (key.scope === "full") {
          expect(boardPayload.weekWindow.weeks.length).toBeGreaterThan(1);
          expect(boardPayload.monthWindow.months.length).toBeGreaterThan(1);
        } else {
          expect(boardPayload.weekWindow.weeks).toEqual([]);
          expect(boardPayload.monthWindow.months).toEqual([]);
        }
      }
    }

    expect(editorBuckets).toEqual(new Set([
      "public",
      "anon",
      "legacy",
      "jeff",
      "dave",
      "milos",
      "mike",
    ]));
    expect(views).toEqual(new Set(["list", "month"]));
    expect(scopes).toEqual(new Set(["selected", "full"]));
  });

  it("swallows per-payload write failures and keeps going", async () => {
    let count = 0;
    writeBoardPayloadCache.mockImplementation(async () => {
      count += 1;
      if (count <= 2) {
        throw new Error("temporary upsert failure");
      }
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { precomputeBoardPayloadCaches } = await import("@/lib/precompute-board-payloads");
      const result = await precomputeBoardPayloadCaches({
        snapshot,
        file,
        env,
        nowMs: Date.parse("2026-05-11T12:00:00.000Z"),
      });

      expect(result).toEqual({
        attempted: 28,
        written: 26,
        failed: 2,
      });
      expect(writeBoardPayloadCache).toHaveBeenCalledTimes(28);
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
