import { describe, expect, it } from "vitest";
import {
  SHELL_BUCKET_ANON,
  SHELL_BUCKET_NAMESPACE_EDITOR,
  buildShellCacheKey,
  isStaleShellCacheKey,
  shellCacheDateStamp,
  SHELL_CACHE_NAME,
  decodeSessionEditorIdFromCookie,
  deriveShellBucket,
  parseCookieValue,
  shouldHandleNavigationRequest,
  shouldBypassShellCacheForRequest,
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
    const a = buildShellCacheKey("https://example.com/?view=list&start=2026-05-04", "ed:mike", "2026-09-01");
    const b = buildShellCacheKey("https://example.com/?start=2026-05-04&view=list", "ed:mike", "2026-09-01");
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

describe("shouldBypassShellCacheForRequest", () => {
  it("returns true for navigation URLs carrying an editor token param", () => {
    expect(shouldBypassShellCacheForRequest("https://example.com/?editor=mike-token-abc")).toBe(true);
    expect(shouldBypassShellCacheForRequest("https://example.com/?view=list&editor=jeff-token-abc")).toBe(true);
  });

  it("returns false for normal navigation URLs without editor param", () => {
    expect(shouldBypassShellCacheForRequest("https://example.com/")).toBe(false);
    expect(shouldBypassShellCacheForRequest("https://example.com/?view=month&month=2026-05")).toBe(false);
  });

  it("returns false for unparseable URLs", () => {
    expect(shouldBypassShellCacheForRequest("not-a-url")).toBe(false);
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

  describe("RSC / router-data filtering", () => {
    const url = "https://example.com/?view=list";
    const docSignals = {
      mode: "navigate",
      destination: "document",
      acceptHeader: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };

    it("accepts a real top-level document navigation", () => {
      expect(shouldHandleNavigationRequest(url, "GET", docSignals)).toBe(true);
    });

    it("rejects requests carrying the RSC header (Next.js router data)", () => {
      expect(shouldHandleNavigationRequest(url, "GET", { ...docSignals, rscHeader: "1" })).toBe(false);
    });

    it("rejects RSC prefetches", () => {
      expect(shouldHandleNavigationRequest(url, "GET", { ...docSignals, prefetchHeader: "1" })).toBe(false);
    });

    it("rejects requests with the legacy _rsc query param", () => {
      expect(shouldHandleNavigationRequest("https://example.com/?_rsc=abc", "GET", docSignals)).toBe(false);
      expect(shouldHandleNavigationRequest("https://example.com/?view=list&_rsc=abc", "GET", docSignals)).toBe(false);
    });

    it("rejects requests whose mode is not navigate", () => {
      expect(shouldHandleNavigationRequest(url, "GET", { ...docSignals, mode: "cors" })).toBe(false);
      expect(shouldHandleNavigationRequest(url, "GET", { ...docSignals, mode: "same-origin" })).toBe(false);
      expect(shouldHandleNavigationRequest(url, "GET", { ...docSignals, mode: "no-cors" })).toBe(false);
    });

    it("rejects requests whose destination is not document", () => {
      expect(shouldHandleNavigationRequest(url, "GET", { ...docSignals, destination: "empty" })).toBe(false);
      expect(shouldHandleNavigationRequest(url, "GET", { ...docSignals, destination: "image" })).toBe(false);
    });

    it("rejects requests whose Accept header lacks text/html", () => {
      expect(shouldHandleNavigationRequest(url, "GET", { ...docSignals, acceptHeader: "*/*" })).toBe(false);
      expect(shouldHandleNavigationRequest(url, "GET", { ...docSignals, acceptHeader: "application/json" })).toBe(false);
    });

    it("does not require any signal to be present (back-compat with old call sites)", () => {
      expect(shouldHandleNavigationRequest(url, "GET")).toBe(true);
      expect(shouldHandleNavigationRequest(url, "GET", {})).toBe(true);
    });

    it("treats null/undefined signal values as unknown and stays permissive", () => {
      expect(shouldHandleNavigationRequest(url, "GET", {
        mode: null,
        destination: null,
        acceptHeader: null,
        rscHeader: null,
        prefetchHeader: null,
      })).toBe(true);
    });
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
    expect(shouldBypassShellCacheForRequest(url)).toBe(true);
    expect(shouldPersistResponseForRequest(url)).toBe(false);
  });
});

// ── Date-scoped shell cache (calendar stale-shell regression) ────────────────
//
// The SSR shell hard-embeds todayKey / weekStart / monthKey. With a dateless
// key, an August shell was replayed in September: routeTarget was seeded with
// past coordinates, /api/board/window clamped them to the current week/month,
// and the client's exact-match render gate rejected every response — the board
// hung on "Loading calendar…" for PWA users.

describe("shellCacheDateStamp", () => {
  it("formats the local calendar date as YYYY-MM-DD", () => {
    expect(shellCacheDateStamp(new Date(2026, 8, 1))).toBe("2026-09-01");
    expect(shellCacheDateStamp(new Date(2026, 7, 31))).toBe("2026-08-31");
  });

  it("zero-pads single-digit months and days", () => {
    expect(shellCacheDateStamp(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("shell cache key changes across dates", () => {
  const url = "https://example.com/?view=month";

  it("produces a different key on a different day", () => {
    const august = buildShellCacheKey(url, "ed:mike", "2026-08-24");
    const september = buildShellCacheKey(url, "ed:mike", "2026-09-01");
    expect(august).not.toBe(september);
  });

  it("a shell cached in August is never read back in September", () => {
    const cached = buildShellCacheKey(url, "ed:mike", "2026-08-24");
    const lookup = buildShellCacheKey(url, "ed:mike", "2026-09-01");
    expect(cached).not.toBe(lookup); // cache.match(lookup) misses → network
  });

  it("stays stable within the same day", () => {
    expect(buildShellCacheKey(url, "ed:mike", "2026-09-01"))
      .toBe(buildShellCacheKey(url, "ed:mike", "2026-09-01"));
  });

  it("still partitions by editor bucket on the same date", () => {
    expect(buildShellCacheKey(url, "ed:mike", "2026-09-01"))
      .not.toBe(buildShellCacheKey(url, "ed:dave", "2026-09-01"));
  });

  it("still excludes the raw editor token", () => {
    const token = "mike-editor-token-0123456789-secret";
    const key = buildShellCacheKey(`https://example.com/?editor=${token}`, "ed:mike", "2026-09-01");
    expect(key).not.toContain(token);
    expect(key).not.toContain("editor=");
  });

  it("defaults to today when no stamp is supplied", () => {
    expect(buildShellCacheKey(url, "ed:mike")).toContain(shellCacheDateStamp());
  });
});

describe("old shell cache version is replaced/evicted", () => {
  it("bumps the shell cache name past the poisoned v1", () => {
    // The SW activate handler deletes every cache not in PRESERVED_CACHE_NAMES,
    // so a new name evicts the entire v1 cache on update.
    expect(SHELL_CACHE_NAME).toBe("la-app-shell:v2");
    expect(SHELL_CACHE_NAME).not.toBe("la-app-shell:v1");
  });

  it("prunes entries from other days", () => {
    const today = "2026-09-01";
    const stale = buildShellCacheKey("https://example.com/", "ed:mike", "2026-08-24");
    const fresh = buildShellCacheKey("https://example.com/", "ed:mike", today);
    expect(isStaleShellCacheKey(stale, today)).toBe(true);
    expect(isStaleShellCacheKey(fresh, today)).toBe(false);
  });

  it("recognises the absolute URL form the Cache API stores", () => {
    const today = "2026-09-01";
    expect(isStaleShellCacheKey("https://app.example/shell:ed:mike:2026-08-24:/", today)).toBe(true);
    expect(isStaleShellCacheKey("https://app.example/shell:ed:mike:2026-09-01:/", today)).toBe(false);
  });

  it("ignores unrelated cache entries", () => {
    expect(isStaleShellCacheKey("https://app.example/brand/logo.png", "2026-09-01")).toBe(false);
  });
});
