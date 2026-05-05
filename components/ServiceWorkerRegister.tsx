"use client";

import { useEffect } from "react";

/**
 * Mounts after first paint and registers /sw.js when:
 *   1. The runtime has `navigator.serviceWorker`.
 *   2. The page is being viewed as a Home Screen / standalone PWA.
 *
 * The standalone gate keeps tab visitors on the unchanged SSR path
 * during initial rollout. To broaden later, flip `STANDALONE_ONLY`.
 *
 * If the registration call throws or the runtime lacks a SW, this
 * component does nothing — the existing SSR flow is unaffected.
 */
const STANDALONE_ONLY = true;

export function ServiceWorkerRegister(): null {
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (STANDALONE_ONLY && !isStandaloneDisplay()) return;

    let cancelled = false;
    let idleHandle: number | null = null;

    const register = (): void => {
      if (cancelled) return;
      navigator.serviceWorker
        .register("/sw.js")
        .catch((err) => {
          // Registration failure is non-fatal: SSR still serves the page.
          // eslint-disable-next-line no-console
          console.warn("[sw-register] failed:", err);
        });
    };

    const idleWindow = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (typeof idleWindow.requestIdleCallback === "function") {
      idleHandle = idleWindow.requestIdleCallback(register, { timeout: 3000 });
    } else {
      idleHandle = window.setTimeout(register, 1500);
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

function isStandaloneDisplay(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) {
      return true;
    }
    const nav = window.navigator as Navigator & { standalone?: boolean };
    return nav.standalone === true;
  } catch {
    return false;
  }
}
