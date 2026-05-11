import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardWindowPayload } from "@/lib/board-window";
import {
  BOARD_WINDOW_CACHE_KEY_PREFIX,
  BOARD_WINDOW_CACHE_LRU_CAP,
  BOARD_WINDOW_CACHE_SCHEMA_VERSION,
  buildViewKey,
  clearAllCaches,
  clearCache,
  editorIdToBucket,
  isHydrationPayloadCompatible,
  pickFreshestForView,
  readCache,
  writeCache,
  type CacheBucket,
  type CacheStorage,
} from "@/lib/board-window-cache";

class MemoryStorage implements CacheStorage {
  private map = new Map<string, string>();
  private orderedKeys: string[] = [];

  get length(): number {
    return this.orderedKeys.length;
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    if (!this.map.has(key)) this.orderedKeys.push(key);
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
    this.orderedKeys = this.orderedKeys.filter((k) => k !== key);
  }

  key(index: number): string | null {
    return this.orderedKeys[index] ?? null;
  }
}

class ThrowingStorage implements CacheStorage {
  get length(): number { return 0; }
  getItem(): string | null { throw new Error("storage unavailable"); }
  setItem(): void { throw new Error("storage unavailable"); }
  removeItem(): void { /* swallowed by callers */ }
  key(): string | null { return null; }
}

function makePayload(opts: {
  editorId: string | null;
  view?: "list" | "month";
  weekStart?: string;
  monthKey?: string;
  generatedAtUtc?: string;
}): BoardWindowPayload {
  return {
    status: "ok",
    snapshotStatus: "ok",
    generatedAtUtc: opts.generatedAtUtc ?? "2026-05-04T12:00:00.000Z",
    snapshotWindowStartUtc: "2026-05-04T04:00:00.000Z",
    snapshotWindowEndUtc: "2026-08-04T04:00:00.000Z",
    timezone: "America/New_York",
    resolvedEditorId: opts.editorId,
    todayKey: "2026-05-04",
    todayMonthKey: "2026-05",
    selected: {
      view: opts.view ?? "list",
      weekStart: opts.weekStart ?? "2026-05-04",
      monthKey: opts.monthKey ?? "2026-05",
      weekNav: {
        weekStart: opts.weekStart ?? "2026-05-04",
        prevStart: "2026-04-27",
        nextStart: "2026-05-11",
        hasPrev: true,
        hasNext: true,
        canGoPrev: true,
        canGoNext: true,
      },
      monthNav: {
        monthKey: opts.monthKey ?? "2026-05",
        prevMonth: "2026-04",
        nextMonth: "2026-06",
        hasPrev: true,
        hasNext: true,
        canGoPrev: true,
        canGoNext: true,
      },
    },
    selectedBoards: {
      weekRows: [],
      month: { monthKey: opts.monthKey ?? "2026-05", label: "May 2026", weeks: [] },
    },
    weekWindow: { startWeek: opts.weekStart ?? "2026-05-04", endWeek: "2026-06-29", weekCount: 0, weeks: [] },
    monthWindow: { startMonth: opts.monthKey ?? "2026-05", endMonth: "2026-09", monthCount: 0, months: [] },
  };
}

