import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  EDITOR_SESSION_COOKIE_NAME,
  buildEditorSessionCookieValue,
} from "@/lib/editor-auth";

const editorEnv = {
  EDITOR_TOKEN: "legacy-editor-token-0123456789",
  EDITOR_TOKENS_JSON: JSON.stringify({
    jeff: "jeff-editor-token-0123456789",
    dave: "dave-editor-token-0123456789",
    milos: "milos-editor-token-0123456789",
    mike: "mike-editor-token-00123456789",
  }),
};

const WORK_DATE = "2026-05-18";
const WORK_DATE_2 = "2026-05-19";

function normalizeWorkDateForTest(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = trimmed.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const makeClockInEntry = (workDate: string = WORK_DATE) => ({
  id: "uuid",
  google_event_id: "evt1",
  editor_profile: "jeff",
  work_date: workDate,
  la_number: null,
  clock_in_at: new Date().toISOString(),
  clock_out_at: null,
  notes: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

const makeClockOutEntry = (workDate: string = WORK_DATE) => ({
  ...makeClockInEntry(workDate),
  clock_out_at: new Date().toISOString(),
});

function parseSortableTimestampForTest(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveDeterministicActiveEntryForTest(entries: Array<ReturnType<typeof makeClockInEntry>>) {
  const running = entries.filter((entry) => !!entry.clock_in_at && !entry.clock_out_at);
  if (running.length === 0) return null;
  const sorted = [...running].sort((a, b) => {
    const updatedDiff = parseSortableTimestampForTest(b.updated_at) - parseSortableTimestampForTest(a.updated_at);
    if (updatedDiff !== 0) return updatedDiff;
    const createdDiff = parseSortableTimestampForTest(b.created_at) - parseSortableTimestampForTest(a.created_at);
    if (createdDiff !== 0) return createdDiff;
    const clockInDiff = parseSortableTimestampForTest(b.clock_in_at) - parseSortableTimestampForTest(a.clock_in_at);
    if (clockInDiff !== 0) return clockInDiff;
    return b.id.localeCompare(a.id);
  });
  return sorted[0] ?? null;
}

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ env: editorEnv, file: { timezone: "America/Los_Angeles" } }),
}));

