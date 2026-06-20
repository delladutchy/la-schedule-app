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
  calculateInvoicePacket,
  calculateWorkdayMileage,
  getDefaultDeductionForMode,
  initWorkdayEntries,
  round2,
} from "@/lib/invoice-calculations";
import {
  countInvoiceLineItemOverrides,
  hasInvoiceLineItemOverride,
  removeInvoiceLineItemOverride,
  sanitizeInvoiceLineItemOverrides,
  type InvoiceLineItemKey,
  type InvoiceLineItemOverrides,
} from "@/lib/invoice-line-item-overrides";
import { isNumericInvoiceNumber } from "@/lib/invoice-number";
import { isEditableKeyboardTarget } from "@/lib/keyboard";

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
  action: "open" | "download" | "review" | "manual" | null;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

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
  editableSubject: string;
  editableBody: string;
}

const EMAIL_DIALOG_RESET: EmailDialogState = {
  open: false, presetId: "", customTo: "", status: "idle", error: null,
  editableSubject: "", editableBody: "",
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

interface OverrideFields {
  invoice_job_name_override: string;
  invoice_day_rate_description_override: string;
  invoice_ot_description_override: string;
  invoice_per_diem_description_override: string;
  invoice_bag_fees_description_override: string;
  invoice_parking_description_override: string;
  invoice_uber_description_override: string;
  invoice_tolls_description_override: string;
  invoice_hotel_description_override: string;
  invoice_other_description_override: string;
  invoice_note_override: string;
}

type OverrideFieldKey = keyof OverrideFields;
type LineItemDescriptionField = Exclude<OverrideFieldKey, "invoice_job_name_override" | "invoice_note_override">;

const DEFAULT_OT_DESCRIPTION = "Over 10hrs";
const DEFAULT_INVOICE_NOTE = "Thanks again,\nJeff";

const OVERRIDE_FIELD_KEYS: readonly OverrideFieldKey[] = [
  "invoice_job_name_override",
  "invoice_day_rate_description_override",
  "invoice_ot_description_override",
  "invoice_per_diem_description_override",
  "invoice_bag_fees_description_override",
  "invoice_parking_description_override",
  "invoice_uber_description_override",
  "invoice_tolls_description_override",
  "invoice_hotel_description_override",
  "invoice_other_description_override",
  "invoice_note_override",
];

const EMPTY_OVERRIDE_FIELDS: OverrideFields = {
  invoice_job_name_override: "",
  invoice_day_rate_description_override: "",
  invoice_ot_description_override: "",
  invoice_per_diem_description_override: "",
  invoice_bag_fees_description_override: "",
  invoice_parking_description_override: "",
  invoice_uber_description_override: "",
  invoice_tolls_description_override: "",
  invoice_hotel_description_override: "",
  invoice_other_description_override: "",
  invoice_note_override: "",
};

function hydrateOverrideFields(data: InvoiceData | null | undefined): OverrideFields {
  const hydrated = { ...EMPTY_OVERRIDE_FIELDS };
  if (!data) return hydrated;
  for (const field of OVERRIDE_FIELD_KEYS) {
    hydrated[field] = data[field] ?? "";
  }
  return hydrated;
}

function buildOverridePatch(overrides: OverrideFields): Record<OverrideFieldKey, string | null> {
  return OVERRIDE_FIELD_KEYS.reduce((acc, field) => {
    acc[field] = overrides[field].trim() || null;
    return acc;
  }, {} as Record<OverrideFieldKey, string | null>);
}

function hasOverrideText(overrides: OverrideFields): boolean {
  return OVERRIDE_FIELD_KEYS.some((field) => overrides[field].trim() !== "");
}

interface AutoMileage {
  oneWayMiles: number;
  roundTripMiles: number;
}

type AdjustmentDraftFields = Partial<Record<"qty" | "rate" | "amount", string>>;
type AdjustmentDrafts = Partial<Record<InvoiceLineItemKey, AdjustmentDraftFields>>;

interface AdjustmentRow {
  key: InvoiceLineItemKey;
  label: string;
  mode: "qtyRate" | "amount";
  autoQty?: number;
  autoRate?: number;
  autoAmount: number;
  qty?: number;
  rate?: number;
  amount: number;
  visible: boolean;
  isCustom: boolean;
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

// Parse LA number from a raw calendar event title when la_number is not saved in invoice_data.
// "LA#5555 — test job" → "LA#5555"    "test job" → null
function parseLaFromSummary(summary: string): string | null {
  const match = summary.trim().match(/^\s*LA\s*#?\s*(\d{3,})\s*/i);
  return match?.[1] ? `LA#${match[1]}` : null;
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

function fmtInvoiceShortDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  return `${month}/${day}`;
}

function fmtInvoiceCompactTime(raw: string): string {
  const trimmed = raw.trim();
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(trimmed);
  if (!match) return trimmed.replace(/\s+/g, "").toLowerCase();
  const hour = Number(match[1]);
  const minute = match[2] ?? "00";
  const meridiem = (match[3] ?? "").toLowerCase();
  return `${hour}:${minute}${meridiem}`;
}

function buildWorkedDateTimeLines(workdays: InvoicePacket["workdays"]): string {
  return workdays
    .map((workday) => {
      const date = fmtInvoiceShortDate(workday.date);
      const start = fmtInvoiceCompactTime(workday.startTime);
      const end = fmtInvoiceCompactTime(workday.endTime);
      return start && end ? `${date} - ${start}-${end}` : date;
    })
    .join("\n");
}

function resolveOverrideText(value: string, fallback = ""): string {
  return value.trim() || fallback;
}

function resolveOverrideInputValue(value: string, fallback = ""): string {
  return value === "" ? fallback : value;
}

function formatAdjustmentInputValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return Number(value.toFixed(2)).toString();
}

function parseAdjustmentInputValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) return null;
  return round2(num);
}

function mergeAdjustmentLine(
  overrides: InvoiceLineItemOverrides,
  key: InvoiceLineItemKey,
  patch: Partial<Record<"qty" | "rate" | "amount", number | null>>,
): InvoiceLineItemOverrides {
  const current = { ...(overrides[key] ?? {}) };
  for (const [field, value] of Object.entries(patch) as Array<["qty" | "rate" | "amount", number | null]>) {
    if (value == null) {
      delete current[field];
    } else {
      current[field] = value;
    }
  }

  const next = { ...overrides };
  if (current.qty == null && current.rate == null && current.amount == null) {
    delete next[key];
  } else {
    next[key] = current;
  }
  return next;
}