function keyFor(bucket: CacheBucket): string {
  return `${BOARD_WINDOW_CACHE_KEY_PREFIX}:v${BOARD_WINDOW_CACHE_SCHEMA_VERSION}:${bucket}`;
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("editorIdToBucket", () => {
  it("normalizes known editor ids to their canonical bucket", () => {
    expect(editorIdToBucket("Jeff")).toBe("jeff");
    expect(editorIdToBucket(" mike ")).toBe("mike");
    expect(editorIdToBucket("legacy")).toBe("legacy");
    expect(editorIdToBucket("dave")).toBe("dave");
    expect(editorIdToBucket("milos")).toBe("milos");
  });

  it("collapses null/empty/unknown to anon", () => {
    expect(editorIdToBucket(null)).toBe("anon");
    expect(editorIdToBucket(undefined)).toBe("anon");
    expect(editorIdToBucket("")).toBe("anon");
    expect(editorIdToBucket("attacker")).toBe("anon");
  });
});

describe("read/write round-trip", () => {
  it("writes a sanitized payload and reads it back under the same bucket", () => {
    const payload = makePayload({ editorId: "mike", view: "month", monthKey: "2026-05" });
    writeCache("mike", payload, storage);
    const entry = readCache("mike", storage);
    expect(entry).not.toBeNull();
    expect(entry?.bucket).toBe("mike");
    expect(entry?.items[buildViewKey(payload)]?.resolvedEditorId).toBe("mike");
  });

  it("returns null when no cache exists", () => {
    expect(readCache("dave", storage)).toBeNull();
  });
});

describe("editor isolation", () => {
  it("never writes a payload into a bucket whose editor differs from resolvedEditorId", () => {
    const mikePayload = makePayload({ editorId: "mike" });
    writeCache("dave", mikePayload, storage);
    expect(readCache("dave", storage)).toBeNull();
    expect(storage.getItem(keyFor("dave"))).toBeNull();
  });

  it("does not let a tampered bucket field be served from another editor's slot", () => {
    const tampered = {
      schemaVersion: BOARD_WINDOW_CACHE_SCHEMA_VERSION,
      bucket: "mike",
      updatedAtMs: Date.now(),
      items: {
        [buildViewKey(makePayload({ editorId: "mike" }))]: makePayload({ editorId: "mike" }),
      },
    };
    storage.setItem(keyFor("dave"), JSON.stringify(tampered));
    expect(readCache("dave", storage)).toBeNull();
    expect(storage.getItem(keyFor("dave"))).toBeNull();
  });

  it("anon bucket and editor buckets do not share state", () => {
    const anonPayload = makePayload({ editorId: null });
    const jeffPayload = makePayload({ editorId: "jeff" });
    writeCache("anon", anonPayload, storage);
    writeCache("jeff", jeffPayload, storage);
    const anon = readCache("anon", storage);
    const jeff = readCache("jeff", storage);
    expect(anon?.bucket).toBe("anon");
    expect(jeff?.bucket).toBe("jeff");
    expect(anon?.items[buildViewKey(anonPayload)]?.resolvedEditorId).toBeNull();
    expect(jeff?.items[buildViewKey(jeffPayload)]?.resolvedEditorId).toBe("jeff");
  });

  it("collapses unknown editor ids on the payload to anon and refuses non-anon writes", () => {
    const stranger = makePayload({ editorId: "stranger" });
    writeCache("jeff", stranger, storage);
    expect(readCache("jeff", storage)).toBeNull();
    writeCache("anon", stranger, storage);
    const entry = readCache("anon", storage);
    expect(entry).not.toBeNull();
    expect(entry?.items[buildViewKey(stranger)]?.resolvedEditorId).toBe("stranger");
  });
});

describe("pickFreshestForView", () => {
  it("returns null when cache is empty", () => {
    const ssr = makePayload({ editorId: "jeff" });
    expect(pickFreshestForView(null, "jeff", buildViewKey(ssr), ssr)).toBeNull();
  });

  it("returns null when cached generatedAtUtc is not strictly newer than SSR", () => {
    const ssr = makePayload({ editorId: "jeff", generatedAtUtc: "2026-05-04T12:00:00.000Z" });
    writeCache("jeff", ssr, storage);
    const entry = readCache("jeff", storage);
    expect(pickFreshestForView(entry, "jeff", buildViewKey(ssr), ssr)).toBeNull();
  });

  it("returns the cached payload when it is strictly newer than SSR for the same view", () => {
    const ssr = makePayload({ editorId: "jeff", generatedAtUtc: "2026-05-04T12:00:00.000Z" });
    const cached = makePayload({ editorId: "jeff", generatedAtUtc: "2026-05-04T12:30:00.000Z" });
    writeCache("jeff", cached, storage);
    const entry = readCache("jeff", storage);
    const fresher = pickFreshestForView(entry, "jeff", buildViewKey(ssr), ssr);
    expect(fresher?.generatedAtUtc).toBe("2026-05-04T12:30:00.000Z");
  });

  it("rejects a fresher cached payload that resolves to a different editor", () => {
    const ssr = makePayload({ editorId: "dave", generatedAtUtc: "2026-05-04T12:00:00.000Z" });
    const tamperedEntry = {
      schemaVersion: BOARD_WINDOW_CACHE_SCHEMA_VERSION,
      bucket: "dave" as const,
      updatedAtMs: Date.now(),
      items: {
        [buildViewKey(ssr)]: makePayload({
          editorId: "mike",
          generatedAtUtc: "2026-05-04T13:00:00.000Z",
          weekStart: ssr.selected.weekStart,
          monthKey: ssr.selected.monthKey,
          view: ssr.selected.view,
        }),
      },
    };
    storage.setItem(keyFor("dave"), JSON.stringify(tamperedEntry));
    const entry = readCache("dave", storage);
    expect(pickFreshestForView(entry, "dave", buildViewKey(ssr), ssr)).toBeNull();
  });
});

describe("isHydrationPayloadCompatible", () => {
  it("rejects hydrating Month UI from a list payload", () => {
    const payload = makePayload({
      editorId: "jeff",
      view: "list",
      weekStart: "2026-05-04",
      monthKey: "2026-05",
    });
    expect(isHydrationPayloadCompatible({
      currentViewMode: "month",
      targetWeekStart: "2026-05-04",
      targetMonthKey: "2026-05",
      payload,
    })).toBe(false);
  });

  it("rejects hydrating Week/List UI from a month payload", () => {
    const payload = makePayload({
      editorId: "jeff",
      view: "month",
      weekStart: "2026-05-04",
      monthKey: "2026-05",
    });
    expect(isHydrationPayloadCompatible({
      currentViewMode: "list",
      targetWeekStart: "2026-05-04",
      targetMonthKey: "2026-05",
      payload,
    })).toBe(false);
  });

  it("rejects payloads with mismatched selected week/month keys", () => {
    const payload = makePayload({
      editorId: "jeff",
      view: "month",
      weekStart: "2026-05-11",
      monthKey: "2026-06",
    });
    expect(isHydrationPayloadCompatible({
      currentViewMode: "month",
      targetWeekStart: "2026-05-04",
      targetMonthKey: "2026-05",
      payload,
    })).toBe(false);
  });

  it("accepts matching payloads for fast hydration", () => {
    const payload = makePayload({
      editorId: "jeff",
      view: "month",
      weekStart: "2026-05-04",
      monthKey: "2026-05",
      generatedAtUtc: "2026-05-04T12:30:00.000Z",
    });
    expect(isHydrationPayloadCompatible({
      currentViewMode: "month",
      targetWeekStart: "2026-05-04",
      targetMonthKey: "2026-05",
      payload,
    })).toBe(true);
  });

  it("rejects stale list payloads for a different selected week target", () => {
    const payload = makePayload({
      editorId: "jeff",
      view: "list",
      weekStart: "2026-05-04",
      monthKey: "2026-05",
    });
    expect(isHydrationPayloadCompatible({
      currentViewMode: "list",
      targetWeekStart: "2026-05-11",
      targetMonthKey: "2026-05",
      payload,
    })).toBe(false);
  });

  it("rejects stale month payloads for a different selected month target", () => {
    const payload = makePayload({
      editorId: "jeff",
      view: "month",
      weekStart: "2026-05-04",
      monthKey: "2026-05",
    });
    expect(isHydrationPayloadCompatible({
      currentViewMode: "month",
      targetWeekStart: "2026-05-04",
      targetMonthKey: "2026-06",
      payload,
    })).toBe(false);
  });

  it("accepts month payloads when month matches even if weekStart differs", () => {
    const payload = makePayload({
      editorId: "jeff",
      view: "month",
      weekStart: "2026-05-11",
      monthKey: "2026-05",
    });
    expect(isHydrationPayloadCompatible({
      currentViewMode: "month",
      targetWeekStart: "2026-05-04",
      targetMonthKey: "2026-05",
      payload,
    })).toBe(true);
  });

  it("accepts list payloads when weekStart matches even if monthKey differs", () => {
    const payload = makePayload({
      editorId: "jeff",
      view: "list",
      weekStart: "2026-05-04",
      monthKey: "2026-06",
    });
    expect(isHydrationPayloadCompatible({
      currentViewMode: "list",
      targetWeekStart: "2026-05-04",
      targetMonthKey: "2026-05",
      payload,
    })).toBe(true);
  });
});
describe("LRU cap", () => {
  it("retains only the most-recently-written entries up to the cap", () => {
    const writes: BoardWindowPayload[] = [];
    for (let i = 0; i < BOARD_WINDOW_CACHE_LRU_CAP + 3; i += 1) {
      const payload = makePayload({
        editorId: "jeff",
        view: "list",
        weekStart: `2026-${String((i % 12) + 1).padStart(2, "0")}-01`,
        monthKey: `2026-${String((i % 12) + 1).padStart(2, "0")}`,
        generatedAtUtc: `2026-05-04T12:0${i}:00.000Z`,
      });
      writes.push(payload);
      writeCache("jeff", payload, storage);
    }
    const entry = readCache("jeff", storage);
    expect(entry).not.toBeNull();
    const keys = Object.keys(entry?.items ?? {});
    expect(keys.length).toBe(BOARD_WINDOW_CACHE_LRU_CAP);
    // The oldest 3 writes should have been dropped; the most recent
    // BOARD_WINDOW_CACHE_LRU_CAP writes should remain.
    const expected = writes.slice(-BOARD_WINDOW_CACHE_LRU_CAP).map(buildViewKey);
    expect(keys).toEqual(expected);
  });

  it("re-writing the same view key does not evict other entries", () => {
    const a = makePayload({ editorId: "jeff", view: "list", weekStart: "2026-05-04", monthKey: "2026-05" });
    const b = makePayload({ editorId: "jeff", view: "month", weekStart: "2026-05-04", monthKey: "2026-05" });
    writeCache("jeff", a, storage);
    writeCache("jeff", b, storage);
    const aFresh = makePayload({ editorId: "jeff", view: "list", weekStart: "2026-05-04", monthKey: "2026-05", generatedAtUtc: "2026-05-04T13:00:00.000Z" });
    writeCache("jeff", aFresh, storage);

    const entry = readCache("jeff", storage);
    expect(Object.keys(entry?.items ?? {}).sort()).toEqual([buildViewKey(a), buildViewKey(b)].sort());
    expect(entry?.items[buildViewKey(a)]?.generatedAtUtc).toBe("2026-05-04T13:00:00.000Z");
  });
});

describe("clearCache / clearAllCaches", () => {
  it("clearCache only deletes the targeted bucket", () => {
    writeCache("jeff", makePayload({ editorId: "jeff" }), storage);
    writeCache("dave", makePayload({ editorId: "dave" }), storage);
    clearCache("jeff", storage);
    expect(readCache("jeff", storage)).toBeNull();
    expect(readCache("dave", storage)).not.toBeNull();
  });

  it("clearAllCaches removes every la-schedule-cache:* key but leaves unrelated keys alone", () => {
    writeCache("mike", makePayload({ editorId: "mike" }), storage);
    writeCache("anon", makePayload({ editorId: null }), storage);
    storage.setItem("unrelated:other", "keep me");
    clearAllCaches(storage);
    expect(readCache("mike", storage)).toBeNull();
    expect(readCache("anon", storage)).toBeNull();
    expect(storage.getItem("unrelated:other")).toBe("keep me");
  });
});

describe("corruption resilience", () => {
  it("returns null and self-heals when stored JSON is malformed", () => {
    storage.setItem(keyFor("jeff"), "{not json");
    expect(readCache("jeff", storage)).toBeNull();
    expect(storage.getItem(keyFor("jeff"))).toBeNull();
  });

  it("returns null and self-heals when stored value fails schema validation", () => {
    storage.setItem(keyFor("jeff"), JSON.stringify({ schemaVersion: 999, bucket: "jeff" }));
    expect(readCache("jeff", storage)).toBeNull();
    expect(storage.getItem(keyFor("jeff"))).toBeNull();
  });

  it("returns null when the cached schemaVersion does not match", () => {
    const wrong = {
      schemaVersion: 0,
      bucket: "jeff",
      updatedAtMs: Date.now(),
      items: {},
    };
    storage.setItem(keyFor("jeff"), JSON.stringify(wrong));
    expect(readCache("jeff", storage)).toBeNull();
  });

  it("does not throw when a write quota is exceeded", () => {
    const throwingStorage: CacheStorage = {
      length: 0,
      getItem: () => null,
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => undefined,
      key: () => null,
    };
    expect(() => writeCache("jeff", makePayload({ editorId: "jeff" }), throwingStorage)).not.toThrow();
  });
});

describe("storage unavailable", () => {
  it("read/write/clear no-op safely when storage is null", () => {
    expect(readCache("jeff", null)).toBeNull();
    expect(() => writeCache("jeff", makePayload({ editorId: "jeff" }), null)).not.toThrow();
    expect(() => clearCache("jeff", null)).not.toThrow();
    expect(() => clearAllCaches(null)).not.toThrow();
  });

  it("read returns null and never throws when getItem itself throws", () => {
    expect(readCache("jeff", new ThrowingStorage())).toBeNull();
  });

  it("write swallows getItem-side errors and still attempts setItem", () => {
    const calls: string[] = [];
    const throwingThenSetting: CacheStorage = {
      length: 0,
      getItem: () => { throw new Error("blocked"); },
      setItem: (k) => { calls.push(`set:${k}`); },
      removeItem: () => undefined,
      key: () => null,
    };
    writeCache("mike", makePayload({ editorId: "mike" }), throwingThenSetting);
    expect(calls.some((c) => c.startsWith(`set:${BOARD_WINDOW_CACHE_KEY_PREFIX}:`))).toBe(true);
  });
});
