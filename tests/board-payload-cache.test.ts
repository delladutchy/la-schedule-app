import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readBoardPayloadCacheFromSupabase = vi.fn();
const writeBoardPayloadCacheToSupabase = vi.fn();
const deleteBoardPayloadCacheFromSupabase = vi.fn();

vi.mock("@/lib/board-payload-cache-supabase", () => ({
  readBoardPayloadCache: (...args: unknown[]) => readBoardPayloadCacheFromSupabase(...args),
  writeBoardPayloadCache: (...args: unknown[]) => writeBoardPayloadCacheToSupabase(...args),
  deleteBoardPayloadCache: (...args: unknown[]) => deleteBoardPayloadCacheFromSupabase(...args),
}));

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

const originalBoardCacheEnabled = process.env.BOARD_CACHE_ENABLED;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("lib/board-payload-cache", () => {
  beforeEach(() => {
    vi.resetModules();
    readBoardPayloadCacheFromSupabase.mockReset();
    writeBoardPayloadCacheToSupabase.mockReset();
    deleteBoardPayloadCacheFromSupabase.mockReset();
    readBoardPayloadCacheFromSupabase.mockResolvedValue({
      payload,
      generatedAtUtc: payload.generatedAtUtc,
    });
    writeBoardPayloadCacheToSupabase.mockResolvedValue(undefined);
    deleteBoardPayloadCacheFromSupabase.mockResolvedValue(undefined);
    delete process.env.BOARD_CACHE_ENABLED;
  });

  afterEach(() => {
    restoreEnv("BOARD_CACHE_ENABLED", originalBoardCacheEnabled);
  });

  it("BOARD_CACHE_ENABLED unset/false preserves existing behavior", async () => {
    const cache = await import("@/lib/board-payload-cache");

    expect(cache.isBoardCacheEnabled()).toBe(false);
    await expect(cache.readBoardPayloadCache(key)).resolves.toBeNull();
    await expect(cache.writeBoardPayloadCache(key, payload)).resolves.toBeUndefined();
    await expect(cache.deleteBoardPayloadCache(key)).resolves.toBeUndefined();

    expect(readBoardPayloadCacheFromSupabase).not.toHaveBeenCalled();
    expect(writeBoardPayloadCacheToSupabase).not.toHaveBeenCalled();
    expect(deleteBoardPayloadCacheFromSupabase).not.toHaveBeenCalled();
  });

  it("reads and writes when BOARD_CACHE_ENABLED=true", async () => {
    process.env.BOARD_CACHE_ENABLED = "true";
    const cache = await import("@/lib/board-payload-cache");

    await expect(cache.readBoardPayloadCache(key)).resolves.toEqual({
      payload,
      generatedAtUtc: payload.generatedAtUtc,
    });
    await expect(cache.writeBoardPayloadCache(key, payload)).resolves.toBeUndefined();

    expect(readBoardPayloadCacheFromSupabase).toHaveBeenCalledWith(key);
    expect(writeBoardPayloadCacheToSupabase).toHaveBeenCalledWith(key, payload);
  });

  it("Supabase read errors safely return null", async () => {
    process.env.BOARD_CACHE_ENABLED = "true";
    readBoardPayloadCacheFromSupabase.mockRejectedValueOnce(new Error("supabase unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const cache = await import("@/lib/board-payload-cache");
      await expect(cache.readBoardPayloadCache(key)).resolves.toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("Supabase write/delete errors do not throw", async () => {
    process.env.BOARD_CACHE_ENABLED = "true";
    writeBoardPayloadCacheToSupabase.mockRejectedValueOnce(new Error("upsert failed"));
    deleteBoardPayloadCacheFromSupabase.mockRejectedValueOnce(new Error("delete failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const cache = await import("@/lib/board-payload-cache");
      await expect(cache.writeBoardPayloadCache(key, payload)).resolves.toBeUndefined();
      await expect(cache.deleteBoardPayloadCache(key)).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
