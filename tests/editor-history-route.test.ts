import { beforeEach, describe, expect, it, vi } from "vitest";

const authorizeEditorRequest = vi.fn();
const readAuditEvents = vi.fn();

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
  };
});

async function loadGet() {
  const mod = await import("@/app/api/editor/history/route");
  return mod.GET;
}

describe("/api/editor/history auth", () => {
  beforeEach(() => {
    authorizeEditorRequest.mockReset();
    readAuditEvents.mockReset();
  });

  it("rejects invalid token", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: false });
    const GET = await loadGet();
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
    const GET = await loadGet();
    const req = new Request("http://localhost/api/editor/history?limit=50");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const payload = await res.json() as { events?: unknown[] };
    expect(payload.events?.length).toBe(1);
    expect(readAuditEvents).toHaveBeenCalledWith("availability-snapshots", 50);
  });
});