function buildAutoInvoiceData(data: InvoiceData, workdayEntries: WorkdayEntry[]): InvoiceData {
  return {
    ...data,
    workday_entries: workdayEntries,
    invoice_line_item_overrides: {},
  };
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
  filename: string;
}

function InvoicePreviewLabel({ label, description }: { label: string; description?: string }) {
  const cleanDescription = description?.trim();
  return (
    <span className="invoice-preview-label">
      <span>{label}</span>
      {cleanDescription ? <small className="invoice-preview-description">{cleanDescription}</small> : null}
    </span>
  );
}

function EmailDialog({ dialog, onChange, onSend, onClose, filename }: EmailDialogProps) {
  const isBusy = dialog.status === "sending";
  const isDone = dialog.status === "success";

  let previewTo: string[] = [];
  let previewCc: string[] = [];
  let previewUnconfigured = false;

  if (dialog.presetId === "custom") {
    const addr = dialog.customTo.trim();
    // Require a plausible email (must contain @) before counting it as a valid recipient.
    previewTo = addr.includes("@") ? [addr] : [];
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

  // "To" preview line: primary addresses, then CC if present.
  const toLine = previewTo.join(", ");
  const ccLine = previewCc.length > 0 ? previewCc.join(", ") : null;

  return (
    <div className="invoice-email-dialog" role="dialog" aria-label="Review Invoice">
      <p className="invoice-block-label">Review &amp; Send</p>

      {!isDone ? (
        <>
          {/* Send to — recipient selector */}
          <div className="invoice-email-field">
            <label className="invoice-label-sm" htmlFor="inv-email-preset">Send to</label>
            <select
              id="inv-email-preset"
              className="invoice-select invoice-email-select"
              value={dialog.presetId}
              disabled={isBusy}
              onChange={(e) => onChange((prev) => ({ ...prev, presetId: e.target.value, customTo: "", error: null }))}
            >
              <option value="">— choose recipient —</option>
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
            <p className="invoice-status-muted invoice-email-unconfigured">
              This preset is not configured. Edit <code>lib/invoice-recipients.ts</code> to add the address.
            </p>
          ) : null}

          {/* Email review — To and Attachment are read-only; Subject and Message are editable */}
          <div className="invoice-email-review">
            <div className="invoice-email-review-row">
              <span className="invoice-email-review-label">To</span>
              <span className="invoice-email-review-value">{toLine || "—"}</span>
              {ccLine ? (
                <span className="invoice-email-review-cc">CC: {ccLine}</span>
              ) : null}
            </div>
            <div className="invoice-email-review-row">
              <label className="invoice-email-review-label" htmlFor="inv-email-subject">Subject</label>
              <input
                id="inv-email-subject"
                type="text"
                className="invoice-email-edit-input"
                value={dialog.editableSubject}
                onChange={(e) => onChange((prev) => ({ ...prev, editableSubject: e.target.value }))}
                disabled={isBusy}
              />
            </div>
            <div className="invoice-email-review-row">
              <label className="invoice-email-review-label" htmlFor="inv-email-body">Message</label>
              <textarea
                id="inv-email-body"
                className="invoice-email-edit-textarea"
                value={dialog.editableBody}
                onChange={(e) => onChange((prev) => ({ ...prev, editableBody: e.target.value }))}
                disabled={isBusy}
                rows={7}
              />
            </div>
            <div className="invoice-email-review-row">
              <span className="invoice-email-review-label">Attachment</span>
              <span className="invoice-email-review-value">{filename}</span>
            </div>
          </div>
        </>
      ) : (
        <p className="invoice-sync-success">
          Invoice sent to {previewTo.join(", ")}.
          {ccLine ? ` CC: ${ccLine}` : ""}
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
  const [overrides, setOverrides] = useState<OverrideFields>({ ...EMPTY_OVERRIDE_FIELDS });
  const [overridesExpanded, setOverridesExpanded] = useState(false);
  const [lineItemOverrides, setLineItemOverrides] = useState<InvoiceLineItemOverrides>({});
  const [adjustmentDrafts, setAdjustmentDrafts] = useState<AdjustmentDrafts>({});
  const [adjustmentsExpanded, setAdjustmentsExpanded] = useState(false);
  const [autoMileage, setAutoMileage] = useState<AutoMileage | null>(null);
  const [autoMileageNote, setAutoMileageNote] = useState<AutoMileageNote | null>(
    jobLocation ? null : "no_location",
  );
  const [syncState, setSyncState] = useState<SyncState>({ status: "idle", message: null, syncedAt: null });
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [isSaving, setIsSaving] = useState(false);
  const [pdfState, setPdfState] = useState<PdfState>({ status: "idle", error: null, action: null });
  const [renumberState, setRenumberState] = useState<RenumberState>({ status: "idle", error: null });
  const [emailDialog, setEmailDialog] = useState<EmailDialogState>(EMAIL_DIALOG_RESET);
  const [sentDetailsOpen, setSentDetailsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveVersionRef = useRef(0);
  const requestKey = `${eventId}::${workDates.join("|")}`;

  // Fetch existing invoice data on mount / key change
  useEffect(() => {
    if (!eventId) return;
    setFetchState({ status: "loading" });
    setSaveError(null);
    setSaveStatus("idle");

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
        const json = await res.json() as { invoiceData: InvoiceData | null; packet: InvoicePacket | null; sheetUrl?: string | null };
        if (cancelled) return;

        if (json.sheetUrl) setSheetUrl(json.sheetUrl);

        const data = json.invoiceData;
        if (data) {
          const mergedWorkdays = initWorkdayEntries(data.workday_entries, workDates, defaultStartTime, defaultEndTime);
          const mergedData = { ...data, workday_entries: mergedWorkdays };
          setInvoiceData(mergedData);
          setPacket(calculateInvoicePacket(mergedData));
          setWorkdayEntries(mergedWorkdays);
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
          const hydratedLineItemOverrides = sanitizeInvoiceLineItemOverrides(data.invoice_line_item_overrides);
          setLineItemOverrides(hydratedLineItemOverrides);
          setAdjustmentDrafts({});
          setAdjustmentsExpanded(countInvoiceLineItemOverrides(hydratedLineItemOverrides) > 0);
          const hydratedOverrides = hydrateOverrideFields(data);
          setOverrides(hydratedOverrides);
          setOverridesExpanded(hasOverrideText(hydratedOverrides));
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
          setLineItemOverrides({});
          setAdjustmentDrafts({});
          setAdjustmentsExpanded(false);
          setOverrides({ ...EMPTY_OVERRIDE_FIELDS });
          setOverridesExpanded(false);
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

  function markSavePending(): number {
    saveVersionRef.current += 1;
    setSaveError(null);
    setSaveStatus("saving");
    return saveVersionRef.current;
  }

  function markSaveSucceeded(version: number): void {
    if (version === saveVersionRef.current) {
      setSaveStatus("saved");
    }
  }

  function markSaveFailed(version: number, message: string): void {
    if (version === saveVersionRef.current) {
      setSaveError(message);
      setSaveStatus("error");
    }
  }

  async function save(patch: Record<string, unknown>, version = markSavePending()): Promise<void> {
    setSaveError(null);
    setSaveStatus("saving");
    setIsSaving(true);
    try {
      const res = await fetch(`/api/invoice/${encodeURIComponent(eventId)}`, {
        method: "PATCH",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        markSaveFailed(version, "Could not save invoice data — try again");
        return;
      }
      const json = await res.json() as { invoiceData: InvoiceData; packet: InvoicePacket };
      if (version === saveVersionRef.current) {
        setInvoiceData(json.invoiceData);
        setPacket(json.packet);
        setLineItemOverrides(sanitizeInvoiceLineItemOverrides(json.invoiceData.invoice_line_item_overrides));
        markSaveSucceeded(version);
      }
      // Do NOT optimistically mark sheet as synced here. The background Sheets API
      // call fires after this response returns, and may fail silently (e.g. in
      // serverless where the Lambda terminates after the response). syncState is
      // only updated when the actual Sheets upsert is confirmed (PDF refresh,
      // manual Sync button, or email send).
    } catch {
      markSaveFailed(version, "Could not save invoice data — try again");
    } finally {
      if (version === saveVersionRef.current) {
        setIsSaving(false);
      }
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
      gigSummary,
      workday_entries: workdayEntries,
      bag_fees: parseExpenseInput(expenses.bag_fees),
      hotel: parseExpenseInput(expenses.hotel),
      parking: parseExpenseInput(expenses.parking),
      tolls: parseExpenseInput(expenses.tolls),
      uber: parseExpenseInput(expenses.uber),
      other_expenses: parseExpenseInput(expenses.other_expenses),
      expense_notes: expenses.expense_notes.trim() ? expenses.expense_notes : null,
      invoice_line_item_overrides: lineItemOverrides,
      ...buildOverridePatch(overrides),
    };
  }

  async function flushCurrentInvoiceInputs(): Promise<{ invoiceData: InvoiceData; packet: InvoicePacket } | null> {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    setSaveError(null);
    const version = markSavePending();
    setIsSaving(true);
    try {
      const res = await fetch(`/api/invoice/${encodeURIComponent(eventId)}`, {
        method: "PATCH",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        body: JSON.stringify(buildCurrentInvoiceInputPatch()),
      });
      if (!res.ok) {
        markSaveFailed(version, "Could not save invoice data — try again");
        return null;
      }
      const json = await res.json() as { invoiceData: InvoiceData; packet: InvoicePacket };
      setInvoiceData(json.invoiceData);
      setPacket(json.packet);
      setLineItemOverrides(sanitizeInvoiceLineItemOverrides(json.invoiceData.invoice_line_item_overrides));
      markSaveSucceeded(version);
      return json;
    } catch {
      markSaveFailed(version, "Could not save invoice data — try again");
      return null;
    } finally {
      if (version === saveVersionRef.current) {
        setIsSaving(false);
      }
    }
  }

  function scheduleSave(patch: Record<string, unknown>) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const version = markSavePending();
    // Always include gigSummary so the server-side background sheet sync has the full job title.
    // Always include the current merged workday list so past/missing invoice days cannot be
    // dropped by an expense/text-only autosave.
    saveTimer.current = setTimeout(() => {
      void save({ workday_entries: workdayEntries, ...patch, gigSummary }, version);
    }, 600);
  }

  // ---------------------------------------------------------------------------
  // Change handlers
  // ---------------------------------------------------------------------------

  function handleWorkdayChange(index: number, patch: Partial<WorkdayEntry>) {
    const updated = workdayEntries.map((e, i) => i === index ? { ...e, ...patch } : e);
    setWorkdayEntries(updated);
    if (invoiceData) {
      const optimisticData = { ...invoiceData, workday_entries: updated };
      setInvoiceData(optimisticData);
      setPacket(calculateInvoicePacket(optimisticData));
    }
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

  function handleOverrideChange(field: keyof OverrideFields, value: string) {
    setOverrides((prev) => ({ ...prev, [field]: value }));
    scheduleSave({ [field]: value.trim() || null });
  }

  function applyLineItemOverrides(nextOverrides: InvoiceLineItemOverrides) {
    const sanitized = sanitizeInvoiceLineItemOverrides(nextOverrides);
    setLineItemOverrides(sanitized);
    if (invoiceData) {
      const optimisticData = {
        ...invoiceData,
        workday_entries: workdayEntries,
        invoice_line_item_overrides: sanitized,
      };
      setInvoiceData(optimisticData);
      setPacket(calculateInvoicePacket(optimisticData));
    }
    scheduleSave({ invoice_line_item_overrides: sanitized });
  }

  function handleLineItemAdjustmentChange(
    row: AdjustmentRow,
    field: "qty" | "rate" | "amount",
    value: string,
  ) {
    setAdjustmentDrafts((prev) => ({
      ...prev,
      [row.key]: {
        ...(prev[row.key] ?? {}),
        [field]: value,
      },
    }));

    const parsed = parseAdjustmentInputValue(value);
    let nextOverrides = mergeAdjustmentLine(lineItemOverrides, row.key, { [field]: parsed });

    if (row.mode === "qtyRate") {
      const line = nextOverrides[row.key] ?? {};
      const qty = line.qty ?? row.autoQty ?? 0;
      const rate = line.rate ?? row.autoRate ?? 0;
      const hasQtyRateOverride = line.qty != null || line.rate != null;
      nextOverrides = mergeAdjustmentLine(nextOverrides, row.key, {
        amount: hasQtyRateOverride ? round2(qty * rate) : null,
      });
    }

    applyLineItemOverrides(nextOverrides);
  }

  function handleResetLineItemAdjustment(key: InvoiceLineItemKey) {
    setAdjustmentDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    applyLineItemOverrides(removeInvoiceLineItemOverride(lineItemOverrides, key));
  }

  // ---------------------------------------------------------------------------
  // Sheet sync
  // ---------------------------------------------------------------------------

  async function handleSyncSheet() {
    if (syncState.status === "syncing") return;
    const prevSyncedAt = syncState.syncedAt;
    setSyncState((prev) => ({ ...prev, status: "syncing", message: null }));
    try {
      const saved = await flushCurrentInvoiceInputs();
      if (!saved) {
        setSyncState({
          status: "error",
          message: "Could not save latest invoice data before sheet sync.",
          syncedAt: prevSyncedAt,
        });
        return;
      }
      const res = await fetch("/api/invoice/sync-sheet", {
        method: "POST",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        body: JSON.stringify({ eventId, gigSummary }),
      });
      const json = await res.json().catch(() => ({})) as {
        syncedAt?: string;
        message?: string;
        sheetTarget?: { sheetId?: string | null; sheetName?: string };
      };
      if (res.ok) {
        setSyncState({ status: "success", message: null, syncedAt: json.syncedAt ?? null });
      } else {
        // Use the server-classified message (auth error, tab not found, etc.) if available.
        setSyncState({
          status: "error",
          message: json.message ?? "Sheet sync failed — retry",
          syncedAt: prevSyncedAt,
        });
      }
    } catch {
      setSyncState({ status: "error", message: "Sheet sync failed — network error", syncedAt: prevSyncedAt });
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
  // PDF generation — core flow:
  //   flush save → POST to PDF route → update state → return new URL to caller
  //   Background: re-fetches full state (non-blocking).
  // ---------------------------------------------------------------------------

  // Background full-state refresh after PDF generation. Fire-and-forget; does
  // not block the caller from acting on the new URL.
  async function refreshInvoiceState(generated: NormalizedInvoicePdfMetadata): Promise<void> {
    let latestPdfMetadata = generated;
    try {
      const pdfMetaRes = await fetch(`/api/invoice/pdf/${encodeURIComponent(eventId)}`, {
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        cache: "no-store",
      });
      if (pdfMetaRes.ok) {
        const pdfMetaJson = await pdfMetaRes.json() as InvoicePdfMetadataResponse;
        const refreshedPdfMetadata = normalizeInvoicePdfMetadata(pdfMetaJson);
        latestPdfMetadata = preferGeneratedPdfMetadata(generated, refreshedPdfMetadata);
        setInvoiceData((prev) => mergeInvoicePdfMetadata(prev, latestPdfMetadata));
      }
    } catch { /* non-fatal */ }

    try {
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
    } catch { /* non-fatal */ }
  }

  // Core: flush → generate → update state immediately → return new URL.
  // Action tracks what triggered this so the UI can show context-appropriate labels.
  async function generateFreshPdf(action: "open" | "download" | "review" | "manual"): Promise<string | null> {
    if (pdfState.status === "generating") return null;
    const oldInvoicePdfUrl = invoiceData?.invoice_pdf_url ?? null;
    logInvoicePdfDiagnostic("pdf generate start", { action, old_invoice_pdf_url: oldInvoicePdfUrl });

    setPdfState({ status: "generating", error: null, action });
    setSaveError(null);

    const flushed = await flushCurrentInvoiceInputs();
    if (!flushed) {
      setPdfState({ status: "error", error: "Could not save invoice data — try again", action });
      return null;
    }

    try {
      const res = await fetch(`/api/invoice/pdf/${encodeURIComponent(eventId)}`, {
        method: "POST",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        body: JSON.stringify({ gigSummary }),
      });
      const json = await res.json() as InvoicePdfMetadataResponse;
      if (!res.ok || !json.ok) {
        setPdfState({ status: "error", error: json.detail ?? json.error ?? "PDF generation failed", action });
        return null;
      }

      const generatedPdfMetadata = normalizeInvoicePdfMetadata(json);
      logInvoicePdfDiagnostic("pdf generate POST returned", {
        action,
        old_invoice_pdf_url: oldInvoicePdfUrl,
        new_invoice_pdf_url: generatedPdfMetadata.invoicePdfUrl,
        invoice_pdf_path: generatedPdfMetadata.storagePath,
      });

      // Update state immediately with the fresh URL — caller can use it right away.
      setInvoiceData((prev) => mergeInvoicePdfMetadata(prev, generatedPdfMetadata));
      setPdfState({ status: "done", error: null, action: null });

      // Background: sync full invoice state without blocking the caller.
      void refreshInvoiceState(generatedPdfMetadata);

      return generatedPdfMetadata.invoicePdfUrl;
    } catch {
      setPdfState({ status: "error", error: "Network error — check connection and retry", action });
      return null;
    }
  }

  // Open PDF: regenerate fresh PDF, then open the new URL in a new tab.
  async function handleOpenPdf() {
    const url = await generateFreshPdf("open");
    if (!url) return; // error already set in pdfState
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // Download PDF: regenerate fresh PDF, then trigger a browser download of the new URL.
  async function handleDownloadPdf() {
    const url = await generateFreshPdf("download");
    if (!url) return; // error already set in pdfState
    const a = document.createElement("a");
    a.href = url;
    a.download = buildPdfFilename(invoiceNumber, laNumber);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // Review: regenerate fresh PDF, then open the email/review dialog.
  async function handleOpenReview() {
    const url = await generateFreshPdf("review");
    if (!url) return; // error already set in pdfState
    // Seed editable fields with computed defaults so the user can adjust before sending.
    setEmailDialog({ ...EMAIL_DIALOG_RESET, open: true, editableSubject: emailSubject, editableBody: emailBody });
  }

  // Manual/advanced regeneration (also used by renumber flow).
  async function handleCreatePdf() {
    await generateFreshPdf("manual");
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
        body: JSON.stringify({
          to: toAddresses,
          cc: ccAddresses,
          gigSummary,
          overrideSubject: emailDialog.editableSubject || undefined,
          overrideBody: emailDialog.editableBody || undefined,
        }),
      });
      const json = await res.json() as {
        ok?: boolean; error?: string; detail?: string;
        sentAt?: string; sentTo?: string; sentSubject?: string; subject?: string;
      };
      if (!res.ok || !json.ok) {
        setEmailDialog((prev) => ({
          ...prev,
          status: "error",
          error: json.detail ?? json.error ?? "Email failed to send",
        }));
        return;
      }
      // Optimistically patch sent fields so the card updates immediately without waiting for refresh.
      setInvoiceData((prev) => prev ? {
        ...prev,
        invoice_status: "sent",
        invoice_sent_at: json.sentAt ?? prev.invoice_sent_at,
        invoice_sent_to: json.sentTo ?? prev.invoice_sent_to,
        invoice_sent_subject: json.sentSubject ?? json.subject ?? prev.invoice_sent_subject,
      } : prev);
      // Background refresh to pick up any other server-side changes.
      void fetch(`/api/invoice/${encodeURIComponent(eventId)}`, {
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        cache: "no-store",
      }).then(async (refreshRes) => {
        if (refreshRes.ok) {
          const j = await refreshRes.json() as { invoiceData: InvoiceData | null; packet: InvoicePacket | null };
          if (j.invoiceData) { setInvoiceData(j.invoiceData); setPacket(j.packet); }
        }
      }).catch(() => { /* non-fatal */ });
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
  // Always show the live calculated total so the card stays in sync with Invoice Preview.
  // invoice_total is only updated when a PDF is generated; p.estimatedTotal reflects every save.
  const displayedInvoiceTotal = p?.estimatedTotal ?? invoiceTotal ?? null;
  const displayedBalanceDue = displayedInvoiceTotal != null
    ? Math.max(displayedInvoiceTotal - amountPaid, 0)
    : (remainingBalance ?? null);
  const invoiceStatusLabel = currentStatus ? INVOICE_STATUS_LABELS[currentStatus] : "Not sent";
  const invoiceSentAt = invoiceData?.invoice_sent_at ?? null;
  const invoiceSentTo = invoiceData?.invoice_sent_to ?? null;
  const invoiceSentSubject = invoiceData?.invoice_sent_subject ?? null;

  // Email preview — computed client-side to match what the server will send.
  // effectiveEmailLaNumber: use stored la_number first; fall back to parsing from
  // the calendar event title so the subject/body are correct even when la_number
  // hasn't been explicitly saved in invoice_data.
  const effectiveEmailLaNumber = laNumber ?? parseLaFromSummary(gigSummary);
  const autoPreviewJobTitle = emailStripLaPrefix(gigSummary, effectiveEmailLaNumber);
  // Job name override applies to the email body default (user can still edit in Review panel).
  const previewJobTitle = overrides.invoice_job_name_override.trim() || autoPreviewJobTitle;
  const previewWorkDates = p ? emailWorkDateRange(p.workdays) : "";
  const emailSubject = buildPreviewSubject(effectiveEmailLaNumber, autoPreviewJobTitle);
  const emailBody = buildPreviewBody(effectiveEmailLaNumber, previewJobTitle, previewWorkDates);
  const emailFilename = buildPreviewFilename(effectiveEmailLaNumber, autoPreviewJobTitle, invoiceNumber);
  const autoPacket = invoiceData
    ? calculateInvoicePacket(buildAutoInvoiceData(invoiceData, workdayEntries))
    : null;
  const customAdjustmentCount = countInvoiceLineItemOverrides(lineItemOverrides);
  const adjustmentRows: AdjustmentRow[] = p && autoPacket
    ? [
        {
          key: "day_rate" as const,
          label: "Day Rate",
          mode: "qtyRate" as const,
          autoQty: autoPacket.dayRateQty,
          autoRate: autoPacket.dayRate,
          autoAmount: autoPacket.dayRateTotal,
          qty: p.dayRateQty,
          rate: p.dayRate,
          amount: p.dayRateTotal,
          visible: autoPacket.dayRateQty > 0 || hasInvoiceLineItemOverride(lineItemOverrides, "day_rate"),
          isCustom: hasInvoiceLineItemOverride(lineItemOverrides, "day_rate"),
        },
        {
          key: "ot" as const,
          label: "OT",
          mode: "qtyRate" as const,
          autoQty: autoPacket.totalOvertimeHours,
          autoRate: autoPacket.overtimeRate,
          autoAmount: autoPacket.overtimeTotal,
          qty: p.totalOvertimeHours,
          rate: p.overtimeRate,
          amount: p.overtimeTotal,
          visible: autoPacket.overtimeTotal > 0 || hasInvoiceLineItemOverride(lineItemOverrides, "ot"),
          isCustom: hasInvoiceLineItemOverride(lineItemOverrides, "ot"),
        },
        {
          key: "per_diem" as const,
          label: "Per Diem",
          mode: "qtyRate" as const,
          autoQty: autoPacket.perDiemQty,
          autoRate: autoPacket.perDiemRate,
          autoAmount: autoPacket.perDiemTotal,
          qty: p.perDiemQty,
          rate: p.perDiemRate,
          amount: p.perDiemTotal,
          visible: autoPacket.perDiemTotal > 0 || hasInvoiceLineItemOverride(lineItemOverrides, "per_diem"),
          isCustom: hasInvoiceLineItemOverride(lineItemOverrides, "per_diem"),
        },
        {
          key: "bag_fees" as const,
          label: "Bag Fees",
          mode: "amount" as const,
          autoAmount: autoPacket.bagFees,
          amount: p.bagFees,
          visible: autoPacket.bagFees > 0 || hasInvoiceLineItemOverride(lineItemOverrides, "bag_fees"),
          isCustom: hasInvoiceLineItemOverride(lineItemOverrides, "bag_fees"),
        },
        {
          key: "parking" as const,
          label: "Parking",
          mode: "amount" as const,
          autoAmount: autoPacket.parking,
          amount: p.parking,
          visible: autoPacket.parking > 0 || hasInvoiceLineItemOverride(lineItemOverrides, "parking"),
          isCustom: hasInvoiceLineItemOverride(lineItemOverrides, "parking"),
        },
        {
          key: "uber" as const,
          label: "Uber",
          mode: "amount" as const,
          autoAmount: autoPacket.uber,
          amount: p.uber,
          visible: autoPacket.uber > 0 || hasInvoiceLineItemOverride(lineItemOverrides, "uber"),
          isCustom: hasInvoiceLineItemOverride(lineItemOverrides, "uber"),
        },
        {
          key: "tolls" as const,
          label: "Tolls",
          mode: "amount" as const,
          autoAmount: autoPacket.tolls,
          amount: p.tolls,
          visible: autoPacket.tolls > 0 || hasInvoiceLineItemOverride(lineItemOverrides, "tolls"),
          isCustom: hasInvoiceLineItemOverride(lineItemOverrides, "tolls"),
        },
        {
          key: "hotel" as const,
          label: "Hotel",
          mode: "amount" as const,
          autoAmount: autoPacket.hotel,
          amount: p.hotel,
          visible: autoPacket.hotel > 0 || hasInvoiceLineItemOverride(lineItemOverrides, "hotel"),
          isCustom: hasInvoiceLineItemOverride(lineItemOverrides, "hotel"),
        },
        {
          key: "other" as const,
          label: "Other",
          mode: "amount" as const,
          autoAmount: autoPacket.otherExpenses,
          amount: p.otherExpenses,
          visible: autoPacket.otherExpenses > 0 || hasInvoiceLineItemOverride(lineItemOverrides, "other"),
          isCustom: hasInvoiceLineItemOverride(lineItemOverrides, "other"),
        },
      ].filter((row) => row.visible)
    : [];
  const defaultDayRateDescription = p ? buildWorkedDateTimeLines(p.workdays) : "";
  const resolveLineItemDescription = (field: LineItemDescriptionField, fallback = "") =>
    resolveOverrideText(overrides[field], fallback);
  const resolveLineItemInputValue = (field: LineItemDescriptionField, fallback = "") =>
    resolveOverrideInputValue(overrides[field], fallback);
  const lineItemDescriptionFields = p
    ? [
        {
          field: "invoice_day_rate_description_override" as const,
          label: "Day Rate description",
          defaultDescription: defaultDayRateDescription,
          rows: Math.max(3, p.workdays.length),
          visible: p.dayRateQty > 0,
          hint: "Generated from saved workday dates/times. Clear to return to generated lines.",
        },
        {
          field: "invoice_ot_description_override" as const,
          label: "OT description",
          defaultDescription: DEFAULT_OT_DESCRIPTION,
          rows: 2,
          visible: p.overtimeTotal > 0,
          hint: "Clear to return to the default OT description.",
        },
        {
          field: "invoice_per_diem_description_override" as const,
          label: "Per Diem description",
          defaultDescription: "",
          rows: 2,
          visible: p.perDiemTotal > 0,
          hint: "Optional description for this line.",
        },
        {
          field: "invoice_bag_fees_description_override" as const,
          label: "Bag Fees description",
          defaultDescription: "",
          rows: 2,
          visible: p.bagFees > 0,
          hint: "Optional description for this line.",
        },
        {
          field: "invoice_parking_description_override" as const,
          label: "Parking description",
          defaultDescription: "",
          rows: 2,
          visible: p.parking > 0,
          hint: "Optional description for this line.",
        },
        {
          field: "invoice_uber_description_override" as const,
          label: "Uber description",
          defaultDescription: "",
          rows: 2,
          visible: p.uber > 0,
          hint: "Optional description for this line.",
        },
        {
          field: "invoice_tolls_description_override" as const,
          label: "Tolls description",
          defaultDescription: "",
          rows: 2,
          visible: p.tolls > 0,
          hint: "Optional description for this line.",
        },
        {
          field: "invoice_hotel_description_override" as const,
          label: "Hotel description",
          defaultDescription: "",
          rows: 2,
          visible: p.hotel > 0,
          hint: "Optional description for this line.",
        },
        {
          field: "invoice_other_description_override" as const,
          label: "Other description",
          defaultDescription: "",
          rows: 2,
          visible: p.otherExpenses > 0,
          hint: "Optional description for this line.",
        },
      ].filter((field) => field.visible)
    : [];
  const invoiceNoteText = resolveOverrideInputValue(overrides.invoice_note_override, DEFAULT_INVOICE_NOTE);

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
    <div
      className="invoice-section"
      onKeyDown={(event) => {
        if (isEditableKeyboardTarget(event.target)) event.stopPropagation();
      }}
    >
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

      {/* ── Edit Invoice Text (optional overrides, collapsed by default) ── */}
      <div className="invoice-block">
        <button
          type="button"
          className="invoice-collapsible-toggle"
          onClick={() => setOverridesExpanded((prev) => !prev)}
          aria-expanded={overridesExpanded}
        >
          <span className="invoice-block-label">Edit invoice text</span>
          <span className="invoice-collapsible-meta">
            {saveStatus !== "idle" ? (
              <span className="invoice-save-status" data-status={saveStatus}>
                {saveStatus === "saving"
                  ? "Saving…"
                  : saveStatus === "saved"
                    ? "Saved"
                    : "Could not save invoice data — try again"}
              </span>
            ) : null}
            <span className="invoice-collapsible-chevron">{overridesExpanded ? "▲" : "▼"}</span>
          </span>
        </button>
        {overridesExpanded ? (
          <div className="invoice-collapsible-content invoice-overrides-content">
            <p className="invoice-overrides-hint">
              Clear any generated/default text to return to the automatic invoice wording.
            </p>
            <div className="invoice-override-field">
              <label className="invoice-label-sm" htmlFor="inv-override-job">Job name</label>
              <input
                id="inv-override-job"
                type="text"
                className="invoice-input invoice-override-input"
                value={overrides.invoice_job_name_override}
                onChange={(e) => handleOverrideChange("invoice_job_name_override", e.target.value)}
                placeholder={autoPreviewJobTitle || "e.g. Wilm U Grad"}
              />
              <p className="invoice-override-hint-sm">Affects: PDF job row, email body. (Subject always uses LA #.)</p>
            </div>
            {lineItemDescriptionFields.map((fieldConfig) => {
              const value = resolveLineItemInputValue(fieldConfig.field, fieldConfig.defaultDescription);
              return (
                <div className="invoice-override-field" key={fieldConfig.field}>
                  <label className="invoice-label-sm" htmlFor={`inv-override-${fieldConfig.field}`}>{fieldConfig.label}</label>
                  <textarea
                    id={`inv-override-${fieldConfig.field}`}
                    className="invoice-textarea invoice-override-textarea"
                    value={value}
                    onChange={(e) => handleOverrideChange(fieldConfig.field, e.target.value)}
                    placeholder={fieldConfig.defaultDescription || "Optional description"}
                    rows={fieldConfig.rows}
                  />
                  <p className="invoice-override-hint-sm">Affects: PDF/preview description column. {fieldConfig.hint}</p>
                </div>
              );
            })}
            <div className="invoice-override-field">
              <label className="invoice-label-sm" htmlFor="inv-override-note">Invoice note</label>
              <textarea
                id="inv-override-note"
                className="invoice-textarea invoice-override-textarea"
                value={invoiceNoteText}
                onChange={(e) => handleOverrideChange("invoice_note_override", e.target.value)}
                placeholder={DEFAULT_INVOICE_NOTE}
                rows={3}
              />
              <p className="invoice-override-hint-sm">Affects: PDF "Note to customer" section. Leave blank for default.</p>
            </div>
          </div>
        ) : null}
      </div>

      {/* ── Advanced invoice adjustments (manual qty/rate/amount overrides) ── */}
      {p ? (
        <div className="invoice-block">
          <button
            type="button"
            className="invoice-collapsible-toggle"
            onClick={() => setAdjustmentsExpanded((prev) => !prev)}
            aria-expanded={adjustmentsExpanded}
          >
            <span className="invoice-block-label">Advanced invoice adjustments</span>
            <span className="invoice-collapsible-meta">
              {customAdjustmentCount > 0 ? (
                <span className="invoice-adjustment-alert">{customAdjustmentCount} custom</span>
              ) : null}
              <span className="invoice-collapsible-chevron">{adjustmentsExpanded ? "▲" : "▼"}</span>
            </span>
          </button>
          {adjustmentsExpanded ? (
            <div className="invoice-collapsible-content invoice-adjustments-content">
              <p className="invoice-overrides-hint">
                Leave rows on Auto for normal calculations. Edit only when an invoice needs a manual client-facing adjustment.
              </p>
              {adjustmentRows.length > 0 ? (
                <div className="invoice-adjustment-list">
                  {adjustmentRows.map((row) => {
                    const draft = adjustmentDrafts[row.key] ?? {};
                    const qtyValue = draft.qty ?? formatAdjustmentInputValue(row.qty);
                    const rateValue = draft.rate ?? formatAdjustmentInputValue(row.rate);
                    const amountValue = draft.amount ?? formatAdjustmentInputValue(row.amount);
                    return (
                      <div className="invoice-adjustment-row" key={row.key}>
                        <div className="invoice-adjustment-row-head">
                          <div>
                            <span className="invoice-adjustment-label">{row.label}</span>
                            <span className="invoice-adjustment-auto">
                              Auto {fmtCurrency(row.autoAmount)}
                            </span>
                          </div>
                          <span className={`invoice-adjustment-status${row.isCustom ? " is-custom" : ""}`}>
                            {row.isCustom ? "Custom" : "Auto"}
                          </span>
                        </div>
                        {row.mode === "qtyRate" ? (
                          <div className="invoice-adjustment-grid invoice-adjustment-grid--qty-rate">
                            <label className="invoice-label-sm" htmlFor={`inv-adjust-${row.key}-qty`}>
                              Qty
                              <input
                                id={`inv-adjust-${row.key}-qty`}
                                type="number"
                                min="0"
                                step="0.01"
                                className="invoice-input-sm"
                                value={qtyValue}
                                onChange={(e) => handleLineItemAdjustmentChange(row, "qty", e.target.value)}
                              />
                            </label>
                            <label className="invoice-label-sm" htmlFor={`inv-adjust-${row.key}-rate`}>
                              Rate
                              <input
                                id={`inv-adjust-${row.key}-rate`}
                                type="number"
                                min="0"
                                step="0.01"
                                className="invoice-input-sm"
                                value={rateValue}
                                onChange={(e) => handleLineItemAdjustmentChange(row, "rate", e.target.value)}
                              />
                            </label>
                            <div className="invoice-adjustment-amount">
                              <span className="invoice-label-sm">Amount</span>
                              <strong>{fmtCurrency(row.amount)}</strong>
                            </div>
                          </div>
                        ) : (
                          <div className="invoice-adjustment-grid invoice-adjustment-grid--amount">
                            <label className="invoice-label-sm" htmlFor={`inv-adjust-${row.key}-amount`}>
                              Amount
                              <input
                                id={`inv-adjust-${row.key}-amount`}
                                type="number"
                                min="0"
                                step="0.01"
                                className="invoice-input-sm"
                                value={amountValue}
                                onChange={(e) => handleLineItemAdjustmentChange(row, "amount", e.target.value)}
                              />
                            </label>
                          </div>
                        )}
                        {row.isCustom ? (
                          <button
                            type="button"
                            className="invoice-adjustment-reset"
                            onClick={() => handleResetLineItemAdjustment(row.key)}
                          >
                            Reset to Auto
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="invoice-overrides-hint">No current invoice lines are available to adjust.</p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── Invoice Preview ────────────────────────────────────── */}
      {p ? (
        <div className="invoice-block invoice-block--preview">
          <p className="invoice-block-label">Invoice Preview</p>
          <div className="invoice-preview">
            {p.dayRateQty > 0 ? (
              <div className="invoice-preview-row">
                <InvoicePreviewLabel
                  label="Day Rate"
                  description={resolveLineItemDescription("invoice_day_rate_description_override", defaultDayRateDescription)}
                />
                <span className="invoice-preview-qty">{p.dayRateQty} × {fmtCurrency(p.dayRate)}</span>
                <span className="invoice-preview-amount">{fmtCurrency(p.dayRateTotal)}</span>
              </div>
            ) : null}
            {p.totalOvertimeHours > 0 ? (
              <div className="invoice-preview-row">
                <InvoicePreviewLabel
                  label="OT"
                  description={resolveLineItemDescription("invoice_ot_description_override", DEFAULT_OT_DESCRIPTION)}
                />
                <span className="invoice-preview-qty">{fmtHours(p.totalOvertimeHours)} h × {fmtCurrency(p.overtimeRate)}</span>
                <span className="invoice-preview-amount">{fmtCurrency(p.overtimeTotal)}</span>
              </div>
            ) : null}
            {p.perDiemQty > 0 ? (
              <div className="invoice-preview-row">
                <InvoicePreviewLabel
                  label="Per Diem"
                  description={resolveLineItemDescription("invoice_per_diem_description_override")}
                />
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
                <InvoicePreviewLabel
                  label="Bag Fees"
                  description={resolveLineItemDescription("invoice_bag_fees_description_override")}
                />
                <span className="invoice-preview-qty" />
                <span className="invoice-preview-amount">{fmtCurrency(p.bagFees)}</span>
              </div>
            ) : null}
            {p.hotel > 0 ? (
              <div className="invoice-preview-row">
                <InvoicePreviewLabel
                  label="Hotel"
                  description={resolveLineItemDescription("invoice_hotel_description_override")}
                />
                <span className="invoice-preview-qty" />
                <span className="invoice-preview-amount">{fmtCurrency(p.hotel)}</span>
              </div>
            ) : null}
            {p.parking > 0 ? (
              <div className="invoice-preview-row">
                <InvoicePreviewLabel
                  label="Parking"
                  description={resolveLineItemDescription("invoice_parking_description_override")}
                />
                <span className="invoice-preview-qty" />
                <span className="invoice-preview-amount">{fmtCurrency(p.parking)}</span>
              </div>
            ) : null}
            {p.tolls > 0 ? (
              <div className="invoice-preview-row">
                <InvoicePreviewLabel
                  label="Tolls"
                  description={resolveLineItemDescription("invoice_tolls_description_override")}
                />
                <span className="invoice-preview-qty" />
                <span className="invoice-preview-amount">{fmtCurrency(p.tolls)}</span>
              </div>
            ) : null}
            {p.uber > 0 ? (
              <div className="invoice-preview-row">
                <InvoicePreviewLabel
                  label="Uber"
                  description={resolveLineItemDescription("invoice_uber_description_override")}
                />
                <span className="invoice-preview-qty" />
                <span className="invoice-preview-amount">{fmtCurrency(p.uber)}</span>
              </div>
            ) : null}
            {p.otherExpenses > 0 ? (
              <div className="invoice-preview-row">
                <InvoicePreviewLabel
                  label="Other"
                  description={resolveLineItemDescription("invoice_other_description_override")}
                />
                <span className="invoice-preview-qty" />
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
                    <dd>
                      {displayedInvoiceTotal != null ? fmtCurrency(displayedInvoiceTotal) : "—"}
                      {isSaving ? <span className="invoice-card-saving"> Saving…</span> : null}
                    </dd>
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
                {(invoiceSentAt || invoiceSentTo || invoiceSentSubject) ? (
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
                        {invoiceSentSubject ? (
                          <div className="invoice-sent-detail-row">
                            <span className="invoice-label-sm">Subject</span>
                            <span>{invoiceSentSubject}</span>
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

              {/* Normal action buttons — Review and Open PDF only */}
              <div className="invoice-pdf-buttons">
                {!emailDialog.open ? (
                  <button
                    type="button"
                    className="invoice-pdf-email-btn"
                    onClick={() => { void handleOpenReview(); }}
                    disabled={pdfState.status === "generating"}
                  >
                    {pdfState.action === "review" && pdfState.status === "generating"
                      ? "Updating…"
                      : "Review"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="invoice-pdf-link-btn"
                  onClick={() => { void handleOpenPdf(); }}
                  disabled={pdfState.status === "generating"}
                >
                  {pdfState.action === "open" && pdfState.status === "generating"
                    ? "Updating PDF…"
                    : "Open PDF"}
                </button>
              </div>

              {/* Email dialog — inline below action row */}
              {emailDialog.open ? (
                <EmailDialog
                  dialog={emailDialog}
                  onChange={setEmailDialog}
                  onSend={() => { void handleSendEmail(); }}
                  onClose={() => setEmailDialog(EMAIL_DIALOG_RESET)}
                  filename={emailFilename}
                />
              ) : null}

              {pdfState.status === "error" ? (
                <p className="invoice-error" role="alert">{pdfState.error}</p>
              ) : null}

              {/* Sheet sync status — small, non-intrusive; always visible when there is info */}
              {syncState.status === "success" && syncedLabel ? (
                <p className="invoice-sheet-sync-status">Sheet sync: Updated {syncedLabel}</p>
              ) : syncState.status === "error" ? (
                <p className="invoice-sheet-sync-status invoice-sheet-sync-status--warn">
                  Sheet sync warning — use Advanced → Sync to retry
                </p>
              ) : syncState.status === "syncing" ? (
                <p className="invoice-sheet-sync-status">Sheet sync: Syncing…</p>
              ) : null}

              {/* Advanced — collapsed by default; Download PDF / Regenerate / Sync live here */}
              <div className="invoice-advanced">
                <button
                  type="button"
                  className="invoice-advanced-toggle"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  aria-expanded={advancedOpen}
                >
                  Advanced {advancedOpen ? "▾" : "▸"}
                </button>
                {advancedOpen ? (
                  <div className="invoice-advanced-content">
                    <div className="invoice-advanced-buttons">
                      <button
                        type="button"
                        className="invoice-pdf-regen-btn"
                        onClick={() => { void handleDownloadPdf(); }}
                        disabled={pdfState.status === "generating"}
                      >
                        {pdfState.action === "download" && pdfState.status === "generating"
                          ? "Updating PDF…"
                          : "Download PDF"}
                      </button>
                      <button
                        type="button"
                        className="invoice-pdf-regen-btn"
                        onClick={() => { void handleCreatePdf(); }}
                        disabled={pdfState.status === "generating"}
                      >
                        {pdfState.action === "manual" && pdfState.status === "generating"
                          ? "Regenerating…"
                          : "Regenerate PDF"}
                      </button>
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
                    {sheetUrl ? (
                      <a
                        href={sheetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="invoice-sheet-link"
                      >
                        Open Google Sheet ↗
                      </a>
                    ) : (
                      <span className="invoice-sheet-link invoice-sheet-link--disabled">
                        Google Sheet not configured
                      </span>
                    )}
                    {syncState.status === "success" && syncedLabel ? (
                      <p className="invoice-sync-success">Sheet synced {syncedLabel}</p>
                    ) : syncState.status === "error" ? (
                      <p className="invoice-error" role="alert">{syncState.message ?? "Sheet sync failed — retry"}</p>
                    ) : null}
                  </div>
                ) : null}
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
                {pdfState.action === "manual" && pdfState.status === "generating"
                  ? "Generating PDF…"
                  : "Create Invoice PDF"}
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

    </div>
  );
}
