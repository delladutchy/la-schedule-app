"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { EDITOR_TOKEN_SESSION_KEY, sanitizeEditorToken } from "@/lib/editor-session";

/**
 * Captures `?editor=<token>` once, stores it in localStorage, then strips it
 * from the URL so normal navigation stays clean/read-only by default.
 */
export function EditorTokenBridge() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const tokenFromUrl = sanitizeEditorToken(searchParams.get("editor"));
    const tokenFromStorage = sanitizeEditorToken(
      window.localStorage.getItem(EDITOR_TOKEN_SESSION_KEY),
    );
    const token = tokenFromUrl ?? tokenFromStorage;
    if (!token) return;

    window.localStorage.setItem(EDITOR_TOKEN_SESSION_KEY, token);
    void (async () => {
      let bootstrapOk = false;
      try {
        const response = await fetch("/api/editor/session", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          credentials: "same-origin",
        });
        bootstrapOk = response.ok;
      } catch {
        // Keep localStorage token fallback when session bootstrap is unavailable.
      } finally {
        // Only clean editor query after session bootstrap succeeds, so we
        // don't lose server-side editor identity during in-app navigation.
        if (!tokenFromUrl || !bootstrapOk) return;
        const url = new URL(window.location.href);
        if (!url.searchParams.has("editor")) return;
        url.searchParams.delete("editor");
        const next = `${url.pathname}${url.search}${url.hash}`;
        window.history.replaceState(window.history.state, "", next);
      }
    })();
  }, [searchParams]);

  return null;
}
