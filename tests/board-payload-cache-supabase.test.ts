import { beforeEach, describe, expect, it, vi } from "vitest";

const getSupabaseServerClient = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: (...args: unknown[]) => getSupabaseServerClient(...args),
}));

interface MockSupabaseError {
  code?: string;
  message: string;
}

interface ReadResponse {
  data: { payload: unknown; generated_at_utc: string } | null;
  error: MockSupabaseError | null;
}

interface WriteResponse {
  error: MockSupabaseError | null;
}

interface DeleteResponse {
  error: MockSupabaseError | null;
}

function createMockClient(opts: {
  readResponse?: ReadResponse;
  writeResponse?: WriteResponse;
  deleteResponse?: DeleteResponse;
}) {
  const maybeSingle = vi.fn(async () => opts.readResponse ?? { data: null, error: null });
  const eqForRead5 = vi.fn(() => ({ maybeSingle }));
  const eqForRead4 = vi.fn(() => ({ eq: eqForRead5 }));
  const eqForRead3 = vi.fn(() => ({ eq: eqForRead4 }));
  const eqForRead2 = vi.fn(() => ({ eq: eqForRead3 }));
  const eqForRead1 = vi.fn(() => ({ eq: eqForRead2 }));
  const select = vi.fn(() => ({ eq: eqForRead1 }));

  const upsert = vi.fn(async () => opts.writeResponse ?? { error: null });

  const eqForDelete5 = vi.fn(async () => opts.deleteResponse ?? { error: null });
  const eqForDelete4 = vi.fn(() => ({ eq: eqForDelete5 }));
  const eqForDelete3 = vi.fn(() => ({ eq: eqForDelete4 }));
  const eqForDelete2 = vi.fn(() => ({ eq: eqForDelete3 }));
  const eqForDelete1 = vi.fn(() => ({ eq: eqForDelete2 }));
  const del = vi.fn(() => ({ eq: eqForDelete1 }));

  const from = vi.fn(() => ({ select, upsert, delete: del }));

  return {
    client: { from },
    spies: {
      from,
      select,
      upsert,
      delete: del,
      eqForRead1,
      eqForRead2,
      eqForRead3,
      eqForRead4,
      eqForRead5,
      maybeSingle,
      eqForDelete1,
      eqForDelete2,
      eqForDelete3,
      eqForDelete4,
      eqForDelete5,
    },
  };
}

const key = {
  viewMode: "month" as const,
  weekStart: "2026-05-11",
  monthKey: "2026-05",
  editorBucket: "jeff",
  scope: "full" as const,
};

const payload = {
  status: "ok" as const,
  snapshotStatus: "ok" as const,
  generatedAtUtc: "2026-05-01T12:00:00.000Z",
  snapshotWindowStartUtc: "2026-05-01T00:00:00.000Z",
  snapshotWindowEndUtc: "2026-08-01T00:00:00.000Z",
  timezone: "America/New_York",
  resolvedEditorId: "jeff",
  todayKey: "2026-05-11",
  todayMonthKey: "2026-05",
  selected: {
    view: "month" as const,
    weekStart: "2026-05-11",
    monthKey: "2026-05",
    weekNav: {
      weekStart: "2026-05-11",
      prevStart: "2026-05-04",
      nextStart: "2026-05-18",
      hasPrev: true,
      hasNext: true,
      canGoPrev: false,
      canGoNext: true,
    },
    monthNav: {
      monthKey: "2026-05",
      prevMonth: "2026-04",
      nextMonth: "2026-06",
      hasPrev: true,
      hasNext: true,
      canGoPrev: false,
      canGoNext: true,
    },
  },
  selectedBoards: {
    weekRows: [],
    month: {
      monthKey: "2026-05",
      label: "May 2026",
      weeks: [],
    },
  },
  weekWindow: {
    startWeek: "2026-05-11",
    endWeek: "2026-05-11",
    weekCount: 0,
    weeks: [],
  },
  monthWindow: {
    startMonth: "2026-05",
    endMonth: "2026-05",
    monthCount: 0,
    months: [],
  },
};

describe("lib/board-payload-cache-supabase", () => {
  beforeEach(() => {
    vi.resetModules();
    getSupabaseServerClient.mockReset();
  });

  it("board cache write uses expected table and columns", async () => {
    const mock = createMockClient({ writeResponse: { error: null } });
    getSupabaseServerClient.mockReturnValue(mock.client);

    const { writeBoardPayloadCache } = await import("@/lib/board-payload-cache-supabase");
    await writeBoardPayloadCache(key, payload);

    expect(mock.spies.from).toHaveBeenCalledWith("board_payload_cache");
    expect(mock.spies.upsert).toHaveBeenCalledWith(
      {
        view_mode: "month",
        week_start: "2026-05-11",
        month_key: "2026-05",
        editor_bucket: "jeff",
        scope: "full",
        payload,
        generated_at_utc: "2026-05-01T12:00:00.000Z",
      },
      { onConflict: "view_mode,week_start,month_key,editor_bucket,scope" },
    );
  });

  it("board cache read returns payload", async () => {
    const mock = createMockClient({
      readResponse: {
        data: {
          payload,
          generated_at_utc: "2026-05-01T12:00:00.000Z",
        },
        error: null,
      },
    });
    getSupabaseServerClient.mockReturnValue(mock.client);

    const { readBoardPayloadCache } = await import("@/lib/board-payload-cache-supabase");
    const result = await readBoardPayloadCache(key);

    expect(result).toEqual({
      payload,
      generatedAtUtc: "2026-05-01T12:00:00.000Z",
    });
    expect(mock.spies.select).toHaveBeenCalledWith("payload,generated_at_utc");
  });

  it("missing cache returns null", async () => {
    const mock = createMockClient({
      readResponse: { data: null, error: null },
    });
    getSupabaseServerClient.mockReturnValue(mock.client);

    const { readBoardPayloadCache } = await import("@/lib/board-payload-cache-supabase");
    const result = await readBoardPayloadCache(key);

    expect(result).toBeNull();
  });

  it("PGRST116 from maybeSingle returns null", async () => {
    const mock = createMockClient({
      readResponse: {
        data: null,
        error: { code: "PGRST116", message: "no rows" },
      },
    });
    getSupabaseServerClient.mockReturnValue(mock.client);

    const { readBoardPayloadCache } = await import("@/lib/board-payload-cache-supabase");
    const result = await readBoardPayloadCache(key);

    expect(result).toBeNull();
  });
});
