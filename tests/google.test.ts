import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryRequest = {
  requestBody?: {
    timeMin?: string;
    timeMax?: string;
    items?: Array<{ id: string }>;
  };
};

const queryMock = vi.fn();

vi.mock("googleapis", () => {
  class OAuth2Mock {
    constructor(_clientId: string, _clientSecret: string) {}
    setCredentials(_creds: unknown) {}
  }

  return {
    google: {
      auth: { OAuth2: OAuth2Mock },
      calendar: vi.fn(() => ({
        freebusy: {
          query: queryMock,
        },
      })),
    },
  };
});

import { fetchFreeBusy } from "@/lib/google";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("fetchFreeBusy", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("chunks long windows into <=60-day requests and keeps 5-calendar batching", async () => {
    queryMock.mockImplementation(async (req: QueryRequest) => {
      const rb = req.requestBody;
      const calendars: Record<string, { busy: Array<{ start: string; end: string }> }> = {};
      for (const item of rb?.items ?? []) {
        calendars[item.id] = {
          busy: [{ start: rb?.timeMin as string, end: rb?.timeMax as string }],
        };
      }
      return { data: { calendars } };
    });

    const startMs = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    const endMs = startMs + 125 * DAY_MS;
    const calendarIds = ["c1", "c2", "c3", "c4", "c5", "c6"];

    const out = await fetchFreeBusy({
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
      calendarIds,
      timeMinMs: startMs,
      timeMaxMs: endMs,
    });

    expect(out.erroredCalendarIds).toEqual([]);
    expect(queryMock).toHaveBeenCalledTimes(6); // 3 time slices * 2 calendar slices
    expect(out.intervals).toHaveLength(18); // 3 time slices * 6 calendars

    const calls = queryMock.mock.calls.map(([req]) => (req as QueryRequest).requestBody);
    for (const rb of calls) {
      expect((rb?.items ?? []).length).toBeLessThanOrEqual(5);
      const minMs = Date.parse(rb?.timeMin as string);
      const maxMs = Date.parse(rb?.timeMax as string);
      expect(maxMs - minMs).toBeLessThanOrEqual(60 * DAY_MS);
    }

    const windows = calls.map((rb) => `${rb?.timeMin}|${rb?.timeMax}`);
    const windowCounts = new Map<string, number>();
    for (const w of windows) {
      windowCounts.set(w, (windowCounts.get(w) ?? 0) + 1);
    }
    expect(windowCounts.size).toBe(3);
    expect([...windowCounts.values()]).toEqual([2, 2, 2]);
  });

  it("deduplicates per-calendar errors across multiple time chunks", async () => {
    queryMock.mockImplementation(async (req: QueryRequest) => {
      const rb = req.requestBody;
      const calendars: Record<string, unknown> = {};
      for (const item of rb?.items ?? []) {
        if (item.id === "good") {
          calendars[item.id] = { busy: [] };
        }
        if (item.id === "bad-1") {
          calendars[item.id] = { errors: [{ reason: "notFound" }] };
        }
      }
      return { data: { calendars } };
    });

    const startMs = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    const endMs = startMs + 130 * DAY_MS;

    const out = await fetchFreeBusy({
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
      calendarIds: ["good", "bad-1", "bad-2"],
      timeMinMs: startMs,
      timeMaxMs: endMs,
    });

    expect(out.intervals).toEqual([]);
    expect(out.erroredCalendarIds.sort()).toEqual(["bad-1", "bad-2"]);
    expect(queryMock).toHaveBeenCalledTimes(3); // 3 time slices, 1 calendar slice each
  });
});
