/**
 * Service Worker — app shell cache (stale-while-revalidate).
 *
 * Goal: instant first paint for already-installed Home Screen apps.
 * Strategy:
 *   - Intercept GET / navigation requests.
 *   - Bucket cache per editor identity, derived ONLY from the
 *     `la_editor_session` cookie (NEVER from the `?editor=TOKEN` query).
 *   - Token-bearing requests are passed through to network and NEVER
 *     persisted, so the raw token never lands in disk-backed Cache API
 *     storage.
 *   - On a hit, serve the cached HTML immediately and revalidate in
 *     the background. On a miss, fall through to the network.
 *   - Any unexpected SW failure falls back to plain network → SSR.
 *
 * Rollback:
 *   To disable this SW everywhere, copy public/sw-kill.js's contents
 *   into this file and deploy. Every installed SW will then evict its
 *   caches, unregister itself, and reload its open clients.
 *
 * !!! The cache helpers below are mirrored from lib/sw-cache-key.ts —
 *     keep both in sync if you change the bucket / key shape.        !!!
 */

const SHELL_CACHE_NAME = "la-app-shell:v1";
const SESSION_COOKIE_NAME = "la_editor_session";
const KNOWN_EDITORS = ["jeff", "legacy", "dave", "milos", "mike"];

self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    try {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(function (n) { return n !== SHELL_CACHE_NAME; })
          .map(function (n) { return caches.delete(n); }),
      );
    } catch (e) {
      // Best-effort cleanup; never block activation.
    }
    try {
      await self.clients.claim();
    } catch (e) {
      // ignore
    }
  })());
});

self.addEventListener("fetch", function (event) {
  const req = event.request;
  if (!shouldHandleNavigationRequest(req.url, req.method)) return;

  event.respondWith((async function () {
    try {
      const bucket = deriveShellBucket(req.headers.get("cookie"));
      const cacheKey = buildShellCacheKey(req.url, bucket);
      const cache = await caches.open(SHELL_CACHE_NAME);
      const cached = await cache.match(cacheKey);

      if (cached) {
        // Hit: serve cached HTML now, revalidate in the background.
        event.waitUntil(
          revalidate(req, cache, cacheKey).then(function (didUpdate) {
            if (didUpdate) notifyClients({ type: "shell-revalidated" });
          }),
        );
        return cached;
      }

      // Miss: go to the network. Cache only when the request URL had
      // no `?editor=TOKEN` to keep the raw token out of stored bytes.
      const fresh = await fetchAndMaybeCache(req, cache, cacheKey);
      if (fresh) return fresh;
      return fetch(req);
    } catch (e) {
      // Any SW failure → network fallback. SSR remains source of truth.
      return fetch(req);
    }
  })());
});

self.addEventListener("message", function (event) {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "invalidate-shell-cache") {
    event.waitUntil((async function () {
      try { await caches.delete(SHELL_CACHE_NAME); } catch (e) { /* ignore */ }
    })());
  }
});

async function revalidate(request, cache, cacheKey) {
  try {
    return Boolean(await fetchAndMaybeCache(request, cache, cacheKey));
  } catch (e) {
    return false;
  }
}

async function fetchAndMaybeCache(request, cache, cacheKey) {
  const networkRequest = new Request(request, { cache: "no-store" });
  let response;
  try {
    response = await fetch(networkRequest);
  } catch (e) {
    return null;
  }
  if (!response || !response.ok) return null;
  if (!shouldPersistResponseForRequest(request.url)) return response;
  try {
    await cache.put(cacheKey, response.clone());
  } catch (e) {
    // Quota exceeded / opaque response — ignore, return live response.
  }
  return response;
}

async function notifyClients(message) {
  try {
    const clients = await self.clients.matchAll({ type: "window" });
    for (let i = 0; i < clients.length; i += 1) {
      try { clients[i].postMessage(message); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    // ignore
  }
}

// --- Mirrored from lib/sw-cache-key.ts (keep in sync) ---

function shouldHandleNavigationRequest(rawUrl, method) {
  if (method !== "GET") return false;
  let url;
  try { url = new URL(rawUrl); } catch (e) { return false; }
  return url.pathname === "/" || url.pathname === "";
}

function shouldPersistResponseForRequest(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch (e) { return false; }
  if (url.searchParams.has("editor")) return false;
  return true;
}

function parseCookieValue(cookieHeader, cookieName) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (let i = 0; i < parts.length; i += 1) {
    const trimmed = parts[i].trim();
    if (trimmed.indexOf(cookieName + "=") !== 0) continue;
    const value = trimmed.slice(cookieName.length + 1).trim();
    return value || null;
  }
  return null;
}

function decodeSessionEditorIdFromCookie(rawCookie) {
  if (!rawCookie) return null;
  const dotIndex = rawCookie.indexOf(".");
  if (dotIndex <= 0) return null;
  const payloadB64 = rawCookie.slice(0, dotIndex);
  let decoded;
  try {
    const normalized = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    decoded = atob(normalized);
  } catch (e) {
    return null;
  }
  let claims;
  try {
    claims = JSON.parse(decoded);
  } catch (e) {
    return null;
  }
  if (typeof claims.editorId !== "string") return null;
  const normalized = claims.editorId.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function deriveShellBucket(cookieHeader) {
  const editorId = decodeSessionEditorIdFromCookie(
    parseCookieValue(cookieHeader, SESSION_COOKIE_NAME),
  );
  if (editorId && KNOWN_EDITORS.indexOf(editorId) !== -1) {
    return "ed:" + editorId;
  }
  return "anon";
}

function buildShellCacheKey(rawUrl, bucket) {
  let url;
  try { url = new URL(rawUrl); } catch (e) {
    return "shell:" + bucket + ":invalid";
  }
  url.searchParams.delete("editor");
  const entries = Array.from(url.searchParams.entries());
  entries.sort(function (a, b) { return a[0].localeCompare(b[0]); });
  const search = entries.length === 0
    ? ""
    : "?" + entries.map(function (kv) { return kv[0] + "=" + kv[1]; }).join("&");
  return "shell:" + bucket + ":" + url.pathname + search;
}
