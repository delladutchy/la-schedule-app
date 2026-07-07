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
  buildMileageInvoicePresentationLines,
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
import {
  buildVerifiedMessage,
  isVerifyBlockingEmail,
  VERIFY_FAIL_MESSAGE,
} from "@/lib/invoice-pipeline";
import { InvoiceAttachments } from "@/components/InvoiceAttachments";

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

/**
 * Snap a UTC ISO string to the nearest 30-min TIME_OPTIONS value.
 *
 * Returns `undefined` when the local clock time is exactly midnight (00:00).
 * Midnight occurs for all-day Google Calendar events whose UTC boundary is
 * midnight in the display timezone — showing "12:00 AM" as a default for those
 * would be incorrect. Callers treat `undefined` as "no scheduled time / leave blank".
 */
export function snapUtcToTimeOption(utcIso: string): string | undefined {
  const d = new Date(utcIso);
  const totalMins = d.getHours() * 60 + d.getMinutes();
  if (totalMins === 0) return undefined; // midnight local = all-day event, no real time
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
  hasDuplicates?: boolean;
}

interface VerifyState {
  status: "idle" | "verifying" | "verified" | "failed";
  message: string | null;
  verifiedAt: string | null;
  autoRepaired: boolean;
  hasUnrelatedClutter: boolean;
}

const VERIFY_INITIAL: VerifyState = {
  status: "idle", message: null, verifiedAt: null, autoRepaired: false, hasUnrelatedClutter: false,
};

type WorkflowState =
  | "no_pdf"
  | "ready_to_review"
  | "ready_to_send"
  | "awaiting_payment"
  | "paid"
  | "needs_attention";

const WORKFLOW_LABELS: Record<WorkflowState, string> = {
  no_pdf:           "Needs invoice",
  ready_to_review:  "Ready to review",
  ready_to_send:    "Ready to send",
  awaiting_payment: "Waiting for payment",
  paid:             "Paid",
  needs_attention:  "Needs attention",
};

interface SheetDuplicateRow {
  rowNumber: number;
  invNumber: string;
  laNumber: string;
  date: string;
  total: string;
  gigEvent?: string;
}

interface SheetDuplicateGroup {
  key: string;
  rows: SheetDuplicateRow[];
  keepRow: number;
  deleteRows: number[];
}

interface SheetDuplicateState {
  status: "idle" | "checking" | "ready" | "deleting" | "error";
  message: string | null;
  duplicates: SheetDuplicateGroup[];
  totalDuplicateRows: number;
  deletedRows: number[];
}

interface SheetHealthEntryUI {
  rowNumber: number;
  invNumber: string;
  laNumber: string;
  date: string;
  total: string;
  status: string;
}

interface SheetHealthGroupUI {
  key: string;
  activeRows: SheetHealthEntryUI[];
  voidedRows: SheetHealthEntryUI[];
  syncRow: number | null;
  hasOneActiveRow: boolean;
  voidedRowsHaveZeroTotal: boolean;
}

interface SheetHealthState {
  status: "idle" | "checking" | "ready" | "error";
  message: string | null;
  totalActiveRows: number;
  totalVoidedRows: number;
  totalArchivedRows: number;
  totalUniqueKeys: number;
  activeDuplicateCount: number;
  voidedRowsWithMoneyCount: number;
  isClean: boolean;
  activeDuplicateGroups: SheetHealthGroupUI[];
  scannedAt: string | null;
  totalsRowNum: number | null;
  activeBelowTotalsCount: number;
  unknownBelowTotalsCount: number;
}

interface SheetRepairState {
  status: "idle" | "repairing" | "done" | "error";
  message: string | null;
  voidArchivedCount: number;
  duplicatesArchivedCount: number;
  rowsMovedCount: number;
  repairedAt: string | null;
}

interface SheetResetState {
  status: "idle" | "resetting" | "done" | "error";
  message: string | null;
  voidArchivedCount: number;
  testArchivedCount: number;
  duplicatesArchivedCount: number;
  belowTotalsMovedCount: number;
  goodRowsKept: number;
  formulasRebuilt: boolean;
  resetAt: string | null;
}

interface SheetResetPreviewRowUI {
  rowNumber: number;
  invNumber: string;
  laNumber: string;
  date: string;
  gigEvent: string;
  total: string;
  reason: "void" | "test" | "duplicate" | "keep";
}

interface SheetResetPreviewState {
  status: "idle" | "previewing" | "ready" | "error";
  message: string | null;
  voidRows: SheetResetPreviewRowUI[];
  testRows: SheetResetPreviewRowUI[];
  duplicateRows: SheetResetPreviewRowUI[];
  keepRows: SheetResetPreviewRowUI[];
  totalToArchive: number;
}

const RESET_PREVIEW_INITIAL: SheetResetPreviewState = {
  status: "idle", message: null,
  voidRows: [], testRows: [], duplicateRows: [], keepRows: [],
  totalToArchive: 0,
};

interface PdfState {
  status: "idle" | "generating" | "done" | "error";
  error: string | null;
  action: "open" | "download" | "review" | "manual" | null;
}

type SaveStatus = "idle" | "unsaved" | "saving" | "saved" | "error";

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
  /** Set on successful Gmail draft creation — used to show the "Open Draft" link. */
  draftUrl: string | null;
}

