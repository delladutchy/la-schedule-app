"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { EDITOR_TOKEN_SESSION_KEY, sanitizeEditorToken } from "@/lib/editor-session";

interface Props {
  initialEditorToken?: string;
}

interface SyncNotice {
  kind: "ok" | "error";
  message: string;
}

export function EditorSyncButton({ initialEditorToken }: Props) {
  const router = useRouter();
  const [editorToken, setEditorToken] = useState<string | null>(null);
  const [isEditorSessionActive, setIsEditorSessionActive] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [notice, setNotice] = useState<SyncNotice | null>(null);

  useEffect(() => {
    const fromProp = sanitizeEditorToken(initialEditorToken);
    const fromUrl = sanitizeEditorToken(
      new URLSearchParams(window.location.search).get("editor"),
    );
    const fromSession = sanitizeEditorToken(
      window.localStorage.getItem(EDITOR_TOKEN_SESSION_KEY),
    );
    const resolved = fromProp ?? fromUrl ?? fromSession;

    if (resolved) {
      window.localStorage.setItem(EDITOR_TOKEN_SESSION_KEY, resolved);
      setEditorToken(resolved);
      setIsEditorSessionActive(true);
    } else {
      setEditorToken(null);
      setIsEditorSessionActive(false);
    }
  }, [initialEditorToken]);

  useEffect(() => {
    let cancelled = false;
    async function probeSession() {
      try {
        const headers: Record<string, string> = {};
        if (editorToken) {
          headers.Authorization = `Bearer ${editorToken}`;
        }
        const response = await fetch("/api/editor/history?limit=1", {
          headers,
          credentials: "same-origin",
        });
        if (cancelled) return;
        if (response.status === 401) {
          if (editorToken) {
            window.localStorage.removeItem(EDITOR_TOKEN_SESSION_KEY);
            setEditorToken(null);
          }
          setIsEditorSessionActive(false);
          return;
        }
        setIsEditorSessionActive(response.ok);
      } catch {
        if (!cancelled) {
          setIsEditorSessionActive(!!editorToken);
        }
      }
    }
    void probeSession();
    return () => {
      cancelled = true;
    };
  }, [editorToken]);

  useEffect(() => {
    if (!notice || notice.kind !== "ok") return undefined;
    const timeoutId = window.setTimeout(() => {
      setNotice((current) => (current?.kind === "ok" ? null : current));
    }, 2500);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  if (!isEditorSessionActive) return null;

  return (
    <div className="editor-sync-control">
      <button
        type="button"
        className="editor-sync-button"
        onClick={async () => {
          if (isPending) return;
          setNotice(null);
          setIsPending(true);
          try {
            const headers: Record<string, string> = {};
            if (editorToken) {
              headers.Authorization = `Bearer ${editorToken}`;
            }
            const response = await fetch("/api/editor/sync", {
              method: "POST",
              headers,
              credentials: "same-origin",
            });

            if (response.status === 401) {
              window.localStorage.removeItem(EDITOR_TOKEN_SESSION_KEY);
              setEditorToken(null);
              setIsEditorSessionActive(false);
              setNotice({ kind: "error", message: "Editor session expired." });
              return;
            }

            if (!response.ok) {
              let message = "Refresh failed.";
              try {
                const payload = await response.json() as { error?: string };
                if (payload.error?.trim()) message = payload.error.trim();
              } catch {
                // Keep generic error message.
              }
              setNotice({ kind: "error", message });
              return;
            }

            setNotice({ kind: "ok", message: "Calendar synced." });
            router.refresh();
          } catch {
            setNotice({ kind: "error", message: "Network error." });
          } finally {
            setIsPending(false);
          }
        }}
        disabled={isPending}
      >
        {isPending ? (
          <>
            Syncing
            <span className="editor-sync-inline-spinner" aria-hidden="true">
              <span className="editor-sync-inline-spinner-dot" />
              <span className="editor-sync-inline-spinner-dot" />
              <span className="editor-sync-inline-spinner-dot" />
            </span>
          </>
        ) : "Sync"}
      </button>
      {notice ? (
        <span
          className={`editor-sync-status editor-sync-status--${notice.kind}`}
          role="status"
          aria-live="polite"
        >
          {notice.message}
        </span>
      ) : null}
    </div>
  );
}
