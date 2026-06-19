"use client";

import { useEffect, useRef, useState } from "react";
import { Truck } from "lucide-react";
import type { InvoiceData, InvoicePacket, MileageMode, WorkdayEntry } from "@/lib/invoice-types";
import { INVOICE_STATUS_LABELS, TERMINAL_STATUSES } from "@/lib/invoice-types";
import {
  RECIPIENT_PRESETS,
  findPreset,
  isPresetConfigured,
  type RecipientPreset,
} from "@/lib/invoice-recipients";
import {
  calculateWorkdayMileage,
  getDefaultDeductionForMode,
  initWorkdayEntries,
  round2,
} from "@/lib/invoice-calculations";
import { isNumericInvoiceNumber } from "@/lib/invoice-number";

// ---------------------------------------------------------------------------
// Time dropdown helpers
// ---------------------------------------------------------------------------

const TIME_OPTIONS: string[] = (() => {
  const opts: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const meridiem = h < 12 ? "AM" : "PM";
      const minStr = m === 0 ? "00" : "30";
      opts.push(`${hour12}:${minStr} ${meridiem}`);
    }
  }
  return opts;
})();

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function fmtCurrency(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtHours(n: number): string {
  return n % 1 === 0 ? `${n}` : n.toFixed(2);
}

function buildPdfFilename(invoiceNumber: string | null, laNumber: string | null): string {
  const parts: string[] = ["Invoice", invoiceNumber ?? "invoice"];
  if (laNumber) parts.push(`LA${laNumber.replace(/[^a-zA-Z0-9-]/g, "")}`);
  return `${parts.join("-")}.pdf`;
}

function fmtDate(isoDate: string): string {
  const parts = isoDate.split("-").map(Number);
  const y = parts[0] ?? 1970;
  const mo = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  return new Date(y, mo - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// Snap a UTC ISO string to the nearest 30-min TIME_OPTIONS value.
export function snapUtcToTimeOption(utcIso: string): string {
  const d = new Date(utcIso);
  const totalMins = d.getHours() * 60 + d.getMinutes();
  const snapped = Math.round(totalMins / 30) * 30;
  const hSnapped = Math.floor(snapped / 60) % 24;
  const mSnapped = snapped % 60;
  const period = hSnapped >= 12 ? "PM" : "AM";
  const h12 = hSnapped % 12 || 12;
  return `${h12}:${String(mSnapped).padStart(2, "0")} ${period}`;
}

// ---------------------------------------------------------------------------
// Mileage mode labels
// ---------------------------------------------------------------------------

const MODE_LABELS: Record<MileageMode, string> = {
  none:             "None",
  from_dewey:       "From Dewey",
  to_dewey:         "To Dewey",
  round_trip_dewey: "Round Trip",
  custom:           "Custom",
};

const ACTIVE_MODES: MileageMode[] = ["from_dewey", "to_dewey", "round_trip_dewey", "custom"];

// ---------------------------------------------------------------------------
// Types for local state
// ---------------------------------------------------------------------------

interface FetchState {
  status: "loading" | "ready" | "error" | "unavailable";
}

interface SyncState {
  status: "idle" | "syncing" | "success" | "error";
  message: string | null;
  syncedAt: string | null;
}

interface PdfState {
  status: "idle" | "generating" | "done" | "error";
  error: string | null;
}

interface RenumberState {
  status: "idle" | "renumbering" | "error";
  error: string | null;
}

interface InvoicePdfMetadataResponse {
  ok?: boolean;
  invoiceNumber?: string | null;
  invoice_number?: string | null;
  pdfUrl?: string | null;
  invoice_pdf_url?: string | null;
  storagePath?: string | null;
  invoice_pdf_path?: string | null;
  invoiceUpdatedAt?: string | null;
  invoice_updated_at?: string | null;
  timestamp?: string | null;
  invoiceCreatedAt?: string | null;
  invoice_created_at?: string | null;
  createdAt?: string | null;
  invoiceTotal?: number | null;
  invoice_total?: number | null;
  template?: string | null;
  error?: string;
  detail?: string;
}

interface NormalizedInvoicePdfMetadata {
  invoiceNumber: string | null;
  invoicePdfUrl: string | null;
  storagePath: string | null;
  invoiceUpdatedAt: string | null;
  invoiceCreatedAt: string | null;
  invoiceTotal: number | null;
  template: string | null;
}

// "custom" means the user typed their own address; a preset id means they
// selected one of the RECIPIENT_PRESETS.
type EmailPresetId = "custom" | string;

interface EmailDialogState {
  open: boolean;
  presetId: EmailPresetId;
  customTo: string;
  status: "idle" | "sending" | "success" | "error";
  error: string | null;
}

const EMAIL_DIALOG_RESET: EmailDialogState = {
  open: false, presetId: "", customTo: "", status: "idle", error: null,
};

interface ExpenseFields {
  bag_fees: string;
  hotel: string;
  parking: string;
  tolls: string;
  uber: string;
  other_expenses: string;
  expense_notes: string;
}

interface AutoMileage {
  oneWayMiles: number;
  roundTripMiles: number;
}

// Reason why auto-mileage is unavailable (shown inside the per-day mileage editor).
type AutoMileageNote =
  | "no_location"       // jobLocation prop missing
  | "api_error"         // fetch failed
  | "implausible";      // returned miles > MAX_PLAUSIBLE_ONE_WAY_MILES

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  eventId: string;
  workDates: string[];
  gigSummary: string;
  editorToken: string | null;
  defaultStartTime?: string; // snapped 12h time from job startUtc
  defaultEndTime?: string;   // snapped 12h time from job endUtc
  jobLocation?: string;      // Google Calendar location field
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function buildAuthHeaders(token: string | null): Record<string, string> {
  const base: Record<string, string> = { "Content-Type": "application/json" };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

function logInvoicePdfDiagnostic(message: string, details: Record<string, unknown>): void {
  if (process.env.NODE_ENV !== "production") {
    console.log(`[invoice/ui] ${message}`, details);
  }
}

function normalizeInvoicePdfMetadata(json: InvoicePdfMetadataResponse): NormalizedInvoicePdfMetadata {
  return {
    invoiceNumber: json.invoice_number ?? json.invoiceNumber ?? null,
    invoicePdfUrl: json.invoice_pdf_url ?? json.pdfUrl ?? null,
    storagePath: json.invoice_pdf_path ?? json.storagePath ?? null,
    invoiceUpdatedAt: json.invoice_updated_at ?? json.invoiceUpdatedAt ?? json.timestamp ?? json.createdAt ?? null,
    invoiceCreatedAt: json.invoice_created_at ?? json.invoiceCreatedAt ?? json.createdAt ?? null,
    invoiceTotal: typeof json.invoice_total === "number"
      ? json.invoice_total
      : typeof json.invoiceTotal === "number"
        ? json.invoiceTotal
        : null,
    template: json.template ?? null,
  };
}

function preferGeneratedPdfMetadata(
  generated: NormalizedInvoicePdfMetadata,
  refreshed: NormalizedInvoicePdfMetadata,
): NormalizedInvoicePdfMetadata {
  return {
    invoiceNumber: generated.invoiceNumber ?? refreshed.invoiceNumber,
    invoicePdfUrl: generated.invoicePdfUrl ?? refreshed.invoicePdfUrl,
    storagePath: generated.storagePath ?? refreshed.storagePath,
    invoiceUpdatedAt: generated.invoiceUpdatedAt ?? refreshed.invoiceUpdatedAt,
    invoiceCreatedAt: generated.invoiceCreatedAt ?? refreshed.invoiceCreatedAt,
    invoiceTotal: generated.invoiceTotal ?? refreshed.invoiceTotal,
    template: generated.template ?? refreshed.template,
  };
}

function mergeInvoicePdfMetadata(
  data: InvoiceData | null,
  metadata: NormalizedInvoicePdfMetadata,
): InvoiceData | null {
  if (!data) return data;
  return {
    ...data,
    invoice_number: metadata.invoiceNumber ?? data.invoice_number,
    invoice_pdf_url: metadata.invoicePdfUrl ?? data.invoice_pdf_url,
    invoice_created_at: metadata.invoiceCreatedAt ?? data.invoice_created_at,
    invoice_total: metadata.invoiceTotal ?? data.invoice_total,
    updated_at: metadata.invoiceUpdatedAt ?? data.updated_at,
  };
}

function buildPdfActionUrl(pdfUrl: string | null, version: string | null): string {
  if (!pdfUrl) return "#";
  const separator = pdfUrl.includes("?") ? "&" : "?";
  return `${pdfUrl}${separator}v=${encodeURIComponent(version ?? String(Date.now()))}`;
}

// ---------------------------------------------------------------------------
// WorkdayRow sub-component
// ---------------------------------------------------------------------------

interface WorkdayRowProps {
  entry: WorkdayEntry;
  workdays: InvoicePacket["workdays"];
  index: number;
  onChange: (index: number, patch: Partial<WorkdayEntry>) => void;
  autoMileage: AutoMileage | null;
  autoMileageNote: AutoMileageNote | null;
  mileageRate: number;
}

function WorkdayRow({ entry, workdays, index, onChange, autoMileage, autoMileageNote, mileageRate }: WorkdayRowProps) {
  const calc = workdays[index];
  const totalH = calc ? fmtHours(calc.totalHours) : "—";
  const otH = calc && calc.overtimeHours > 0 ? fmtHours(calc.overtimeHours) : "0";

  const mode: MileageMode = entry.mileageMode ?? "none";
  const milesDriven = entry.milesDriven ?? 0;
  const effectiveDeduction = entry.mileageDeduction ?? getDefaultDeductionForMode(mode);
  const mileCalc = calculateWorkdayMileage(entry);

  // Open by default when mode is already set (e.g. loaded from DB).
  const [mileageOpen, setMileageOpen] = useState(mode !== "none");

  // Sync open state when mode changes externally (e.g. after save round-trip).
  const prevMode = useRef(mode);
  if (prevMode.current !== mode) {
    prevMode.current = mode;
    // Don't close if user just removed mileage — handled by setMode("none")
  }

  function setMode(newMode: MileageMode) {
    if (newMode === "none") {
      onChange(index, { mileageMode: "none", milesDriven: null, mileageDeduction: null });
      setMileageOpen(false);
      return;
    }
    // Auto-fill miles from cached API result based on mode
    let autoMiles: number | null = null;
    if (autoMileage) {
      if (newMode === "from_dewey" || newMode === "to_dewey") {
        autoMiles = autoMileage.oneWayMiles;
      } else if (newMode === "round_trip_dewey") {
        autoMiles = autoMileage.roundTripMiles;
      }
      // custom: leave blank for manual entry
    }
    onChange(index, {
      mileageMode: newMode,
      milesDriven: autoMiles ?? (entry.milesDriven ?? null),
      mileageDeduction: null, // reset to mode default when switching modes
    });
  }

  // Truck is green when mileage mode is set and miles are entered.
  const mileageComplete = mode !== "none" && milesDriven > 0;
  const mileageValid = mileageComplete && effectiveDeduction >= 0;

  return (
    <div className="invoice-workday-row">
      <p className="invoice-workday-date">{fmtDate(entry.date)}</p>
      <div className="invoice-workday-times">
        <div className="invoice-workday-field">
          <label className="invoice-label-sm" htmlFor={`inv-start-${index}`}>Start</label>
          <select
            id={`inv-start-${index}`}
            className="invoice-select"
            value={entry.startTime}
            onChange={(e) => onChange(index, { startTime: e.target.value })}
          >
            <option value="">—</option>
            {TIME_OPTIONS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="invoice-workday-field">
          <label className="invoice-label-sm" htmlFor={`inv-end-${index}`}>End</label>
          <select
            id={`inv-end-${index}`}
            className="invoice-select"
            value={entry.endTime}
            onChange={(e) => onChange(index, { endTime: e.target.value })}
          >
            <option value="">—</option>
            {TIME_OPTIONS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="invoice-workday-field invoice-workday-field--calc">
          <span className="invoice-label-sm">Total</span>
          <span className="invoice-calc-val">{totalH} h</span>
        </div>
        <div className="invoice-workday-field invoice-workday-field--calc">
          <span className="invoice-label-sm">OT</span>
          <span className={`invoice-calc-val${calc && calc.overtimeHours > 0 ? " invoice-calc-val--ot" : ""}`}>
            {otH} h
          </span>
        </div>
        {/* Truck icon — tap to open/close mileage editor */}
        <button
          type="button"
          className={`invoice-mileage-truck${mileageComplete ? " invoice-mileage-truck--complete" : ""}`}
          aria-label={mileageComplete ? "Edit mileage" : "Add mileage"}
          onClick={() => setMileageOpen((prev) => !prev)}
        >
          <Truck size={17} strokeWidth={1.75} />
        </button>
      </div>

      {/* ── Mileage editor (expanded when mileageOpen) ─────────── */}
      {mileageOpen ? (
        <div className="invoice-mileage-editor">
          {/* Top row: mode buttons (left) + remove/confirm controls (right) */}
          <div className="invoice-mileage-top-row">
            <div className="invoice-mileage-modes">
              {ACTIVE_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`invoice-mileage-mode-btn${mode === m ? " invoice-mileage-mode-btn--active" : ""}`}
                  onClick={() => setMode(m)}
                >
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
            <div className="invoice-mileage-controls">
              <button
                type="button"
                className="invoice-mileage-remove-btn"
                onClick={() => setMode("none")}
                aria-label="Remove mileage"
              >
                ✕
              </button>
              <button
                type="button"
                className={`invoice-mileage-confirm-btn${mileageValid ? " invoice-mileage-confirm-btn--valid" : ""}`}
                aria-label="Confirm mileage entry"
                onClick={() => {
                  if (mileageValid) {
                    (document.activeElement as HTMLElement | null)?.blur();
                    setMileageOpen(false);
                  }
                }}
              >
                ✓
              </button>
            </div>
          </div>

          {/* Auto-mileage hint — shown when miles can't be auto-filled */}
          {autoMileageNote && mode !== "none" ? (
            <p className="invoice-mileage-manual-note">
              {autoMileageNote === "no_location"
                ? "No job location — enter miles manually."
                : autoMileageNote === "implausible"
                  ? "Location may be ambiguous — enter miles manually."
                  : "Could not auto-calculate — enter miles manually."}
            </p>
          ) : null}

          {mode !== "none" ? (
            <div className="invoice-mileage-fields">
              <div className="invoice-mileage-field-row">
                <label className="invoice-label-sm" htmlFor={`inv-miles-${index}`}>Miles</label>
                <input
                  id={`inv-miles-${index}`}
                  type="number"
                  min="0"
                  step="1"
                  className="invoice-input-sm invoice-input-miles"
                  value={milesDriven || ""}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    onChange(index, { milesDriven: isNaN(val) ? null : val });
                  }}
                  placeholder="enter miles"
                />
              </div>
              <div className="invoice-mileage-field-row">
                <label className="invoice-label-sm" htmlFor={`inv-deduction-${index}`}>
                  Deduction
                </label>
                <input
                  id={`inv-deduction-${index}`}
                  type="number"
                  min="0"
                  step="1"
                  className="invoice-input-sm invoice-input-miles"
                  value={effectiveDeduction}
                  readOnly={mode !== "custom"}
                  onChange={(e) => {
                    if (mode !== "custom") return;
                    const val = parseFloat(e.target.value);
                    onChange(index, { mileageDeduction: isNaN(val) ? null : val });
                  }}
                />
              </div>
              {mileCalc && mileCalc.milesDriven > 0 ? (
                <div className="invoice-mileage-day-preview">
                  <span>Billable: {mileCalc.billableMiles} mi</span>
                  <span>Net: {fmtCurrency(round2(mileCalc.billableMiles * mileageRate))}</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Email preview helpers — mirrors server-side logic in email route
// ---------------------------------------------------------------------------

function emailCleanLa(laNumber: string | null): string {
  return (laNumber ?? "").replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "");
}

function emailStripLaPrefix(gigSummary: string, laNumber: string | null): string {
  let title = gigSummary.trim();
  const cleanLa = emailCleanLa(laNumber);
  if (cleanLa) {
    title = title
      .replace(new RegExp(`^\\s*LA\\s*#?\\s*${cleanLa.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:[-–—:|]+\\s*)?`, "i"), "")
      .trim();
  }
  return title.replace(/^[\s\-–—:|]+/, "").trim();
}

function emailWorkDateRange(workdays: InvoicePacket["workdays"]): string {
  if (workdays.length === 0) return "";
  const dates = workdays.map((w) => w.date).sort();
  const fmtShort = (iso: string) => {
    const parts = iso.split("-").map(Number);
    return `${parts[1]}/${parts[2]}`;
  };
  if (dates.length === 1) return fmtShort(dates[0]!);
  return `${fmtShort(dates[0]!)} - ${fmtShort(dates[dates.length - 1]!)}`;
}

function buildPreviewSubject(laNumber: string | null, jobTitle: string): string {
  const cleanLa = emailCleanLa(laNumber);
  if (cleanLa) return `Jeff Ulsh - Invoice LA #${cleanLa}`;
  return `Jeff Ulsh - Invoice${jobTitle ? ` ${jobTitle}` : ""}`;
}

function buildPreviewBody(laNumber: string | null, jobTitle: string, workDateStr: string): string {
  const cleanLa = emailCleanLa(laNumber);
  let line = "Invoice for";
  if (cleanLa) line += ` LA#${cleanLa}`;
  if (jobTitle) line += ` ${jobTitle}`;
  if (workDateStr) line += ` - ${workDateStr}`;
  return [line + ".", "", "Thank you guys,", "", "Jeff Ulsh"].join("\n");
}

function buildPreviewFilename(laNumber: string | null, jobTitle: string, invoiceNumber: string | null): string {
  const cleanLa = emailCleanLa(laNumber);
  const nameSlug = jobTitle
    ? "-" + jobTitle.replace(/[^a-zA-Z0-9]/g, " ").trim().replace(/\s+/g, "-").slice(0, 30).replace(/-+$/, "")
    : "";
  if (cleanLa) return `Invoice-LA${cleanLa}${nameSlug}.pdf`;
  const numSlug = (invoiceNumber ?? "invoice").replace(/[^a-zA-Z0-9]/g, "");
  return `Invoice-${numSlug}${nameSlug}.pdf`;
}

// ---------------------------------------------------------------------------
// EmailDialog sub-component
// ---------------------------------------------------------------------------

interface EmailDialogProps {
  dialog: EmailDialogState;
  onChange: React.Dispatch<React.SetStateAction<EmailDialogState>>;
  onSend: () => void;
  onClose: () => void;
  subject: string;
  body: string;
  filename: string;
}

function EmailDialog({ dialog, onChange, onSend, onClose, subject, body, filename }: EmailDialogProps) {
  const isBusy = dialog.status === "sending";
  const isDone = dialog.status === "success";

  let previewTo: string[] = [];
  let previewCc: string[] = [];
  let previewUnconfigured = false;

  if (dialog.presetId === "custom") {
    previewTo = dialog.customTo.trim() ? [dialog.customTo.trim()] : [];
  } else if (dialog.presetId) {
    const preset = findPreset(dialog.presetId);
    if (preset) {
      if (isPresetConfigured(preset)) {
        previewTo = preset.to;
        previewCc = preset.cc;
      } else {
        previewUnconfigured = true;
      }
    }
  }

  const canSend = !isBusy && !isDone && !previewUnconfigured && previewTo.length > 0;
  const toDisplay = previewTo.length > 0
    ? previewTo.join(", ") + (previewCc.length > 0 ? ` — CC: ${previewCc.join(", ")}` : "")
    : "—";

  return (
    <div className="invoice-email-dialog" role="dialog" aria-label="Send Invoice">
      <p className="invoice-block-label">Send Invoice</p>

      {!isDone ? (
        <>
          {/* Recipient selector */}
          <div className="invoice-email-field">
            <label className="invoice-label-sm" htmlFor="inv-email-preset">Recipient</label>
            <select
              id="inv-email-preset"
              className="invoice-select invoice-email-select"
              value={dialog.presetId}
              disabled={isBusy}
              onChange={(e) => onChange((prev) => ({ ...prev, presetId: e.target.value, customTo: "", error: null }))}
            >
              <option value="">Choose recipient…</option>
              {RECIPIENT_PRESETS.map((preset) => {
                const configured = isPresetConfigured(preset);
                return (
                  <option key={preset.id} value={preset.id} disabled={!configured}>
                    {preset.label}{!configured ? " (not configured)" : ""}
                  </option>
                );
              })}
              <option value="custom">Custom…</option>
            </select>
          </div>

          {dialog.presetId === "custom" ? (
            <div className="invoice-email-field">
              <label className="invoice-label-sm" htmlFor="inv-email-custom">Email address</label>
              <input
                id="inv-email-custom"
                type="email"
                className="invoice-email-full-input"
                value={dialog.customTo}
                onChange={(e) => onChange((prev) => ({ ...prev, customTo: e.target.value, error: null }))}
                placeholder="client@example.com"
                disabled={isBusy}
                autoFocus
              />
            </div>
          ) : null}

          {previewUnconfigured ? (
            <p className="invoice-status-muted invoice-email-preview">
              This preset is not configured yet. Edit <code>lib/invoice-recipients.ts</code> to add the address.
            </p>
          ) : null}

          {/* Review preview */}
          <div className="invoice-email-review">
            <div className="invoice-email-review-row">
              <span className="invoice-label-sm">To</span>
              <span>{toDisplay}</span>
            </div>
            <div className="invoice-email-review-row">
              <span className="invoice-label-sm">Subject</span>
              <span>{subject}</span>
            </div>
            <div className="invoice-email-review-row invoice-email-review-row--body">
              <span className="invoice-label-sm">Message</span>
              <pre className="invoice-email-review-body">{body}</pre>
            </div>
            <div className="invoice-email-review-row">
              <span className="invoice-label-sm">Attachment</span>
              <span>{filename}</span>
            </div>
          </div>
        </>
      ) : (
        <p className="invoice-sync-success">
          Invoice sent to {previewTo.join(", ")}.
          {previewCc.length > 0 ? ` CC: ${previewCc.join(", ")}` : ""}
        </p>
      )}

      {dialog.error ? (
        <p className="invoice-error" role="alert">{dialog.error}</p>
      ) : null}

      <div className="invoice-email-actions">
        {!isDone ? (
          <button
            type="button"
            className="invoice-pdf-create-btn"
            onClick={onSend}
            disabled={!canSend}
          >
            {isBusy ? "Sending…" : "Send Invoice"}
          </button>
        ) : null}
        <button
          type="button"
          className="invoice-pdf-regen-btn"
          onClick={onClose}
        >
          {isDone ? "Done" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InvoiceSection
// ---------------------------------------------------------------------------

export function InvoiceSection({
  eventId,
  workDates,
  gigSummary,
  editorToken,
  defaultStartTime,
  defaultEndTime,
  jobLocation,
}: Props) {
  const [fetchState, setFetchState] = useState<FetchState>({ status: "loading" });
  const [invoiceData, setInvoiceData] = useState<InvoiceData | null>(null);
  const [packet, setPacket] = useState<InvoicePacket | null>(null);
  const [workdayEntries, setWorkdayEntries] = useState<WorkdayEntry[]>([]);
  const [expenses, setExpenses] = useState<ExpenseFields>({
    bag_fees: "",
    hotel: "",
    parking: "",
    tolls: "",
    uber: "",
    other_expenses: "",
    expense_notes: "",
  });
  const [expensesExpanded, setExpensesExpanded] = useState(false);
  const [autoMileage, setAutoMileage] = useState<AutoMileage | null>(null);
  const [autoMileageNote, setAutoMileageNote] = useState<AutoMileageNote | null>(
    jobLocation ? null : "no_location",
  );
  const [syncState, setSyncState] = useState<SyncState>({ status: "idle", message: null, syncedAt: null });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [pdfState, setPdfState] = useState<PdfState>({ status: "idle", error: null });
  const [renumberState, setRenumberState] = useState<RenumberState>({ status: "idle", error: null });
  const [emailDialog, setEmailDialog] = useState<EmailDialogState>(EMAIL_DIALOG_RESET);
  const [sentDetailsOpen, setSentDetailsOpen] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestKey = `${eventId}::${workDates.join("|")}`;

  // Fetch existing invoice data on mount / key change
  useEffect(() => {
    if (!eventId) return;
    setFetchState({ status: "loading" });
    setSaveError(null);

    const headers: Record<string, string> = {};
    if (editorToken) headers.Authorization = `Bearer ${editorToken}`;
    let cancelled = false;

    fetch(`/api/invoice/${encodeURIComponent(eventId)}`, {
      headers,
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 503) { setFetchState({ status: "unavailable" }); return; }
        if (!res.ok) { setFetchState({ status: "error" }); return; }
        const json = await res.json() as { invoiceData: InvoiceData | null; packet: InvoicePacket | null };
        if (cancelled) return;

        const data = json.invoiceData;
        if (data) {
          setInvoiceData(data);
          setPacket(json.packet);
          setWorkdayEntries(initWorkdayEntries(data.workday_entries, workDates, defaultStartTime, defaultEndTime));
          const exp: ExpenseFields = {
            bag_fees: data.bag_fees != null ? String(data.bag_fees) : "",
            hotel: data.hotel != null ? String(data.hotel) : "",
            parking: data.parking != null ? String(data.parking) : "",
            tolls: data.tolls != null ? String(data.tolls) : "",
            uber: data.uber != null ? String(data.uber) : "",
            other_expenses: data.other_expenses != null ? String(data.other_expenses) : "",
            expense_notes: data.expense_notes ?? "",
          };
          setExpenses(exp);
          setExpensesExpanded(
            data.bag_fees != null || data.hotel != null || data.parking != null ||
            data.tolls != null || data.uber != null || data.other_expenses != null ||
            (data.expense_notes != null && data.expense_notes.trim() !== ""),
          );
          if (data.sheet_synced_at) {
            setSyncState({ status: "success", message: null, syncedAt: data.sheet_synced_at });
          } else if (data.sheet_sync_error) {
            setSyncState({ status: "error", message: "Sheet sync failed — retry", syncedAt: null });
          }
        } else {
          setWorkdayEntries(initWorkdayEntries([], workDates, defaultStartTime, defaultEndTime));
          setInvoiceData(null);
          setPacket(null);
        }
        setFetchState({ status: "ready" });
      })
      .catch(() => {
        if (!cancelled) setFetchState({ status: "error" });
      });

    return () => { cancelled = true; };
  }, [requestKey]);

  // Fetch mileage distance once when jobLocation is known.
  // Origin is always Dewey Beach, DE 19971 — no GPS, no dynamic location.
  useEffect(() => {
    if (!jobLocation) {
      setAutoMileage(null);
      setAutoMileageNote("no_location");
      return;
    }
    setAutoMileageNote(null); // reset while loading
    const headers: Record<string, string> = {};
    if (editorToken) headers.Authorization = `Bearer ${editorToken}`;
    fetch(`/api/invoice/mileage?location=${encodeURIComponent(jobLocation)}`, {
      headers,
      credentials: "same-origin",
    })
      .then(async (res) => {
        if (!res.ok) { setAutoMileageNote("api_error"); return; }
        const json = await res.json() as {
          oneWayMiles?: number;
          roundTripMiles?: number;
          plausible?: boolean;
        };
        if (typeof json.oneWayMiles === "number" && typeof json.roundTripMiles === "number") {
          if (json.plausible === false) {
            // Distance is implausibly large — the location string is likely ambiguous
            // (e.g. "Fenwick Island" resolved to SC instead of DE). Don't auto-fill.
            setAutoMileage(null);
            setAutoMileageNote("implausible");
          } else {
            setAutoMileage({ oneWayMiles: json.oneWayMiles, roundTripMiles: json.roundTripMiles });
            setAutoMileageNote(null);
          }
        } else {
          setAutoMileageNote("api_error");
        }
      })
      .catch(() => { setAutoMileageNote("api_error"); });
  }, [jobLocation, editorToken]);

  // ---------------------------------------------------------------------------
  // Save helpers
  // ---------------------------------------------------------------------------

  async function save(patch: Record<string, unknown>): Promise<void> {
    setSaveError(null);
    setIsSaving(true);
    try {
      const res = await fetch(`/api/invoice/${encodeURIComponent(eventId)}`, {
        method: "PATCH",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        body: JSON.stringify(patch),
      });
      if (!res.ok) { setSaveError("Could not save. Try again."); return; }
      const json = await res.json() as { invoiceData: InvoiceData; packet: InvoicePacket };
      setInvoiceData(json.invoiceData);
      setPacket(json.packet);
    } catch {
      setSaveError("Network error. Try again.");
    } finally {
      setIsSaving(false);
    }
  }

  function parseExpenseInput(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const num = parseFloat(trimmed);
    return isNaN(num) ? null : num;
  }

  function buildCurrentInvoiceInputPatch(): Record<string, unknown> {
    return {
      workday_entries: workdayEntries,
      bag_fees: parseExpenseInput(expenses.bag_fees),
      hotel: parseExpenseInput(expenses.hotel),
      parking: parseExpenseInput(expenses.parking),
      tolls: parseExpenseInput(expenses.tolls),
      uber: parseExpenseInput(expenses.uber),
      other_expenses: parseExpenseInput(expenses.other_expenses),
      expense_notes: expenses.expense_notes.trim() ? expenses.expense_notes : null,
    };
  }

  async function flushCurrentInvoiceInputs(): Promise<{ invoiceData: InvoiceData; packet: InvoicePacket } | null> {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    setSaveError(null);
    setIsSaving(true);
    try {
      const res = await fetch(`/api/invoice/${encodeURIComponent(eventId)}`, {
        method: "PATCH",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        body: JSON.stringify(buildCurrentInvoiceInputPatch()),
      });
      if (!res.ok) {
        setSaveError("Could not save invoice data. Try again.");
        return null;
      }
      const json = await res.json() as { invoiceData: InvoiceData; packet: InvoicePacket };
      setInvoiceData(json.invoiceData);
      setPacket(json.packet);
      return json;
    } catch {
      setSaveError("Network error saving invoice data. Try again.");
      return null;
    } finally {
      setIsSaving(false);
    }
  }

  function scheduleSave(patch: Record<string, unknown>) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void save(patch); }, 600);
  }

  // ---------------------------------------------------------------------------
  // Change handlers
  // ---------------------------------------------------------------------------

  function handleWorkdayChange(index: number, patch: Partial<WorkdayEntry>) {
    const updated = workdayEntries.map((e, i) => i === index ? { ...e, ...patch } : e);
    setWorkdayEntries(updated);
    scheduleSave({ workday_entries: updated });
  }

  function handleExpenseChange(field: keyof ExpenseFields, value: string) {
    const updated = { ...expenses, [field]: value };
    setExpenses(updated);
    if (field === "expense_notes") {
      scheduleSave({ expense_notes: value || null });
    } else {
      const num = parseFloat(value);
      scheduleSave({ [field]: value === "" || isNaN(num) ? null : num });
    }
  }

  // ---------------------------------------------------------------------------
  // Sheet sync
  // ---------------------------------------------------------------------------

  async function handleSyncSheet() {
    if (syncState.status === "syncing") return;
    const prevSyncedAt = syncState.syncedAt;
    setSyncState((prev) => ({ ...prev, status: "syncing", message: null }));
    try {
      const res = await fetch("/api/invoice/sync-sheet", {
        method: "POST",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        body: JSON.stringify({ eventId, gigSummary }),
      });
      if (res.ok) {
        const json = await res.json() as { syncedAt: string };
        setSyncState({ status: "success", message: null, syncedAt: json.syncedAt ?? null });
      } else {
        const json = await res.json().catch(() => ({})) as { message?: string };
        setSyncState({
          status: "error",
          message: json.message ?? "Sheet sync failed — retry",
          syncedAt: prevSyncedAt,
        });
      }
    } catch {
      setSyncState({ status: "error", message: "Sheet sync failed — retry", syncedAt: prevSyncedAt });
    }
  }

  // ---------------------------------------------------------------------------
  // Renumber — assign next numeric invoice number to a legacy JU-style number,
  // then immediately regenerate the PDF (which also re-syncs Google Sheets).
  // ---------------------------------------------------------------------------

  async function handleRenumber() {
    if (renumberState.status === "renumbering" || pdfState.status === "generating") return;
    setRenumberState({ status: "renumbering", error: null });
    try {
      const res = await fetch(`/api/invoice/renumber/${encodeURIComponent(eventId)}`, {
        method: "POST",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
      });
      const json = await res.json() as { ok?: boolean; newNumber?: string; error?: string; detail?: string };
      if (!res.ok || !json.ok) {
        setRenumberState({ status: "error", error: json.detail ?? json.error ?? "Could not assign new number" });
        return;
      }
      // Invoice number updated in DB. Regenerate PDF (which also syncs Google Sheets).
      setRenumberState({ status: "idle", error: null });
      await handleCreatePdf();
    } catch {
      setRenumberState({ status: "error", error: "Network error — try again" });
    }
  }

  // ---------------------------------------------------------------------------
  // PDF generation — full one-shot workflow:
  //   flush save → generate PDF (server handles: mark complete + sheet sync + upload)
  // ---------------------------------------------------------------------------

  async function handleCreatePdf() {
    if (pdfState.status === "generating") return;
    const oldInvoicePdfUrl = invoiceData?.invoice_pdf_url ?? null;
    logInvoicePdfDiagnostic("regenerate start", {
      old_invoice_pdf_url: oldInvoicePdfUrl,
      template: "orange-2026",
    });

    setPdfState({ status: "generating", error: null });
    setSaveError(null);

    // Step 1: flush all current invoice inputs to DB before the PDF route reads them.
    const flushed = await flushCurrentInvoiceInputs();
    if (!flushed) {
      setPdfState({ status: "error", error: "Could not save invoice data — try again" });
      return;
    }

    // Step 2: generate PDF. The route handles: mark complete, sheet sync, PDF upload, metadata.
    try {
      const res = await fetch(`/api/invoice/pdf/${encodeURIComponent(eventId)}`, {
        method: "POST",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        body: JSON.stringify({ gigSummary }),
      });
      const json = await res.json() as InvoicePdfMetadataResponse;
      if (!res.ok || !json.ok) {
        setPdfState({ status: "error", error: json.detail ?? json.error ?? "PDF generation failed" });
        return;
      }
      const generatedPdfMetadata = normalizeInvoicePdfMetadata(json);
      logInvoicePdfDiagnostic("regenerate POST returned", {
        old_invoice_pdf_url: oldInvoicePdfUrl,
        new_invoice_pdf_url: generatedPdfMetadata.invoicePdfUrl,
        invoice_pdf_path: generatedPdfMetadata.storagePath,
        invoice_updated_at: generatedPdfMetadata.invoiceUpdatedAt,
        template: generatedPdfMetadata.template ?? "orange-2026",
      });

      setInvoiceData((prev) => mergeInvoicePdfMetadata(prev, generatedPdfMetadata));

      let latestPdfMetadata = generatedPdfMetadata;
      try {
        const pdfMetaRes = await fetch(`/api/invoice/pdf/${encodeURIComponent(eventId)}`, {
          headers: buildAuthHeaders(editorToken),
          credentials: "same-origin",
          cache: "no-store",
        });
        if (pdfMetaRes.ok) {
          const pdfMetaJson = await pdfMetaRes.json() as InvoicePdfMetadataResponse;
          const refreshedPdfMetadata = normalizeInvoicePdfMetadata(pdfMetaJson);
          latestPdfMetadata = preferGeneratedPdfMetadata(generatedPdfMetadata, refreshedPdfMetadata);
          setInvoiceData((prev) => mergeInvoicePdfMetadata(prev, latestPdfMetadata));
          logInvoicePdfDiagnostic("regenerate metadata refreshed", {
            refreshed_invoice_pdf_url: refreshedPdfMetadata.invoicePdfUrl,
            active_invoice_pdf_url: latestPdfMetadata.invoicePdfUrl,
            invoice_pdf_path: latestPdfMetadata.storagePath,
            invoice_updated_at: latestPdfMetadata.invoiceUpdatedAt,
          });
        }
      } catch {
        // The POST response already has the authoritative freshly uploaded URL.
      }

      // Step 3: refresh all invoice state so the PDF actions appear.
      const refreshRes = await fetch(`/api/invoice/${encodeURIComponent(eventId)}`, {
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        cache: "no-store",
      });
      if (refreshRes.ok) {
        const rj = await refreshRes.json() as { invoiceData: InvoiceData | null; packet: InvoicePacket | null };
        if (rj.invoiceData) {
          setInvoiceData(mergeInvoicePdfMetadata(rj.invoiceData, latestPdfMetadata));
          setPacket(rj.packet);
          if (rj.invoiceData.sheet_synced_at) {
            setSyncState({ status: "success", message: null, syncedAt: rj.invoiceData.sheet_synced_at });
          }
        }
      }
      setPdfState({ status: "done", error: null });
    } catch {
      setPdfState({ status: "error", error: "Network error — check connection and retry" });
    }
  }

  async function handleSendEmail() {
    if (emailDialog.status === "sending") return;

    // Resolve addresses from the selected preset or custom input.
    let toAddresses: string[] = [];
    let ccAddresses: string[] = [];

    if (emailDialog.presetId === "custom") {
      const addr = emailDialog.customTo.trim();
      if (!addr) {
        setEmailDialog((prev) => ({ ...prev, error: "Enter a recipient email address." }));
        return;
      }
      toAddresses = [addr];
    } else if (emailDialog.presetId) {
      const preset = findPreset(emailDialog.presetId);
      if (!preset || !isPresetConfigured(preset)) {
        setEmailDialog((prev) => ({ ...prev, error: "This recipient preset is not configured yet." }));
        return;
      }
      toAddresses = preset.to;
      ccAddresses = preset.cc;
    } else {
      setEmailDialog((prev) => ({ ...prev, error: "Select a recipient before sending." }));
      return;
    }

    setEmailDialog((prev) => ({ ...prev, status: "sending", error: null }));
    try {
      const flushed = await flushCurrentInvoiceInputs();
      if (!flushed) {
        setEmailDialog((prev) => ({
          ...prev,
          status: "error",
          error: "Could not save the latest invoice changes — email was not sent.",
        }));
        return;
      }

      const res = await fetch(`/api/invoice/email/${encodeURIComponent(eventId)}`, {
        method: "POST",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        body: JSON.stringify({ to: toAddresses, cc: ccAddresses, gigSummary }),
      });
      const json = await res.json() as { ok?: boolean; error?: string; detail?: string; sentAt?: string };
      if (!res.ok || !json.ok) {
        setEmailDialog((prev) => ({
          ...prev,
          status: "error",
          error: json.detail ?? json.error ?? "Email failed to send",
        }));
        return;
      }
      // Refresh to pick up updated invoice_status = "sent"
      const refreshRes = await fetch(`/api/invoice/${encodeURIComponent(eventId)}`, {
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        cache: "no-store",
      });
      if (refreshRes.ok) {
        const j = await refreshRes.json() as { invoiceData: InvoiceData | null; packet: InvoicePacket | null };
        if (j.invoiceData) { setInvoiceData(j.invoiceData); setPacket(j.packet); }
      }
      setEmailDialog((prev) => ({ ...prev, status: "success", error: null }));
    } catch {
      setEmailDialog((prev) => ({ ...prev, status: "error", error: "Network error — try again" }));
    }
  }

  // ---------------------------------------------------------------------------
  // Render guards
  // ---------------------------------------------------------------------------

  if (fetchState.status === "loading") {
    return (
      <div className="invoice-section">
        <p className="board-day-modal-event-label">Invoice / Tracking</p>
        <p className="invoice-status-muted">Loading…</p>
      </div>
    );
  }
  if (fetchState.status === "unavailable") {
    return (
      <div className="invoice-section">
        <p className="board-day-modal-event-label">Invoice / Tracking</p>
        <p className="invoice-status-muted">Unavailable.</p>
      </div>
    );
  }
  if (fetchState.status === "error") {
    return (
      <div className="invoice-section">
        <p className="board-day-modal-event-label">Invoice / Tracking</p>
        <p className="invoice-error" role="alert">Could not load invoice data. Check connection and try reopening.</p>
      </div>
    );
  }
  if (workDates.length === 0) return null;

  const p = packet;
  const m = p?.mileage ?? null;
  const mileageRate = invoiceData?.mileage_rate ?? 0.52;
  const showMileage = m != null && m.totalMiles > 0;

  const syncedLabel = syncState.syncedAt
    ? (() => {
        try {
          return new Date(syncState.syncedAt).toLocaleString("en-US", {
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
          });
        } catch { return syncState.syncedAt; }
      })()
    : null;

  const hasPreviouslySynced = syncState.syncedAt != null;
  const currentStatus = invoiceData?.invoice_status;
  const isTerminal = !!(currentStatus && TERMINAL_STATUSES.has(currentStatus));
  const pdfUrl = invoiceData?.invoice_pdf_url ?? null;
  const hasPdf = !!pdfUrl;
  const invoiceNumber = invoiceData?.invoice_number ?? null;
  const laNumber = invoiceData?.la_number ?? null;
  const pdfVersion = invoiceData?.updated_at ?? invoiceData?.invoice_created_at ?? null;
  const pdfActionUrl = buildPdfActionUrl(pdfUrl, pdfVersion);
  const invoiceTotal = invoiceData?.invoice_total ?? null;
  const amountPaid = invoiceData?.amount_paid ?? 0;
  const remainingBalance = invoiceData?.remaining_balance ?? null;
  const displayedInvoiceTotal = invoiceTotal ?? p?.estimatedTotal ?? null;
  const displayedBalanceDue = remainingBalance ?? (
    displayedInvoiceTotal != null ? Math.max(displayedInvoiceTotal - amountPaid, 0) : null
  );
  const invoiceStatusLabel = currentStatus ? INVOICE_STATUS_LABELS[currentStatus] : "Not sent";
  const invoiceSentAt = invoiceData?.invoice_sent_at ?? null;
  const invoiceSentTo = invoiceData?.invoice_sent_to ?? null;

  // Email preview — computed client-side to match what the server will send
  const previewJobTitle = emailStripLaPrefix(gigSummary, laNumber);
  const previewWorkDates = p ? emailWorkDateRange(p.workdays) : "";
  const emailSubject = buildPreviewSubject(laNumber, previewJobTitle);
  const emailBody = buildPreviewBody(laNumber, previewJobTitle, previewWorkDates);
  const emailFilename = buildPreviewFilename(laNumber, previewJobTitle, invoiceNumber);

  // Per-day mileage is the source of truth. Legacy total_miles only matters when
  // no per-day mileage has been entered yet.
  const hasPerDayMileage = workdayEntries.some(
    (e) => e.mileageMode && e.mileageMode !== "none",
  );
  const legacyMiles = invoiceData?.total_miles ?? 0;
  const hasLegacyMileage = !hasPerDayMileage && legacyMiles > 0;

  async function handleConvertLegacyMileage() {
    if (!invoiceData || legacyMiles <= 0 || workdayEntries.length === 0) return;
    const deduction = invoiceData.mileage_deduction_miles ?? 60;
    // Write legacy miles into the first workday as a custom entry.
    const updated = workdayEntries.map((e, i) =>
      i === 0
        ? { ...e, mileageMode: "custom" as const, milesDriven: legacyMiles, mileageDeduction: deduction }
        : e,
    );
    setWorkdayEntries(updated);
    // Single atomic save: update workday entries + zero out legacy total_miles.
    await save({ workday_entries: updated, total_miles: null });
  }

  return (
    <div className="invoice-section">
      <p className="board-day-modal-event-label">Invoice / Tracking</p>

      {saveError ? <p className="invoice-error" role="alert">{saveError}</p> : null}

      {/* ── Work Dates / Hours + per-day mileage ─────────────────── */}
      <div className="invoice-block">
        <p className="invoice-block-label">Work Days</p>
        {workdayEntries.map((entry, i) => (
          <WorkdayRow
            key={entry.date}
            entry={entry}
            workdays={p?.workdays ?? []}
            index={i}
            onChange={handleWorkdayChange}
            autoMileage={autoMileage}
            autoMileageNote={autoMileageNote}
            mileageRate={mileageRate}
          />
        ))}
      </div>

      {/* Compact legacy mileage migration note — only shown when no per-day mileage exists */}
      {hasLegacyMileage ? (
        <div className="invoice-legacy-banner">
          <p className="invoice-legacy-banner-text">
            Previous mileage exists: {legacyMiles} mi. Add per-day mileage above to replace it.
          </p>
          <button
            type="button"
            className="invoice-legacy-convert-btn"
            onClick={() => { void handleConvertLegacyMileage(); }}
            disabled={isSaving}
          >
            Convert to custom entry on {fmtDate(workdayEntries[0]?.date ?? "")}
          </button>
        </div>
      ) : null}

      {/* ── Additional Expenses (collapsible) ──────────────────── */}
      <div className="invoice-block">
        <button
          type="button"
          className="invoice-collapsible-toggle"
          onClick={() => setExpensesExpanded((prev) => !prev)}
          aria-expanded={expensesExpanded}
        >
          <span className="invoice-block-label">Additional Expenses</span>
          <span className="invoice-collapsible-chevron">{expensesExpanded ? "▲" : "▼"}</span>
        </button>
        {expensesExpanded ? (
          <div className="invoice-collapsible-content">
            <div className="invoice-expense-grid">
              {(
                [
                  ["bag_fees", "Bag Fees"],
                  ["hotel", "Hotel"],
                  ["parking", "Parking"],
                  ["tolls", "Tolls"],
                  ["uber", "Uber"],
                  ["other_expenses", "Other"],
                ] as const
              ).map(([field, label]) => (
                <div key={field} className="invoice-expense-row">
                  <label className="invoice-label-sm" htmlFor={`inv-${field}`}>{label}</label>
                  <div className="invoice-currency-field">
                    <span className="invoice-currency-prefix">$</span>
                    <input
                      id={`inv-${field}`}
                      type="number"
                      min="0"
                      step="0.01"
                      className="invoice-input-sm"
                      value={expenses[field as keyof ExpenseFields]}
                      onChange={(e) => handleExpenseChange(field, e.target.value)}
                      placeholder="0"
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="invoice-notes-row">
              <label className="invoice-label-sm" htmlFor="inv-expense-notes">Notes</label>
              <textarea
                id="inv-expense-notes"
                className="invoice-textarea"
                value={expenses.expense_notes}
                onChange={(e) => handleExpenseChange("expense_notes", e.target.value)}
                placeholder="Receipt details, etc."
                rows={2}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* ── Invoice Preview ────────────────────────────────────── */}
      {p ? (
        <div className="invoice-block invoice-block--preview">
          <p className="invoice-block-label">Invoice Preview</p>
          <div className="invoice-preview">
            {p.dayRateQty > 0 ? (
              <div className="invoice-preview-row">
                <span>Freelance Audio – Day Rate</span>
                <span className="invoice-preview-qty">{p.dayRateQty} × {fmtCurrency(p.dayRate)}</span>
                <span className="invoice-preview-amount">{fmtCurrency(p.dayRateTotal)}</span>
              </div>
            ) : null}
            {p.totalOvertimeHours > 0 ? (
              <div className="invoice-preview-row">
                <span>Overtime</span>
                <span className="invoice-preview-qty">{fmtHours(p.totalOvertimeHours)} h × {fmtCurrency(p.overtimeRate)}</span>
                <span className="invoice-preview-amount">{fmtCurrency(p.overtimeTotal)}</span>
              </div>
            ) : null}
            {p.perDiemQty > 0 ? (
              <div className="invoice-preview-row">
                <span>Per Diem</span>
                <span className="invoice-preview-qty">{p.perDiemQty} × {fmtCurrency(p.perDiemRate)}</span>
                <span className="invoice-preview-amount">{fmtCurrency(p.perDiemTotal)}</span>
              </div>
            ) : null}
            {showMileage && m ? (
              <>
                <div className="invoice-preview-row">
                  <span>Mileage</span>
                  <span className="invoice-preview-qty">{m.reimbursedMiles} mi × ${mileageRate}</span>
                  <span className="invoice-preview-amount">{fmtCurrency(m.mileageAmount)}</span>
                </div>
                {m.deductionMiles > 0 ? (
                  <div className="invoice-preview-row invoice-preview-row--adj">
                    <span>Mileage Adjustment</span>
                    <span className="invoice-preview-qty">–{m.deductionMiles} mi × ${mileageRate}</span>
                    <span className="invoice-preview-amount">{fmtCurrency(m.mileageAdjustmentAmount)}</span>
                  </div>
                ) : null}
              </>
            ) : null}
            {p.bagFees > 0 ? (
              <div className="invoice-preview-row">
                <span>Bag Fees</span>
                <span className="invoice-preview-amount">{fmtCurrency(p.bagFees)}</span>
              </div>
            ) : null}
            {p.hotel > 0 ? (
              <div className="invoice-preview-row">
                <span>Hotel</span>
                <span className="invoice-preview-amount">{fmtCurrency(p.hotel)}</span>
              </div>
            ) : null}
            {p.parking > 0 ? (
              <div className="invoice-preview-row">
                <span>Parking</span>
                <span className="invoice-preview-amount">{fmtCurrency(p.parking)}</span>
              </div>
            ) : null}
            {p.tolls > 0 ? (
              <div className="invoice-preview-row">
                <span>Tolls</span>
                <span className="invoice-preview-amount">{fmtCurrency(p.tolls)}</span>
              </div>
            ) : null}
            {p.uber > 0 ? (
              <div className="invoice-preview-row">
                <span>Uber</span>
                <span className="invoice-preview-amount">{fmtCurrency(p.uber)}</span>
              </div>
            ) : null}
            {p.otherExpenses > 0 ? (
              <div className="invoice-preview-row">
                <span>Other</span>
                <span className="invoice-preview-amount">{fmtCurrency(p.otherExpenses)}</span>
              </div>
            ) : null}
            <div className="invoice-preview-row invoice-preview-row--total">
              <span>Estimated Total</span>
              <span className="invoice-preview-amount">{fmtCurrency(p.estimatedTotal)}</span>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Primary action: Create Invoice PDF ───────────────── */}
      {p ? (
        <div className="invoice-block invoice-pdf-block">
          {isSaving ? <span className="invoice-saving-indicator">Saving…</span> : null}

          {hasPdf ? (
            // PDF exists — show actions
            <div className="invoice-pdf-actions">
              <div className="invoice-status-card">
                <div className="invoice-status-card-header">
                  <div>
                    <p className="invoice-pdf-number">Invoice #{invoiceNumber ?? "—"}</p>
                    {laNumber ? (
                      <p className="invoice-pdf-la-number">LA Job #{laNumber}</p>
                    ) : null}
                  </div>
                  <span className="invoice-status-pill" data-status={currentStatus ?? "draft"}>
                    {invoiceStatusLabel}
                  </span>
                </div>
                <dl className="invoice-status-grid">
                  <div className="invoice-status-grid-row">
                    <dt>Status</dt>
                    <dd>{invoiceStatusLabel}</dd>
                  </div>
                  {invoiceSentAt ? (
                    <div className="invoice-status-grid-row">
                      <dt>Sent</dt>
                      <dd>{(() => { try { return new Date(invoiceSentAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return invoiceSentAt; } })()}</dd>
                    </div>
                  ) : null}
                  <div className="invoice-status-grid-row">
                    <dt>Total</dt>
                    <dd>{displayedInvoiceTotal != null ? fmtCurrency(displayedInvoiceTotal) : "—"}</dd>
                  </div>
                  <div className="invoice-status-grid-row">
                    <dt>Amount Paid</dt>
                    <dd>{fmtCurrency(amountPaid)}</dd>
                  </div>
                  <div className="invoice-status-grid-row invoice-status-grid-row--balance">
                    <dt>Balance Due</dt>
                    <dd>{displayedBalanceDue != null ? fmtCurrency(displayedBalanceDue) : "—"}</dd>
                  </div>
                </dl>
                {(invoiceSentAt || invoiceSentTo) ? (
                  <div className="invoice-sent-summary">
                    <button
                      type="button"
                      className="invoice-sent-toggle"
                      onClick={() => setSentDetailsOpen((v) => !v)}
                      aria-expanded={sentDetailsOpen}
                    >
                      Sent details {sentDetailsOpen ? "▾" : "▸"}
                    </button>
                    {sentDetailsOpen ? (
                      <div className="invoice-sent-details">
                        {invoiceSentTo ? (
                          <div className="invoice-sent-detail-row">
                            <span className="invoice-label-sm">Sent to</span>
                            <span>{invoiceSentTo}</span>
                          </div>
                        ) : null}
                        {invoiceSentAt ? (
                          <div className="invoice-sent-detail-row">
                            <span className="invoice-label-sm">Sent at</span>
                            <span>{(() => {
                              try {
                                const d = new Date(invoiceSentAt);
                                const m = d.getMonth() + 1;
                                const dy = d.getDate();
                                const yr = String(d.getFullYear()).slice(-2);
                                const h = d.getHours();
                                const min = String(d.getMinutes()).padStart(2, "0");
                                const ampm = h >= 12 ? "PM" : "AM";
                                const h12 = h % 12 || 12;
                                return `${m}/${dy}/${yr} ${h12}:${min} ${ampm}`;
                              } catch { return invoiceSentAt; }
                            })()}</span>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {/* Convert legacy JU-style number to numeric */}
              {invoiceNumber && !isNumericInvoiceNumber(invoiceNumber) ? (
                <div className="invoice-renumber-block">
                  <button
                    type="button"
                    className="invoice-pdf-regen-btn"
                    onClick={() => { void handleRenumber(); }}
                    disabled={renumberState.status === "renumbering" || pdfState.status === "generating"}
                  >
                    {renumberState.status === "renumbering" || pdfState.status === "generating"
                      ? "Converting…"
                      : "Convert to Numeric Invoice #"}
                  </button>
                  {renumberState.error ? (
                    <p className="invoice-error" role="alert">{renumberState.error}</p>
                  ) : null}
                </div>
              ) : null}

              {/* PDF action buttons */}
              <div className="invoice-pdf-buttons">
                <a
                  href={pdfActionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="invoice-pdf-link-btn"
                  onClick={() => logInvoicePdfDiagnostic("open pdf", {
                    invoice_pdf_url: pdfUrl,
                    url_used: pdfActionUrl,
                    invoice_updated_at: pdfVersion,
                  })}
                >
                  Open PDF
                </a>
                <a
                  href={pdfActionUrl}
                  download={buildPdfFilename(invoiceNumber, laNumber)}
                  className="invoice-pdf-link-btn invoice-pdf-link-btn--secondary"
                  onClick={() => logInvoicePdfDiagnostic("download pdf", {
                    invoice_pdf_url: pdfUrl,
                    url_used: pdfActionUrl,
                    filename: buildPdfFilename(invoiceNumber, laNumber),
                    invoice_updated_at: pdfVersion,
                  })}
                >
                  Download PDF
                </a>
                {!emailDialog.open ? (
                  <button
                    type="button"
                    className="invoice-pdf-email-btn"
                    onClick={() => setEmailDialog({ ...EMAIL_DIALOG_RESET, open: true })}
                  >
                    Review
                  </button>
                ) : null}
              </div>

              {/* Email dialog — inline below action row */}
              {emailDialog.open ? (
                <EmailDialog
                  dialog={emailDialog}
                  onChange={setEmailDialog}
                  onSend={() => { void handleSendEmail(); }}
                  onClose={() => setEmailDialog(EMAIL_DIALOG_RESET)}
                  subject={emailSubject}
                  body={emailBody}
                  filename={emailFilename}
                />
              ) : null}

              {pdfState.status === "error" ? (
                <p className="invoice-error" role="alert">{pdfState.error}</p>
              ) : null}

              {/* Regenerate — secondary action below the PDF buttons */}
              <div className="invoice-secondary-actions">
                <button
                  type="button"
                  className="invoice-pdf-regen-btn"
                  onClick={() => { void handleCreatePdf(); }}
                  disabled={pdfState.status === "generating"}
                >
                  {pdfState.status === "generating" ? "Regenerating…" : "Regenerate PDF"}
                </button>
              </div>
            </div>
          ) : (
            // No PDF yet — primary CTA
            <div className="invoice-pdf-actions">
              <button
                type="button"
                className={`invoice-pdf-create-btn${pdfState.status === "generating" ? " invoice-pdf-create-btn--loading" : ""}`}
                onClick={() => { void handleCreatePdf(); }}
                disabled={pdfState.status === "generating" || isSaving || p.dayRateQty === 0}
              >
                {pdfState.status === "generating" ? "Generating PDF…" : "Create Invoice PDF"}
              </button>
              {p.dayRateQty === 0 ? (
                <p className="invoice-status-muted">Enter start/end times for at least one day first.</p>
              ) : null}
              {pdfState.status === "error" ? (
                <p className="invoice-error" role="alert">{pdfState.error}</p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {/* ── Secondary: manual sheet sync ─────────────────────────── */}
      <div className="invoice-sync-row invoice-sync-row--secondary">
        {syncState.status === "success" && syncedLabel ? (
          <p className="invoice-sync-success">Sheet synced {syncedLabel}</p>
        ) : syncState.status === "error" ? (
          <p className="invoice-error" role="alert">{syncState.message ?? "Sheet sync failed — retry"}</p>
        ) : null}
        <button
          type="button"
          className="invoice-sync-button"
          onClick={() => { void handleSyncSheet(); }}
          disabled={syncState.status === "syncing" || isSaving}
        >
          {syncState.status === "syncing"
            ? "Syncing…"
            : hasPreviouslySynced
              ? "Update Google Sheet"
              : "Sync to Google Sheet"}
        </button>
      </div>
    </div>
  );
}