const EMAIL_DIALOG_RESET: EmailDialogState = {
  open: false, presetId: "", customTo: "", status: "idle", error: null,
  editableSubject: "", editableBody: "", draftUrl: null,
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
  onPendingChange?: (hasPending: boolean) => void;
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

function buildCurrentSheetDuplicateKeys(invoiceNumber: string | null, laNumber: string | null): Set<string> {
  const keys = new Set<string>();
  const cleanLa = emailCleanLa(laNumber);
  const cleanInv = (invoiceNumber ?? "").trim();
  if (cleanLa) keys.add(`la:${cleanLa}`);
  if (cleanInv) keys.add(`inv:${cleanInv}`);
  return keys;
}

function formatSheetDuplicateKey(key: string): string {
  if (key.startsWith("la:")) return `LA #${key.slice(3)}`;
  if (key.startsWith("inv:")) return `Invoice #${key.slice(4)}`;
  return key;
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

/**
 * Builds a `mailto:` link for the Apple Mail fallback button. Per RFC 6068,
 * only the query-string fields (cc/subject/body) need percent-encoding —
 * the `to` address list is joined with commas as-is.
 *
 * mailto cannot carry attachments, so this never references the PDF; the
 * separate "Open PDF" button stays visible for manual attachment.
 */
export function buildInvoiceMailtoHref(to: string[], cc: string[], subject: string, body: string): string {
  const toPart = to.join(",");
  const params: string[] = [];
  if (cc.length > 0) params.push(`cc=${encodeURIComponent(cc.join(","))}`);
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
  if (body) params.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${toPart}${params.length > 0 ? `?${params.join("&")}` : ""}`;
}

interface GmailDraftErrorResponse {
  code?: string;
  message?: string;
  detail?: string;
  error?: string;
}

const GMAIL_DRAFT_FALLBACK_ERROR = "Failed to create Gmail draft";

/**
 * Picks a human-readable error string from a failed gmail-draft API response.
 * `message` (set for typed errors like GMAIL_AUTH_INVALID_GRANT) always wins
 * over `detail`/`error` so raw provider text (e.g. "invalid_grant") never
 * reaches the UI.
 */
export function resolveGmailDraftErrorMessage(json: GmailDraftErrorResponse | null | undefined): string {
  return json?.message ?? json?.detail ?? json?.error ?? GMAIL_DRAFT_FALLBACK_ERROR;
}

// ---------------------------------------------------------------------------
// EmailDialog sub-component
// ---------------------------------------------------------------------------

interface EmailDialogProps {
  dialog: EmailDialogState;
  onChange: React.Dispatch<React.SetStateAction<EmailDialogState>>;
  /** Called when the user clicks the primary action (Create Gmail Draft). */
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
      <p className="invoice-block-label">Review &amp; Draft</p>

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
        <div className="invoice-gmail-draft-success">
          <p className="invoice-sync-success">Draft created successfully in Gmail.</p>
          {dialog.draftUrl ? (
            <a
              href={dialog.draftUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="invoice-gmail-draft-link"
            >
              Open Draft in Gmail →
            </a>
          ) : null}
          <a
            href={buildInvoiceMailtoHref(previewTo, previewCc, dialog.editableSubject, dialog.editableBody)}
            className="invoice-gmail-draft-link"
          >
            Open in Apple Mail →
          </a>
          <p className="invoice-status-muted">
            mailto links can&rsquo;t carry attachments — use Open PDF below to attach it manually.
          </p>
        </div>
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
            {isBusy ? "Creating draft…" : "Create Gmail Draft"}
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
  onPendingChange,
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
  const [workDaysExpanded, setWorkDaysExpanded] = useState(false);
  const [expensesExpanded, setExpensesExpanded] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [attachmentsExpanded, setAttachmentsExpanded] = useState(false);
  const [overrides, setOverrides] = useState<OverrideFields>({ ...EMPTY_OVERRIDE_FIELDS });
  const [editInvoiceExpanded, setEditInvoiceExpanded] = useState(false);
  const [adjustmentOverridesExpanded, setAdjustmentOverridesExpanded] = useState(false);
  const [lineItemOverrides, setLineItemOverrides] = useState<InvoiceLineItemOverrides>({});
  const [adjustmentDrafts, setAdjustmentDrafts] = useState<AdjustmentDrafts>({});
  const [autoMileage, setAutoMileage] = useState<AutoMileage | null>(null);
  const [autoMileageNote, setAutoMileageNote] = useState<AutoMileageNote | null>(
    jobLocation ? null : "no_location",
  );
  const [syncState, setSyncState] = useState<SyncState>({ status: "idle", message: null, syncedAt: null });
  const [sheetDuplicateState, setSheetDuplicateState] = useState<SheetDuplicateState>({
    status: "idle",
    message: null,
    duplicates: [],
    totalDuplicateRows: 0,
    deletedRows: [],
  });
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [sheetHealthState, setSheetHealthState] = useState<SheetHealthState>({
    status: "idle",
    message: null,
    totalActiveRows: 0,
    totalVoidedRows: 0,
    totalArchivedRows: 0,
    totalUniqueKeys: 0,
    activeDuplicateCount: 0,
    voidedRowsWithMoneyCount: 0,
    isClean: true,
    activeDuplicateGroups: [],
    scannedAt: null,
    totalsRowNum: null,
    activeBelowTotalsCount: 0,
    unknownBelowTotalsCount: 0,
  });
  const [sheetRepairState, setSheetRepairState] = useState<SheetRepairState>({
    status: "idle",
    message: null,
    voidArchivedCount: 0,
    duplicatesArchivedCount: 0,
    rowsMovedCount: 0,
    repairedAt: null,
  });
  const [sheetResetState, setSheetResetState] = useState<SheetResetState>({
    status: "idle",
    message: null,
    voidArchivedCount: 0,
    testArchivedCount: 0,
    duplicatesArchivedCount: 0,
    belowTotalsMovedCount: 0,
    goodRowsKept: 0,
    formulasRebuilt: false,
    resetAt: null,
  });
  const [sheetResetPreviewState, setSheetResetPreviewState] = useState<SheetResetPreviewState>(RESET_PREVIEW_INITIAL);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [isSaving, setIsSaving] = useState(false);
  const [pdfState, setPdfState] = useState<PdfState>({ status: "idle", error: null, action: null });
  const [renumberState, setRenumberState] = useState<RenumberState>({ status: "idle", error: null });
  const [emailDialog, setEmailDialog] = useState<EmailDialogState>(EMAIL_DIALOG_RESET);
  const [sentDetailsOpen, setSentDetailsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [verifyState, setVerifyState] = useState<VerifyState>(VERIFY_INITIAL);
  const [attachmentCount, setAttachmentCount] = useState<number | null>(null);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [recordPaymentAmount, setRecordPaymentAmount] = useState("");
  const [recordPaymentDate, setRecordPaymentDate] = useState("");
  const [recordPaymentMethod, setRecordPaymentMethod] = useState("Direct Deposit");
  const [recordPaymentRef, setRecordPaymentRef] = useState("");
  const [recordPaymentStatus, setRecordPaymentStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [recordPaymentError, setRecordPaymentError] = useState<string | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveVersionRef = useRef(0);
  const hasAutoExpandedWorkDays = useRef(false);
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
          const hydratedOverrides = hydrateOverrideFields(data);
          setOverrides(hydratedOverrides);
          setEditInvoiceExpanded(false);
          setExpensesExpanded(false);
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
          setEditInvoiceExpanded(false);
          setOverrides({ ...EMPTY_OVERRIDE_FIELDS });
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
    saveVersionRef.current += 1;
    const version = saveVersionRef.current;
    setSaveError(null);
    setSaveStatus("unsaved");
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

  useEffect(() => {
    const hasPending = saveStatus === "unsaved" || isSaving;
    onPendingChange?.(hasPending);
  }, [saveStatus, isSaving, onPendingChange]);

  // Auto-expand Advanced Recovery Tools when pipeline verification fails so
  // the user can see and use the manual tools without needing to know to open them.
  useEffect(() => {
    if (verifyState.status === "failed") setAdvancedOpen(true);
  }, [verifyState.status]);

  // Auto-expand Work Days once when data loads and no hours are calculated yet,
  // so the user sees the time entry fields immediately without needing to click.
  useEffect(() => {
    if (!hasAutoExpandedWorkDays.current && packet && packet.dayRateQty === 0) {
      hasAutoExpandedWorkDays.current = true;
      setWorkDaysExpanded(true);
    }
  }, [packet]);

  async function handleCheckSheetDuplicates(options: { silent?: boolean } = {}) {
    if (sheetDuplicateState.status === "checking" || sheetDuplicateState.status === "deleting") return;
    setSheetDuplicateState((prev) => ({
      ...prev,
      status: "checking",
      message: options.silent ? prev.message : null,
      deletedRows: [],
    }));

    try {
      const res = await fetch("/api/invoice/sheet-duplicates", {
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        cache: "no-store",
      });
      const json = await res.json().catch(() => ({})) as {
        duplicates?: SheetDuplicateGroup[];
        totalDuplicateRows?: number;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        setSheetDuplicateState((prev) => ({
          ...prev,
          status: "error",
          message: json.message ?? json.error ?? "Could not check Sheet duplicates.",
        }));
        return;
      }

      const duplicates = Array.isArray(json.duplicates) ? json.duplicates : [];
      const totalDuplicateRows = typeof json.totalDuplicateRows === "number"
        ? json.totalDuplicateRows
        : duplicates.reduce((sum, group) => sum + group.deleteRows.length, 0);
      setSheetDuplicateState({
        status: "ready",
        message: totalDuplicateRows > 0
          ? "Duplicate Sheet rows found. Review before relying on Sheet totals."
          : "No duplicate Sheet rows found.",
        duplicates,
        totalDuplicateRows,
        deletedRows: [],
      });
    } catch {
      setSheetDuplicateState((prev) => ({
        ...prev,
        status: "error",
        message: "Could not check Sheet duplicates — network error.",
      }));
    }
  }

  async function handleDeleteSheetDuplicates() {
    if (sheetDuplicateState.status === "checking" || sheetDuplicateState.status === "deleting") return;
    const deleteRows = sheetDuplicateState.duplicates.flatMap((group) => group.deleteRows);
    if (deleteRows.length === 0) return;

    const confirmed = window.confirm(
      `Archive ${deleteRows.length} duplicate Google Sheet row${deleteRows.length === 1 ? "" : "s"}?\n\n` +
      "This keeps ONE active row per invoice/job and archives only the extras.\n" +
      "It does NOT remove any invoice entirely — the invoice itself is preserved.\n" +
      "All archived rows are saved to the 'Voided Duplicates' tab first.\n\n" +
      "Proceed?"
    );
    if (!confirmed) return;

    setSheetDuplicateState((prev) => ({
      ...prev,
      status: "deleting",
      message: "Deleting duplicate Sheet rows…",
      deletedRows: [],
    }));

    try {
      const res = await fetch("/api/invoice/sheet-duplicates", {
        method: "POST",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        body: JSON.stringify({ deleteRows }),
      });
      const json = await res.json().catch(() => ({})) as {
        ok?: boolean;
        duplicates?: SheetDuplicateGroup[];
        totalDuplicateRows?: number;
        deletedRows?: number[];
        message?: string;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setSheetDuplicateState((prev) => ({
          ...prev,
          status: "error",
          message: json.message ?? json.error ?? "Could not delete duplicate Sheet rows.",
        }));
        return;
      }

      const duplicates = Array.isArray(json.duplicates) ? json.duplicates : [];
      const deletedRows = Array.isArray(json.deletedRows) ? json.deletedRows : [];
      const totalDuplicateRows = typeof json.totalDuplicateRows === "number"
        ? json.totalDuplicateRows
        : duplicates.reduce((sum, group) => sum + group.deleteRows.length, 0);

      setSheetDuplicateState({
        status: "ready",
        message: deletedRows.length > 0
          ? `Deleted duplicate Sheet row${deletedRows.length === 1 ? "" : "s"} ${deletedRows.sort((a, b) => a - b).join(", ")}.`
          : "No duplicate rows were deleted.",
        duplicates,
        totalDuplicateRows,
        deletedRows,
      });
    } catch {
      setSheetDuplicateState((prev) => ({
        ...prev,
        status: "error",
        message: "Could not delete duplicate Sheet rows — network error.",
      }));
    }
  }

  // ---------------------------------------------------------------------------
  // Sheet health check
  // ---------------------------------------------------------------------------

  async function handleSheetHealthCheck() {
    if (sheetHealthState.status === "checking") return;
    setSheetHealthState((prev) => ({ ...prev, status: "checking", message: null }));
    try {
      const res = await fetch("/api/invoice/sheet-health", {
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
      });
      const json = await res.json().catch(() => ({})) as {
        isClean?: boolean;
        totalActiveRows?: number;
        totalVoidedRows?: number;
        totalArchivedRows?: number;
        totalUniqueKeys?: number;
        activeDuplicateCount?: number;
        voidedRowsWithMoneyCount?: number;
        activeDuplicateGroups?: SheetHealthGroupUI[];
        scannedAt?: string;
        message?: string;
        totalsRowNum?: number | null;
        activeBelowTotalsCount?: number;
        unknownBelowTotalsCount?: number;
      };
      if (!res.ok) {
        setSheetHealthState((prev) => ({
          ...prev,
          status: "error",
          message: json.message ?? "Sheet health check failed — retry",
        }));
        return;
      }
      const isClean = json.isClean ?? true;
      const dupeCount = json.activeDuplicateCount ?? 0;
      const badVoidCount = json.voidedRowsWithMoneyCount ?? 0;
      const archived = json.totalArchivedRows ?? 0;
      const belowTotals = json.activeBelowTotalsCount ?? 0;
      const unknownBelowTotals = json.unknownBelowTotalsCount ?? 0;
      const summary = isClean
        ? `Sheet is clean — ${json.totalActiveRows ?? 0} active rows, ${json.totalUniqueKeys ?? 0} unique keys${archived > 0 ? `, ${archived} archived` : ""}.`
        : [
            dupeCount > 0 ? `${dupeCount} key${dupeCount > 1 ? "s" : ""} with active duplicates.` : null,
            badVoidCount > 0 ? `${badVoidCount} voided row${badVoidCount > 1 ? "s" : ""} still have money (Sheet totals may be overstated).` : null,
            belowTotals > 0 ? `${belowTotals} active row${belowTotals > 1 ? "s" : ""} below TOTALS (outside SUM formula range).` : null,
            unknownBelowTotals > 0 ? `${unknownBelowTotals} unclassified row${unknownBelowTotals > 1 ? "s" : ""} below TOTALS left untouched.` : null,
          ].filter(Boolean).join(" ");
      setSheetHealthState({
        status: "ready",
        message: summary,
        totalActiveRows: json.totalActiveRows ?? 0,
        totalVoidedRows: json.totalVoidedRows ?? 0,
        totalArchivedRows: archived,
        totalUniqueKeys: json.totalUniqueKeys ?? 0,
        activeDuplicateCount: dupeCount,
        voidedRowsWithMoneyCount: badVoidCount,
        isClean,
        activeDuplicateGroups: json.activeDuplicateGroups ?? [],
        scannedAt: json.scannedAt ?? null,
        totalsRowNum: json.totalsRowNum ?? null,
        activeBelowTotalsCount: belowTotals,
        unknownBelowTotalsCount: unknownBelowTotals,
      });
    } catch {
      setSheetHealthState((prev) => ({
        ...prev,
        status: "error",
        message: "Sheet health check failed — network error.",
      }));
    }
  }

  // ---------------------------------------------------------------------------
  // Sheet repair
  // ---------------------------------------------------------------------------

  async function handleRepairSheet() {
    if (sheetRepairState.status === "repairing") return;
    const confirmed = window.confirm(
      "Repair Sheet Layout?\n\n" +
      "This will:\n" +
      "  • Archive and remove VOID_DUPLICATE rows from the main sheet\n" +
      "  • Archive and remove active duplicate rows below TOTALS\n" +
      "  • Move misplaced active rows to above the TOTALS line\n\n" +
      "All removed rows are archived to 'Voided Duplicates' first.\n" +
      "Unrelated rows and rows above TOTALS are never touched.\n\n" +
      "Proceed?"
    );
    if (!confirmed) return;

    setSheetRepairState({ status: "repairing", message: null, voidArchivedCount: 0, duplicatesArchivedCount: 0, rowsMovedCount: 0, repairedAt: null });
    try {
      const res = await fetch("/api/invoice/sheet-repair", {
        method: "POST",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
      });
      const json = await res.json().catch(() => ({})) as {
        ok?: boolean;
        message?: string;
        voidArchivedCount?: number;
        duplicatesArchivedCount?: number;
        rowsMovedCount?: number;
        repairedAt?: string;
      };
      if (!res.ok) {
        setSheetRepairState((prev) => ({ ...prev, status: "error", message: json.message ?? "Repair failed — retry" }));
        return;
      }
      setSheetRepairState({
        status: "done",
        message: json.message ?? "Repair complete.",
        voidArchivedCount: json.voidArchivedCount ?? 0,
        duplicatesArchivedCount: json.duplicatesArchivedCount ?? 0,
        rowsMovedCount: json.rowsMovedCount ?? 0,
        repairedAt: json.repairedAt ?? null,
      });
      // Refresh health state after repair
      void handleSheetHealthCheck();
    } catch {
      setSheetRepairState((prev) => ({ ...prev, status: "error", message: "Repair failed — network error." }));
    }
  }

  // ---------------------------------------------------------------------------
  // Sheet reset / clean start
  // ---------------------------------------------------------------------------

  async function handlePreviewReset() {
    if (sheetResetPreviewState.status === "previewing") return;
    setSheetResetPreviewState({ ...RESET_PREVIEW_INITIAL, status: "previewing" });
    try {
      const res = await fetch("/api/invoice/sheet-reset", {
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
      });
      const json = await res.json().catch(() => ({})) as {
        voidRows?: SheetResetPreviewRowUI[];
        testRows?: SheetResetPreviewRowUI[];
        duplicateRows?: SheetResetPreviewRowUI[];
        keepRows?: SheetResetPreviewRowUI[];
        totalToArchive?: number;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        setSheetResetPreviewState({ ...RESET_PREVIEW_INITIAL, status: "error", message: json.message ?? json.error ?? "Could not load preview." });
        return;
      }
      setSheetResetPreviewState({
        status: "ready",
        message: null,
        voidRows:      Array.isArray(json.voidRows)      ? json.voidRows      : [],
        testRows:      Array.isArray(json.testRows)      ? json.testRows      : [],
        duplicateRows: Array.isArray(json.duplicateRows) ? json.duplicateRows : [],
        keepRows:      Array.isArray(json.keepRows)      ? json.keepRows      : [],
        totalToArchive: typeof json.totalToArchive === "number" ? json.totalToArchive : 0,
      });
    } catch {
      setSheetResetPreviewState({ ...RESET_PREVIEW_INITIAL, status: "error", message: "Could not load preview — network error." });
    }
  }

  async function handleResetSheet() {
    if (sheetResetState.status === "resetting") return;

    setSheetResetState({
      status: "resetting", message: null,
      voidArchivedCount: 0, testArchivedCount: 0, duplicatesArchivedCount: 0,
      belowTotalsMovedCount: 0, goodRowsKept: 0, formulasRebuilt: false, resetAt: null,
    });
    try {
      const res = await fetch("/api/invoice/sheet-reset", {
        method: "POST",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
      });
      const json = await res.json().catch(() => ({})) as {
        ok?: boolean;
        message?: string;
        voidArchivedCount?: number;
        testArchivedCount?: number;
        duplicatesArchivedCount?: number;
        belowTotalsMovedCount?: number;
        goodRowsKept?: number;
        formulasRebuilt?: boolean;
        resetAt?: string;
      };
      if (!res.ok) {
        setSheetResetState((prev) => ({ ...prev, status: "error", message: json.message ?? "Reset failed — retry" }));
        return;
      }
      setSheetResetState({
        status: "done",
        message: json.message ?? "Reset complete.",
        voidArchivedCount:       json.voidArchivedCount       ?? 0,
        testArchivedCount:       json.testArchivedCount       ?? 0,
        duplicatesArchivedCount: json.duplicatesArchivedCount ?? 0,
        belowTotalsMovedCount:   json.belowTotalsMovedCount   ?? 0,
        goodRowsKept:            json.goodRowsKept            ?? 0,
        formulasRebuilt:         json.formulasRebuilt         ?? false,
        resetAt:                 json.resetAt                 ?? null,
      });
      // Refresh health state and clear preview after reset
      setSheetResetPreviewState(RESET_PREVIEW_INITIAL);
      void handleSheetHealthCheck();
    } catch {
      setSheetResetState((prev) => ({ ...prev, status: "error", message: "Reset failed — network error." }));
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
        hasDuplicates?: boolean;
        archivedRows?: number[];
        keptRow?: number;
        autoRepaired?: boolean;
        formulasRepaired?: boolean;
        hasUnrelatedClutter?: boolean;
        sheetTarget?: { sheetId?: string | null; sheetName?: string };
      };
      if (res.ok) {
        setSyncState({
          status: "success",
          message: json.message ?? null,
          syncedAt: json.syncedAt ?? null,
          hasDuplicates: json.hasDuplicates === true,
        });
        // Skip the silent duplicate check when the server already confirmed the
        // sheet is clean for this invoice (autoRepaired covers current duplicates).
        // If unrelated clutter exists, the message from the server already says so.
        if (!json.autoRepaired && !json.hasUnrelatedClutter) {
          void handleCheckSheetDuplicates({ silent: true });
        }
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
  // Verified pipeline — the core normal-workflow action.
  //
  // Steps:
  //   1. Autosave pending edits (flush)
  //   2. Regenerate a fresh PDF
  //   3. Sync / update Google Sheet (includes auto-repair, duplicate archiving,
  //      formula rebuild — all handled server-side by upsertSheetRow)
  //   4. Verify: PDF URL exists + Sheet sync succeeded → set verified message
  //
  // All three primary actions (Review, Open PDF, and Send Invoice gate) run
  // through this function.  On any failure: verifyState.status = "failed",
  // Advanced Recovery Tools auto-expand, email send is blocked.
  // ---------------------------------------------------------------------------

  async function runVerifiedPipeline(): Promise<{ success: boolean; pdfUrl: string | null }> {
    const prevSyncedAt = syncState.syncedAt; // capture before any awaits
    setVerifyState({ status: "verifying", message: null, verifiedAt: null, autoRepaired: false, hasUnrelatedClutter: false });

    // ── Step 1: Autosave ─────────────────────────────────────────────────────
    const saved = await flushCurrentInvoiceInputs();
    if (!saved) {
      setVerifyState({ status: "failed", message: VERIFY_FAIL_MESSAGE, verifiedAt: null, autoRepaired: false, hasUnrelatedClutter: false });
      return { success: false, pdfUrl: null };
    }

    // ── Step 2: Regenerate PDF ───────────────────────────────────────────────
    let pdfUrl: string | null = null;
    try {
      const pdfRes = await fetch(`/api/invoice/pdf/${encodeURIComponent(eventId)}`, {
        method: "POST",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        body: JSON.stringify({ gigSummary }),
      });
      const pdfJson = await pdfRes.json() as InvoicePdfMetadataResponse;
      if (!pdfRes.ok || !pdfJson.ok) {
        setPdfState({ status: "error", error: pdfJson.detail ?? pdfJson.error ?? "PDF generation failed", action: null });
        setVerifyState({ status: "failed", message: VERIFY_FAIL_MESSAGE, verifiedAt: null, autoRepaired: false, hasUnrelatedClutter: false });
        return { success: false, pdfUrl: null };
      }
      const pdfMeta = normalizeInvoicePdfMetadata(pdfJson);
      pdfUrl = pdfMeta.invoicePdfUrl;
      setInvoiceData((prev) => mergeInvoicePdfMetadata(prev, pdfMeta));
      setPdfState({ status: "done", error: null, action: null });
    } catch {
      setPdfState({ status: "error", error: "Network error — PDF not generated", action: null });
      setVerifyState({ status: "failed", message: VERIFY_FAIL_MESSAGE, verifiedAt: null, autoRepaired: false, hasUnrelatedClutter: false });
      return { success: false, pdfUrl: null };
    }

    if (!pdfUrl) {
      setVerifyState({ status: "failed", message: VERIFY_FAIL_MESSAGE, verifiedAt: null, autoRepaired: false, hasUnrelatedClutter: false });
      return { success: false, pdfUrl: null };
    }

    // ── Step 3: Sync Google Sheet ─────────────────────────────────────────────
    let autoRepaired = false;
    let hasUnrelatedClutter = false;
    let newSyncedAt: string | null = null;
    try {
      const syncRes = await fetch("/api/invoice/sync-sheet", {
        method: "POST",
        headers: buildAuthHeaders(editorToken),
        credentials: "same-origin",
        body: JSON.stringify({ eventId, gigSummary }),
      });
      const syncJson = await syncRes.json().catch(() => ({})) as {
        syncedAt?: string;
        message?: string;
        autoRepaired?: boolean;
        formulasRepaired?: boolean;
        hasUnrelatedClutter?: boolean;
      };
      if (!syncRes.ok) {
        setSyncState({ status: "error", message: syncJson.message ?? "Sheet sync failed — retry", syncedAt: prevSyncedAt });
        setVerifyState({ status: "failed", message: VERIFY_FAIL_MESSAGE, verifiedAt: null, autoRepaired: false, hasUnrelatedClutter: false });
        return { success: false, pdfUrl: null };
      }
      autoRepaired = syncJson.autoRepaired ?? false;
      hasUnrelatedClutter = syncJson.hasUnrelatedClutter ?? false;
      newSyncedAt = syncJson.syncedAt ?? null;
      setSyncState({ status: "success", message: syncJson.message ?? null, syncedAt: newSyncedAt });
    } catch {
      setSyncState({ status: "error", message: "Sheet sync failed — network error", syncedAt: prevSyncedAt });
      setVerifyState({ status: "failed", message: VERIFY_FAIL_MESSAGE, verifiedAt: null, autoRepaired: false, hasUnrelatedClutter: false });
      return { success: false, pdfUrl: null };
    }

    // ── Step 4: Verified ─────────────────────────────────────────────────────
    // PDF URL exists + Sheet sync succeeded + auto-repair / formula rebuild
    // handled server-side. Build the user-facing message.
    const verifyMessage = buildVerifiedMessage(autoRepaired, hasUnrelatedClutter);
    setVerifyState({
      status: "verified",
      message: verifyMessage,
      verifiedAt: newSyncedAt ?? new Date().toISOString(),
      autoRepaired,
      hasUnrelatedClutter,
    });

    // Background: refresh full invoice state (non-blocking, picks up DB changes).
    void refreshInvoiceState(normalizeInvoicePdfMetadata({ invoice_pdf_url: pdfUrl, ok: true }));

    return { success: true, pdfUrl };
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

  // Open PDF: run verified pipeline, then open the fresh URL in a new tab.
  async function handleOpenPdf() {
    const { success, pdfUrl } = await runVerifiedPipeline();
    if (!success || !pdfUrl) return; // verifyState already set to "failed"
    window.open(pdfUrl, "_blank", "noopener,noreferrer");
  }

  // Download PDF (Advanced Recovery Tools only): regenerate + download.
  async function handleDownloadPdf() {
    const url = await generateFreshPdf("download");
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = buildPdfFilename(invoiceNumber, laNumber);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // Review: run verified pipeline, then open the email/review dialog.
  // Dialog only opens when pipeline fully verified — PDF + Sheet confirmed.
  async function handleOpenReview() {
    const { success } = await runVerifiedPipeline();
    if (!success) return; // verifyState already set to "failed"
    // Seed editable fields with computed defaults so the user can adjust before sending.
    setEmailDialog({ ...EMAIL_DIALOG_RESET, open: true, editableSubject: emailSubject, editableBody: emailBody });
  }

  // Manual/advanced regeneration (Advanced Recovery Tools only; also used by renumber flow).
  async function handleCreatePdf() {
    await generateFreshPdf("manual");
  }

  async function handleRecordPayment(e: React.FormEvent) {
    e.preventDefault();
    if (recordPaymentStatus === "submitting") return;
    setRecordPaymentStatus("submitting");
    setRecordPaymentError(null);

    const amountNum = parseFloat(recordPaymentAmount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setRecordPaymentError("Enter a valid amount greater than $0.");
      setRecordPaymentStatus("error");
      return;
    }
    if (!recordPaymentDate) {
      setRecordPaymentError("Payment date is required.");
      setRecordPaymentStatus("error");
      return;
    }

    const invoiceTotal = invoiceData?.invoice_total ?? p?.estimatedTotal ?? null;

    const body: Record<string, unknown> = {
      amount_paid: amountNum,
      paid_date: recordPaymentDate,
      payment_method: recordPaymentMethod,
      reference: recordPaymentRef.trim() || undefined,
    };
    if (invoiceTotal != null) body.invoice_total = invoiceTotal;

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (editorToken) headers.Authorization = `Bearer ${editorToken}`;
      const res = await fetch(`/api/invoice/record-payment/${encodeURIComponent(eventId)}`, {
        method: "POST",
        headers,
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json() as { detail?: string; error?: string };
        throw new Error(json.detail ?? json.error ?? `HTTP ${res.status}`);
      }
      // Refresh invoice data to reflect updated status and payment totals
      const refreshRes = await fetch(`/api/invoice/${encodeURIComponent(eventId)}`, {
        headers: editorToken ? { Authorization: `Bearer ${editorToken}` } : {},
        credentials: "same-origin",
        cache: "no-store",
      });
      if (refreshRes.ok) {
        const refreshJson = await refreshRes.json() as { invoiceData: InvoiceData | null; packet: InvoicePacket | null };
        if (refreshJson.invoiceData) {
          setInvoiceData(refreshJson.invoiceData);
          setPacket(refreshJson.packet ?? calculateInvoicePacket(refreshJson.invoiceData));
        }
      }
      setRecordPaymentStatus("success");
      setRecordPaymentOpen(false);
      setRecordPaymentAmount("");
      setRecordPaymentDate("");
      setRecordPaymentMethod("Direct Deposit");
      setRecordPaymentRef("");
    } catch (err) {
      setRecordPaymentError(err instanceof Error ? err.message : "Failed to record payment.");
      setRecordPaymentStatus("error");
    }
  }

  async function handleSendEmail() {
    if (emailDialog.status === "sending") return;

    // Block if the verified pipeline has not confirmed this invoice.
    if (isVerifyBlockingEmail(verifyState.status)) {
      setEmailDialog((prev) => ({
        ...prev,
        status: "error",
        error: "Invoice not verified — close this dialog, click Review, and try again.",
      }));
      return;
    }

    // Resolve addresses.
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
      setEmailDialog((prev) => ({ ...prev, error: "Select a recipient before creating a draft." }));
      return;
    }

    setEmailDialog((prev) => ({ ...prev, status: "sending", error: null }));
    try {
      const flushed = await flushCurrentInvoiceInputs();
      if (!flushed) {
        setEmailDialog((prev) => ({
          ...prev,
          status: "error",
          error: "Could not save the latest invoice changes — draft was not created.",
        }));
        return;
      }

      const res = await fetch(`/api/invoice/gmail-draft/${encodeURIComponent(eventId)}`, {
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
        ok?: boolean; error?: string; detail?: string; code?: string; message?: string;
        draftId?: string; draftUrl?: string; subject?: string;
        invoice_pdf_url?: string;
      };
      if (!res.ok || !json.ok) {
        setEmailDialog((prev) => ({
          ...prev,
          status: "error",
          error: resolveGmailDraftErrorMessage(json),
        }));
        return;
      }
      // Optimistically update PDF URL if refreshed.
      if (json.invoice_pdf_url) {
        setInvoiceData((prev) => prev ? { ...prev, invoice_pdf_url: json.invoice_pdf_url! } : prev);
      }
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
      setEmailDialog((prev) => ({ ...prev, status: "success", error: null, draftUrl: json.draftUrl ?? null }));
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
  const isVerifying = verifyState.status === "verifying";
  const showMileage = m != null && m.totalMiles > 0;
  const mileagePreviewLines = buildMileageInvoicePresentationLines(m);

  const syncedLabel = syncState.syncedAt
    ? (() => {
        try {
          return new Date(syncState.syncedAt).toLocaleString("en-US", {
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
          });
        } catch { return syncState.syncedAt; }
      })()
    : null;

  const verifiedLabel = verifyState.verifiedAt
    ? (() => {
        try {
          return new Date(verifyState.verifiedAt).toLocaleString("en-US", {
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
          });
        } catch { return verifyState.verifiedAt; }
      })()
    : null;

  const currentStatus = invoiceData?.invoice_status;
  const isTerminal = !!(currentStatus && TERMINAL_STATUSES.has(currentStatus));
  const pdfUrl = invoiceData?.invoice_pdf_url ?? null;
  const hasPdf = !!pdfUrl;
  const invoiceNumber = invoiceData?.invoice_number ?? null;
  const laNumber = invoiceData?.la_number ?? null;
  const currentSheetDuplicateKeys = buildCurrentSheetDuplicateKeys(invoiceNumber, laNumber);
  const currentSheetDuplicateGroups = sheetDuplicateState.duplicates.filter((group) =>
    currentSheetDuplicateKeys.has(group.key),
  );
  const hasCurrentSheetDuplicates = currentSheetDuplicateGroups.length > 0;
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

  const workflowState: WorkflowState = !hasPdf
    ? "no_pdf"
    : verifyState.status === "failed"
      ? "needs_attention"
      : currentStatus === "paid"
        ? "paid"
        : (currentStatus === "sent" || currentStatus === "partially_paid")
          ? "awaiting_payment"
          : verifyState.status === "verified"
            ? "ready_to_send"
            : "ready_to_review";
  const workflowLabel = WORKFLOW_LABELS[workflowState];
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
  // Day Rate description is always auto-derived from Work Days; not editable here.
  const lineItemDescriptionFields = p
    ? [
        {
          field: "invoice_ot_description_override" as const,
          label: "OT",
          defaultDescription: DEFAULT_OT_DESCRIPTION,
          rows: 2,
          visible: p.overtimeTotal > 0,
        },
        {
          field: "invoice_per_diem_description_override" as const,
          label: "Per Diem",
          defaultDescription: "",
          rows: 2,
          visible: p.perDiemTotal > 0,
        },
        {
          field: "invoice_bag_fees_description_override" as const,
          label: "Bag Fees",
          defaultDescription: "",
          rows: 2,
          visible: p.bagFees > 0,
        },
        {
          field: "invoice_parking_description_override" as const,
          label: "Parking",
          defaultDescription: "",
          rows: 2,
          visible: p.parking > 0,
        },
        {
          field: "invoice_uber_description_override" as const,
          label: "Uber",
          defaultDescription: "",
          rows: 2,
          visible: p.uber > 0,
        },
        {
          field: "invoice_tolls_description_override" as const,
          label: "Tolls",
          defaultDescription: "",
          rows: 2,
          visible: p.tolls > 0,
        },
        {
          field: "invoice_hotel_description_override" as const,
          label: "Hotel",
          defaultDescription: "",
          rows: 2,
          visible: p.hotel > 0,
        },
        {
          field: "invoice_other_description_override" as const,
          label: "Other",
          defaultDescription: "",
          rows: 2,
          visible: p.otherExpenses > 0,
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

  // ── Summary values for collapsed section headers ─────────────────────────
  const workDaysTotalHours = p
    ? p.workdays.reduce((sum, w) => sum + w.totalHours, 0)
    : 0;
  const expensesTotal = (["bag_fees", "hotel", "parking", "tolls", "uber", "other_expenses"] as const)
    .reduce((sum, field) => sum + (parseExpenseInput(expenses[field]) ?? 0), 0);

  return (
    <div
      className="invoice-section"
      onKeyDown={(event) => {
        if (isEditableKeyboardTarget(event.target)) event.stopPropagation();
      }}
    >
      <p className="board-day-modal-event-label">Invoice / Tracking</p>

      {saveError ? <p className="invoice-error" role="alert">{saveError}</p> : null}

      {/* ── Invoice card: status, totals, actions ─────────────────── */}
      {p ? (
        <div className="invoice-block invoice-pdf-block">
          {isSaving ? <span className="invoice-saving-indicator">Saving…</span> : null}

          {hasPdf ? (
            <div className="invoice-pdf-actions">
              <div className="invoice-status-card">
                <div className="invoice-status-card-header">
                  <div>
                    <p className="invoice-pdf-number">Invoice #{invoiceNumber ?? "—"}</p>
                    {laNumber ? (
                      <p className="invoice-pdf-la-number">LA Job #{laNumber}</p>
                    ) : null}
                  </div>
                  <span className="invoice-status-pill" data-status={workflowState}>
                    {workflowLabel}
                  </span>
                </div>
                <dl className="invoice-status-grid">
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

              {/* Action buttons — primary action depends on workflow state */}
              <div className="invoice-pdf-buttons">
                {!emailDialog.open && workflowState !== "awaiting_payment" && workflowState !== "paid" ? (
                  <button
                    type="button"
                    className="invoice-pdf-email-btn"
                    onClick={() => { void handleOpenReview(); }}
                    disabled={isVerifying || pdfState.status === "generating"}
                  >
                    {isVerifying
                      ? "Verifying…"
                      : workflowState === "ready_to_send"
                        ? "Create Gmail Draft"
                        : "Review Invoice"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="invoice-pdf-link-btn invoice-pdf-link-btn--secondary"
                  onClick={() => { void handleOpenPdf(); }}
                  disabled={isVerifying || pdfState.status === "generating"}
                >
                  {isVerifying ? "Verifying…" : "Open PDF"}
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

              {/* Verified status line — driven by the pipeline; falls back to legacy sync status */}
              {verifyState.status === "verified" ? (
                <p className="invoice-verify-status invoice-verify-status--ok">
                  ✓ Verified{verifiedLabel ? ` · ${verifiedLabel}` : ""}
                </p>
              ) : verifyState.status === "failed" ? (
                <p className="invoice-verify-status invoice-verify-status--fail" role="alert">
                  ⚠ {verifyState.message ?? VERIFY_FAIL_MESSAGE}
                </p>
              ) : verifyState.status === "verifying" ? (
                <p className="invoice-verify-status">Verifying…</p>
              ) : syncState.status === "success" && syncedLabel ? (
                <p className="invoice-sheet-sync-status">
                  {syncState.message ?? "Sheet updated"} · {syncedLabel}
                </p>
              ) : syncState.status === "error" ? (
                <p className="invoice-sheet-sync-status invoice-sheet-sync-status--warn">
                  Sheet sync warning — use Advanced Recovery Tools to retry
                </p>
              ) : null}

              {syncState.hasDuplicates ? (
                <p className="invoice-sheet-sync-status invoice-sheet-sync-status--warn" role="alert">
                  ⚠ Duplicate Sheet rows were auto-cleaned during sync. Open Advanced → Sheet Health Check to verify.
                </p>
              ) : null}

              {pdfState.status === "error" ? (
                <p className="invoice-error" role="alert">{pdfState.error}</p>
              ) : null}
            </div>
          ) : (
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

      {/* ── Record as Already Paid ─────────────────────────────────── */}
      {p && currentStatus !== "void" ? (
        <div className="invoice-block invoice-record-payment-block">
          <button
            type="button"
            className="invoice-collapsible-toggle"
            onClick={() => {
              setRecordPaymentOpen((v) => !v);
              setRecordPaymentError(null);
              setRecordPaymentStatus("idle");
            }}
            aria-expanded={recordPaymentOpen}
          >
            <span className="invoice-block-label">Record as Already Paid</span>
            <span className="invoice-collapsible-meta">
              {currentStatus === "paid" ? (
                <span className="invoice-collapsible-summary invoice-status-paid-chip">
                  ✓ Paid{invoiceData?.paid_date ? ` ${invoiceData.paid_date}` : ""}
                </span>
              ) : currentStatus === "partially_paid" ? (
                <span className="invoice-collapsible-summary">Partial — ${amountPaid.toFixed(2)} of {displayedInvoiceTotal != null ? `$${displayedInvoiceTotal.toFixed(2)}` : "?"}</span>
              ) : null}
              <span className="invoice-collapsible-chevron">{recordPaymentOpen ? "▲" : "▼"}</span>
            </span>
          </button>
          {recordPaymentOpen ? (
            <form
              className="invoice-record-payment-form"
              onSubmit={(e) => { void handleRecordPayment(e); }}
            >
              <div className="invoice-record-payment-row">
                <label className="invoice-record-payment-label" htmlFor="rp-amount">Amount Received</label>
                <input
                  id="rp-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  className="invoice-record-payment-input"
                  placeholder="0.00"
                  value={recordPaymentAmount}
                  onChange={(e) => setRecordPaymentAmount(e.target.value)}
                  required
                />
              </div>
              <div className="invoice-record-payment-row">
                <label className="invoice-record-payment-label" htmlFor="rp-date">Date Received</label>
                <input
                  id="rp-date"
                  type="date"
                  className="invoice-record-payment-input"
                  value={recordPaymentDate}
                  onChange={(e) => setRecordPaymentDate(e.target.value)}
                  required
                />
              </div>
              <div className="invoice-record-payment-row">
                <label className="invoice-record-payment-label" htmlFor="rp-method">Payment Method</label>
                <select
                  id="rp-method"
                  className="invoice-record-payment-input"
                  value={recordPaymentMethod}
                  onChange={(e) => setRecordPaymentMethod(e.target.value)}
                >
                  <option>Direct Deposit</option>
                  <option>Check</option>
                  <option>Cash</option>
                  <option>Wire Transfer</option>
                  <option>Other</option>
                </select>
              </div>
              <div className="invoice-record-payment-row">
                <label className="invoice-record-payment-label" htmlFor="rp-ref">Reference / Note</label>
                <input
                  id="rp-ref"
                  type="text"
                  className="invoice-record-payment-input"
                  placeholder="Check #, memo, etc."
                  value={recordPaymentRef}
                  onChange={(e) => setRecordPaymentRef(e.target.value)}
                />
              </div>
              {(() => {
                const amt = parseFloat(recordPaymentAmount);
                const total = invoiceData?.invoice_total ?? p?.estimatedTotal ?? null;
                if (Number.isFinite(amt) && total != null && amt > total + 0.005) {
                  return (
                    <p className="invoice-record-payment-warn">
                      Amount (${amt.toFixed(2)}) exceeds invoice total (${total.toFixed(2)}). Overpayment will be recorded.
                    </p>
                  );
                }
                return null;
              })()}
              {recordPaymentError ? (
                <p className="invoice-error" role="alert">{recordPaymentError}</p>
              ) : null}
              <div className="invoice-record-payment-actions">
                <button
                  type="submit"
                  className="invoice-record-payment-submit"
                  disabled={recordPaymentStatus === "submitting"}
                >
                  {recordPaymentStatus === "submitting" ? "Recording…" : "Record Payment"}
                </button>
                <button
                  type="button"
                  className="invoice-record-payment-cancel"
                  onClick={() => {
                    setRecordPaymentOpen(false);
                    setRecordPaymentError(null);
                    setRecordPaymentStatus("idle");
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}

      {/* ── Work Dates / Hours + per-day mileage ─────────────────── */}
      <div className="invoice-block">
        <button
          type="button"
          className="invoice-collapsible-toggle"
          onClick={() => setWorkDaysExpanded((prev) => !prev)}
          aria-expanded={workDaysExpanded}
        >
          <span className="invoice-block-label">Work Days</span>
          <span className="invoice-collapsible-meta">
            {p && workDaysTotalHours > 0 ? (
              <span className="invoice-collapsible-summary">
                {workdayEntries.length} {workdayEntries.length === 1 ? "day" : "days"} · {fmtHours(workDaysTotalHours)} hrs
                {p.totalOvertimeHours > 0 ? ` · ${fmtHours(p.totalOvertimeHours)} OT` : ""}
              </span>
            ) : (
              <span className="invoice-collapsible-summary">{workdayEntries.length} {workdayEntries.length === 1 ? "day" : "days"}</span>
            )}
            <span className="invoice-collapsible-chevron">{workDaysExpanded ? "▲" : "Edit ▼"}</span>
          </span>
        </button>
        {workDaysExpanded ? (
          <div className="invoice-collapsible-content">
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
        ) : null}
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
          <span className="invoice-block-label">Expenses</span>
          <span className="invoice-collapsible-meta">
            {expensesTotal > 0 ? (
              <span className="invoice-collapsible-summary">{fmtCurrency(expensesTotal)}</span>
            ) : null}
            <span className="invoice-collapsible-chevron">{expensesExpanded ? "▲" : "Edit ▼"}</span>
          </span>
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

      {/* ── Edit Invoice (text overrides + line item adjustments, collapsed by default) ── */}
      <div className="invoice-block">
        <button
          type="button"
          className="invoice-collapsible-toggle"
          onClick={() => setEditInvoiceExpanded((prev) => !prev)}
          aria-expanded={editInvoiceExpanded}
        >
          <span className="invoice-block-label">Edit Invoice</span>
          <span className="invoice-collapsible-meta">
            {saveStatus !== "idle" ? (
              <span className="invoice-save-status" data-status={saveStatus}>
                {saveStatus === "unsaved"
                  ? "Unsaved changes"
                  : saveStatus === "saving"
                    ? "Saving…"
                    : saveStatus === "saved"
                      ? "Saved"
                      : "Save failed"}
              </span>
            ) : null}
            {customAdjustmentCount > 0 ? (
              <span className="invoice-adjustment-alert">{customAdjustmentCount} custom</span>
            ) : null}
            <span className="invoice-collapsible-chevron">{editInvoiceExpanded ? "▲" : "▼"}</span>
          </span>
        </button>
        {editInvoiceExpanded ? (
          <div className="invoice-collapsible-content">
            <div className="invoice-override-field">
              <label className="invoice-label-sm" htmlFor="inv-override-job">Job name</label>
              <input
                id="inv-override-job"
                type="text"
                className="invoice-input invoice-override-input"
                value={overrides.invoice_job_name_override}
                onChange={(e) => handleOverrideChange("invoice_job_name_override", e.target.value)}
                placeholder={autoPreviewJobTitle || ""}
              />
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
                    placeholder={fieldConfig.defaultDescription || ""}
                    rows={fieldConfig.rows}
                  />
                </div>
              );
            })}
            <div className="invoice-override-field">
              <label className="invoice-label-sm" htmlFor="inv-override-note">Note</label>
              <textarea
                id="inv-override-note"
                className="invoice-textarea invoice-override-textarea"
                value={invoiceNoteText}
                onChange={(e) => handleOverrideChange("invoice_note_override", e.target.value)}
                placeholder={DEFAULT_INVOICE_NOTE}
                rows={3}
              />
            </div>

            {/* ── Advanced Amount Overrides (collapsed) ── */}
            {p && adjustmentRows.length > 0 ? (
              <div className="invoice-block invoice-block--nested" style={{ marginTop: "0.75rem" }}>
                <button
                  type="button"
                  className="invoice-collapsible-toggle invoice-collapsible-toggle--sm"
                  onClick={() => setAdjustmentOverridesExpanded((prev) => !prev)}
                  aria-expanded={adjustmentOverridesExpanded}
                >
                  <span className="invoice-block-label">Advanced Amount Overrides</span>
                  <span className="invoice-collapsible-meta">
                    {customAdjustmentCount > 0 ? (
                      <span className="invoice-adjustment-alert">{customAdjustmentCount} custom</span>
                    ) : null}
                    <span className="invoice-collapsible-chevron">{adjustmentOverridesExpanded ? "▲" : "▼"}</span>
                  </span>
                </button>
                {adjustmentOverridesExpanded ? (
                  <div className="invoice-adjustment-list">
                    {adjustmentRows.map((row) => {
                      const draft = adjustmentDrafts[row.key] ?? {};
                      const qtyValue = draft.qty ?? formatAdjustmentInputValue(row.qty);
                      const rateValue = draft.rate ?? formatAdjustmentInputValue(row.rate);
                      const amountValue = draft.amount ?? formatAdjustmentInputValue(row.amount);
                      return (
                        <div className="invoice-adjustment-row" key={row.key}>
                          <div className="invoice-adjustment-row-head">
                            <span className="invoice-adjustment-label">{row.label}</span>
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
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ── Invoice Preview ────────────────────────────────────── */}
      {p ? (
        <div className="invoice-block invoice-block--preview">
          <button
            type="button"
            className="invoice-collapsible-toggle"
            onClick={() => setPreviewExpanded((prev) => !prev)}
            aria-expanded={previewExpanded}
          >
            <span className="invoice-block-label">Preview</span>
            <span className="invoice-collapsible-meta">
              <span className="invoice-collapsible-summary">{fmtCurrency(p.estimatedTotal)}</span>
              <span className="invoice-collapsible-chevron">{previewExpanded ? "▲" : "Show ▼"}</span>
            </span>
          </button>
          {previewExpanded ? (
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
            {showMileage ? (
              <>
                {mileagePreviewLines.map((line) => (
                  <div
                    className={`invoice-preview-row${line.amount < 0 ? " invoice-preview-row--adj" : ""}`}
                    key={line.service}
                  >
                    <InvoicePreviewLabel label={line.service} description={line.description} />
                    <span className="invoice-preview-qty">{line.qty} mi × {fmtCurrency(line.rate)}</span>
                    <span className="invoice-preview-amount">{fmtCurrency(line.amount)}</span>
                  </div>
                ))}
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
          ) : null}
        </div>
      ) : null}

      {/* ── Attachments / Receipts ──────────────────────────── */}
      <div className="invoice-block">
        <button
          type="button"
          className="invoice-collapsible-toggle"
          onClick={() => setAttachmentsExpanded((prev) => !prev)}
          aria-expanded={attachmentsExpanded}
        >
          <span className="invoice-block-label">Receipts</span>
          <span className="invoice-collapsible-meta">
            {!attachmentsExpanded && attachmentCount !== null ? (
              <span className="invoice-collapsible-summary">
                {attachmentCount === 0
                  ? "No receipts"
                  : attachmentCount === 1
                    ? "1 receipt"
                    : `${attachmentCount} receipts`}
              </span>
            ) : null}
            <span className="invoice-collapsible-chevron">{attachmentsExpanded ? "▲" : "Manage ▼"}</span>
          </span>
        </button>
        {/* Always mounted so the count is fetched even when collapsed */}
        <InvoiceAttachments
          eventId={eventId}
          editorToken={editorToken}
          expanded={attachmentsExpanded}
          onCountChange={setAttachmentCount}
        />
      </div>

      {/* ── Advanced Recovery Tools ── */}
      {p && hasPdf ? (
        <div className="invoice-block">
          <div className="invoice-advanced">
            <button
              type="button"
              className="invoice-advanced-toggle"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
            >
              Advanced Recovery Tools {advancedOpen ? "▾" : "▸"}
            </button>
            {advancedOpen ? (
              <div className="invoice-advanced-content">
                    <p className="invoice-advanced-hint">
                      Normal invoice actions verify PDF and Sheet automatically. Use these only if something looks wrong.
                    </p>
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
                        disabled={syncState.status === "syncing" || isSaving || isVerifying}
                      >
                        {syncState.status === "syncing"
                          ? "Syncing…"
                          : "Sync / Update Google Sheet"}
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

                    {/* ── 1. Clean Duplicate Rows — safe for production ── */}
                    <div className="invoice-sheet-duplicates">
                      <div className="invoice-sheet-duplicates-head">
                        <div>
                          <p className="invoice-sheet-duplicates-title">Clean Duplicate Rows</p>
                          <p className="invoice-sheet-helper">
                            Safe for production. Keeps one active row per invoice/job and archives only the extras.
                            Does not remove any invoice entirely.
                            Use this for normal duplicate cleanup.
                          </p>
                        </div>
                        <div className="invoice-sheet-duplicate-actions">
                          <button
                            type="button"
                            className="invoice-pdf-regen-btn"
                            onClick={() => { void handleCheckSheetDuplicates(); }}
                            disabled={sheetDuplicateState.status === "checking" || sheetDuplicateState.status === "deleting"}
                          >
                            {sheetDuplicateState.status === "checking" ? "Checking…" : "Check Sheet Duplicates"}
                          </button>
                          {sheetDuplicateState.totalDuplicateRows > 0 ? (
                            <button
                              type="button"
                              className="invoice-sheet-delete-duplicates-btn"
                              onClick={() => { void handleDeleteSheetDuplicates(); }}
                              disabled={sheetDuplicateState.status === "checking" || sheetDuplicateState.status === "deleting"}
                            >
                              {sheetDuplicateState.status === "deleting" ? "Archiving…" : "Archive Duplicate Rows"}
                            </button>
                          ) : null}
                        </div>
                      </div>

                      {sheetDuplicateState.message ? (
                        <p
                          className={`invoice-sheet-duplicate-message${
                            sheetDuplicateState.status === "error"
                              ? " is-error"
                              : sheetDuplicateState.totalDuplicateRows > 0
                                ? " is-warning"
                                : ""
                          }`}
                          role={sheetDuplicateState.status === "error" || sheetDuplicateState.totalDuplicateRows > 0 ? "alert" : undefined}
                        >
                          {sheetDuplicateState.message}
                        </p>
                      ) : null}

                      {sheetDuplicateState.duplicates.length > 0 ? (
                        <div className="invoice-sheet-duplicate-groups">
                          {sheetDuplicateState.duplicates.map((group) => (
                            <div
                              className={`invoice-sheet-duplicate-group${
                                currentSheetDuplicateKeys.has(group.key) ? " is-current" : ""
                              }`}
                              key={group.key}
                            >
                              <div className="invoice-sheet-duplicate-group-head">
                                <span>{formatSheetDuplicateKey(group.key)}</span>
                                <span>Keep row {group.keepRow}</span>
                              </div>
                              <div className="invoice-sheet-duplicate-rows">
                                {group.rows.map((row) => {
                                  const willDelete = group.deleteRows.includes(row.rowNumber);
                                  return (
                                    <div
                                      className={`invoice-sheet-duplicate-row${willDelete ? " is-delete" : " is-keep"}`}
                                      key={`${group.key}-${row.rowNumber}`}
                                    >
                                      <span>Row {row.rowNumber}</span>
                                      <span>Invoice {row.invNumber || "—"} / LA {row.laNumber || "—"}</span>
                                      <span>{row.date || "No date"}</span>
                                      <span>{row.total || "No total"}</span>
                                      <strong>{willDelete ? "Archive" : "Keep"}</strong>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    {/* ── 2. Sheet Health Check — read-only scan ── */}
                    <div className="invoice-sheet-health">
                      <div className="invoice-sheet-duplicates-head">
                        <div>
                          <p className="invoice-sheet-duplicates-title">Sheet Health Check</p>
                          <p className="invoice-sheet-helper">
                            Read-only scan. Confirms one active row per invoice/job. Does not modify the Sheet.
                          </p>
                        </div>
                        <button
                          type="button"
                          className="invoice-pdf-regen-btn"
                          onClick={() => { void handleSheetHealthCheck(); }}
                          disabled={sheetHealthState.status === "checking"}
                        >
                          {sheetHealthState.status === "checking" ? "Scanning…" : "Check Sheet Health"}
                        </button>
                      </div>
                      {sheetHealthState.status === "ready" || sheetHealthState.status === "error" ? (
                        <>
                          <p
                            className={`invoice-sheet-duplicate-message${
                              sheetHealthState.status === "error" || !sheetHealthState.isClean
                                ? " is-warning"
                                : ""
                            }`}
                            role={!sheetHealthState.isClean || sheetHealthState.status === "error" ? "alert" : undefined}
                          >
                            {sheetHealthState.isClean ? "✓ " : "⚠ "}{sheetHealthState.message}
                          </p>
                          {sheetHealthState.status === "ready" ? (
                            <div className="invoice-sheet-helper" style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                              <span>Active rows: {sheetHealthState.totalActiveRows}</span>
                              <span>Unique keys: {sheetHealthState.totalUniqueKeys}</span>
                              {sheetHealthState.totalsRowNum ? (
                                <span>TOTALS row: {sheetHealthState.totalsRowNum}</span>
                              ) : null}
                              {sheetHealthState.activeBelowTotalsCount > 0 ? (
                                <span style={{ color: "var(--color-warning, #c8a000)" }}>Below TOTALS: {sheetHealthState.activeBelowTotalsCount}</span>
                              ) : null}
                              {sheetHealthState.unknownBelowTotalsCount > 0 ? (
                                <span style={{ color: "var(--color-warning, #c8a000)" }}>Unclassified below TOTALS: {sheetHealthState.unknownBelowTotalsCount}</span>
                              ) : null}
                              {sheetHealthState.totalArchivedRows > 0 ? (
                                <span>Archived: {sheetHealthState.totalArchivedRows}</span>
                              ) : null}
                              {sheetHealthState.totalVoidedRows > 0 ? (
                                <span>Still on main sheet (old): {sheetHealthState.totalVoidedRows}</span>
                              ) : null}
                            </div>
                          ) : null}
                          {sheetHealthState.activeDuplicateGroups.length > 0 ? (
                            <div className="invoice-sheet-duplicate-groups">
                              {sheetHealthState.activeDuplicateGroups.map((group) => (
                                <div className="invoice-sheet-duplicate-group is-current" key={group.key}>
                                  <div className="invoice-sheet-duplicate-group-head">
                                    <span>{group.key}</span>
                                    <span>{group.activeRows.length} active rows — sync would use row {group.syncRow ?? "?"}</span>
                                  </div>
                                  <div className="invoice-sheet-duplicate-rows">
                                    {group.activeRows.map((row) => (
                                      <div
                                        className={`invoice-sheet-duplicate-row${row.rowNumber === group.syncRow ? " is-keep" : " is-delete"}`}
                                        key={`health-active-${group.key}-${row.rowNumber}`}
                                      >
                                        <span>Row {row.rowNumber}</span>
                                        <span>Inv {row.invNumber || "—"} / LA {row.laNumber || "—"}</span>
                                        <span>{row.date || "No date"}</span>
                                        <span>{row.total || "No total"}</span>
                                        <strong>{row.rowNumber === group.syncRow ? "Sync target" : "Active duplicate"}</strong>
                                      </div>
                                    ))}
                                    {group.voidedRows.map((row) => (
                                      <div
                                        className="invoice-sheet-duplicate-row is-keep"
                                        key={`health-void-${group.key}-${row.rowNumber}`}
                                        style={{ opacity: 0.5 }}
                                      >
                                        <span>Row {row.rowNumber}</span>
                                        <span>Inv {row.invNumber || "—"} / LA {row.laNumber || "—"}</span>
                                        <span>{row.date || "No date"}</span>
                                        <span>{row.total || "—"}</span>
                                        <strong>VOIDED</strong>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>

                    {/* ── 3. Repair Sheet Layout ── */}
                    <div className="invoice-sheet-health">
                      <div className="invoice-sheet-duplicates-head">
                        <div>
                          <p className="invoice-sheet-duplicates-title">Repair Sheet Layout</p>
                          <p className="invoice-sheet-helper">
                            Moves misplaced rows above TOTALS and archives VOID rows.
                            Does not remove test/fake rows or rebuild formulas. Confirmation required.
                          </p>
                        </div>
                        <button
                          type="button"
                          className="invoice-pdf-regen-btn"
                          onClick={() => { void handleRepairSheet(); }}
                          disabled={sheetRepairState.status === "repairing"}
                        >
                          {sheetRepairState.status === "repairing" ? "Repairing…" : "Repair Sheet Layout"}
                        </button>
                      </div>
                      {sheetRepairState.status === "done" || sheetRepairState.status === "error" ? (
                        <p
                          className={`invoice-sheet-duplicate-message${sheetRepairState.status === "error" ? " is-warning" : ""}`}
                          role={sheetRepairState.status === "error" ? "alert" : undefined}
                        >
                          {sheetRepairState.status === "error" ? "⚠ " : "✓ "}{sheetRepairState.message}
                        </p>
                      ) : null}
                      {sheetRepairState.status === "done" && (sheetRepairState.voidArchivedCount > 0 || sheetRepairState.duplicatesArchivedCount > 0 || sheetRepairState.rowsMovedCount > 0) ? (
                        <div className="invoice-sheet-helper" style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                          {sheetRepairState.voidArchivedCount > 0 ? <span>Void archived: {sheetRepairState.voidArchivedCount}</span> : null}
                          {sheetRepairState.duplicatesArchivedCount > 0 ? <span>Duplicates archived: {sheetRepairState.duplicatesArchivedCount}</span> : null}
                          {sheetRepairState.rowsMovedCount > 0 ? <span>Rows moved above TOTALS: {sheetRepairState.rowsMovedCount}</span> : null}
                        </div>
                      ) : null}
                    </div>

                    {/* ── 4. Reset / Rebuild — Advanced Recovery Only ── */}
                    <div className="invoice-sheet-health">
                      <div className="invoice-sheet-duplicates-head">
                        <div>
                          <p className="invoice-sheet-duplicates-title">
                            Reset / Rebuild Sheet{" "}
                            <span style={{ color: "var(--color-warning, #c8a000)", fontWeight: "normal", fontSize: "0.85em" }}>
                              — Advanced Recovery Only
                            </span>
                          </p>
                          <p className="invoice-sheet-helper">
                            <strong>Not for normal duplicate cleanup.</strong>{" "}
                            This archives VOID rows, test/fake rows (LA#5555, invoice 1001, gig name containing "test"), and duplicates, then rebuilds TOTALS formulas.
                            Preview the row list before confirming — rows classified as "test" will be removed.
                          </p>
                        </div>
                        {sheetResetPreviewState.status !== "ready" ? (
                          <button
                            type="button"
                            className="invoice-sheet-delete-duplicates-btn"
                            onClick={() => { void handlePreviewReset(); }}
                            disabled={sheetResetPreviewState.status === "previewing" || sheetResetState.status === "resetting"}
                          >
                            {sheetResetPreviewState.status === "previewing" ? "Loading Preview…" : "Preview Reset"}
                          </button>
                        ) : (
                          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                            <button
                              type="button"
                              className="invoice-pdf-regen-btn"
                              onClick={() => { setSheetResetPreviewState(RESET_PREVIEW_INITIAL); }}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="invoice-sheet-delete-duplicates-btn"
                              onClick={() => { void handleResetSheet(); }}
                              disabled={sheetResetState.status === "resetting"}
                            >
                              {sheetResetState.status === "resetting" ? "Resetting…" : "Confirm Reset"}
                            </button>
                          </div>
                        )}
                      </div>

                      {sheetResetPreviewState.status === "error" ? (
                        <p className="invoice-sheet-duplicate-message is-warning" role="alert">
                          ⚠ {sheetResetPreviewState.message}
                        </p>
                      ) : null}

                      {sheetResetPreviewState.status === "ready" ? (
                        <div className="invoice-sheet-reset-preview">
                          {sheetResetPreviewState.totalToArchive === 0 && sheetResetPreviewState.keepRows.length === 0 ? (
                            <p className="invoice-sheet-duplicate-message">
                              ✓ Sheet looks clean — nothing to archive.
                            </p>
                          ) : (
                            <>
                              <p className={`invoice-sheet-duplicate-message${sheetResetPreviewState.totalToArchive > 0 ? " is-warning" : ""}`} role={sheetResetPreviewState.totalToArchive > 0 ? "alert" : undefined}>
                                {sheetResetPreviewState.totalToArchive > 0
                                  ? `⚠ Reset will archive ${sheetResetPreviewState.totalToArchive} row${sheetResetPreviewState.totalToArchive === 1 ? "" : "s"}. Review each section below before confirming.`
                                  : `✓ No rows to archive. ${sheetResetPreviewState.keepRows.length} row${sheetResetPreviewState.keepRows.length === 1 ? "" : "s"} will be kept.`
                                }
                              </p>
                              {sheetResetPreviewState.testRows.length > 0 ? (
                                <div className="invoice-sheet-duplicate-groups">
                                  <p className="invoice-sheet-duplicates-title" style={{ marginTop: "0.75rem" }}>
                                    Test/Fake rows — will be archived ({sheetResetPreviewState.testRows.length})
                                  </p>
                                  <p className="invoice-sheet-helper">LA#5555, invoice 1001, or gig name containing "test".</p>
                                  {sheetResetPreviewState.testRows.map((row) => (
                                    <div className="invoice-sheet-duplicate-row is-delete" key={`preview-test-${row.rowNumber}`}>
                                      <span>Row {row.rowNumber}</span>
                                      <span>Inv {row.invNumber || "—"} / LA {row.laNumber || "—"}</span>
                                      <span>{row.date || "No date"}</span>
                                      <span>{row.total || "No total"}</span>
                                      <span>{row.gigEvent || "—"}</span>
                                      <strong>TEST — archive</strong>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                              {sheetResetPreviewState.voidRows.length > 0 ? (
                                <div className="invoice-sheet-duplicate-groups">
                                  <p className="invoice-sheet-duplicates-title" style={{ marginTop: "0.75rem" }}>
                                    VOID rows — will be archived ({sheetResetPreviewState.voidRows.length})
                                  </p>
                                  {sheetResetPreviewState.voidRows.map((row) => (
                                    <div className="invoice-sheet-duplicate-row is-delete" key={`preview-void-${row.rowNumber}`}>
                                      <span>Row {row.rowNumber}</span>
                                      <span>Inv {row.invNumber || "—"} / LA {row.laNumber || "—"}</span>
                                      <span>{row.date || "No date"}</span>
                                      <span>{row.total || "No total"}</span>
                                      <strong>VOID — archive</strong>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                              {sheetResetPreviewState.duplicateRows.length > 0 ? (
                                <div className="invoice-sheet-duplicate-groups">
                                  <p className="invoice-sheet-duplicates-title" style={{ marginTop: "0.75rem" }}>
                                    Duplicate rows — will be archived ({sheetResetPreviewState.duplicateRows.length})
                                  </p>
                                  {sheetResetPreviewState.duplicateRows.map((row) => (
                                    <div className="invoice-sheet-duplicate-row is-delete" key={`preview-dup-${row.rowNumber}`}>
                                      <span>Row {row.rowNumber}</span>
                                      <span>Inv {row.invNumber || "—"} / LA {row.laNumber || "—"}</span>
                                      <span>{row.date || "No date"}</span>
                                      <span>{row.total || "No total"}</span>
                                      <strong>DUPLICATE — archive</strong>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                              {sheetResetPreviewState.keepRows.length > 0 ? (
                                <div className="invoice-sheet-duplicate-groups">
                                  <p className="invoice-sheet-duplicates-title" style={{ marginTop: "0.75rem" }}>
                                    Rows that will be kept ({sheetResetPreviewState.keepRows.length})
                                  </p>
                                  {sheetResetPreviewState.keepRows.map((row) => (
                                    <div className="invoice-sheet-duplicate-row is-keep" key={`preview-keep-${row.rowNumber}`}>
                                      <span>Row {row.rowNumber}</span>
                                      <span>Inv {row.invNumber || "—"} / LA {row.laNumber || "—"}</span>
                                      <span>{row.date || "No date"}</span>
                                      <span>{row.total || "No total"}</span>
                                      <strong>KEEP</strong>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </>
                          )}
                        </div>
                      ) : null}

                      {sheetResetState.status === "done" || sheetResetState.status === "error" ? (
                        <p
                          className={`invoice-sheet-duplicate-message${sheetResetState.status === "error" ? " is-warning" : ""}`}
                          role={sheetResetState.status === "error" ? "alert" : undefined}
                        >
                          {sheetResetState.status === "error" ? "⚠ " : "✓ "}{sheetResetState.message}
                        </p>
                      ) : null}
                      {sheetResetState.status === "done" ? (
                        <div className="invoice-sheet-helper" style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                          {sheetResetState.testArchivedCount > 0 ? <span>Test rows archived: {sheetResetState.testArchivedCount}</span> : null}
                          {sheetResetState.voidArchivedCount > 0 ? <span>Void archived: {sheetResetState.voidArchivedCount}</span> : null}
                          {sheetResetState.duplicatesArchivedCount > 0 ? <span>Duplicates archived: {sheetResetState.duplicatesArchivedCount}</span> : null}
                          {sheetResetState.belowTotalsMovedCount > 0 ? <span>Moved above TOTALS: {sheetResetState.belowTotalsMovedCount}</span> : null}
                          <span>Real rows kept: {sheetResetState.goodRowsKept}</span>
                          {sheetResetState.formulasRebuilt ? <span>Formulas rebuilt</span> : null}
                        </div>
                      ) : null}
                    </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

    </div>
  );
}