vi.mock("@/lib/job-time", () => ({
  isJeffEditorId: (id: string) => id === "jeff" || id === "legacy",
  normalizeEditorProfile: (id: string) => (id === "legacy" ? "jeff" : id),
  normalizeWorkDate: (value: string) => normalizeWorkDateForTest(value),
  normalizeWorkDateFromUnknown: (value: unknown) => normalizeWorkDateForTest(value),
  normalizeEntryIdFromUnknown: (value: unknown) => (
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null
  ),
  resolveDeterministicActiveEntry: (entries: Array<ReturnType<typeof makeClockInEntry>>) => (
    resolveDeterministicActiveEntryForTest(entries)
  ),
  getJobTimeEntries: vi.fn().mockResolvedValue([]),
  getActiveJobTimeEntries: vi.fn().mockResolvedValue([]),
  upsertClockIn: vi.fn().mockImplementation((eventId: string, editor: string, workDate: string) => Promise.resolve({
    ...makeClockInEntry(workDate),
    google_event_id: eventId,
    editor_profile: editor,
  })),
  upsertClockOut: vi.fn().mockImplementation((eventId: string, editor: string, workDate: string) => Promise.resolve({
    ...makeClockOutEntry(workDate),
    google_event_id: eventId,
    editor_profile: editor,
  })),
  upsertClockOutById: vi.fn().mockImplementation((entryId: string, editor: string) => Promise.resolve({
    ...makeClockOutEntry(WORK_DATE),
    id: entryId,
    editor_profile: editor,
  })),
  deleteJobTimeEntry: vi.fn().mockImplementation((eventId: string, editor: string, workDate: string) => Promise.resolve({
    ...makeClockInEntry(workDate),
    google_event_id: eventId,
    editor_profile: editor,
  })),
  deleteJobTimeEntryById: vi.fn().mockImplementation((entryId: string, editor: string) => Promise.resolve({
    ...makeClockInEntry(WORK_DATE),
    id: entryId,
    editor_profile: editor,
  })),
  upsertEditTimes: vi.fn().mockImplementation((
    eventId: string,
    editor: string,
    workDate: string,
    clockInAt: string,
    clockOutAt: string | null,
  ) => Promise.resolve({
    ...makeClockInEntry(workDate),
    google_event_id: eventId,
    editor_profile: editor,
    clock_in_at: clockInAt,
    clock_out_at: clockOutAt,
  })),
  closeAllRemainingActiveEntries: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/supabase", () => ({
  SupabaseConfigError: class SupabaseConfigError extends Error {},
  getSupabaseServerClient: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function jeffBearer() {
  return { Authorization: "Bearer jeff-editor-token-0123456789" };
}

async function loadGetRoute() {
  const mod = await import("@/app/api/job-time/route");
  return mod.GET;
}
async function loadClockInRoute() {
  const mod = await import("@/app/api/job-time/clock-in/route");
  return mod.POST;
}
async function loadClockOutRoute() {
  const mod = await import("@/app/api/job-time/clock-out/route");
  return mod.POST;
}
async function loadClearRoute() {
  const mod = await import("@/app/api/job-time/clear/route");
  return mod.POST;
}
async function loadEditTimesRoute() {
  const mod = await import("@/app/api/job-time/edit-times/route");
  return mod.POST;
}
async function loadActiveRoute() {
  const mod = await import("@/app/api/job-time/active/route");
  return mod.GET;
}

// ---------------------------------------------------------------------------
// GET /api/job-time
// ---------------------------------------------------------------------------

describe("GET /api/job-time — authorization", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const GET = await loadGetRoute();
    const res = await GET(new Request("http://localhost/api/job-time?eventId=evt1"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("allows Jeff with bearer token and returns entries array", async () => {
    const GET = await loadGetRoute();
    const res = await GET(
      new Request("http://localhost/api/job-time?eventId=evt1", {
        headers: jeffBearer(),
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ entries: [] });
  });

  it("returns entries with normalized work_date keys", async () => {
    const { getJobTimeEntries } = await import("@/lib/job-time");
    vi.mocked(getJobTimeEntries).mockResolvedValueOnce([
      makeClockInEntry(WORK_DATE),
      makeClockInEntry(WORK_DATE_2),
    ]);

    const GET = await loadGetRoute();
    const res = await GET(
      new Request("http://localhost/api/job-time?eventId=evt1", {
        headers: jeffBearer(),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { entries: Array<{ work_date: string }> };
    expect(json.entries.map((entry) => entry.work_date)).toEqual([WORK_DATE, WORK_DATE_2]);
  });

  it("allows legacy token (maps to jeff profile)", async () => {
    const GET = await loadGetRoute();
    const res = await GET(
      new Request("http://localhost/api/job-time?eventId=evt1", {
        headers: { Authorization: "Bearer legacy-editor-token-0123456789" },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { entries: unknown[] };
    expect(Array.isArray(json.entries)).toBe(true);
  });

  it("rejects Dave with 403", async () => {
    const GET = await loadGetRoute();
    const res = await GET(
      new Request("http://localhost/api/job-time?eventId=evt1", {
        headers: { Authorization: "Bearer dave-editor-token-0123456789" },
      }),
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "forbidden" });
  });

  it("rejects Milos with 403", async () => {
    const GET = await loadGetRoute();
    const res = await GET(
      new Request("http://localhost/api/job-time?eventId=evt1", {
        headers: { Authorization: "Bearer milos-editor-token-0123456789" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects Mike with 403", async () => {
    const GET = await loadGetRoute();
    const res = await GET(
      new Request("http://localhost/api/job-time?eventId=evt1", {
        headers: { Authorization: "Bearer mike-editor-token-00123456789" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when eventId is missing", async () => {
    const GET = await loadGetRoute();
    const res = await GET(
      new Request("http://localhost/api/job-time", { headers: jeffBearer() }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "missing_event_id" });
  });

  it("passes workDate filter to getJobTimeEntries", async () => {
    const { getJobTimeEntries } = await import("@/lib/job-time");
    const GET = await loadGetRoute();
    await GET(
      new Request(`http://localhost/api/job-time?eventId=evt1&workDate=${WORK_DATE}`, {
        headers: jeffBearer(),
      }),
    );
    expect(getJobTimeEntries).toHaveBeenCalledWith("evt1", "jeff", WORK_DATE);
  });

  it("returns 400 when workDate query is invalid", async () => {
    const GET = await loadGetRoute();
    const res = await GET(
      new Request("http://localhost/api/job-time?eventId=evt1&workDate=not-a-date", {
        headers: jeffBearer(),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_work_date" });
  });
});

// ---------------------------------------------------------------------------
// GET /api/job-time/active
// ---------------------------------------------------------------------------

describe("GET /api/job-time/active — authorization and shape", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const GET = await loadActiveRoute();
    const res = await GET(new Request("http://localhost/api/job-time/active"));
    expect(res.status).toBe(401);
  });

  it("rejects non-Jeff requests with 403", async () => {
    const GET = await loadActiveRoute();
    const res = await GET(
      new Request("http://localhost/api/job-time/active", {
        headers: { Authorization: "Bearer dave-editor-token-0123456789" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns an empty entries array when there are no active rows", async () => {
    const { getActiveJobTimeEntries } = await import("@/lib/job-time");
    vi.mocked(getActiveJobTimeEntries).mockResolvedValueOnce([]);

    const GET = await loadActiveRoute();
    const res = await GET(
      new Request("http://localhost/api/job-time/active", {
        headers: jeffBearer(),
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ entries: [] });
    expect(getActiveJobTimeEntries).toHaveBeenCalledWith("jeff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("excludes a clocked-out id after clock-out has completed", async () => {
    const { getActiveJobTimeEntries } = await import("@/lib/job-time");
    vi.mocked(getActiveJobTimeEntries).mockResolvedValueOnce([]);

    const GET = await loadActiveRoute();
    const res = await GET(
      new Request("http://localhost/api/job-time/active", {
        headers: jeffBearer(),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { entries: Array<{ id: string }> };
    expect(json.entries).toEqual([]);
    expect(json.entries.some((entry) => entry.id === "row-running-1")).toBe(false);
  });

  it("returns a deterministic single active entry and warns when duplicates exist", async () => {
    const { getActiveJobTimeEntries } = await import("@/lib/job-time");
    const older = {
      ...makeClockInEntry(WORK_DATE),
      id: "row-older",
      google_event_id: "evt-older",
      clock_in_at: "2026-05-18T09:00:00.000Z",
      created_at: "2026-05-18T09:00:00.000Z",
      updated_at: "2026-05-18T09:00:00.000Z",
    };
    const newer = {
      ...makeClockInEntry(WORK_DATE_2),
      id: "row-newer",
      google_event_id: "evt-newer",
      clock_in_at: "2026-05-19T09:00:00.000Z",
      created_at: "2026-05-19T09:00:00.000Z",
      updated_at: "2026-05-19T10:00:00.000Z",
    };
    vi.mocked(getActiveJobTimeEntries).mockResolvedValueOnce([older, newer]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const GET = await loadActiveRoute();
    const res = await GET(
      new Request("http://localhost/api/job-time/active", {
        headers: jeffBearer(),
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json() as { entries: Array<{ id: string; google_event_id: string }> };
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0]?.id).toBe("row-newer");
    expect(json.entries[0]?.google_event_id).toBe("evt-newer");
    expect(warnSpy).toHaveBeenCalledWith(
      "[job-time:active] duplicate_active_rows_detected",
      expect.objectContaining({
        rowCount: 2,
        selectedPrimaryId: "row-newer",
      }),
    );
    warnSpy.mockRestore();
  });

  it("returns active row fields for Jeff", async () => {
    const { getActiveJobTimeEntries } = await import("@/lib/job-time");
    vi.mocked(getActiveJobTimeEntries).mockResolvedValueOnce([
      makeClockInEntry(WORK_DATE),
    ]);

    const GET = await loadActiveRoute();
    const res = await GET(
      new Request("http://localhost/api/job-time/active", {
        headers: jeffBearer(),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as {
      entries: Array<{
        google_event_id: string;
        work_date: string;
        clock_in_at: string | null;
        clock_out_at: string | null;
      }>;
    };
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0]?.google_event_id).toBe("evt1");
    expect(json.entries[0]?.work_date).toBe(WORK_DATE);
    expect(json.entries[0]?.clock_in_at).toBeTruthy();
    expect(json.entries[0]?.clock_out_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/job-time/clock-in
// ---------------------------------------------------------------------------

describe("POST /api/job-time/clock-in — authorization", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const POST = await loadClockInRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("allows Jeff to clock in and returns entry", async () => {
    const POST = await loadClockInRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { entry: { work_date: string } };
    expect(json.entry).toBeDefined();
    expect(json.entry.work_date).toBe(WORK_DATE);
  });

  it("creates a new row when Jeff has no active entry", async () => {
    const { getActiveJobTimeEntries, upsertClockIn } = await import("@/lib/job-time");
    vi.mocked(getActiveJobTimeEntries).mockResolvedValueOnce([]);

    const POST = await loadClockInRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt-create", workDate: WORK_DATE }),
      }),
    );

    expect(res.status).toBe(200);
    expect(getActiveJobTimeEntries).toHaveBeenCalledWith("jeff");
    expect(upsertClockIn).toHaveBeenCalledWith("evt-create", "jeff", WORK_DATE, undefined);
  });

  it("reuses the existing active row instead of creating a duplicate", async () => {
    const { getActiveJobTimeEntries, upsertClockIn } = await import("@/lib/job-time");
    const existing = {
      ...makeClockInEntry("2026-05-17"),
      id: "row-existing-active",
      google_event_id: "evt-existing-active",
      work_date: "2026-05-17",
      clock_in_at: "2026-05-17T12:00:00.000Z",
      clock_out_at: null,
      updated_at: "2026-05-17T12:00:00.000Z",
    };
    vi.mocked(getActiveJobTimeEntries).mockResolvedValueOnce([existing]);

    const POST = await loadClockInRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt-new-target", workDate: WORK_DATE }),
      }),
    );

    expect(res.status).toBe(200);
    expect(upsertClockIn).not.toHaveBeenCalled();
    const json = await res.json() as { entry: { id: string; google_event_id: string; work_date: string } };
    expect(json.entry.id).toBe("row-existing-active");
    expect(json.entry.google_event_id).toBe("evt-existing-active");
    expect(json.entry.work_date).toBe("2026-05-17");
  });

  it("prevents duplicate active rows even when request eventId/workDate differ", async () => {
    const { getActiveJobTimeEntries, upsertClockIn } = await import("@/lib/job-time");
    const activeFromOtherEvent = {
      ...makeClockInEntry("2026-05-20"),
      id: "row-other-event",
      google_event_id: "evt-other",
      work_date: "2026-05-20",
      clock_in_at: "2026-05-20T08:00:00.000Z",
      clock_out_at: null,
      updated_at: "2026-05-20T08:30:00.000Z",
    };
    vi.mocked(getActiveJobTimeEntries).mockResolvedValueOnce([activeFromOtherEvent]);

    const POST = await loadClockInRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt-requested", workDate: "2026-05-18" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(upsertClockIn).not.toHaveBeenCalled();
    const json = await res.json() as { entry: { id: string } };
    expect(json.entry.id).toBe("row-other-event");
  });

  it("normalizes ISO workDate input to YYYY-MM-DD", async () => {
    const { upsertClockIn } = await import("@/lib/job-time");
    const POST = await loadClockInRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: `${WORK_DATE}T12:00:00.000Z` }),
      }),
    );
    expect(res.status).toBe(200);
    expect(upsertClockIn).toHaveBeenCalledWith("evt1", "jeff", WORK_DATE, undefined);
    const json = await res.json() as { entry: { work_date: string } };
    expect(json.entry.work_date).toBe(WORK_DATE);
  });

  it("returns 400 when workDate is missing", async () => {
    const POST = await loadClockInRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1" }),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "missing_work_date" });
  });

  it("returns 400 when workDate format is invalid", async () => {
    const POST = await loadClockInRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: "not-a-date" }),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "missing_work_date" });
  });

  it("returns 400 when workDate is a non-existent calendar date", async () => {
    const POST = await loadClockInRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: "2026-02-30" }),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "missing_work_date" });
  });

  it("rejects Dave from clock-in with 403", async () => {
    const POST = await loadClockInRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-in", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer dave-editor-token-0123456789",
        },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 500 without entry payload when clock-in persistence fails", async () => {
    const { upsertClockIn } = await import("@/lib/job-time");
    vi.mocked(upsertClockIn).mockRejectedValueOnce(new Error("insert failed"));

    const POST = await loadClockInRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string; entry?: unknown };
    expect(json.error).toBe("internal_error");
    expect("entry" in json).toBe(false);
  });

  it("returns complete entry with all fields clients need to confirm the write", async () => {
    const POST = await loadClockInRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { entry: Record<string, unknown> };
    expect(json.entry).toMatchObject({
      id: expect.any(String),
      google_event_id: "evt1",
      work_date: WORK_DATE,
      editor_profile: "jeff",
      clock_in_at: expect.any(String),
      clock_out_at: null,
    });
    // id must be non-empty so clients can use it for targeted clock-out/confirmation
    expect((json.entry.id as string).length).toBeGreaterThan(0);
  });

  it("returns 500 when DB column is missing (simulates un-run migration)", async () => {
    const { upsertClockIn } = await import("@/lib/job-time");
    vi.mocked(upsertClockIn).mockRejectedValueOnce(
      new Error('column "work_date" of relation "job_time_entries" does not exist'),
    );

    const POST = await loadClockInRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string; entry?: unknown };
    expect(json.error).toBe("internal_error");
    expect("entry" in json).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/job-time/clock-out
// ---------------------------------------------------------------------------

describe("POST /api/job-time/clock-out — authorization", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("allows Jeff to clock out", async () => {
    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { entry: { clock_out_at: string } };
    expect(json.entry.clock_out_at).toBeTruthy();
  });

  it("targets exact eventId + workDate for clock-out", async () => {
    const { upsertClockOut } = await import("@/lib/job-time");
    const POST = await loadClockOutRoute();
    await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt-two", workDate: WORK_DATE_2 }),
      }),
    );
    expect(upsertClockOut).toHaveBeenCalledWith("evt-two", "jeff", WORK_DATE_2);
  });

  it("clocks out by entry id when entryId is provided", async () => {
    const { upsertClockOutById, upsertClockOut } = await import("@/lib/job-time");
    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ entryId: "row-running-1", eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(200);
    expect(upsertClockOutById).toHaveBeenCalledWith("row-running-1", "jeff");
    expect(upsertClockOut).not.toHaveBeenCalled();
  });

  it("allows clock-out by entry id even when eventId payload differs", async () => {
    const { upsertClockOutById, upsertClockOut } = await import("@/lib/job-time");
    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ entryId: "row-running-2", eventId: "evt-mismatch", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(200);
    expect(upsertClockOutById).toHaveBeenCalledWith("row-running-2", "jeff");
    expect(upsertClockOut).not.toHaveBeenCalled();
  });

  it("returns 400 when workDate is missing", async () => {
    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1" }),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "missing_work_date" });
  });

  it("rejects Milos from clock-out with 403", async () => {
    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer milos-editor-token-0123456789",
        },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects Milos from clock-out by entry id with 403", async () => {
    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer milos-editor-token-0123456789",
        },
        body: JSON.stringify({ entryId: "row-123", eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("sweeps all other active Jeff rows after primary clock-out by eventId+workDate", async () => {
    const { upsertClockOut, closeAllRemainingActiveEntries } = await import("@/lib/job-time");
    const primary = { ...makeClockOutEntry(WORK_DATE), id: "row-primary", clock_out_at: "2026-05-18T18:00:00.000Z" };
    vi.mocked(upsertClockOut).mockResolvedValueOnce(primary);

    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(200);
    expect(closeAllRemainingActiveEntries).toHaveBeenCalledWith("jeff", primary.clock_out_at, primary.id);
    const json = await res.json() as { entry: { id: string } };
    expect(json.entry.id).toBe("row-primary");
  });

  it("sweeps all other active Jeff rows after primary clock-out by entry id", async () => {
    const { upsertClockOutById, closeAllRemainingActiveEntries } = await import("@/lib/job-time");
    const primary = { ...makeClockOutEntry(WORK_DATE), id: "row-target", clock_out_at: "2026-05-18T17:30:00.000Z" };
    vi.mocked(upsertClockOutById).mockResolvedValueOnce(primary);

    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ entryId: "row-target", eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(200);
    expect(closeAllRemainingActiveEntries).toHaveBeenCalledWith("jeff", primary.clock_out_at, primary.id);
  });

  it("still returns success even when the sweep itself fails", async () => {
    const { upsertClockOut, closeAllRemainingActiveEntries } = await import("@/lib/job-time");
    vi.mocked(closeAllRemainingActiveEntries).mockRejectedValueOnce(new Error("sweep db error"));
    const primary = { ...makeClockOutEntry(WORK_DATE), id: "row-ok" };
    vi.mocked(upsertClockOut).mockResolvedValueOnce(primary);

    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { entry: { id: string } };
    expect(json.entry.id).toBe("row-ok");
  });

  it("re-queries active rows after sweep and returns activeCount: 0 when all cleared", async () => {
    const { upsertClockOut, getActiveJobTimeEntries } = await import("@/lib/job-time");
    const primary = { ...makeClockOutEntry(WORK_DATE), id: "row-primary", clock_out_at: "2026-05-18T18:00:00.000Z" };
    vi.mocked(upsertClockOut).mockResolvedValueOnce(primary);
    vi.mocked(getActiveJobTimeEntries).mockResolvedValueOnce([]);

    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { entry: { id: string }; activeCount: number; activeIds: string[] };
    expect(json.entry.id).toBe("row-primary");
    expect(json.activeCount).toBe(0);
    expect(json.activeIds).toEqual([]);
    expect(getActiveJobTimeEntries).toHaveBeenCalledWith("jeff");
  });

  it("returns activeCount > 0 in response when orphaned rows remain after sweep", async () => {
    const { upsertClockOut, getActiveJobTimeEntries } = await import("@/lib/job-time");
    const primary = { ...makeClockOutEntry(WORK_DATE), id: "row-primary" };
    const orphan = { ...makeClockInEntry(WORK_DATE_2), id: "row-orphan" };
    vi.mocked(upsertClockOut).mockResolvedValueOnce(primary);
    vi.mocked(getActiveJobTimeEntries).mockResolvedValueOnce([orphan]);

    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { entry: { id: string }; activeCount: number; activeIds: string[] };
    expect(json.activeCount).toBe(1);
    expect(json.activeIds).toContain("row-orphan");
  });
});

// ---------------------------------------------------------------------------
// POST /api/job-time/clear
// ---------------------------------------------------------------------------

describe("POST /api/job-time/clear — authorization and validation", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const POST = await loadClearRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("allows Jeff to clear and returns success with workDate", async () => {
    const POST = await loadClearRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, workDate: WORK_DATE });
  });

  it("clears by entry id when provided", async () => {
    const { deleteJobTimeEntryById, deleteJobTimeEntry } = await import("@/lib/job-time");
    const POST = await loadClearRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ entryId: "row-clear-1", eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(200);
    expect(deleteJobTimeEntryById).toHaveBeenCalledWith("row-clear-1", "jeff");
    expect(deleteJobTimeEntry).not.toHaveBeenCalled();
  });

  it("rejects Dave with 403", async () => {
    const POST = await loadClearRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clear", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer dave-editor-token-0123456789",
        },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when workDate is missing", async () => {
    const POST = await loadClearRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1" }),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "missing_work_date" });
  });

  it("calls deleteJobTimeEntry with correct args", async () => {
    const { deleteJobTimeEntry } = await import("@/lib/job-time");
    const POST = await loadClearRoute();
    await POST(
      new Request("http://localhost/api/job-time/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(deleteJobTimeEntry).toHaveBeenCalledWith("evt1", "jeff", WORK_DATE);
  });

  it("clears only the requested workDate when same event has multiple dates", async () => {
    const { deleteJobTimeEntry } = await import("@/lib/job-time");
    const POST = await loadClearRoute();
    await POST(
      new Request("http://localhost/api/job-time/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE_2 }),
      }),
    );
    expect(deleteJobTimeEntry).toHaveBeenCalledWith("evt1", "jeff", WORK_DATE_2);
  });

  it("targets exact eventId + workDate for clear", async () => {
    const { deleteJobTimeEntry } = await import("@/lib/job-time");
    const POST = await loadClearRoute();
    await POST(
      new Request("http://localhost/api/job-time/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt-two", workDate: WORK_DATE }),
      }),
    );
    expect(deleteJobTimeEntry).toHaveBeenCalledWith("evt-two", "jeff", WORK_DATE);
  });

  it("returns 404 when clear by entry id does not find a row", async () => {
    const { deleteJobTimeEntryById } = await import("@/lib/job-time");
    vi.mocked(deleteJobTimeEntryById).mockResolvedValueOnce(null);

    const POST = await loadClearRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ entryId: "missing-row", eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/job-time/edit-times
// ---------------------------------------------------------------------------

describe("POST /api/job-time/edit-times — authorization and validation", () => {
  const clockInAt = "2026-05-18T09:00:00.000Z";
  const clockOutAt = "2026-05-18T17:00:00.000Z";
  const clockOutBefore = "2026-05-18T08:00:00.000Z";

  it("rejects unauthenticated requests with 401", async () => {
    const POST = await loadEditTimesRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/edit-times", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE, clockInAt }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("allows Jeff to edit times and returns entry", async () => {
    const POST = await loadEditTimesRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/edit-times", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE, clockInAt, clockOutAt }),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { entry: { clock_out_at: string | null } };
    expect(json.entry).toBeDefined();
    expect(json.entry.clock_out_at).toBe(clockOutAt);
  });

  it("rejects Dave with 403", async () => {
    const POST = await loadEditTimesRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/edit-times", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer dave-editor-token-0123456789",
        },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE, clockInAt }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when workDate is missing", async () => {
    const POST = await loadEditTimesRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/edit-times", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", clockInAt }),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "missing_work_date" });
  });

  it("returns 400 when clockInAt is missing", async () => {
    const POST = await loadEditTimesRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/edit-times", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_clock_in_at" });
  });

  it("returns 422 when clockOutAt is before clockInAt", async () => {
    const POST = await loadEditTimesRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/edit-times", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({
          eventId: "evt1",
          workDate: WORK_DATE,
          clockInAt,
          clockOutAt: clockOutBefore,
        }),
      }),
    );
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: "clock_out_before_clock_in" });
  });

  it("allows clockOutAt to be omitted (creates running entry)", async () => {
    const { upsertEditTimes } = await import("@/lib/job-time");
    const POST = await loadEditTimesRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/edit-times", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE, clockInAt }),
      }),
    );
    expect(res.status).toBe(200);
    expect(upsertEditTimes).toHaveBeenCalledWith("evt1", "jeff", WORK_DATE, clockInAt, null);
    const json = await res.json() as { entry: { clock_out_at: string | null } };
    expect(json.entry.clock_out_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isJeffEditorId / normalizeEditorProfile helpers
// ---------------------------------------------------------------------------

describe("isJeffEditorId helper", () => {
  it("identifies jeff and legacy as Jeff-tier", async () => {
    const { isJeffEditorId } = await import("@/lib/job-time");
    expect(isJeffEditorId("jeff")).toBe(true);
    expect(isJeffEditorId("legacy")).toBe(true);
    expect(isJeffEditorId("dave")).toBe(false);
    expect(isJeffEditorId("milos")).toBe(false);
    expect(isJeffEditorId("mike")).toBe(false);
    expect(isJeffEditorId("")).toBe(false);
  });

  it("normalizes legacy to jeff in the DB profile", async () => {
    const { normalizeEditorProfile } = await import("@/lib/job-time");
    expect(normalizeEditorProfile("jeff")).toBe("jeff");
    expect(normalizeEditorProfile("legacy")).toBe("jeff");
    expect(normalizeEditorProfile("dave")).toBe("dave");
  });
});

// ---------------------------------------------------------------------------
// Clock-out returns 404 when upsertClockOut returns null
// ---------------------------------------------------------------------------

describe("POST /api/job-time/clock-out — 404 when no active clock-in", () => {
  it("returns 404 with not_clocked_in error", async () => {
    const { upsertClockOut } = await import("@/lib/job-time");
    vi.mocked(upsertClockOut).mockResolvedValueOnce(null);

    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "not_clocked_in" });
  });

  it("returns 404 when entry id is provided but not found", async () => {
    const { upsertClockOutById } = await import("@/lib/job-time");
    vi.mocked(upsertClockOutById).mockResolvedValueOnce(null);

    const POST = await loadClockOutRoute();
    const res = await POST(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ entryId: "missing-row", eventId: "evt1", workDate: WORK_DATE }),
      }),
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "not_clocked_in" });
  });
});

