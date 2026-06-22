"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentRecord } from "@/lib/invoice-attachments";

interface Props {
  eventId: string;
  editorToken: string | null;
  /** When false the component renders nothing visible but still fetches so the parent can show a count. */
  expanded: boolean;
  /** Called with the current attachment count after each load or mutation. */
  onCountChange?: (count: number) => void;
}

function authHeaders(token: string | null): HeadersInit {
  if (token) return { Authorization: `Bearer ${token}` };
  return {};
}

function fileIcon(mimeType: string): string {
  if (mimeType === "application/pdf") return "📄";
  if (mimeType.startsWith("image/")) return "🖼";
  return "📎";
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function userFacingUploadError(detail: string | undefined, raw: string | undefined, status: number): string {
  const msg = detail ?? raw ?? "";
  // Pass through file-size and file-type rejections verbatim — these are user-actionable.
  if (/too large|file type|not allowed/i.test(msg)) return msg;
  return `Upload failed (${status}).`;
}

type UploadStatus = "idle" | "uploading" | "error";

export function InvoiceAttachments({ eventId, editorToken, expanded, onCountChange }: Props) {
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/invoice/attachments/${eventId}`, {
        headers: authHeaders(editorToken),
        credentials: "same-origin",
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({})) as { attachments?: AttachmentRecord[]; error?: string };
      if (!res.ok) {
        setFetchError("Receipts are temporarily unavailable.");
      } else {
        setAttachments(j.attachments ?? []);
      }
    } catch {
      setFetchError("Unable to load receipts. Check your connection.");
    } finally {
      setLoading(false);
    }
  }, [eventId, editorToken]);

  useEffect(() => { void load(); }, [load]);

  // Keep parent count in sync whenever the list changes.
  useEffect(() => {
    onCountChange?.(attachments.length);
  }, [attachments.length, onCountChange]);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    setUploadStatus("uploading");
    setUploadError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`/api/invoice/attachments/${eventId}`, {
        method: "POST",
        headers: authHeaders(editorToken),
        credentials: "same-origin",
        body: formData,
      });
      const j = await res.json().catch(() => ({})) as {
        attachment?: AttachmentRecord;
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        setUploadStatus("error");
        setUploadError(userFacingUploadError(j.detail, j.error, res.status));
        return;
      }
      setUploadStatus("idle");
      if (j.attachment) setAttachments((prev) => [...prev, j.attachment!]);
    } catch {
      setUploadStatus("error");
      setUploadError("Network error during upload.");
    }
  }

  async function handleToggleEmail(att: AttachmentRecord) {
    setUpdatingId(att.id);
    try {
      const res = await fetch(`/api/invoice/attachments/${att.id}/update`, {
        method: "PATCH",
        headers: { ...authHeaders(editorToken), "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ include_in_email: !att.include_in_email }),
      });
      if (res.ok) {
        setAttachments((prev) =>
          prev.map((a) => a.id === att.id ? { ...a, include_in_email: !att.include_in_email } : a),
        );
      }
    } catch { /* ignore */ }
    setUpdatingId(null);
  }

  async function handleRemove(att: AttachmentRecord) {
    if (!confirm(`Remove "${att.original_filename}"? This cannot be undone.`)) return;
    setUpdatingId(att.id);
    try {
      const res = await fetch(`/api/invoice/attachments/${att.id}/update`, {
        method: "DELETE",
        headers: authHeaders(editorToken),
        credentials: "same-origin",
      });
      if (res.ok) {
        setAttachments((prev) => prev.filter((a) => a.id !== att.id));
      }
    } catch { /* ignore */ }
    setUpdatingId(null);
  }

  async function handleView(att: AttachmentRecord) {
    try {
      const res = await fetch(`/api/invoice/attachments/${att.id}/update`, {
        headers: authHeaders(editorToken),
        credentials: "same-origin",
      });
      const j = await res.json().catch(() => ({})) as { signedUrl?: string };
      if (j.signedUrl) window.open(j.signedUrl, "_blank", "noopener");
    } catch { /* ignore */ }
  }

  // When collapsed, render nothing — effects still run to keep count current.
  if (!expanded) return null;

  const emailCount = attachments.filter((a) => a.include_in_email).length;

  return (
    <div className="invoice-collapsible-content invoice-attachments">
      {loading ? (
        <p className="invoice-attachments-loading">Loading…</p>
      ) : fetchError ? (
        <p className="invoice-error" role="alert">⚠ {fetchError}</p>
      ) : null}

      {!loading && !fetchError && attachments.length === 0 ? (
        <p className="invoice-attachments-empty">No receipts yet.</p>
      ) : null}

      {attachments.length > 0 ? (
        <ul className="invoice-attachments-list">
          {attachments.map((att) => (
            <li
              key={att.id}
              className={`invoice-attachment-row${updatingId === att.id ? " invoice-attachment-row--updating" : ""}`}
            >
              <span className="invoice-attachment-icon">{fileIcon(att.mime_type)}</span>
              <div className="invoice-attachment-info">
                <button
                  type="button"
                  className="invoice-attachment-name"
                  onClick={() => { void handleView(att); }}
                  title="View attachment"
                >
                  {att.original_filename}
                </button>
                <span className="invoice-attachment-meta">{fmtBytes(att.size_bytes)}</span>
              </div>
              <label className="invoice-attachment-email-toggle" title="Include with invoice email">
                <input
                  type="checkbox"
                  checked={att.include_in_email}
                  onChange={() => { void handleToggleEmail(att); }}
                  disabled={updatingId === att.id}
                />
                <span>Email</span>
              </label>
              <button
                type="button"
                className="invoice-attachment-remove"
                onClick={() => { void handleRemove(att); }}
                disabled={updatingId === att.id}
                aria-label={`Remove ${att.original_filename}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {emailCount > 0 ? (
        <p className="invoice-attachments-email-note">
          {emailCount} {emailCount === 1 ? "receipt" : "receipts"} will be included with email.
        </p>
      ) : null}

      <div className="invoice-attachments-upload">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf"
          style={{ display: "none" }}
          onChange={(e) => { void handleFileSelect(e); }}
        />
        <button
          type="button"
          className="invoice-attachment-upload-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadStatus === "uploading"}
        >
          {uploadStatus === "uploading" ? "Uploading…" : "Attach Receipt / Image"}
        </button>
        {uploadStatus === "error" && uploadError ? (
          <p className="invoice-error" role="alert">{uploadError}</p>
        ) : null}
      </div>
    </div>
  );
}
