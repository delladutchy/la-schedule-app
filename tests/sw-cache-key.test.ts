import { describe, expect, it } from "vitest";
import {
  SHELL_BUCKET_ANON,
  SHELL_BUCKET_NAMESPACE_EDITOR,
  buildShellCacheKey,
  decodeSessionEditorIdFromCookie,
  deriveShellBucket,
  parseCookieValue,
  shouldHandleNavigationRequest,
  shouldPersistResponseForRequest,
} from "@/lib/sw-cache-key";

const SESSION_COOKIE_NAME = "la_editor_session";

function buildSessionCookieValue(editorId: string, opts?: { exp?: number; iat?: number }): string {
  const claims = {
    v: 1,
    editorId,
    iat: opts?.iat ?? Date.now() - 1000,
    exp: opts?.exp ?? Date.now() + 60_000,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  // The signature is irrelevant to bucket derivation — the SW does not
  // verify it (the server does that). Use a placeholder signature so the
  // shape matches what the server emits.
  return `${payload}.placeholder-signature`;
}

function cookieHeaderWithSession(editorId: string): string {
  return `theme=dark; ${SESSION_COOKIE_NAME}=${buildSessionCookieValue(editorId)}; other=1`;
}

describe("parseCookieValue", () => {
  it("returns null when header is missing or empty", () => {
    expect(parseCookieValue(null, "x")).toBeNull();
    expect(parseCookieValue(undefined, "x")).toBeNull();
    expect(parseCookieValue("", "x")).toBeNull();
  });

  it("finds a named cookie among many", () => {
    expect(parseCookieValue("a=1; b=2; c=3", "b")).toBe("2");
    expect(parseCookieValue("a=1; b=2; c=3", "c")).toBe("3");
  });

  it("returns null when the named cookie is absent", () => {
    expect(parseCookieValue("a=1; b=2", "missing")).toBeNull();
  });

  it("does not partial-match cookie names", () => {
    expect(parseCookieValue("editor_other=tok; editor=truth", "editor")).toBe("truth");
  });
});

describe("decodeSessionEditorIdFromCookie", () => {
  it("decodes editorId from a valid base64url payload", () => {
    const cookie = buildSessionCookieValue("mike");
    expect(decodeSessionEditorIdFromCookie(cookie)).toBe("mike");
  });

  it("normalizes case and trims whitespace in the encoded editorId", () => {
    const cookie = buildSessionCookieValue("  Mike  ");
    expect(decodeSessionEditorIdFromCookie(cookie)).toBe("mike");
  });

  it("returns null when there is no dot separator", () => {
    expect(decodeSessionEditorIdFromCookie("notavalidcookie")).toBeNull();
  });

  it("returns null when the payload is not valid base64", () => {
    expect(decodeSessionEditorIdFromCookie("***.sig")).toBeNull();
  });

  it("returns null when the decoded payload is not JSON", () => {
    const payload = Buffer.from("not json", "utf8").toString("base64url");
    expect(decodeSessionEditorIdFromCookie(`${payload}.sig`)).toBeNull();
  });

  it("returns null when editorId is missing or wrong type", () => {
    const noEditor = Buffer.from(JSON.stringify({ v: 1 }), "utf8").toString("base64url");
    expect(decodeSessionEditorIdFromCookie(`${noEditor}.sig`)).toBeNull();
    const numericEditor = Buffer.from(JSON.stringify({ editorId: 7 }), "utf8").toString("base64url");
    expect(decodeSessionEditorIdFromCookie(`${numericEditor}.sig`)).toBeNull();
  });
});

describe("deriveShellBucket", () => {
  it("returns ed:<id> for a known editor cookie", () => {
    for (const id of ["jeff", "legacy", "dave", "milos", "mike"]) {
      const header = cookieHeaderWithSession(id);
      expect(deriveShellBucket(header)).toBe(`${SHELL_BUCKET_NAMESPACE_EDITOR}:${id}`);
    }
  });

  it("returns anon when there is no cookie header", () => {
    expect(deriveShellBucket(null)).toBe(SHELL_BUCKET_ANON);
    expect(deriveShellBucket("")).toBe(SHELL_BUCKET_ANON);
  });

  it("returns anon when the session cookie is malformed", () => {
    expect(deriveShellBucket("la_editor_session=garbled-no-dot; foo=bar")).toBe(SHELL_BUCKET_ANON);
  });

  it("returns anon for an unknown editor id (collapses unknowns)", () => {
    const header = cookieHeaderWithSession("attacker");
    expect(deriveShellBucket(header)).toBe(SHELL_BUCKET_ANON);
  });

  it("ignores the ?editor=TOKEN URL param entirely (cookie is the only signal)", () => {
    // No cookie at all → anon, regardless of any other context the caller
    // may pass alongside. (URL is parsed in buildShellCacheKey, not here.)
    expect(deriveShellBucket("unrelated=1")).toBe(SHELL_BUCKET_ANON);
  });
});

describe("buildShellCacheKey", () => {
  it("never includes the raw ?editor token", () => {
    const token = "mike-editor-token-0123456789-secret";
    const key = buildShellCacheKey(`https://example.com/?view=list&editor=${token}`, "ed:mike");
    expect(key).not.toContain(token);
    expect(key).not.toContain("editor=");
  });

  it("normalizes parameter ordering for stable keys", () => {
    const a = buildShellCacheKey("https://example.com/?view=list&start=2026-05-04", "ed:mike");
    const b = buildShellCacheKey("https://example.com/?start=2026-05-04&view=list", "ed:mike");
    expect(a).toBe(b);
  });

  it("includes the editor bucket label", () => {
    const key = buildShellCacheKey("https://example.com/", "ed:dave");
    expect(key.startsWith("shell:ed:dave:")).toBe(true);
  });

  it("produces different keys for different buckets even with the same URL", () => {
    const url = "https://example.com/?view=list";
    expect(buildShellCacheKey(url, "ed:mike"))
      .not.toBe(buildShellCacheKey(url, "ed:dave"));
    expect(buildShellCacheKey(url, "ed:mike"))
      .not.toBe(buildShellCacheKey(url, SHELL_BUCKET_ANON));
  });

  it("returns a sentinel for an unparseable URL without throwing", () => {
    expect(buildShellCacheKey("not-a-url", "anon")).toBe("shell:anon:invalid");
  });
});

describe("shouldHandleNavigationRequest", () => {
  it("only matches GET to the home route", () => {
    expect(shouldHandleNavigationRequest("https://example.com/", "GET")).toBe(true);
    expect(shouldHandleNavigationRequest("https://example.com/?view=list", "GET")).toBe(true);
  });

  it("ignores non-GET methods", () => {
    expect(shouldHandleNavigationRequest("https://example.com/", "POST")).toBe(false);
    expect(shouldHandleNavigationRequest("https://example.com/", "PUT")).toBe(false);
  });

  it("ignores other paths", () => {
    expect(shouldHandleNavigationRequest("https://example.com/api/board/window", "GET")).toBe(false);
    expect(shouldHandleNavigationRequest("https://example.com/admin", "GET")).toBe(false);
    expect(shouldHandleNavigationRequest("https://example.com/sw.js", "GET")).toBe(false);
    expect(shouldHandleNavigationRequest("https://example.com/manifest.webmanifest", "GET")).toBe(false);
  });

  it("returns false for unparseable URLs", () => {
    expect(shouldHandleNavigationRequest("not-a-url", "GET")).toBe(false);
  });
});

describe("shouldPersistResponseForRequest", () => {
  it("refuses to persist responses to URLs that contained an editor token", () => {
    expect(shouldPersistResponseForRequest("https://example.com/?editor=mike-token-abc")).toBe(false);
    expect(shouldPersistResponseForRequest("https://example.com/?view=list&editor=foo")).toBe(false);
  });

  it("permits persistence for token-free URLs", () => {
    expect(shouldPersistResponseForRequest("https://example.com/")).toBe(true);
    expect(shouldPersistResponseForRequest("https://example.com/?view=month&month=2026-05")).toBe(true);
  });

  it("returns false for unparseable URLs", () => {
    expect(shouldPersistResponseForRequest("not-a-url")).toBe(false);
  });
});

describe("end-to-end token-leakage guard", () => {
  it("never produces a cache key or bucket containing the raw token across all paths", () => {
    const token = "mike-editor-token-0123456789-secret";
    const url = `https://example.com/?view=list&start=2026-05-04&editor=${token}`;
    const cookieHeader = cookieHeaderWithSession("mike");

    const bucket = deriveShellBucket(cookieHeader);
    const key = buildShellCacheKey(url, bucket);

    expect(bucket).not.toContain(token);
    expect(key).not.toContain(token);
    expect(key).not.toContain("editor=");
    expect(shouldPersistResponseForRequest(url)).toBe(false);
  });
});
