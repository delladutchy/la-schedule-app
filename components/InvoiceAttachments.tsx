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

type MetaFields = {
  receipt_date: string;
  receipt_category: string;
  receipt_amount: string;
};

const EMPTY_META: MetaFields = { receipt_date: "", receipt_category: "", receipt_amount: "" };

export function InvoiceAttachments({ eventId, editorToken, expanded, onCountChange }: Props) {
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [attachmentMeta, setAttachmentMeta] = useState<Record<string, MetaFields>>({});
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

  // Seed local meta state from loaded attachment records (preserves any in-progress edits).
  useEffect(() => {
    setAttachmentMeta((prev) => {
      const next = { ...prev };
      for (const att of attachments) {
        if (!next[att.id]) {
          next[att.id] = {
            receipt_date:     att.receipt_date     ?? "",
            receipt_category: att.receipt_category ?? "",
            receipt_amount:   att.receipt_amount   != null ? String(att.receipt_amount) : "",
          };
        }
      }
      return next;
    });
  }, [attachments]);

  function handleMetaChange(id: string, field: keyof MetaFields, value: string) {
    setAttachmentMeta((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? EMPTY_META), [field]: value },
    }));
  }

  async function handleMetaBlur(att: AttachmentRecord, field: keyof MetaFields) {
    const meta = attachmentMeta[att.id];
    if (!meta) return;

    const patch: Record<string, string | number | null> = {};
    if (field === "receipt_date") {
      patch.receipt_date = meta.receipt_date || null;
    } else if (field === "receipt_category") {
      patch.receipt_category = meta.receipt_category || null;
    } else if (field === "receipt_amount") {
      const num = parseFloat(meta.receipt_amount);
      patch.receipt_amount = isNaN(num) ? null : num;
    }

    try {
      await fetch(`/api/invoice/attachments/${att.id}/update`, {
        method: "PATCH",
        headers: { ...authHeaders(editorToken), "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(patch),
      });
      setAttachments((prev) =>
        prev.map((a) => {
          if (a.id !== att.id) return a;
          if (field === "receipt_date")     return { ...a, receipt_date: meta.receipt_date || null };
          if (field === "receipt_category") return { ...a, receipt_category: meta.receipt_category || null };
          if (field === "receipt_amount") {
            const num = parseFloat(meta.receipt_amount);
            return { ...a, receipt_amount: isNaN(num) ? null : num };
          }
          return a;
        }),
      );
    } catch { /* ignore — data still synced locally */ }
  }

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
          {attachments.map((att) => {
            const meta = attachmentMeta[att.id] ?? EMPTY_META;
            return (
              <li
                key={att.id}
                className={`invoice-attachment-row${updatingId === att.id ? " invoice-attachment-row--updating" : ""}`}
              >
                {/* Main row: icon · filename · email toggle · remove */}
                <div className="invoice-attachment-row-main">
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
                </div>

                {/* Receipt metadata row — used for PDF appendix header */}
                <div className="invoice-attachment-receipt-meta">
                  <input
                    type="date"
                    className="invoice-receipt-meta-input"
                    title="Receipt date (shown in PDF appendix)"
                    value={meta.receipt_date}
                    onChange={(e) => handleMetaChange(att.id, "receipt_date", e.target.value)}
                    onBlur={() => { void handleMetaBlur(att, "receipt_date"); }}
                  />
                  <input
                    type="text"
                    className="invoice-receipt-meta-input"
                    placeholder="Category"
                    title="Receipt category (e.g. Parking, Hotel)"
                    value={meta.receipt_category}
                    onChange={(e) => handleMetaChange(att.id, "receipt_category", e.target.value)}
                    onBlur={() => { void handleMetaBlur(att, "receipt_category"); }}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    className="invoice-receipt-meta-input invoice-receipt-meta-input--amount"
                    placeholder="Amount"
                    title="Receipt amount"
                    value={meta.receipt_amount}
                    onChange={(e) => handleMetaChange(att.id, "receipt_amount", e.target.value)}
                    onBlur={() => { void handleMetaBlur(att, "receipt_amount"); }}
                  />
                </div>
              </li>
            );
          })}
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
