"use client";

/**
 * /admin/payments — Payment Batch Reconciliation
 *
 * Jeff-only. Create payment batches (Light Action direct deposits),
 * allocate each deposit across one or more invoices, track balance.
 */

import { useCallback, useEffect, useState } from "react";
import type { BatchSummary, PaymentAllocation } from "@/lib/payment-batches";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InvoiceOption {
  google_event_id: string;
  invoice_number: string | null;
  la_number: string | null;
  invoice_total: number | null;
  amount_paid: number;
  remaining_balance: number | null;
  invoice_status: string;
  gig_summary?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const [y, mo, d] = s.split("-").map(Number);
  if (!y || !mo || !d) return s;
  return new Date(y, mo - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function getToken(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)editorToken=([^;]+)/);
  return m?.[1] != null ? decodeURIComponent(m[1]) : null;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  const base: Record<string, string> = { "Content-Type": "application/json" };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface AllocationRowProps {
  allocation: PaymentAllocation;
  onRemove: (id: string) => void;
}

function AllocationRow({ allocation, onRemove }: AllocationRowProps) {
  const [removing, setRemoving] = useState(false);

  async function handleRemove() {
    setRemoving(true);
    onRemove(allocation.id);
  }

  const label = allocation.invoice_number
    ? `Invoice #${allocation.invoice_number}`
    : allocation.la_number
      ? `LA# ${allocation.la_number}`
      : allocation.google_event_id.slice(0, 8);

  return (
    <div className="payment-allocation-row">
      <span className="payment-alloc-label">{label}</span>
      <span className="payment-alloc-amount">{fmt(allocation.allocated_amount)}</span>
      <button
        type="button"
        className="payment-alloc-remove"
        onClick={handleRemove}
        disabled={removing}
        aria-label={`Remove allocation for ${label}`}
      >
        ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BatchDetail — expanded view for one batch
// ---------------------------------------------------------------------------

interface BatchDetailProps {
  batch: BatchSummary;
  onUpdated: (b: BatchSummary) => void;
  onDeleted: (id: string) => void;
}

function BatchDetail({ batch, onUpdated, onDeleted }: BatchDetailProps) {
  const [allocations, setAllocations] = useState<PaymentAllocation[]>([]);
  const [invoiceOptions, setInvoiceOptions] = useState<InvoiceOption[]>([]);
  const [loadingAllocs, setLoadingAllocs] = useState(true);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [allocAmount, setAllocAmount] = useState("");
  const [allocError, setAllocError] = useState<string | null>(null);
  const [addingAlloc, setAddingAlloc] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const allocated = allocations.reduce((s, a) => s + a.allocated_amount, 0);
  const unallocated = Math.max(0, batch.amount - allocated);

  async function loadAllocations() {
    setLoadingAllocs(true);
    try {
      const res = await fetch(`/api/payments/${batch.id}/allocations`, {
        headers: authHeaders(),
        credentials: "same-origin",
      });
      if (res.ok) {
        const json = await res.json() as { allocations: PaymentAllocation[] };
        setAllocations(json.allocations);
      }
    } finally {
      setLoadingAllocs(false);
    }
  }

  async function loadInvoiceOptions() {
    // Fetch all invoice data from the invoice list endpoint
    try {
      const res = await fetch("/api/invoice/list", { headers: authHeaders(), credentials: "same-origin" });
      if (res.ok) {
        const json = await res.json() as { invoices?: InvoiceOption[] };
        // Filter to invoices that have a PDF and are not void/paid
        const eligible = (json.invoices ?? []).filter(
          (inv) => inv.invoice_total != null && !["paid", "void"].includes(inv.invoice_status),
        );
        setInvoiceOptions(eligible);
      }
    } catch { /* non-fatal */ }
  }

  useEffect(() => {
    void loadAllocations();
    void loadInvoiceOptions();
  }, [batch.id]);

  async function handleAddAllocation() {
    setAllocError(null);
    if (!selectedEventId) { setAllocError("Select an invoice"); return; }
    const amount = parseFloat(allocAmount);
    if (isNaN(amount) || amount <= 0) { setAllocError("Enter a valid amount > 0"); return; }

    const option = invoiceOptions.find((o) => o.google_event_id === selectedEventId);
    if (!option?.invoice_total) { setAllocError("Invoice total unknown"); return; }

    setAddingAlloc(true);
    try {
      const res = await fetch(`/api/payments/${batch.id}/allocations`, {
        method: "POST",
        headers: authHeaders(),
        credentials: "same-origin",
        body: JSON.stringify({
          google_event_id:  selectedEventId,
          allocated_amount: amount,
          invoice_total:    option.invoice_total,
        }),
      });
      const json = await res.json() as { allocation?: PaymentAllocation; error?: string; detail?: string };
      if (!res.ok) { setAllocError(json.detail ?? json.error ?? "Failed to allocate"); return; }
      if (json.allocation) setAllocations((prev) => [...prev, json.allocation!]);
      setAllocAmount("");
      setSelectedEventId("");
      // Update parent batch summary
      const newAllocated = allocations.reduce((s, a) => s + a.allocated_amount, 0) + amount;
      onUpdated({ ...batch, allocatedTotal: newAllocated, unallocatedTotal: Math.max(0, batch.amount - newAllocated) });
    } catch {
      setAllocError("Network error");
    } finally {
      setAddingAlloc(false);
    }
  }

  async function handleRemoveAllocation(allocationId: string) {
    const alloc = allocations.find((a) => a.id === allocationId);
    if (!alloc) return;

    const option = invoiceOptions.find((o) => o.google_event_id === alloc.google_event_id);
    const invoiceTotal = option?.invoice_total ?? 0;

    try {
      const res = await fetch(`/api/payments/${batch.id}/allocations/${allocationId}`, {
        method: "DELETE",
        headers: authHeaders(),
        credentials: "same-origin",
        body: JSON.stringify({ google_event_id: alloc.google_event_id, invoice_total: invoiceTotal }),
      });
      if (res.ok) {
        const newAllocs = allocations.filter((a) => a.id !== allocationId);
        setAllocations(newAllocs);
        const newAllocated = newAllocs.reduce((s, a) => s + a.allocated_amount, 0);
        onUpdated({ ...batch, allocatedTotal: newAllocated, unallocatedTotal: Math.max(0, batch.amount - newAllocated) });
      }
    } catch { /* non-fatal */ }
  }

  async function handleDeleteBatch() {
    if (!confirm(`Delete this batch (${fmt(batch.amount)} received ${fmtDate(batch.received_date)})? This will remove all allocations and reverse payment records.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/payments/${batch.id}`, {
        method: "DELETE",
        headers: authHeaders(),
        credentials: "same-origin",
      });
      if (res.ok) onDeleted(batch.id);
    } catch { /* non-fatal */ } finally {
      setDeleting(false);
    }
  }

  const selectedOption = invoiceOptions.find((o) => o.google_event_id === selectedEventId);
  const balanceStatus = unallocated < 0.005 ? "balanced" : unallocated < batch.amount ? "partial" : "unallocated";

  return (
    <div className="payment-batch-detail">
      <div className="payment-batch-meta">
        <span><strong>{fmtDate(batch.received_date)}</strong></span>
        <span>{batch.payment_method}</span>
        {batch.reference ? <span>Ref: {batch.reference}</span> : null}
        {batch.notes ? <span className="payment-batch-notes">{batch.notes}</span> : null}
      </div>

      <div className={`payment-batch-balance payment-batch-balance--${balanceStatus}`}>
        <span>Deposit: {fmt(batch.amount)}</span>
        <span>Allocated: {fmt(allocated)}</span>
        <span className="payment-batch-unalloc">
          {balanceStatus === "balanced" ? "Fully applied" : `Unallocated: ${fmt(unallocated)}`}
        </span>
      </div>

      {/* Existing allocations */}
      {loadingAllocs ? (
        <p className="invoice-status-muted">Loading…</p>
      ) : allocations.length > 0 ? (
        <div className="payment-allocations-list">
          {allocations.map((a) => (
            <AllocationRow key={a.id} allocation={a} onRemove={handleRemoveAllocation} />
          ))}
        </div>
      ) : (
        <p className="invoice-status-muted">No allocations yet.</p>
      )}

      {/* Add allocation form */}
      <div className="payment-add-allocation">
        <p className="invoice-block-label">Apply to Invoice</p>
        {allocError ? <p className="invoice-error" role="alert">{allocError}</p> : null}
        <div className="payment-add-alloc-fields">
          <select
            className="invoice-select"
            value={selectedEventId}
            onChange={(e) => {
              setSelectedEventId(e.target.value);
              // Pre-fill amount from invoice remaining balance
              const opt = invoiceOptions.find((o) => o.google_event_id === e.target.value);
              if (opt) {
                const suggested = opt.remaining_balance ?? opt.invoice_total ?? 0;
                setAllocAmount(suggested > 0 ? String(suggested) : "");
              }
            }}
          >
            <option value="">— Select invoice —</option>
            {invoiceOptions.map((opt) => {
              const label = opt.invoice_number
                ? `#${opt.invoice_number}`
                : opt.la_number
                  ? `LA# ${opt.la_number}`
                  : opt.google_event_id.slice(0, 8);
              const balance = opt.remaining_balance ?? opt.invoice_total ?? 0;
              return (
                <option key={opt.google_event_id} value={opt.google_event_id}>
                  {label} — {fmt(balance)} remaining
                </option>
              );
            })}
          </select>
          <div className="invoice-currency-field">
            <span className="invoice-currency-prefix">$</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              className="invoice-input-sm"
              value={allocAmount}
              onChange={(e) => setAllocAmount(e.target.value)}
              placeholder={selectedOption
                ? String(selectedOption.remaining_balance ?? selectedOption.invoice_total ?? "")
                : "amount"}
            />
          </div>
          <button
            type="button"
            className="invoice-complete-button"
            onClick={() => { void handleAddAllocation(); }}
            disabled={addingAlloc}
          >
            {addingAlloc ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>

      <button
        type="button"
        className="payment-batch-delete-btn"
        onClick={() => { void handleDeleteBatch(); }}
        disabled={deleting}
      >
        {deleting ? "Deleting…" : "Delete Batch"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function PaymentsPage() {
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Create batch form
  const [formReceivedDate, setFormReceivedDate] = useState("");
  const [formAmount, setFormAmount] = useState("");
  const [formMethod, setFormMethod] = useState("Direct Deposit");
  const [formReference, setFormReference] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const loadBatches = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/payments", { headers: authHeaders(), credentials: "same-origin" });
      if (!res.ok) { setFetchError("Could not load payment batches"); return; }
      const json = await res.json() as { batches: BatchSummary[] };
      setBatches(json.batches);
    } catch {
      setFetchError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadBatches(); }, [loadBatches]);

  async function handleCreateBatch(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const amount = parseFloat(formAmount);
    if (!formReceivedDate) { setFormError("Date is required"); return; }
    if (isNaN(amount) || amount <= 0) { setFormError("Amount must be > 0"); return; }

    setCreating(true);
    try {
      const res = await fetch("/api/payments", {
        method: "POST",
        headers: authHeaders(),
        credentials: "same-origin",
        body: JSON.stringify({
          received_date:  formReceivedDate,
          amount,
          payment_method: formMethod || "Direct Deposit",
          reference:      formReference || null,
          notes:          formNotes || null,
        }),
      });
      const json = await res.json() as { batch?: BatchSummary; error?: string; detail?: string };
      if (!res.ok) { setFormError(json.detail ?? json.error ?? "Failed to create"); return; }
      if (json.batch) {
        const newBatch: BatchSummary = { ...json.batch, allocatedTotal: 0, unallocatedTotal: json.batch.amount, allocationCount: 0 };
        setBatches((prev) => [newBatch, ...prev]);
        setExpandedId(newBatch.id);
      }
      setFormReceivedDate("");
      setFormAmount("");
      setFormReference("");
      setFormNotes("");
      setShowForm(false);
    } catch {
      setFormError("Network error");
    } finally {
      setCreating(false);
    }
  }

  const totalReceived = batches.reduce((s, b) => s + b.amount, 0);
  const totalAllocated = batches.reduce((s, b) => s + b.allocatedTotal, 0);

  return (
    <main className="admin-page">
      <div className="admin-page-header">
        <h1 className="admin-page-title">Payment Batches</h1>
        <p className="admin-page-subtitle">Reconcile Light Action direct deposits across invoices</p>
      </div>

      {/* Summary row */}
      {batches.length > 0 ? (
        <div className="payment-summary-row">
          <span>Total received: <strong>{fmt(totalReceived)}</strong></span>
          <span>Total allocated: <strong>{fmt(totalAllocated)}</strong></span>
          {totalReceived - totalAllocated > 0.005 ? (
            <span className="payment-unalloc-warning">
              Unallocated: {fmt(totalReceived - totalAllocated)}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Create batch form */}
      <div className="payment-create-section">
        {!showForm ? (
          <button
            type="button"
            className="invoice-complete-button"
            onClick={() => setShowForm(true)}
          >
            + Record New Deposit
          </button>
        ) : (
          <form className="payment-create-form" onSubmit={(e) => { void handleCreateBatch(e); }}>
            <p className="invoice-block-label">New Payment Batch</p>
            {formError ? <p className="invoice-error" role="alert">{formError}</p> : null}
            <div className="payment-form-grid">
              <div className="payment-form-field">
                <label className="invoice-label-sm" htmlFor="pm-date">Date Received</label>
                <input
                  id="pm-date"
                  type="date"
                  className="invoice-input-sm"
                  value={formReceivedDate}
                  onChange={(e) => setFormReceivedDate(e.target.value)}
                  required
                />
              </div>
              <div className="payment-form-field">
                <label className="invoice-label-sm" htmlFor="pm-amount">Amount</label>
                <div className="invoice-currency-field">
                  <span className="invoice-currency-prefix">$</span>
                  <input
                    id="pm-amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    className="invoice-input-sm"
                    value={formAmount}
                    onChange={(e) => setFormAmount(e.target.value)}
                    placeholder="0.00"
                    required
                  />
                </div>
              </div>
              <div className="payment-form-field">
                <label className="invoice-label-sm" htmlFor="pm-method">Method</label>
                <select
                  id="pm-method"
                  className="invoice-select"
                  value={formMethod}
                  onChange={(e) => setFormMethod(e.target.value)}
                >
                  <option>Direct Deposit</option>
                  <option>Check</option>
                  <option>ACH</option>
                  <option>Wire</option>
                  <option>Other</option>
                </select>
              </div>
              <div className="payment-form-field">
                <label className="invoice-label-sm" htmlFor="pm-ref">Reference</label>
                <input
                  id="pm-ref"
                  type="text"
                  className="invoice-input-sm"
                  value={formReference}
                  onChange={(e) => setFormReference(e.target.value)}
                  placeholder="bank ref, memo, etc."
                />
              </div>
              <div className="payment-form-field payment-form-field--full">
                <label className="invoice-label-sm" htmlFor="pm-notes">Notes</label>
                <input
                  id="pm-notes"
                  type="text"
                  className="invoice-input-sm"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  placeholder="optional notes"
                />
              </div>
            </div>
            <div className="invoice-sync-buttons">
              <button
                type="submit"
                className="invoice-complete-button"
                disabled={creating}
              >
                {creating ? "Saving…" : "Save Batch"}
              </button>
              <button
                type="button"
                className="invoice-sync-button"
                onClick={() => setShowForm(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Batch list */}
      {loading ? (
        <p className="invoice-status-muted">Loading…</p>
      ) : fetchError ? (
        <p className="invoice-error" role="alert">{fetchError}</p>
      ) : batches.length === 0 ? (
        <p className="invoice-status-muted">No payment batches recorded yet.</p>
      ) : (
        <div className="payment-batch-list">
          {batches.map((b) => {
            const isExpanded = expandedId === b.id;
            const balanceStatus =
              b.unallocatedTotal < 0.005 ? "balanced" : b.allocatedTotal > 0 ? "partial" : "none";

            return (
              <div key={b.id} className={`payment-batch-card payment-batch-card--${balanceStatus}`}>
                <button
                  type="button"
                  className="payment-batch-card-header"
                  onClick={() => setExpandedId(isExpanded ? null : b.id)}
                  aria-expanded={isExpanded}
                >
                  <span className="payment-batch-card-date">{fmtDate(b.received_date)}</span>
                  <span className="payment-batch-card-amount">{fmt(b.amount)}</span>
                  <span className={`payment-batch-card-status payment-batch-card-status--${balanceStatus}`}>
                    {balanceStatus === "balanced"
                      ? "Fully applied"
                      : balanceStatus === "partial"
                        ? `${fmt(b.unallocatedTotal)} remaining`
                        : "Not applied"}
                  </span>
                  <span className="payment-batch-chevron">{isExpanded ? "▲" : "▼"}</span>
                </button>
                {isExpanded ? (
                  <BatchDetail
                    batch={b}
                    onUpdated={(updated) => setBatches((prev) => prev.map((x) => x.id === updated.id ? updated : x))}
                    onDeleted={(id) => {
                      setBatches((prev) => prev.filter((x) => x.id !== id));
                      setExpandedId(null);
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
