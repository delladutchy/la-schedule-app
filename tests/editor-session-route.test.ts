import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    env: {
      EDITOR_TOKEN: "legacy-editor-token-0123456789",
      EDITOR_TOKENS_JSON: JSON.stringify({
        jeff: "jeff-editor-token-0123456789",
        dave: "dave-editor-token-0123456789",
        milos: "milos-editor-token-0123456789",
      }),
    },
  }),
}));

async function loadRoute() {
  const mod = await import("@/app/api/editor/session/route");
  return mod.POST;
}

describe("/api/editor/session", () => {
  it("rejects invalid editor token", async () => {
    const POST = await loadRoute();
    const req = new Request("http://localhost/api/editor/session", {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid-editor-token-0000",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sets secure editor session cookie for valid token", async () => {
    const POST = await loadRoute();
    const req = new Request("http://localhost/api/editor/session", {
      method: "POST",
      headers: {
        Authorization: "Bearer dave-editor-token-0123456789",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: "ok",
      editorId: "dave",
    });
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("la_editor_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=5184000");
    expect(setCookie).not.toContain("dave-editor-token-0123456789");
    expect(setCookie).not.toContain("legacy-editor-token-0123456789");
  });
});
