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
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const store = await import("@/lib/store");

    try {
      const readResult = await store.readCurrentSnapshot("availability-snapshots");
      expect(readResult).toEqual(baseSnapshot);
      expect(readCurrentSnapshotFromBlobs).toHaveBeenCalledWith("availability-snapshots", {});
      expect(readCurrentSnapshotFromSupabase).not.toHaveBeenCalled();

      await store.writeCurrentSnapshot("availability-snapshots", baseSnapshot);
      expect(writeCurrentSnapshotToBlobs).toHaveBeenCalledWith("availability-snapshots", baseSnapshot);
      expect(writeCurrentSnapshotToSupabase).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        "[snapshot] Supabase write-through skipped enabled=false store=availability-snapshots generatedAtUtc=2026-05-01T12:00:00.000Z",
      );
    } finally {
      infoSpy.mockRestore();
    }
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

  it("falls back to Netlify Blobs when Supabase reads return no row", async () => {
    process.env.SUPABASE_READS_ENABLED = "true";
    readCurrentSnapshotFromSupabase.mockResolvedValueOnce(null);

    const store = await import("@/lib/store");
    const readResult = await store.readCurrentSnapshot("availability-snapshots", { consistency: "strong" });
    expect(readResult).toEqual(baseSnapshot);
    expect(readCurrentSnapshotFromSupabase).toHaveBeenCalledWith("availability-snapshots", { consistency: "strong" });
    expect(readCurrentSnapshotFromBlobs).toHaveBeenCalledWith("availability-snapshots", { consistency: "strong" });
  });

  it("uses Supabase snapshot when it is fresher than Netlify Blobs", async () => {
    process.env.SUPABASE_READS_ENABLED = "true";
    const blobsSnapshot: Snapshot = {
      ...baseSnapshot,
      generatedAtUtc: "2026-05-01T11:00:00.000Z",
    };
    const supabaseSnapshot: Snapshot = {
      ...baseSnapshot,
      generatedAtUtc: "2026-05-01T12:00:00.000Z",
    };
    readCurrentSnapshotFromBlobs.mockResolvedValueOnce(blobsSnapshot);
    readCurrentSnapshotFromSupabase.mockResolvedValueOnce(supabaseSnapshot);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      const store = await import("@/lib/store");
      const readResult = await store.readCurrentSnapshot("availability-snapshots");
      expect(readResult).toEqual(supabaseSnapshot);
      expect(readCurrentSnapshotFromSupabase).toHaveBeenCalledWith("availability-snapshots", {});
      expect(readCurrentSnapshotFromBlobs).toHaveBeenCalledWith("availability-snapshots", {});
      expect(infoSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Supabase snapshot stale; using Netlify Blobs fallback"),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("falls back to Netlify Blobs when Supabase snapshot is stale", async () => {
    process.env.SUPABASE_READS_ENABLED = "true";
    const blobsSnapshot: Snapshot = {
      ...baseSnapshot,
      generatedAtUtc: "2026-05-01T12:00:00.000Z",
    };
    const supabaseSnapshot: Snapshot = {
      ...baseSnapshot,
      generatedAtUtc: "2026-05-01T11:00:00.000Z",
    };
    readCurrentSnapshotFromBlobs.mockResolvedValueOnce(blobsSnapshot);
    readCurrentSnapshotFromSupabase.mockResolvedValueOnce(supabaseSnapshot);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      const store = await import("@/lib/store");
      const readResult = await store.readCurrentSnapshot("availability-snapshots");
      expect(readResult).toEqual(blobsSnapshot);
      expect(readCurrentSnapshotFromSupabase).toHaveBeenCalledWith("availability-snapshots", {});
      expect(readCurrentSnapshotFromBlobs).toHaveBeenCalledWith("availability-snapshots", {});
      expect(infoSpy).toHaveBeenCalledWith(
        "[snapshot] Supabase snapshot stale; using Netlify Blobs fallback store=availability-snapshots supabaseGeneratedAt=2026-05-01T11:00:00.000Z blobsGeneratedAt=2026-05-01T12:00:00.000Z",
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("Supabase write failures do not break Netlify primary writes", async () => {
    process.env.SUPABASE_WRITES_ENABLED = "true";
    writeCurrentSnapshotToSupabase.mockRejectedValueOnce({
      code: "42501",
      message: "permission denied by row-level security policy",
      secret: "do-not-log",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      const store = await import("@/lib/store");
      await expect(store.writeCurrentSnapshot("availability-snapshots", baseSnapshot)).resolves.toEqual({
        supabaseWriteAttempted: true,
        supabaseWriteSucceeded: false,
        supabaseWriteErrorCode: "42501",
        supabaseWriteErrorMessage: "permission denied by row-level security policy",
      });
      expect(writeCurrentSnapshotToBlobs).toHaveBeenCalledWith("availability-snapshots", baseSnapshot);
      expect(writeCurrentSnapshotToSupabase).toHaveBeenCalledWith("availability-snapshots", baseSnapshot);
      expect(infoSpy).toHaveBeenCalledWith(
        "[snapshot] Supabase write-through attempting enabled=true store=availability-snapshots generatedAtUtc=2026-05-01T12:00:00.000Z",
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "[snapshot] Supabase write-through failed; continuing with Netlify Blobs snapshot. store=availability-snapshots generatedAtUtc=2026-05-01T12:00:00.000Z code=42501 message=permission denied by row-level security policy",
      );
      expect(errorSpy.mock.calls.join(" ")).not.toContain("do-not-log");
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("Supabase write-through enabled logs attempt and success", async () => {
    process.env.SUPABASE_WRITES_ENABLED = "true";
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      const store = await import("@/lib/store");
      await store.writeCurrentSnapshot("availability-snapshots", baseSnapshot);
      expect(writeCurrentSnapshotToSupabase).toHaveBeenCalledWith("availability-snapshots", baseSnapshot);
      expect(infoSpy).toHaveBeenCalledWith(
        "[snapshot] Supabase write-through attempting enabled=true store=availability-snapshots generatedAtUtc=2026-05-01T12:00:00.000Z",
      );
      expect(infoSpy).toHaveBeenCalledWith(
        "[snapshot] Supabase write-through success store=availability-snapshots generatedAtUtc=2026-05-01T12:00:00.000Z",
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("does not require Supabase env vars unless Supabase flags are enabled", async () => {
    const store = await import("@/lib/store");
    await expect(store.readCurrentSnapshot("availability-snapshots")).resolves.toEqual(baseSnapshot);
    await expect(store.writeCurrentSnapshot("availability-snapshots", baseSnapshot)).resolves.toEqual({
      supabaseWriteAttempted: false,
      supabaseWriteSucceeded: false,
    });

    expect(readCurrentSnapshotFromSupabase).not.toHaveBeenCalled();
    expect(writeCurrentSnapshotToSupabase).not.toHaveBeenCalled();
  });
});