describe("GET /api/job-time exact-date fetch outcomes", () => {
  it("returns completed row for exact eventId + workDate after clock-out", async () => {
    const { getJobTimeEntries } = await import("@/lib/job-time");
    vi.mocked(getJobTimeEntries).mockResolvedValueOnce([makeClockOutEntry(WORK_DATE)]);

    const GET = await loadGetRoute();
    const res = await GET(
      new Request(`http://localhost/api/job-time?eventId=evt1&workDate=${WORK_DATE}`, {
        headers: jeffBearer(),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { entries: Array<{ work_date: string; clock_out_at: string | null }> };
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0]?.work_date).toBe(WORK_DATE);
    expect(json.entries[0]?.clock_out_at).toBeTruthy();
  });

  it("returns no rows for exact eventId + workDate after clear", async () => {
    const { getJobTimeEntries } = await import("@/lib/job-time");
    vi.mocked(getJobTimeEntries).mockResolvedValueOnce([]);

    const GET = await loadGetRoute();
    const res = await GET(
      new Request(`http://localhost/api/job-time?eventId=evt1&workDate=${WORK_DATE}`, {
        headers: jeffBearer(),
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { entries: unknown[] };
    expect(json.entries).toEqual([]);
  });
});

describe("job-time row targeting independence", () => {
  it("keeps two google_event_id values independent for clock-out and clear", async () => {
    const { upsertClockOut, deleteJobTimeEntry } = await import("@/lib/job-time");
    const clockOut = await loadClockOutRoute();
    const clear = await loadClearRoute();

    await clockOut(
      new Request("http://localhost/api/job-time/clock-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt-alpha", workDate: WORK_DATE }),
      }),
    );
    await clear(
      new Request("http://localhost/api/job-time/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...jeffBearer() },
        body: JSON.stringify({ eventId: "evt-beta", workDate: WORK_DATE_2 }),
      }),
    );

    expect(upsertClockOut).toHaveBeenCalledWith("evt-alpha", "jeff", WORK_DATE);
    expect(deleteJobTimeEntry).toHaveBeenCalledWith("evt-beta", "jeff", WORK_DATE_2);
  });
});
