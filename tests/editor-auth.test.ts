import { describe, expect, it } from "vitest";
import {
  EDITOR_SESSION_COOKIE_NAME,
  authorizeEditorRequest,
  buildEditorSessionCookieValue,
  canEditorModifyEventOwner,
  isSameOriginEditorMutation,
  resolveEditorRole,
  resolveEditorIdFromAuthorizationHeader,
  resolveEditorTokenMap,
} from "@/lib/editor-auth";

describe("editor token auth helper", () => {
  const env = {
    EDITOR_TOKEN: "legacy-editor-token-0123456789",
    EDITOR_TOKENS_JSON: JSON.stringify({
      jeff: "jeff-editor-token-0123456789",
      dave: "dave-editor-token-0123456789",
      milos: "milos-editor-token-0123456789",
    }),
  };

  it("accepts Jeff/Dave/Milos named tokens", () => {
    const tokenMap = resolveEditorTokenMap(env);
    expect(resolveEditorIdFromAuthorizationHeader("Bearer jeff-editor-token-0123456789", tokenMap)).toBe("jeff");
    expect(resolveEditorIdFromAuthorizationHeader("Bearer dave-editor-token-0123456789", tokenMap)).toBe("dave");
    expect(resolveEditorIdFromAuthorizationHeader("Bearer milos-editor-token-0123456789", tokenMap)).toBe("milos");
  });

  it("accepts legacy EDITOR_TOKEN as legacy editor id", () => {
    const tokenMap = resolveEditorTokenMap(env);
    expect(resolveEditorIdFromAuthorizationHeader("Bearer legacy-editor-token-0123456789", tokenMap)).toBe("legacy");
  });

  it("rejects invalid editor tokens", () => {
    const tokenMap = resolveEditorTokenMap(env);
    expect(resolveEditorIdFromAuthorizationHeader("Bearer definitely-not-valid", tokenMap)).toBeNull();
    expect(resolveEditorIdFromAuthorizationHeader(null, tokenMap)).toBeNull();
  });

  it("authorizes request and returns mapped editor id", () => {
    const request = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { Authorization: "Bearer dave-editor-token-0123456789" },
    });
    expect(authorizeEditorRequest(request, env)).toEqual({
      ok: true,
      editorId: "dave",
      source: "bearer",
    });
  });

  it("authorizes request via signed editor session cookie", () => {
    const cookie = buildEditorSessionCookieValue("milos", env, Date.now());
    const request = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: {
        cookie: `${EDITOR_SESSION_COOKIE_NAME}=${cookie}`,
      },
    });
    expect(authorizeEditorRequest(request, env)).toEqual({
      ok: true,
      editorId: "milos",
      source: "cookie",
    });
  });

  it("prefers bearer token over cookie session when both are present", () => {
    const cookie = buildEditorSessionCookieValue("milos", env);
    const request = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: {
        Authorization: "Bearer dave-editor-token-0123456789",
        cookie: `${EDITOR_SESSION_COOKIE_NAME}=${cookie}`,
      },
    });
    expect(authorizeEditorRequest(request, env)).toEqual({
      ok: true,
      editorId: "dave",
      source: "bearer",
    });
  });

  it("rejects tampered editor session cookies", () => {
    const cookie = buildEditorSessionCookieValue("milos", env);
    const [payload] = cookie.split(".", 1);
    const request = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: {
        cookie: `${EDITOR_SESSION_COOKIE_NAME}=${payload}.invalid`,
      },
    });
    expect(authorizeEditorRequest(request, env)).toEqual({ ok: false });
  });

  it("enforces same-origin checks for cookie-authenticated mutations", () => {
    const sameOriginRequest = new Request("https://la-schedule-app.netlify.app/api/gigs/create", {
      method: "POST",
      headers: {
        origin: "https://la-schedule-app.netlify.app",
      },
    });
    expect(isSameOriginEditorMutation(sameOriginRequest)).toBe(true);

    const crossOriginRequest = new Request("https://la-schedule-app.netlify.app/api/gigs/create", {
      method: "POST",
      headers: {
        origin: "https://evil.example.com",
      },
    });
    expect(isSameOriginEditorMutation(crossOriginRequest)).toBe(false);
  });

  it("throws on malformed EDITOR_TOKENS_JSON", () => {
    expect(() => resolveEditorTokenMap({
      EDITOR_TOKEN: "legacy-editor-token-0123456789",
      EDITOR_TOKENS_JSON: "not-json",
    })).toThrowError("EDITOR_TOKENS_JSON");
  });

  it("maps editor roles (Jeff/Dave full, Milos limited)", () => {
    expect(resolveEditorRole("jeff")).toBe("full");
    expect(resolveEditorRole("dave")).toBe("full");
    expect(resolveEditorRole("legacy")).toBe("full");
    expect(resolveEditorRole("milos")).toBe("limited");
  });

  it("enforces owner checks for limited editor only", () => {
    expect(canEditorModifyEventOwner("jeff", undefined)).toBe(true);
    expect(canEditorModifyEventOwner("dave", "milos")).toBe(true);
    expect(canEditorModifyEventOwner("milos", "milos")).toBe(true);
    expect(canEditorModifyEventOwner("milos", "dave")).toBe(false);
    expect(canEditorModifyEventOwner("milos", undefined)).toBe(false);
  });
});
