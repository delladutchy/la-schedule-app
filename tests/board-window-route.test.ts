import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSanitizedBoardWindowPayload,
  type BoardWindowQuery,
} from "@/lib/board-window";
import type { BoardWindowPayload } from "@/lib/board-window";

const readCurrentSnapshot = vi.fn();
const isBoardCacheEnabled = vi.fn();
const readBoardPayloadCache = vi.fn();
const resolveBoardPayloadEditorBucket = vi.fn(
  (editorId: string | null) => editorId?.trim().toLowerCase() || "public",
);
const fetchFreeBusy = vi.fn();
const fetchCalendarEvents = vi.fn();

const TOKENS = {
  jeff: "jeff-editor-token-0123456789",
  dave: "dave-editor-token-0123456789",
  milos: "milos-editor-token-0123456789",
  mike: "mike-editor-token-0123456789",
};

const env = {
  BLOBS_STORE_NAME: "availability-snapshots",
  GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
  OVERTURE_CALENDAR_ID: "overture@group.calendar.google.com",
  EDITOR_TOKENS_JSON: JSON.stringify(TOKENS),
  EDITOR_TOKEN: "legacy-editor-token-0123456789",
};

const file = {
  timezone: "America/New_York",
  workdayStartHour: 9,
  workdayEndHour: 18,
  freshTtlMinutes: 30,
  hardTtlMinutes: 180,
};

const snapshot = {
  version: 1 as const,
  generatedAtUtc: "2026-05-01T12:00:00.000Z",
  windowStartUtc: "2026-05-01T00:00:00.000Z",
  windowEndUtc: "2026-08-01T00:00:00.000Z",
  busy: [
    { startUtc: "2026-05-12T04:00:00.000Z", endUtc: "2026-05-13T04:00:00.000Z" },
    { startUtc: "2026-05-13T04:00:00.000Z", endUtc: "2026-05-14T04:00:00.000Z" },
    { startUtc: "2026-05-14T04:00:00.000Z", endUtc: "2026-05-15T04:00:00.000Z" },
  ],
  namedEvents: [
    {
      startUtc: "2026-05-12T04:00:00.000Z",
      endUtc: "2026-05-13T04:00:00.000Z",
      summary: "LA#10001 — Dave LA Job",
      eventId: "evt-la-dave",
      description: "LA_NOTE_DAVE",
      ownerEditor: "dave",
      calendarId: "la-jobs@group.calendar.google.com",
      displayMode: "details" as const,
    },
    {
      startUtc: "2026-05-13T04:00:00.000Z",
      endUtc: "2026-05-14T04:00:00.000Z",
      summary: "LA#10002 — Milos LA Job",
      eventId: "evt-la-milos",
      description: "LA_NOTE_MILOS",
      ownerEditor: "milos",
      calendarId: "la-jobs@group.calendar.google.com",
      displayMode: "details" as const,
    },
    {
      startUtc: "2026-05-14T04:00:00.000Z",
      endUtc: "2026-05-15T04:00:00.000Z",
      summary: "Overture",
      eventId: "evt-overture",
      description: "OVERTURE_NOTE_JEFF",
      ownerEditor: "jeff",
      calendarId: "overture@group.calendar.google.com",
      displayMode: "details" as const,
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

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ file, env }),
}));

vi.mock("@/lib/store", () => ({
  readCurrentSnapshot: (...args: unknown[]) => readCurrentSnapshot(...args),
}));

vi.mock("@/lib/board-payload-cache", () => ({
  isBoardCacheEnabled: (...args: unknown[]) => isBoardCacheEnabled(...args),
  readBoardPayloadCache: (...args: unknown[]) => readBoardPayloadCache(...args),
  resolveBoardPayloadEditorBucket: (editorId: string | null) =>
    resolveBoardPayloadEditorBucket(editorId),
}));

vi.mock("@/lib/google", () => ({
  fetchFreeBusy: (...args: unknown[]) => fetchFreeBusy(...args),
  fetchCalendarEvents: (...args: unknown[]) => fetchCalendarEvents(...args),
}));

async function loadRoute() {
  const mod = await import("@/app/api/board/window/route");
  return mod.GET;
}

function makeRequest(opts?: {
  token?: string;
  editorQueryToken?: string;
  includeDateParams?: boolean;
}) {
  const url = new URL("http://localhost/api/board/window");
  url.searchParams.set("view", "month");
  if (opts?.includeDateParams !== false) {
    url.searchParams.set("start", "2026-05-12");
    url.searchParams.set("month", "2026-05");
  }
  if (opts?.editorQueryToken) {
    url.searchParams.set("editor", opts.editorQueryToken);
  }
  const headers = opts?.token
    ? { Authorization: `Bearer ${opts.token}` }
    : undefined;
  return new Request(url.toString(), { headers });
}

