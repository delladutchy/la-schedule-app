import { describe, expect, it, vi } from "vitest";
import {
  EDITOR_SESSION_COOKIE_NAME,
  buildEditorSessionCookieValue,
} from "@/lib/editor-auth";

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
    file: {
      timezone: "America/New_York",
    },
  }),
}));

async function loadGigRoutes() {
  const mod = await import("@/app/api/gigs/[eventId]/route");
  return {
    PATCH: mod.PATCH,
    DELETE: mod.DELETE,
  };
}

describe("/api/gigs/[eventId] auth", () => {
  it("rejects PATCH without bearer token", async () => {
    const { PATCH } = await loadGigRoutes();
    const req = new Request("http://localhost/api/gigs/g123", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#71411 — Wilmington Flower Market",
        date: "2026-05-06",
      }),
    });

    const res = await PATCH(req, { params: { eventId: "g123" } });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects DELETE without bearer token", async () => {
    const { DELETE } = await loadGigRoutes();
    const req = new Request("http://localhost/api/gigs/g123", {
      method: "DELETE",
    });

    const res = await DELETE(req, { params: { eventId: "g123" } });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects cookie-auth PATCH from cross-origin requests", async () => {
    const { PATCH } = await loadGigRoutes();
    const cookie = buildEditorSessionCookieValue("dave", {
      EDITOR_TOKEN: "legacy-editor-token-0123456789",
      EDITOR_TOKENS_JSON: JSON.stringify({
        jeff: "jeff-editor-token-0123456789",
        dave: "dave-editor-token-0123456789",
        milos: "milos-editor-token-0123456789",
      }),
    });
    const req = new Request("http://localhost/api/gigs/g123", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        origin: "http://evil.example.com",
        cookie: `${EDITOR_SESSION_COOKIE_NAME}=${cookie}`,
      },
      body: JSON.stringify({
        summary: "LA#71411 — Wilmington Flower Market",
        date: "2026-05-06",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "g123" } });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("rejects cookie-auth DELETE from cross-origin requests", async () => {
    const { DELETE } = await loadGigRoutes();
    const cookie = buildEditorSessionCookieValue("dave", {
      EDITOR_TOKEN: "legacy-editor-token-0123456789",
      EDITOR_TOKENS_JSON: JSON.stringify({
        jeff: "jeff-editor-token-0123456789",
        dave: "dave-editor-token-0123456789",
        milos: "milos-editor-token-0123456789",
      }),
    });
    const req = new Request("http://localhost/api/gigs/g123", {
      method: "DELETE",
      headers: {
        origin: "http://evil.example.com",
        cookie: `${EDITOR_SESSION_COOKIE_NAME}=${cookie}`,
      },
    });

    const res = await DELETE(req, { params: { eventId: "g123" } });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
  });
});
