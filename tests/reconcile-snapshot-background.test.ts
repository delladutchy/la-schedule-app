import { beforeEach, describe, expect, it, vi } from "vitest";

const buildAndPersistSnapshot = vi.fn();
const getStore = vi.fn();
const getEnvConfig = vi.fn();

vi.mock("@/lib/sync", () => ({
  buildAndPersistSnapshot: (...args: unknown[]) => buildAndPersistSnapshot(...args),
}));

vi.mock("@/lib/config", () => ({
  getEnvConfig: (...args: unknown[]) => getEnvConfig(...args),
}));

vi.mock("@netlify/blobs", () => ({
  getStore: (...args: unknown[]) => getStore(...args),
}));

async function loadHandler() {
  const mod = await import("@/netlify/functions/reconcile-snapshot-background");
  return mod.default;
}

function buildRequest(overrides: Partial<{ authorization: string; body: string }> = {}): Request {
  const headers: Record<string, string> = {};
  if (overrides.authorization) headers["authorization"] = overrides.authorization;
  return new Request("http://localhost/.netlify/functions/reconcile-snapshot-background", {
    method: "POST",
    headers,
    body: overrides.body ?? JSON.stringify({ action: "create" }),
  });
}

describe("reconcile snapshot background function", () => {
  beforeEach(() => {
    vi.resetModules();
    buildAndPersistSnapshot.mockReset();
    getStore.mockReset();
    getEnvConfig.mockReset();

    getEnvConfig.mockReturnValue({
      ADMIN_TOKEN: "admin-token-0123456789",
      BLOBS_STORE_NAME: "availability-snapshots",
    });

    const blobMap = new Map<string, unknown>();

    getStore.mockReturnValue({
      setJSON: vi.fn(async (key: string, value: unknown) => {
        blobMap.set(key, value);
      }),
      get: vi.fn(async (key: string) => blobMap.get(key) ?? null),
      delete: vi.fn(async (key: string) => {
        blobMap.delete(key);
      }),
    });

    buildAndPersistSnapshot.mockResolvedValue({
      status: "ok",
      snapshot: {
        generatedAtUtc: "2026-05-12T12:00:00.000Z",
        busy: [],
      },
      skipped: false,
    });
  });

  it("rejects unauthorized requests", async () => {
    const handler = await loadHandler();
    const res = await handler(buildRequest({ authorization: "Bearer wrong-token" }));

    expect(res.status).toBe(401);
    expect(buildAndPersistSnapshot).not.toHaveBeenCalled();
  });

  it("runs primary reconciliation when lock is available", async () => {
    const handler = await loadHandler();
    const res = await handler(buildRequest({ authorization: "Bearer admin-token-0123456789" }));

    expect(res.status).toBe(202);
    expect(buildAndPersistSnapshot).toHaveBeenCalledTimes(1);
  });

  it("coalesces when reconciliation lock is busy", async () => {
    const lockedAtUtc = new Date().toISOString();
    const store = {
      setJSON: vi.fn().mockResolvedValue(undefined),
      get: vi
        .fn()
        .mockResolvedValueOnce({ lockedAtUtc })
        .mockResolvedValueOnce(null),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    getStore.mockReturnValue(store);

    const handler = await loadHandler();
    const res = await handler(buildRequest({ authorization: "Bearer admin-token-0123456789" }));

    expect(res.status).toBe(202);
    expect(buildAndPersistSnapshot).not.toHaveBeenCalled();
    expect(store.setJSON).toHaveBeenCalledWith(
      "internal/reconcile/pending",
      expect.objectContaining({ action: "create" }),
    );
  });

  it("runs one additional coalesced reconciliation when pending marker is newer", async () => {
    const store = {
      setJSON: vi.fn().mockResolvedValue(undefined),
      get: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ requestedAtUtc: "2026-05-12T12:10:00.000Z" }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    getStore.mockReturnValue(store);

    const handler = await loadHandler();
    const res = await handler(buildRequest({
      authorization: "Bearer admin-token-0123456789",
      body: JSON.stringify({ action: "delete", requestedAtUtc: "2026-05-12T12:00:00.000Z" }),
    }));

    expect(res.status).toBe(202);
    expect(buildAndPersistSnapshot).toHaveBeenCalledTimes(2);
  });
});
