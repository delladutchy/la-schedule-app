"use client";

import { useEffect } from "react";

/**
 * Adds `body.hydrated` once React has mounted on the client. Used by the
 * inline #app-shell skeleton in app/layout.tsx to fade itself out as soon
 * as the real UI is interactive. No data dependency, no spinner, no work.
 */
export function HydrationFlag(): null {
  useEffect(() => {
    document.body.classList.add("hydrated");
  }, []);
  return null;
}
