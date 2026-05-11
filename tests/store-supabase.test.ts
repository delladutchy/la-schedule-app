import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@/lib/types";

const getSupabaseServerClient = vi.fn();

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: (...args: unknown[]) => getSupabaseServerClient(...args),
}));

interface MockSupabaseError {
  code?: string;
  message: string;
}

interface ReadResponse {
  data: { snapshot: unknown } | null;
  error: MockSupabaseError | null;
}

interface WriteResponse {
  error: MockSupabaseError | null;
}

function createMockClient(opts: {
  readResponse?: ReadResponse;
  writeResponse?: WriteResponse;
}) {
  const maybeSingle = vi.fn(async () => opts.readResponse ?? { data: null, error: null });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const upsert = vi.fn(async () => opts.writeResponse ?? { error: null });
  const from = vi.fn(() => ({ select, upsert }));

  return {
    client: { from },
    spies: { from, select, eq, maybeSingle, upsert },
  };
}

const snapshot: Snapshot = {
  version: 1,
  generatedAtUtc: "2026-05-01T12:00:00.000Z",
  windowStartUtc: "2026-05-01T00:00:00.000Z",
  windowEndUtc: "2026-05-31T23:59:59.000Z",
  busy: [],
  sourceCalendarIds: ["primary"],
  config: {
    timezone: "America/Los_Angeles",
    workdayStartHour: 9,
    workdayEndHour: 18,
    hideWeekends: true,
    showTentative: false,
    pageTitle: "Availability",
  },
};

describe("lib/store-supabase", () => {
  beforeEach(() => {
    vi.resetModules();
    getSupabaseServerClient.mockReset();
  });

  it("writes the current snapshot payload to snapshot_cache", async () => {
    const mock = createMockClient({ writeResponse: { error: null } });
    getSupabaseServerClient.mockReturnValue(mock.client);

    const { writeCurrentSnapshot } = await import("@/lib/store-supabase");
    await writeCurrentSnapshot("availability-snapshots", snapshot);

    expect(mock.spies.from).toHaveBeenCalledWith("snapshot_cache");
    expect(mock.spies.upsert).toHaveBeenCalledWith(
      {
        store_name: "availability-snapshots",
        snapshot,
      },
      { onConflict: "store_name" },
    );
  });

  it("reads and validates the current snapshot payload", async () => {
    const mock = createMockClient({
      readResponse: {
        data: { snapshot },
        error: null,
      },
    });
    getSupabaseServerClient.mockReturnValue(mock.client);

    const { readCurrentSnapshot } = await import("@/lib/store-supabase");
    const result = await readCurrentSnapshot("availability-snapshots", { consistency: "strong" });

    expect(result).toEqual(snapshot);
    expect(mock.spies.from).toHaveBeenCalledWith("snapshot_cache");
    expect(mock.spies.select).toHaveBeenCalledWith("snapshot");
    expect(mock.spies.eq).toHaveBeenCalledWith("store_name", "availability-snapshots");
  });

  it("returns null when snapshot row is missing", async () => {
    const mock = createMockClient({
      readResponse: {
        data: null,
        error: null,
      },
    });
    getSupabaseServerClient.mockReturnValue(mock.client);

    const { readCurrentSnapshot } = await import("@/lib/store-supabase");
    const result = await readCurrentSnapshot("availability-snapshots");

    expect(result).toBeNull();
  });

  it("returns null when snapshot payload fails schema validation", async () => {
    const mock = createMockClient({
      readResponse: {
        data: { snapshot: { version: 1, generatedAtUtc: "not-an-iso" } },
        error: null,
      },
    });
    getSupabaseServerClient.mockReturnValue(mock.client);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { readCurrentSnapshot } = await import("@/lib/store-supabase");
      const result = await readCurrentSnapshot("availability-snapshots");
      expect(result).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns null when Supabase reports missing rows", async () => {
    const mock = createMockClient({
      readResponse: {
        data: null,
        error: { code: "PGRST116", message: "The result contains 0 rows" },
      },
    });
    getSupabaseServerClient.mockReturnValue(mock.client);

    const { readCurrentSnapshot } = await import("@/lib/store-supabase");
    const result = await readCurrentSnapshot("availability-snapshots");

    expect(result).toBeNull();
  });
});
