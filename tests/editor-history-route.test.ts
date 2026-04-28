import { beforeEach, describe, expect, it, vi } from "vitest";

const authorizeEditorRequest = vi.fn();
const readAuditEvents = vi.fn();
const clearAuditEvents = vi.fn();
const buildAndPersistSnapshot = vi.fn();
const createAllDayEvent = vi.fn();

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    env: {
      BLOBS_STORE_NAME: "availability-snapshots",
      EDITOR_TOKEN: "legacy-editor-token-0123456789",
      EDITOR_TOKENS_JSON: JSON.stringify({
        jeff: "jeff-editor-token-0123456789",
        dave: "dave-editor-token-0123456789",
        milos: "milos-editor-token-0123456789",
      }),
    },
  }),
}));

vi.mock("@/lib/editor-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/editor-auth")>("@/lib/editor-auth");
  return {
    ...actual,
    authorizeEditorRequest: (...args: unknown[]) => authorizeEditorRequest(...args),
  };
});

vi.mock("@/lib/audit-log", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit-log")>("@/lib/audit-log");
  return {
    ...actual,
    readAuditEvents: (...args: unknown[]) => readAuditEvents(...args),
    clearAuditEvents: (...args: unknown[]) => clearAuditEvents(...args),
  };
});

vi.mock("@/lib/sync", () => ({
  buildAndPersistSnapshot: (...args: unknown[]) => buildAndPersistSnapshot(...args),
}));

vi.mock("@/lib/google", () => ({
  createAllDayEvent: (...args: unknown[]) => createAllDayEvent(...args),
}));

async function loadRoutes() {
  const mod = await import("@/app/api/editor/history/route");
  return { GET: mod.GET, DELETE: mod.DELETE };
}

describe("/api/editor/history auth", () => {
  beforeEach(() => {
    authorizeEditorRequest.mockReset();
    readAuditEvents.mockReset();
    clearAuditEvents.mockReset();
    buildAndPersistSnapshot.mockReset();
    createAllDayEvent.mockReset();
  });

  it("rejects invalid token", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: false });
    const { GET } = await loadRoutes();
    const req = new Request("http://localhost/api/editor/history");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("accepts valid token and returns events", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });
    readAuditEvents.mockResolvedValue([{
      id: "1",
      timestampUtc: "2026-04-28T00:00:00.000Z",
      editorId: "jeff",
      action: "sync",
      status: "success",
    }]);
    const { GET } = await loadRoutes();
    const req = new Request("http://localhost/api/editor/history?limit=50");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const payload = await res.json() as { events?: unknown[] };
    expect(payload.events?.length).toBe(1);
    expect(readAuditEvents).toHaveBeenCalledWith("availability-snapshots", 50);
  });

  it("rejects DELETE with invalid token", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: false });
    const { DELETE } = await loadRoutes();
    const req = new Request("http://localhost/api/editor/history", { method: "DELETE" });
    const res = await DELETE(req);
    expect(res.status).toBe(401);
    expect(clearAuditEvents).not.toHaveBeenCalled();
  });

  it("rejects DELETE for non-jeff editor", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "dave" });
    const { DELETE } = await loadRoutes();
    const req = new Request("http://localhost/api/editor/history", { method: "DELETE" });
    const res = await DELETE(req);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
    expect(clearAuditEvents).not.toHaveBeenCalled();
  });

  it("accepts DELETE for jeff and clears events without google/sync calls", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });
    const { DELETE } = await loadRoutes();
    const req = new Request("http://localhost/api/editor/history", { method: "DELETE" });
    const res = await DELETE(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
    expect(clearAuditEvents).toHaveBeenCalledWith("availability-snapshots");
    expect(buildAndPersistSnapshot).not.toHaveBeenCalled();
    expect(createAllDayEvent).not.toHaveBeenCalled();
  });
});
