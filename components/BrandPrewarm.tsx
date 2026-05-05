"use client";

import { useEffect } from "react";

/**
 * After hydration and during browser idle time, fire a low-priority GET
 * for the brand logos so they're already in the browser HTTP cache and
 * the Service Worker static cache when a detail/booking modal opens.
 *
 * Uses `new Image()` (not <link rel="preload">) so:
 *   - The request flows through the SW fetch handler exactly like a
 *     real <img> request, populating la-static:v1.
 *   - The request is request-priority "low" by default for off-screen
 *     images, so it never competes with the initial render.
 *   - No DOM changes, no layout impact, no above-the-fold cost.
 */
const BRAND_ASSETS = [
  "/brand/la-logo.png",
  "/brand/overture-logo.png",
];

export function BrandPrewarm(): null {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const idleWindow = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    let cancelled = false;
    let idleHandle: number | null = null;

    const warm = (): void => {
      if (cancelled) return;
      for (const href of BRAND_ASSETS) {
        try {
          const img = new Image();
          const tunable = img as HTMLImageElement & {
            fetchPriority?: string;
            decoding?: string;
          };
          tunable.fetchPriority = "low";
          tunable.decoding = "async";
          img.src = href;
        } catch {
          // Best-effort warmup; never throw into the page.
        }
      }
    };

    if (typeof idleWindow.requestIdleCallback === "function") {
      idleHandle = idleWindow.requestIdleCallback(warm, { timeout: 4000 });
    } else {
      idleHandle = window.setTimeout(warm, 1500);
    }

    return () => {
      cancelled = true;
      if (idleHandle === null) return;
      if (typeof idleWindow.cancelIdleCallback === "function") {
        idleWindow.cancelIdleCallback(idleHandle);
      } else {
        window.clearTimeout(idleHandle);
      }
    };
  }, []);

  return null;
}
