"use client";

import { useEffect, useRef, useState } from "react";
import type { InvoiceData, InvoicePacket, WorkdayEntry } from "@/lib/invoice-types";

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

interface MileageFields {
  total_miles: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  eventId: string;
  workDates: string[];
  gigSummary: string;
  editorToken: string | null;
  defaultStartTime?: string; // snapped 12h time from job startUtc, e.g. "8:00 AM"
  defaultEndTime?: string;   // snapped 12h time from job endUtc, e.g. "6:00 PM"
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
}

function WorkdayRow({ entry, workdays, index, onChange }: WorkdayRowProps) {
  const calc = workdays[index];
  const totalH = calc ? fmtHours(calc.totalHours) : "—";
  const otH = calc && calc.overtimeHours > 0 ? fmtHours(calc.overtimeHours) : "0";

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
  const [mileage, setMileage] = useState<MileageFields>({ total_miles: "" });
  const [syncState, setSyncState] = useState<SyncState>({ status: "idle", message: null, syncedAt: null });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isMarkingComplete, setIsMarkingComplete] = useState(false);

  // Debounce save timer
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
          const entries = initWorkdayEntries(data.workday_entries, workDates, defaultStartTime, defaultEndTime);
          setWorkdayEntries(entries);
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
          setMileage({ total_miles: data.total_miles != null ? String(data.total_miles) : "" });
          if (data.sheet_synced_at) {
            setSyncState({ status: "success", message: null, syncedAt: data.sheet_synced_at });
          } else if (data.sheet_sync_error) {
            setSyncState({ status: "error", message: "Sheet sync failed — retry", syncedAt: null });
          }
          // Auto-fetch mileage if none saved and job location is known
          if (data.total_miles == null && jobLocation) {
            fetchAutoMileage(jobLocation, editorToken);
          }
        } else {
          // No existing data — initialize from work dates with auto-fill defaults
          const entries = initWorkdayEntries([], workDates, defaultStartTime, defaultEndTime);
          setWorkdayEntries(entries);
          setInvoiceData(null);
          setPacket(null);
          if (jobLocation) {
            fetchAutoMileage(jobLocation, editorToken);
          }
        }
        setFetchState({ status: "ready" });
      })
      .catch(() => {
        if (!cancelled) setFetchState({ status: "error" });
      });

    return () => { cancelled = true; };
  }, [requestKey]);

  function fetchAutoMileage(location: string, token: string | null) {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    fetch(`/api/invoice/mileage?location=${encodeURIComponent(location)}`, {
      headers,
      credentials: "same-origin",
    })
      .then(async (res) => {
        if (!res.ok) return;
        const json = await res.json() as { miles?: number };
        if (typeof json.miles === "number" && json.miles > 0) {
          setMileage({ total_miles: String(json.miles) });
          void save({ total_miles: json.miles });
        }
      })
      .catch(() => { /* silently ignore — user can enter manually */ });
  }

  function initWorkdayEntries(
    existing: WorkdayEntry[],
    dates: string[],
    defaultStart?: string,
    defaultEnd?: string,
  ): WorkdayEntry[] {
    const map = new Map(existing.map((e) => [e.date, e]));
    return dates.map((date) => {
      const saved = map.get(date);
      if (saved) return saved; // always use saved data, even if empty
      return { date, startTime: defaultStart ?? "", endTime: defaultEnd ?? "" };
    });
  }

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
      if (!res.ok) {
        setSaveError("Could not save. Try again.");
        return;
      }
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
  // Workday change handlers
  // ---------------------------------------------------------------------------

  function handleWorkdayChange(index: number, patch: Partial<WorkdayEntry>) {
    const updated = workdayEntries.map((e, i) => i === index ? { ...e, ...patch } : e);
    setWorkdayEntries(updated);
    scheduleSave({ workday_entries: updated });
  }

  // ---------------------------------------------------------------------------
  // Expense handlers
  // ---------------------------------------------------------------------------

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
  // Mileage handlers
  // ---------------------------------------------------------------------------

  function handleMileageChange(value: string) {
    setMileage({ total_miles: value });
    const num = parseFloat(value);
    scheduleSave({ total_miles: value === "" || isNaN(num) ? null : num });
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
          syncedAt: prevSyncedAt, // preserve prior sync timestamp so button stays "Update"
        });
      }
    } catch {
      setSyncState({ status: "error", message: "Sheet sync failed — retry", syncedAt: prevSyncedAt });
    }
  }

  // ---------------------------------------------------------------------------
  // Mark as Complete (sets invoice_status="ready" + auto-syncs)
  // ---------------------------------------------------------------------------

  async function handleMarkComplete() {
    if (isMarkingComplete) return;
    setIsMarkingComplete(true);
    try {
      await save({ invoice_status: "ready" });
    } catch {
      // status save failure is non-fatal; still try to sync
    } finally {
      setIsMarkingComplete(false);
    }
    void handleSyncSheet(); // fire non-blocking — failure must not block the status change
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
  const mileageCalc = p?.mileage ?? null;
  const totalMilesNum = parseFloat(mileage.total_miles);
  const mileagePreviewMiles = !isNaN(totalMilesNum) && totalMilesNum > 0 ? totalMilesNum : null;
  const deduction = invoiceData?.mileage_deduction_miles ?? 60;
  const mileageRate = invoiceData?.mileage_rate ?? 0.52;

  const previewMileageReimbursed = mileagePreviewMiles != null
    ? Math.max(0, mileagePreviewMiles - deduction)
    : (mileageCalc?.reimbursedMiles ?? 0);
  const previewMileageAmount = previewMileageReimbursed * mileageRate;
  const previewMileageAdjAmount = mileagePreviewMiles != null && mileagePreviewMiles > 0
    ? -(deduction * mileageRate)
    : 0;
  const showMileage = mileagePreviewMiles != null && mileagePreviewMiles > 0;

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

  return (
    <div className="invoice-section">
      <p className="board-day-modal-event-label">Invoice / Tracking</p>

      {saveError ? <p className="invoice-error" role="alert">{saveError}</p> : null}

      {/* ── Work Dates / Hours ─────────────────────────────────── */}
      <div className="invoice-block">
        <p className="invoice-block-label">Work Dates / Hours</p>
        {workdayEntries.map((entry, i) => (
          <WorkdayRow
            key={entry.date}
            entry={entry}
            workdays={p?.workdays ?? []}
            index={i}
            onChange={handleWorkdayChange}
          />
        ))}
      </div>

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

      {/* ── Mileage ────────────────────────────────────────────── */}
      <div className="invoice-block">
        <p className="invoice-block-label">Mileage</p>
        <div className="invoice-mileage-row">
          <label className="invoice-label-sm" htmlFor="inv-total-miles">Total Miles</label>
          <input
            id="inv-total-miles"
            type="number"
            min="0"
            step="1"
            className="invoice-input-sm invoice-input-miles"
            value={mileage.total_miles}
            onChange={(e) => handleMileageChange(e.target.value)}
            placeholder="0"
          />
        </div>
        {showMileage ? (
          <div className="invoice-mileage-calc">
            <div className="invoice-calc-row">
              <span>Reimbursed miles</span>
              <span>{previewMileageReimbursed.toFixed(0)}</span>
            </div>
            <div className="invoice-calc-row invoice-calc-row--note">
              <span>Less 30 miles each way per agreement</span>
              <span>{fmtCurrency(previewMileageAdjAmount)}</span>
            </div>
            <div className="invoice-calc-row">
              <span>Mileage amount ({mileageRate}/mi)</span>
              <span>{fmtCurrency(previewMileageAmount)}</span>
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
            {showMileage ? (
              <>
                <div className="invoice-preview-row">
                  <span>Mileage</span>
                  <span className="invoice-preview-qty">{previewMileageReimbursed.toFixed(0)} mi × ${mileageRate}</span>
                  <span className="invoice-preview-amount">{fmtCurrency(previewMileageAmount)}</span>
                </div>
                <div className="invoice-preview-row invoice-preview-row--adj">
                  <span>Mileage Adjustment</span>
                  <span className="invoice-preview-qty">–{deduction} mi × ${mileageRate}</span>
                  <span className="invoice-preview-amount">{fmtCurrency(previewMileageAdjAmount)}</span>
                </div>
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
        {isSaving ? (
          <span className="invoice-saving-indicator">Saving…</span>
        ) : null}
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
