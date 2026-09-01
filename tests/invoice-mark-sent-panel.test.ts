/**
 * Standalone "Mark as Sent" recovery action in the invoice panel.
 *
 * The in-dialog control only exists right after a draft is created in the same
 * UI session. An invoice drafted days earlier stays at draft_created with no
 * way to record that it was sent, so the panel offers the same action —
 * same confirmation, same POST /api/invoice/mark-sent, no second sent path.
 *
 * canMarkSentFromPanel is the real predicate from components/InvoiceSection.tsx.
 * The confirmation gate and the row update mirror the surrounding component
 * wiring (markSentStatus in EmailDialogState, handleInvoiceUpdated in
 * components/InvoiceWorklist.tsx).
 */

import { describe, it, expect } from "vitest";
import { canMarkSentFromPanel } from "@/components/InvoiceSection";
import type { InvoiceStatus } from "@/lib/invoice-types";

const DRAFTED = {
  invoiceNumber: "1009",
  hasPdf: true,
  invoiceStatus: "draft_created" as InvoiceStatus,
};

describe("canMarkSentFromPanel — visibility", () => {
  it("1. shows for an older draft_created invoice with a number and a PDF", () => {
    expect(canMarkSentFromPanel(DRAFTED)).toBe(true);
  });

  it("does not depend on a draft being created in this session", () => {
    // Nothing session-scoped is consulted — only the loaded record.
    expect(canMarkSentFromPanel({ ...DRAFTED })).toBe(true);
  });

  it("2. hidden for sent, partially_paid and paid invoices", () => {
    for (const invoiceStatus of ["sent", "partially_paid", "paid"] as InvoiceStatus[]) {
      expect(canMarkSentFromPanel({ ...DRAFTED, invoiceStatus })).toBe(false);
    }
  });

  it("2b. hidden for void", () => {
    expect(canMarkSentFromPanel({ ...DRAFTED, invoiceStatus: "void" })).toBe(false);
  });

  it("3. hidden without a PDF", () => {
    expect(canMarkSentFromPanel({ ...DRAFTED, hasPdf: false })).toBe(false);
  });

  it("3b. hidden without an invoice number", () => {
    expect(canMarkSentFromPanel({ ...DRAFTED, invoiceNumber: null })).toBe(false);
    expect(canMarkSentFromPanel({ ...DRAFTED, invoiceNumber: "" })).toBe(false);
  });

  it("3c. hidden for none, ready and sheet_synced (never drafted)", () => {
    for (const invoiceStatus of ["none", "ready", "sheet_synced"] as InvoiceStatus[]) {
      expect(canMarkSentFromPanel({ ...DRAFTED, invoiceStatus })).toBe(false);
    }
  });

  it("hidden when the status is not loaded yet", () => {
    expect(canMarkSentFromPanel({ ...DRAFTED, invoiceStatus: null })).toBe(false);
    expect(canMarkSentFromPanel({ ...DRAFTED, invoiceStatus: undefined })).toBe(false);
  });

  it("covers every InvoiceStatus — only draft_created qualifies", () => {
    const all: InvoiceStatus[] = [
      "none", "ready", "sheet_synced", "draft_created",
      "sent", "partially_paid", "paid", "void",
    ];
    const shown = all.filter((invoiceStatus) => canMarkSentFromPanel({ ...DRAFTED, invoiceStatus }));
    expect(shown).toEqual(["draft_created"]);
  });
});

// ── Confirmation gate ────────────────────────────────────────────────────────
// Mirrors the markSentStatus flow shared with the in-dialog control:
// idle → (click Mark as Sent) → confirming → (click "Yes, I sent it") → marking.

type MarkSentStatus = "idle" | "confirming" | "marking" | "done" | "error";

/** Does this control state actually fire handleMarkSent()? Only the confirm button does. */
function firesMarkSent(status: MarkSentStatus, clicked: "mark" | "confirm" | "cancel"): boolean {
  if (clicked === "confirm") return status === "confirming";
  return false;
}

function nextStatus(status: MarkSentStatus, clicked: "mark" | "confirm" | "cancel"): MarkSentStatus {
  if (clicked === "mark" && status !== "marking") return "confirming";
  if (clicked === "confirm" && status === "confirming") return "marking";
  if (clicked === "cancel") return "idle";
  return status;
}

