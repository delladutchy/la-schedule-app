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
const STATIC_CACHE_NAME = "la-static:v1";
const SESSION_COOKIE_NAME = "la_editor_session";
const KNOWN_EDITORS = ["jeff", "legacy", "dave", "milos", "mike"];
const STATIC_CACHE_PATH_PREFIXES = ["/brand/"];
const PRESERVED_CACHE_NAMES = [SHELL_CACHE_NAME, STATIC_CACHE_NAME];

self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    try {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(function (n) { return PRESERVED_CACHE_NAMES.indexOf(n) === -1; })
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
  const signals = navigationSignalsFromRequest(req);
  if (shouldHandleNavigationRequest(req.url, req.method, signals)) {
    event.respondWith(handleNavigationRequest(event, req));
    return;
  }
  if (shouldHandleStaticAssetRequest(req.url, req.method)) {
    event.respondWith(handleStaticAssetRequest(event, req));
    return;
  }
});

function navigationSignalsFromRequest(req) {
  let acceptHeader = null;
  let rscHeader = null;
  let prefetchHeader = null;
  try {
    if (req.headers) {
      acceptHeader = req.headers.get("accept");
      rscHeader = req.headers.get("rsc");
      prefetchHeader = req.headers.get("next-router-prefetch");
    }
  } catch (e) {
    // Some pre-Safari-16.4 contexts can throw on header access; treat as
    // unknown — the URL/_rsc check below still rejects most RSC URLs.
  }
  return {
    mode: req.mode || null,
    destination: req.destination || null,
    rscHeader: rscHeader,
    prefetchHeader: prefetchHeader,
    acceptHeader: acceptHeader,
  };
}

async function handleNavigationRequest(event, req) {
  try {
    // Tokenized editor bootstrap URLs must bypass shell cache entirely so
    // same-domain token switches never replay another editor's cached shell.
    if (shouldBypassShellCacheForRequest(req.url)) {
      return fetch(new Request(req, { cache: "no-store" }));
    }

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
}

async function handleStaticAssetRequest(event, req) {
  try {
    const cache = await caches.open(STATIC_CACHE_NAME);
    const cached = await cache.match(req.url);
    if (cached) {
      // Cache-first; opportunistically refresh in the background.
      event.waitUntil(refreshStaticAsset(req, cache));
      return cached;
    }
    const response = await fetch(req);
    if (response && response.ok) {
      try { await cache.put(req.url, response.clone()); } catch (e) { /* ignore */ }
    }
    return response;
  } catch (e) {
    return fetch(req);
  }
}

async function refreshStaticAsset(req, cache) {
  try {
    const fresh = await fetch(new Request(req.url, { cache: "no-store" }));
    if (fresh && fresh.ok) {
      try { await cache.put(req.url, fresh.clone()); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    // Network error during background refresh — keep the cached copy.
  }
}

self.addEventListener("message", function (event) {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "invalidate-shell-cache") {
    event.waitUntil((async function () {
      try { await caches.delete(SHELL_CACHE_NAME); } catch (e) { /* ignore */ }
    })());
  }
  if (data.type === "invalidate-static-cache") {
    event.waitUntil((async function () {
      try { await caches.delete(STATIC_CACHE_NAME); } catch (e) { /* ignore */ }
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

function shouldHandleNavigationRequest(rawUrl, method, signals) {
  if (method !== "GET") return false;
  signals = signals || {};
  if (signals.rscHeader) return false;
  if (signals.prefetchHeader) return false;
  if (signals.mode != null && signals.mode !== "navigate") return false;
  if (signals.destination != null && signals.destination !== "document") return false;
  if (signals.acceptHeader != null && signals.acceptHeader.indexOf("text/html") === -1) return false;
  let url;
  try { url = new URL(rawUrl); } catch (e) { return false; }
  if (url.searchParams.has("_rsc")) return false;
  return url.pathname === "/" || url.pathname === "";
}

function shouldHandleStaticAssetRequest(rawUrl, method) {
  if (method !== "GET") return false;
  let url;
  try { url = new URL(rawUrl); } catch (e) { return false; }
  for (let i = 0; i < STATIC_CACHE_PATH_PREFIXES.length; i += 1) {
    if (url.pathname.indexOf(STATIC_CACHE_PATH_PREFIXES[i]) === 0) return true;
  }
  return false;
}

function shouldPersistResponseForRequest(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch (e) { return false; }
  if (url.searchParams.has("editor")) return false;
  return true;
}

function shouldBypassShellCacheForRequest(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch (e) { return false; }
  return url.searchParams.has("editor");
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