describe("/api/board/window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    isBoardCacheEnabled.mockReset();
    readBoardPayloadCache.mockReset();
    resolveBoardPayloadEditorBucket.mockClear();
    fetchFreeBusy.mockReset();
    fetchCalendarEvents.mockReset();
    readCurrentSnapshot.mockReset();
    readCurrentSnapshot.mockResolvedValue(snapshot);
    isBoardCacheEnabled.mockReturnValue(false);
    readBoardPayloadCache.mockResolvedValue(null);
    fetchFreeBusy.mockResolvedValue({ intervals: [], erroredCalendarIds: [] });
    fetchCalendarEvents.mockResolvedValue({ events: [], erroredCalendarIds: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns sanitized board-window payload shape", async () => {
    const GET = await loadRoute();
    const res = await GET(makeRequest({ token: TOKENS.jeff }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.generatedAtUtc).toBe("2026-05-01T12:00:00.000Z");
    expect(body.resolvedEditorId).toBe("jeff");
    expect(body).toHaveProperty("selected");
    expect(body).toHaveProperty("selectedBoards.weekRows");
    expect(body).toHaveProperty("selectedBoards.month");
    expect(body).toHaveProperty("weekWindow.weeks");
    expect(body).toHaveProperty("monthWindow.months");
  });

  it("scope=selected returns selected boards only and skips the wide window", async () => {
    const GET = await loadRoute();
    const url = new URL("http://localhost/api/board/window");
    url.searchParams.set("view", "month");
    url.searchParams.set("scope", "selected");
    url.searchParams.set("start", "2026-05-12");
    url.searchParams.set("month", "2026-05");
    const res = await GET(
      new Request(url.toString(), { headers: { Authorization: `Bearer ${TOKENS.jeff}` } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      selectedBoards: { weekRows: unknown[]; month: { weeks: unknown[] } };
      weekWindow: { weeks: unknown[] };
      monthWindow: { months: unknown[] };
    };
    // Selected views must still be populated for the fast-paint payload.
    expect(Array.isArray(body.selectedBoards.weekRows)).toBe(true);
    expect(Array.isArray(body.selectedBoards.month.weeks)).toBe(true);
    expect(body.selectedBoards.month.weeks.length).toBeGreaterThan(0);
    // Wide window must be empty so the route's CPU cost is just the selected
    // builds, not the 9-week + 5-month precompute.
    expect(body.weekWindow.weeks).toEqual([]);
    expect(body.monthWindow.months).toEqual([]);
  });

  it("defaults to no past week/month window slices", async () => {
    const GET = await loadRoute();
    const res = await GET(makeRequest({ token: TOKENS.jeff }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      selected: { weekStart: string; monthKey: string };
      weekWindow: { startWeek: string };
      monthWindow: { startMonth: string };
    };
    expect(body.weekWindow.startWeek).toBe(body.selected.weekStart);
    expect(body.monthWindow.startMonth).toBe(body.selected.monthKey);
  });

  it("does not include prior week/month windows on implicit current-date defaults", async () => {
    const GET = await loadRoute();
    const res = await GET(makeRequest({
      token: TOKENS.jeff,
      includeDateParams: false,
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      selected: { weekStart: string; monthKey: string };
      weekWindow: { startWeek: string };
      monthWindow: { startMonth: string };
    };
    expect(body.weekWindow.startWeek).toBe(body.selected.weekStart);
    expect(body.monthWindow.startMonth).toBe(body.selected.monthKey);
  });

  it("allows Jeff to receive LA and Overture notes", async () => {
    const GET = await loadRoute();
    const res = await GET(makeRequest({ token: TOKENS.jeff }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("LA_NOTE_DAVE");
    expect(serialized).toContain("LA_NOTE_MILOS");
    expect(serialized).toContain("OVERTURE_NOTE_JEFF");
  });

  it("allows Mike to receive Overture notes only", async () => {
    const GET = await loadRoute();
    const res = await GET(makeRequest({ token: TOKENS.mike }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("OVERTURE_NOTE_JEFF");
    expect(serialized).not.toContain("LA_NOTE_DAVE");
    expect(serialized).not.toContain("LA_NOTE_MILOS");
  });

  it("allows Dave to receive LA notes only", async () => {
    const GET = await loadRoute();
    const res = await GET(makeRequest({ token: TOKENS.dave }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("LA_NOTE_DAVE");
    expect(serialized).toContain("LA_NOTE_MILOS");
    expect(serialized).not.toContain("OVERTURE_NOTE_JEFF");
  });

  it("allows Milos to receive only manageable LA notes", async () => {
    const GET = await loadRoute();
    const res = await GET(makeRequest({ token: TOKENS.milos }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("LA_NOTE_MILOS");
    expect(serialized).not.toContain("LA_NOTE_DAVE");
    expect(serialized).not.toContain("OVERTURE_NOTE_JEFF");
  });

  it("does not return notes for public/no-editor requests", async () => {
    const GET = await loadRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("LA_NOTE_DAVE");
    expect(serialized).not.toContain("LA_NOTE_MILOS");
    expect(serialized).not.toContain("OVERTURE_NOTE_JEFF");
    expect((body as { resolvedEditorId?: string | null }).resolvedEditorId ?? null).toBeNull();
  });

  it("resolves editor context from query token bootstrap path", async () => {
    const GET = await loadRoute();
    const res = await GET(makeRequest({ editorQueryToken: TOKENS.jeff }));
    expect(res.status).toBe(200);
    const body = await res.json() as { resolvedEditorId?: string | null };
    expect(body.resolvedEditorId).toBe("jeff");
  });

  it("BOARD_CACHE_ENABLED=false preserves existing route behavior", async () => {
    isBoardCacheEnabled.mockReturnValue(false);
    const GET = await loadRoute();
    const res = await GET(makeRequest({
      token: TOKENS.jeff,
      includeDateParams: false,
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { resolvedEditorId: string | null };
    expect(body.resolvedEditorId).toBe("jeff");
    expect(readBoardPayloadCache).not.toHaveBeenCalled();
  });

  it("BOARD_CACHE_ENABLED=true + scope=selected + cache hit returns cached payload", async () => {
    isBoardCacheEnabled.mockReturnValue(true);
    const cachedPayload = makeCachePayload({ resolvedEditorId: "jeff", viewMode: "month" });
    readBoardPayloadCache.mockResolvedValue({
      payload: cachedPayload,
      generatedAtUtc: cachedPayload.generatedAtUtc,
    });
    const GET = await loadRoute();
    const url = new URL("http://localhost/api/board/window");
    url.searchParams.set("view", "month");
    url.searchParams.set("scope", "selected");
    const res = await GET(
      new Request(url.toString(), { headers: { Authorization: `Bearer ${TOKENS.jeff}` } }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as BoardWindowPayload;
    expect(body.generatedAtUtc).toBe(cachedPayload.generatedAtUtc);
    expect(body.selected.weekStart).toBe(cachedPayload.selected.weekStart);
    expect(body.selected.monthKey).toBe(cachedPayload.selected.monthKey);
    expect(readBoardPayloadCache).toHaveBeenCalledTimes(1);
    expect(readBoardPayloadCache).toHaveBeenCalledWith({
      viewMode: "month",
      weekStart: cachedPayload.selected.weekStart,
      monthKey: cachedPayload.selected.monthKey,
      editorBucket: "jeff",
      scope: "selected",
    });
  });

  it("cache miss falls back to live build path", async () => {
    isBoardCacheEnabled.mockReturnValue(true);
    readBoardPayloadCache.mockResolvedValue(null);
    const GET = await loadRoute();
    const url = new URL("http://localhost/api/board/window");
    url.searchParams.set("view", "month");
    url.searchParams.set("scope", "selected");
    const res = await GET(
      new Request(url.toString(), { headers: { Authorization: `Bearer ${TOKENS.jeff}` } }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as BoardWindowPayload;
    expect(body.resolvedEditorId).toBe("jeff");
    expect(body.selected.view).toBe("month");
    expect(Array.isArray(body.selectedBoards.weekRows)).toBe(true);
  });

  it("invalid cached payload falls back to live build path", async () => {
    isBoardCacheEnabled.mockReturnValue(true);
    readBoardPayloadCache.mockResolvedValue({
      payload: { status: "ok", generatedAtUtc: "2026-05-01T12:00:00.000Z" },
      generatedAtUtc: "2026-05-01T12:00:00.000Z",
    });
    const GET = await loadRoute();
    const url = new URL("http://localhost/api/board/window");
    url.searchParams.set("view", "month");
    url.searchParams.set("scope", "selected");
    const res = await GET(
      new Request(url.toString(), { headers: { Authorization: `Bearer ${TOKENS.jeff}` } }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as BoardWindowPayload;
    expect(body.resolvedEditorId).toBe("jeff");
    expect(body.selected.view).toBe("month");
  });

  it("stale cached payload falls back to live build path", async () => {
    isBoardCacheEnabled.mockReturnValue(true);
    const stalePayload = makeCachePayload({ resolvedEditorId: "jeff", viewMode: "month" });
    readBoardPayloadCache.mockResolvedValue({
      payload: stalePayload,
      generatedAtUtc: "2026-04-01T00:00:00.000Z",
    });
    const GET = await loadRoute();
    const url = new URL("http://localhost/api/board/window");
    url.searchParams.set("view", "month");
    url.searchParams.set("scope", "selected");
    const res = await GET(
      new Request(url.toString(), { headers: { Authorization: `Bearer ${TOKENS.jeff}` } }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as BoardWindowPayload;
    expect(body.resolvedEditorId).toBe("jeff");
    expect(body.generatedAtUtc).toBe(snapshot.generatedAtUtc);
  });

  it("Supabase/cache read error falls back to live build path", async () => {
    isBoardCacheEnabled.mockReturnValue(true);
    readBoardPayloadCache.mockRejectedValueOnce(new Error("supabase unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const GET = await loadRoute();
      const url = new URL("http://localhost/api/board/window");
      url.searchParams.set("view", "month");
      url.searchParams.set("scope", "selected");
      const res = await GET(
        new Request(url.toString(), { headers: { Authorization: `Bearer ${TOKENS.jeff}` } }),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as BoardWindowPayload;
      expect(body.resolvedEditorId).toBe("jeff");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("full scope still uses existing live build path", async () => {
    isBoardCacheEnabled.mockReturnValue(true);
    const GET = await loadRoute();
    const url = new URL("http://localhost/api/board/window");
    url.searchParams.set("view", "month");
    url.searchParams.set("scope", "full");
    const res = await GET(
      new Request(url.toString(), { headers: { Authorization: `Bearer ${TOKENS.jeff}` } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as BoardWindowPayload;
    expect(body.weekWindow.weeks.length).toBeGreaterThan(0);
    expect(readBoardPayloadCache).not.toHaveBeenCalled();
  });

  it("route does not call Google APIs", async () => {
    isBoardCacheEnabled.mockReturnValue(true);
    const GET = await loadRoute();
    const res = await GET(makeRequest({ token: TOKENS.jeff }));
    expect(res.status).toBe(200);
    expect(fetchFreeBusy).not.toHaveBeenCalled();
    expect(fetchCalendarEvents).not.toHaveBeenCalled();
  });

  it("public users do not receive editor payloads from mismatched cache bucket", async () => {
    isBoardCacheEnabled.mockReturnValue(true);
    const leakedPayload = makeCachePayload({ resolvedEditorId: "jeff", viewMode: "month" });
    readBoardPayloadCache.mockResolvedValue({
      payload: leakedPayload,
      generatedAtUtc: leakedPayload.generatedAtUtc,
    });
    const GET = await loadRoute();
    const url = new URL("http://localhost/api/board/window");
    url.searchParams.set("view", "month");
    url.searchParams.set("scope", "selected");
    const res = await GET(new Request(url.toString()));

    expect(res.status).toBe(200);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect((body as { resolvedEditorId?: string | null }).resolvedEditorId ?? null).toBeNull();
    expect(serialized).not.toContain("LA_NOTE_DAVE");
    expect(serialized).not.toContain("LA_NOTE_MILOS");
    expect(serialized).not.toContain("OVERTURE_NOTE_JEFF");
    expect(resolveBoardPayloadEditorBucket).toHaveBeenCalledWith(null);
  });
});

function makeCachePayload(opts: {
  resolvedEditorId: string | null;
  viewMode: "list" | "month";
}): BoardWindowPayload {
  const query: BoardWindowQuery = {
    viewMode: opts.viewMode,
    requestedWeek: null,
    requestedMonth: null,
    weeksBefore: 0,
    weeksAfter: 0,
    monthsBefore: 0,
    monthsAfter: 0,
    scope: "selected",
  };

  return buildSanitizedBoardWindowPayload({
    snapshot,
    snapshotStatus: "ok",
    file,
    env,
    query,
    resolvedEditorId: opts.resolvedEditorId,
    nowMs: Date.parse("2026-05-01T12:00:00.000Z"),
  });
}