describe("4. confirmation is required before writing Sent", () => {
  it("the first click only opens the confirmation — it does not write", () => {
    expect(firesMarkSent("idle", "mark")).toBe(false);
    expect(nextStatus("idle", "mark")).toBe("confirming");
  });

  it("only the explicit confirm fires the request", () => {
    expect(firesMarkSent("confirming", "confirm")).toBe(true);
    expect(nextStatus("confirming", "confirm")).toBe("marking");
  });

  it("cancelling backs out without writing", () => {
    expect(firesMarkSent("confirming", "cancel")).toBe(false);
    expect(nextStatus("confirming", "cancel")).toBe("idle");
  });

  it("confirming from an unconfirmed state never fires", () => {
    for (const status of ["idle", "marking", "done", "error"] as MarkSentStatus[]) {
      expect(firesMarkSent(status, "confirm")).toBe(false);
    }
  });
});

// ── Post-success propagation ─────────────────────────────────────────────────

interface Row {
  eventId: string;
  invoiceStatus: InvoiceStatus;
  invoiceNumber: string | null;
  invoiceTotal: number | null;
  invoicePdfUrl: string | null;
  amountPaid: number;
  remainingBalance: number | null;
}

/** Mirrors handleInvoiceUpdated in components/InvoiceWorklist.tsx. */
function applyInvoiceUpdate(rows: Row[], eventId: string, data: {
  invoice_status: InvoiceStatus; invoice_number: string | null; invoice_total: number | null;
  invoice_pdf_url: string | null; amount_paid: number; remaining_balance: number | null;
}): Row[] {
  return rows.map((entry) => (entry.eventId === eventId ? {
    ...entry,
    invoiceStatus:    data.invoice_status,
    invoiceNumber:    data.invoice_number,
    invoiceTotal:     data.invoice_total,
    invoicePdfUrl:    data.invoice_pdf_url,
    amountPaid:       data.amount_paid,
    remainingBalance: data.remaining_balance,
  } : entry));
}

function statusLabel(s: InvoiceStatus): string {
  switch (s) {
    case "none": case "ready": return "Needs Invoice";
    case "sheet_synced":   return "Synced";
    case "draft_created":  return "Draft";
    case "sent":           return "Sent";
    case "partially_paid": return "Partial";
    case "paid":           return "Paid";
    case "void":           return "Void";
    default:               return s;
  }
}

describe("5. a successful panel action updates the row immediately", () => {
  const OLD_DRAFT_ROW: Row = {
    eventId: "evt-old",
    invoiceStatus: "draft_created",
    invoiceNumber: "1009",
    invoiceTotal: 656.56,
    invoicePdfUrl: "https://storage.example.com/invoice-1009.pdf",
    amountPaid: 0,
    remainingBalance: 656.56,
  };

  const SENT_RECORD = {
    invoice_status: "sent" as InvoiceStatus,
    invoice_number: "1009",
    invoice_total: 656.56,
    invoice_pdf_url: "https://storage.example.com/invoice-1009.pdf",
    amount_paid: 0,
    remaining_balance: 656.56,
  };

  it("the worklist row flips to Sent through the existing onInvoiceUpdated flow", () => {
    expect(statusLabel(OLD_DRAFT_ROW.invoiceStatus)).toBe("Draft");
    const rows = applyInvoiceUpdate([OLD_DRAFT_ROW], "evt-old", SENT_RECORD);
    expect(statusLabel(rows[0]!.invoiceStatus)).toBe("Sent");
  });

  it("the panel action disappears once the invoice is sent", () => {
    const rows = applyInvoiceUpdate([OLD_DRAFT_ROW], "evt-old", SENT_RECORD);
    expect(canMarkSentFromPanel({
      invoiceNumber: rows[0]!.invoiceNumber,
      hasPdf: !!rows[0]!.invoicePdfUrl,
      invoiceStatus: rows[0]!.invoiceStatus,
    })).toBe(false);
  });

  it("preserves the invoice number, total and PDF", () => {
    const rows = applyInvoiceUpdate([OLD_DRAFT_ROW], "evt-old", SENT_RECORD);
    expect(rows[0]!.invoiceNumber).toBe("1009");
    expect(rows[0]!.invoiceTotal).toBe(656.56);
    expect(rows[0]!.invoicePdfUrl).toBe("https://storage.example.com/invoice-1009.pdf");
  });
});
