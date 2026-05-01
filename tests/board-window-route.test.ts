import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readCurrentSnapshot = vi.fn();

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
    readCurrentSnapshot.mockReset();
    readCurrentSnapshot.mockResolvedValue(snapshot);
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
});
