"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InvoiceSection, snapUtcToTimeOption } from "@/components/InvoiceSection";
import type { WorklistEntry, WorklistFilter } from "@/lib/invoice-worklist";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getEditorToken(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)editorToken=([^;]+)/);
  return m?.[1] != null ? decodeURIComponent(m[1]) : null;
}

function authHeaders(token: string | null): Record<string, string> {
  const base: Record<string, string> = { "Content-Type": "application/json" };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

type InvoiceStatus =
  | "none" | "ready" | "sheet_synced" | "draft_created"
  | "sent" | "partially_paid" | "paid" | "void";

function statusLabel(s: InvoiceStatus): string {
  switch (s) {
    case "none":         return "Needs Invoice";
    case "ready":        return "Needs Invoice";
    case "sheet_synced": return "Synced";
    case "draft_created": return "Draft";
    case "sent":         return "Sent";
    case "partially_paid": return "Partial";
    case "paid":         return "Paid";
    case "void":         return "Void";
    default:             return s;
  }
}

function statusClass(s: InvoiceStatus): string {
  switch (s) {
    case "none":
    case "ready":         return "worklist-status-needs";
    case "sheet_synced":
    case "draft_created": return "worklist-status-draft";
    case "sent":
    case "partially_paid": return "worklist-status-sent";
    case "paid":          return "worklist-status-paid";
    case "void":          return "worklist-status-void";
    default:              return "";
  }
}

function fmtAmount(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDate(iso: string): string {
  const [y, mo, d] = iso.split("-").map(Number);
  if (!y || !mo || !d) return iso;
  return new Date(y, mo - 1, d).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function fmtDateRange(start: string, end: string): string {
  if (start === end) return fmtDate(start);
  const [sy, smo, sd] = start.split("-").map(Number);
  const [ey, emo, ed] = end.split("-").map(Number);
  if (!sy || !ey) return `${start} – ${end}`;
  const s = new Date(sy, smo! - 1, sd!).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const e = new Date(ey, emo! - 1, ed!).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
  return `${s} – ${e}`;
}

// ---------------------------------------------------------------------------
// Filter / search (client-side, mirrors lib/invoice-worklist.ts logic)
// ---------------------------------------------------------------------------

function entryMatchesFilter(entry: WorklistEntry, filter: WorklistFilter): boolean {
  if (filter === "all")   return true;
  if (filter === "none")  return entry.invoiceStatus === "none" || entry.invoiceStatus === "ready";
  if (filter === "draft") return entry.invoiceStatus === "draft_created" || entry.invoiceStatus === "sheet_synced";
  if (filter === "sent")  return entry.invoiceStatus === "sent" || entry.invoiceStatus === "partially_paid";
  if (filter === "paid")  return entry.invoiceStatus === "paid";
  return true;
}

function entryMatchesSearch(entry: WorklistEntry, term: string): boolean {
  if (!term.trim()) return true;
  const q = term.trim().toLowerCase();
  return (
    (entry.laJobNumber ?? "").toLowerCase().includes(q) ||
    entry.gigName.toLowerCase().includes(q) ||
    entry.summary.toLowerCase().includes(q) ||
    (entry.invoiceNumber ?? "").toLowerCase().includes(q) ||
    entry.startDate.includes(q) ||
    entry.endDate.includes(q)
  );
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

function getTodayIso(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InvoiceWorklist() {
  const [entries,   setEntries]   = useState<WorklistEntry[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [fetchErr,  setFetchErr]  = useState<string | null>(null);
  const [filter,    setFilter]    = useState<WorklistFilter>("all");
  const [search,    setSearch]    = useState("");
  const [selected,  setSelected]  = useState<WorklistEntry | null>(null);
  const [months,    setMonths]    = useState(18);
  const panelRef = useRef<HTMLDivElement>(null);
  const token    = typeof window !== "undefined" ? getEditorToken() : null;
  const today    = getTodayIso();

  const load = useCallback(async (m: number) => {
    setLoading(true);
    setFetchErr(null);
    try {
      const res = await fetch(`/api/invoice/worklist?months=${m}`, {
        headers: authHeaders(token),
        credentials: "same-origin",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { message?: string; error?: string };
        setFetchErr(j.message ?? j.error ?? `Error ${res.status}`);
        return;
      }
      const j = await res.json() as { entries?: WorklistEntry[] };
      setEntries(j.entries ?? []);
    } catch {
      setFetchErr("Network error — could not load invoice worklist.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(months); }, [load, months]);

  // Close panel on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Focus trap: scroll panel into view on open
  useEffect(() => {
    if (selected && panelRef.current) {
      panelRef.current.scrollTop = 0;
    }
  }, [selected]);

  const visible = entries.filter(
    (e) => entryMatchesFilter(e, filter) && entryMatchesSearch(e, search),
  );

  const filterCounts: Record<WorklistFilter, number> = {
    all:   entries.length,
    none:  entries.filter((e) => e.invoiceStatus === "none" || e.invoiceStatus === "ready").length,
    draft: entries.filter((e) => e.invoiceStatus === "draft_created" || e.invoiceStatus === "sheet_synced").length,
    sent:  entries.filter((e) => e.invoiceStatus === "sent" || e.invoiceStatus === "partially_paid").length,
    paid:  entries.filter((e) => e.invoiceStatus === "paid").length,
  };

  const canClockIn = selected ? selected.workDates.includes(today) : false;

  return (
    <div className="worklist-shell">
      {/* ── Sidebar: list + controls ────────────────────────── */}
      <aside className={`worklist-sidebar${selected ? " worklist-sidebar--narrow" : ""}`}>
        <header className="worklist-header">
          <h1 className="worklist-title">Invoice Worklist</h1>
          <p className="worklist-subtitle">
            All LA gig jobs from Google Calendar · Jeff only
          </p>
        </header>

        {/* Filter tabs */}
        <div className="worklist-filters" role="tablist" aria-label="Invoice filter">
          {(["all", "none", "draft", "sent", "paid"] as WorklistFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`worklist-filter-tab${filter === f ? " worklist-filter-tab--active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "none"  ? "Needs Invoice" :
               f === "draft" ? "Draft"          :
               f === "sent"  ? "Sent"           :
               f === "paid"  ? "Paid"           : "All"}
              <span className="worklist-filter-count">{filterCounts[f]}</span>
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="worklist-search-row">
          <input
            className="worklist-search"
            type="search"
            placeholder="Search LA#, gig name, date, invoice#…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search jobs"
          />
          <div className="worklist-range-control">
            <label className="worklist-range-label" htmlFor="worklist-months">Range</label>
            <select
              id="worklist-months"
              className="worklist-range-select"
              value={months}
              onChange={(e) => { const m = Number(e.target.value); setMonths(m); }}
            >
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
              <option value={18}>18 months</option>
              <option value={24}>2 years</option>
              <option value={36}>3 years</option>
            </select>
          </div>
        </div>

        {/* Status */}
        {loading ? (
          <p className="worklist-loading">Loading jobs…</p>
        ) : fetchErr ? (
          <p className="worklist-error" role="alert">⚠ {fetchErr}</p>
        ) : visible.length === 0 ? (
          <p className="worklist-empty">No jobs match this filter.</p>
        ) : null}

        {/* List */}
        {!loading && !fetchErr && visible.length > 0 ? (
          <ul className="worklist-list" role="list">
            {visible.map((entry) => (
              <li key={entry.eventId} className="worklist-list-item">
                <button
                  type="button"
                  className={`worklist-row${selected?.eventId === entry.eventId ? " worklist-row--active" : ""}`}
                  onClick={() => setSelected(entry.eventId === selected?.eventId ? null : entry)}
                  aria-pressed={selected?.eventId === entry.eventId}
                >
                  <div className="worklist-row-top">
                    <span className="worklist-row-date">{fmtDateRange(entry.startDate, entry.endDate)}</span>
                    <span className={`worklist-row-status ${statusClass(entry.invoiceStatus as InvoiceStatus)}`}>
                      {statusLabel(entry.invoiceStatus as InvoiceStatus)}
                    </span>
                  </div>
                  <div className="worklist-row-name">{entry.gigName}</div>
                  <div className="worklist-row-meta">
                    {entry.laJobNumber ? <span className="worklist-row-la">{entry.laJobNumber}</span> : null}
                    {entry.invoiceNumber ? <span className="worklist-row-inv">#{entry.invoiceNumber}</span> : null}
                    {entry.invoiceTotal != null ? (
                      <span className="worklist-row-total">{fmtAmount(entry.invoiceTotal)}</span>
                    ) : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="worklist-count-note">
          {!loading && !fetchErr ? `${visible.length} of ${entries.length} job${entries.length !== 1 ? "s" : ""}` : ""}
        </p>
      </aside>

      {/* ── Detail panel: InvoiceSection ────────────────────── */}
      {selected ? (
        <div className="worklist-panel" role="region" aria-label="Invoice editor" ref={panelRef}>
          <div className="worklist-panel-header">
            <div className="worklist-panel-title-row">
              <h2 className="worklist-panel-title">{selected.gigName}</h2>
              <button
                type="button"
                className="worklist-panel-close"
                onClick={() => setSelected(null)}
                aria-label="Close invoice editor"
              >
                ✕
              </button>
            </div>
            <p className="worklist-panel-meta">
              {fmtDateRange(selected.startDate, selected.endDate)}
              {selected.laJobNumber ? ` · ${selected.laJobNumber}` : ""}
            </p>
            {!canClockIn ? (
              <p className="worklist-panel-past-note">
                Past job — clock-in is not available. Edit invoice, generate PDF, sync Sheet, or send from below.
              </p>
            ) : null}
          </div>

          {/*
            InvoiceSection manages its own data fetching via /api/invoice/[eventId].
            workDates from the calendar date range let it build workday entries for
            past jobs that may not have clock-in records. Clock-in button is not
            present in InvoiceSection — job time tracking is a separate system.
          */}
          <InvoiceSection
            key={selected.eventId}
            eventId={selected.eventId}
            workDates={selected.workDates}
            gigSummary={selected.summary}
            editorToken={token}
            jobLocation={selected.location ?? undefined}
            defaultStartTime={selected.startTimeUtc ? snapUtcToTimeOption(selected.startTimeUtc) : undefined}
            defaultEndTime={selected.endTimeUtc ? snapUtcToTimeOption(selected.endTimeUtc) : undefined}
          />
        </div>
      ) : null}
    </div>
  );
}
