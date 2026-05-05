/**
 * Service Worker — kill switch.
 *
 * To roll back the live SW, replace public/sw.js's contents with this
 * file's contents and deploy. Within one navigation, every installed SW
 * will:
 *   1. Skip waiting (so this script activates without a tab close).
 *   2. Delete every cache opened by this origin.
 *   3. Unregister itself.
 *   4. Reload its open clients so they go back to the network path.
 *
 * The `fetch` handler is a pass-through during the brief window between
 * activation and unregister completion, so users keep working normally.
 */

self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    try {
      const names = await caches.keys();
      await Promise.all(names.map(function (n) { return caches.delete(n); }));
    } catch (e) {
      // ignore
    }
    try {
      await self.registration.unregister();
    } catch (e) {
      // ignore
    }
    try {
      const clients = await self.clients.matchAll({ type: "window" });
      for (let i = 0; i < clients.length; i += 1) {
        try { clients[i].navigate(clients[i].url); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      // ignore
    }
  })());
});

self.addEventListener("fetch", function (event) {
  // Pass-through. Do not intercept; let the browser handle the network.
  // We deliberately do not call event.respondWith.
});
