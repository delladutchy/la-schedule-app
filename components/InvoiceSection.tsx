"use client";

import { useEffect, useRef, useState } from "react";
import { Truck } from "lucide-react";
import type { InvoiceData, InvoicePacket, MileageMode, WorkdayEntry } from "@/lib/invoice-types";
import {
  calculateWorkdayMileage,
  getDefaultDeductionForMode,
  initWorkdayEntries,
  round2,
} from "@/lib/invoice-calculations";

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
                onClick={() => { if (mileageValid) setMileageOpen(false); }}
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
  const [isMarkingComplete, setIsMarkingComplete] = useState(false);

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

  async function handleMarkComplete() {
    if (isMarkingComplete) return;
    setIsMarkingComplete(true);
    try {
      await save({ invoice_status: "ready" });
    } catch {
      // non-fatal
    } finally {
      setIsMarkingComplete(false);
    }
    void handleSyncSheet();
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
  const isComplete = (
    invoiceData?.invoice_status === "ready" ||
    invoiceData?.invoice_status === "sheet_synced" ||
    invoiceData?.invoice_status === "draft_created" ||
    invoiceData?.invoice_status === "sent" ||
    invoiceData?.invoice_status === "paid"
  );

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

      {/* ── Sheet Sync ─────────────────────────────────────────── */}
      <div className="invoice-sync-row">
        {isSaving ? <span className="invoice-saving-indicator">Saving…</span> : null}
        {syncState.status === "success" && syncedLabel ? (
          <p className="invoice-sync-success">Sheet synced {syncedLabel}</p>
        ) : syncState.status === "error" ? (
          <p className="invoice-error" role="alert">{syncState.message ?? "Sheet sync failed — retry"}</p>
        ) : null}
        <div className="invoice-sync-buttons">
          {!isComplete ? (
            <button
              type="button"
              className="invoice-complete-button"
              onClick={() => { void handleMarkComplete(); }}
              disabled={isMarkingComplete || isSaving}
            >
              {isMarkingComplete ? "Marking…" : "Mark as Complete & Sync"}
            </button>
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
    </div>
  );
}
