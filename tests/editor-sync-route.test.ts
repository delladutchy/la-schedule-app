import { beforeEach, describe, expect, it, vi } from "vitest";

const buildAndPersistSnapshot = vi.fn();
const appendAuditEvent = vi.fn();

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

vi.mock("@/lib/sync", () => ({
  buildAndPersistSnapshot: (...args: unknown[]) => buildAndPersistSnapshot(...args),
}));

vi.mock("@/lib/audit-log", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit-log")>("@/lib/audit-log");
  return {
    ...actual,
    appendAuditEvent: (...args: unknown[]) => appendAuditEvent(...args),
  };
});

async function loadPost() {
  const mod = await import("@/app/api/editor/sync/route");
  return mod.POST;
}

describe("/api/editor/sync auth", () => {
  beforeEach(() => {
    buildAndPersistSnapshot.mockReset();
    appendAuditEvent.mockReset();
  });

  it("rejects POST without bearer token", async () => {
    const POST = await loadPost();
    const req = new Request("http://localhost/api/editor/sync", {
      method: "POST",
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(appendAuditEvent).not.toHaveBeenCalled();
  });

  it("accepts named token and logs safe editor id", async () => {
    const POST = await loadPost();
    buildAndPersistSnapshot.mockResolvedValue({
      status: "ok",
      snapshot: {
        busy: [],
        generatedAtUtc: "2026-04-28T00:00:00.000Z",
      },
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const req = new Request("http://localhost/api/editor/sync", {
        method: "POST",
        headers: { Authorization: "Bearer dave-editor-token-0123456789" },
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(buildAndPersistSnapshot).toHaveBeenCalledTimes(1);
      expect(appendAuditEvent).toHaveBeenCalledTimes(1);
      const auditPayload = appendAuditEvent.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(auditPayload.editorId).toBe("dave");
      expect(auditPayload.action).toBe("sync");
      const logOutput = infoSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logOutput).toContain("editor=dave");
      expect(logOutput).not.toContain("dave-editor-token-0123456789");
    } finally {
      infoSpy.mockRestore();
    }
  });
});
