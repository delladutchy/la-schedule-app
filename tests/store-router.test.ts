import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@/lib/types";

const readCurrentSnapshotFromBlobs = vi.fn();
const writeCurrentSnapshotToBlobs = vi.fn();
const readCurrentSnapshotFromSupabase = vi.fn();
const writeCurrentSnapshotToSupabase = vi.fn();

vi.mock("@/lib/store-blobs", () => ({
  readCurrentSnapshot: (...args: unknown[]) => readCurrentSnapshotFromBlobs(...args),
  writeCurrentSnapshot: (...args: unknown[]) => writeCurrentSnapshotToBlobs(...args),
}));

vi.mock("@/lib/store-supabase", () => ({
  readCurrentSnapshot: (...args: unknown[]) => readCurrentSnapshotFromSupabase(...args),
  writeCurrentSnapshot: (...args: unknown[]) => writeCurrentSnapshotToSupabase(...args),
}));

const baseSnapshot: Snapshot = {
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

const originalSupabaseReadsEnabled = process.env.SUPABASE_READS_ENABLED;
const originalSupabaseWritesEnabled = process.env.SUPABASE_WRITES_ENABLED;
const originalSupabaseUrl = process.env.SUPABASE_URL;
const originalSupabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("lib/store router", () => {
  beforeEach(() => {
    vi.resetModules();

    readCurrentSnapshotFromBlobs.mockReset();
    writeCurrentSnapshotToBlobs.mockReset();
    readCurrentSnapshotFromSupabase.mockReset();
    writeCurrentSnapshotToSupabase.mockReset();

    readCurrentSnapshotFromBlobs.mockResolvedValue(baseSnapshot);
    writeCurrentSnapshotToBlobs.mockResolvedValue(undefined);
    readCurrentSnapshotFromSupabase.mockResolvedValue(baseSnapshot);
    writeCurrentSnapshotToSupabase.mockResolvedValue(undefined);

    delete process.env.SUPABASE_READS_ENABLED;
    delete process.env.SUPABASE_WRITES_ENABLED;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    restoreEnv("SUPABASE_READS_ENABLED", originalSupabaseReadsEnabled);
    restoreEnv("SUPABASE_WRITES_ENABLED", originalSupabaseWritesEnabled);
    restoreEnv("SUPABASE_URL", originalSupabaseUrl);
    restoreEnv("SUPABASE_SERVICE_ROLE_KEY", originalSupabaseServiceRoleKey);
  });

  it("default store still uses Netlify Blobs behavior", async () => {
    const store = await import("@/lib/store");

    const readResult = await store.readCurrentSnapshot("availability-snapshots");
    expect(readResult).toEqual(baseSnapshot);
    expect(readCurrentSnapshotFromBlobs).toHaveBeenCalledWith("availability-snapshots", {});
    expect(readCurrentSnapshotFromSupabase).not.toHaveBeenCalled();

    await store.writeCurrentSnapshot("availability-snapshots", baseSnapshot);
    expect(writeCurrentSnapshotToBlobs).toHaveBeenCalledWith("availability-snapshots", baseSnapshot);
    expect(writeCurrentSnapshotToSupabase).not.toHaveBeenCalled();
  });

  it("falls back to Netlify Blobs when Supabase reads fail", async () => {
    process.env.SUPABASE_READS_ENABLED = "true";
    readCurrentSnapshotFromSupabase.mockRejectedValueOnce(new Error("supabase temporarily unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const store = await import("@/lib/store");
      const readResult = await store.readCurrentSnapshot("availability-snapshots", { consistency: "strong" });
      expect(readResult).toEqual(baseSnapshot);
      expect(readCurrentSnapshotFromSupabase).toHaveBeenCalledWith("availability-snapshots", { consistency: "strong" });
      expect(readCurrentSnapshotFromBlobs).toHaveBeenCalledWith("availability-snapshots", { consistency: "strong" });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("Supabase write failures do not break Netlify primary writes", async () => {
    process.env.SUPABASE_WRITES_ENABLED = "true";
    writeCurrentSnapshotToSupabase.mockRejectedValueOnce(new Error("upsert failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const store = await import("@/lib/store");
      await expect(store.writeCurrentSnapshot("availability-snapshots", baseSnapshot)).resolves.toBeUndefined();
      expect(writeCurrentSnapshotToBlobs).toHaveBeenCalledWith("availability-snapshots", baseSnapshot);
      expect(writeCurrentSnapshotToSupabase).toHaveBeenCalledWith("availability-snapshots", baseSnapshot);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not require Supabase env vars unless Supabase flags are enabled", async () => {
    const store = await import("@/lib/store");
    await expect(store.readCurrentSnapshot("availability-snapshots")).resolves.toEqual(baseSnapshot);
    await expect(store.writeCurrentSnapshot("availability-snapshots", baseSnapshot)).resolves.toBeUndefined();

    expect(readCurrentSnapshotFromSupabase).not.toHaveBeenCalled();
    expect(writeCurrentSnapshotToSupabase).not.toHaveBeenCalled();
  });
});
