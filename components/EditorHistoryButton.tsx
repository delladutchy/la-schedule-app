"use client";

import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import { EDITOR_TOKEN_SESSION_KEY, sanitizeEditorToken } from "@/lib/editor-session";

interface Props {
  initialEditorToken?: string;
}

interface AuditEventItem {
  id: string;
  timestampUtc: string;
  editorId: string;
  action: "create" | "edit" | "delete" | "sync";
  status: "success";
  eventId?: string;
  summary?: string;
  jobNumber?: string;
  jobTitle?: string;
  startDate?: string;
  endDate?: string;
  callTime?: string;
}

function formatAuditTime(timestampUtc: string): string {
  const dt = DateTime.fromISO(timestampUtc, { zone: "utc" }).setZone("America/New_York");
  if (!dt.isValid) return timestampUtc;
  return dt.toFormat("LLL d, h:mm a");
}

function formatAuditAction(event: AuditEventItem): string {
  const editorLabel = event.editorId.charAt(0).toUpperCase() + event.editorId.slice(1);
  const actionLabel = event.action === "sync" ? "synced calendar" : `${event.action}d`;
  if (event.action === "sync") {
    return `${editorLabel} ${actionLabel}`;
  }
  const title = event.jobNumber ?? event.jobTitle ?? event.summary ?? "job";
  return `${editorLabel} ${actionLabel} ${title}`;
}

function formatAuditRange(event: AuditEventItem): string | null {
  if (!event.startDate) return null;
  const start = DateTime.fromISO(event.startDate, { zone: "utc" });
  if (!start.isValid) return event.startDate;
  const startLabel = start.toFormat("LLL d");
  if (!event.endDate || event.endDate === event.startDate) {
    return startLabel;
  }
  const end = DateTime.fromISO(event.endDate, { zone: "utc" });
  if (!end.isValid) return startLabel;
  return `${startLabel} – ${end.toFormat("LLL d")}`;
}

export function EditorHistoryButton({ initialEditorToken }: Props) {
  const [editorToken, setEditorToken] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEventItem[]>([]);

  useEffect(() => {
    const fromProp = sanitizeEditorToken(initialEditorToken);
    const fromUrl = sanitizeEditorToken(new URLSearchParams(window.location.search).get("editor"));
    const fromStorage = sanitizeEditorToken(window.localStorage.getItem(EDITOR_TOKEN_SESSION_KEY));
    const resolved = fromProp ?? fromUrl ?? fromStorage;

    if (resolved) {
      window.localStorage.setItem(EDITOR_TOKEN_SESSION_KEY, resolved);
      setEditorToken(resolved);
    } else {
      setEditorToken(null);
    }
  }, [initialEditorToken]);

  async function loadHistory() {
    if (!editorToken) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/editor/history?limit=100", {
        headers: { Authorization: `Bearer ${editorToken}` },
      });
      if (response.status === 401) {
        window.localStorage.removeItem(EDITOR_TOKEN_SESSION_KEY);
        setEditorToken(null);
        setError("Editor session expired. Re-open the editor link.");
        setEvents([]);
        return;
      }
      if (!response.ok) {
        setError("Could not load edit history.");
        return;
      }
      const payload = await response.json() as { events?: AuditEventItem[] };
      setEvents(Array.isArray(payload.events) ? payload.events : []);
    } catch {
      setError("Network error while loading history.");
    } finally {
      setIsLoading(false);
    }
  }

  if (!editorToken) return null;

  return (
    <>
      <button
        type="button"
        className="editor-sync-button"
        onClick={() => {
          setIsOpen(true);
          void loadHistory();
        }}
      >
        Edit History
      </button>
      {isOpen ? (
        <div
          className="board-day-modal-backdrop"
          role="presentation"
          onClick={() => {
            if (isLoading) return;
            setIsOpen(false);
          }}
        >
          <section
            className="board-day-modal editor-history-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="editor-history-title"
            aria-busy={isLoading || undefined}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="board-day-modal-close-icon"
              aria-label="Close edit history"
              onClick={() => setIsOpen(false)}
              disabled={isLoading}
            >
              ×
            </button>
            <h3 id="editor-history-title" className="board-day-modal-title">
              Edit History
            </h3>

            {isLoading ? (
              <p className="editor-history-note">Loading…</p>
            ) : error ? (
              <p className="month-booking-error" role="alert">{error}</p>
            ) : events.length === 0 ? (
              <p className="editor-history-note">No edit history yet.</p>
            ) : (
              <ul className="editor-history-list">
                {events.map((event) => {
                  const rangeLabel = formatAuditRange(event);
                  return (
                    <li key={event.id} className="editor-history-item">
                      <p className="editor-history-action">{formatAuditAction(event)}</p>
                      <p className="editor-history-meta">
                        {rangeLabel ? `${rangeLabel} — ` : ""}{formatAuditTime(event.timestampUtc)}
                        {event.callTime ? ` — Call ${event.callTime}` : ""}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}
