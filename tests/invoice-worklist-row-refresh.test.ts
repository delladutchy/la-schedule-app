/**
 * Worklist row refresh after an invoice action.
 *
 * The worklist used to load its rows once and never update them, so a job kept
 * showing the status it had when the page loaded — a job created + drafted +
 * marked sent in the panel still read "Needs Invoice" until a hard reload.
 *
 * These mirror the in-place patch (handleInvoiceUpdated) and the badge label
 * (statusLabel) in components/InvoiceWorklist.tsx.
 */

import { describe, it, expect } from "vitest";
import type { InvoiceStatus } from "@/lib/invoice-types";

interface Row {
  eventId: string;
  invoiceStatus: InvoiceStatus;
  invoiceNumber: string | null;
  invoiceTotal: number | null;
  invoicePdfUrl: string | null;
  amountPaid: number;
  remainingBalance: number | null;
  gigName: string;
  startDate: string;
}

interface InvoiceRecord {
  invoice_status: InvoiceStatus;
  invoice_number: string | null;
  invoice_total: number | null;
  invoice_pdf_url: string | null;
  amount_paid: number;
  remaining_balance: number | null;
}

/** Mirrors handleInvoiceUpdated in components/InvoiceWorklist.tsx. */
function applyInvoiceUpdate(rows: Row[], eventId: string, data: InvoiceRecord): Row[] {
  return rows.map((entry) => (
    entry.eventId === eventId
      ? {
          ...entry,
          invoiceStatus:    data.invoice_status,
          invoiceNumber:    data.invoice_number,
          invoiceTotal:     data.invoice_total,
          invoicePdfUrl:    data.invoice_pdf_url,
          amountPaid:       data.amount_paid,
          remainingBalance: data.remaining_balance,
        }
      : entry
  ));
}

/** Mirrors statusLabel in components/InvoiceWorklist.tsx. */
function statusLabel(s: InvoiceStatus): string {
  switch (s) {
    case "none":           return "Needs Invoice";
    case "ready":          return "Needs Invoice";
    case "sheet_synced":   return "Synced";
    case "draft_created":  return "Draft";
    case "sent":           return "Sent";
    case "partially_paid": return "Partial";
    case "paid":           return "Paid";
    case "void":           return "Void";
    default:               return s;
  }
}

const NEEDS_INVOICE_ROW: Row = {
  eventId: "evt123",
  invoiceStatus: "none",
  invoiceNumber: null,
  invoiceTotal: null,
  invoicePdfUrl: null,
  amountPaid: 0,
  remainingBalance: null,
  gigName: "Cole Swindell After game concert",
  startDate: "2026-08-27",
};

const OTHER_ROW: Row = { ...NEEDS_INVOICE_ROW, eventId: "evt999", gigName: "Other job" };

const DRAFT_RECORD: InvoiceRecord = {
  invoice_status: "draft_created",
  invoice_number: "1014",
  invoice_total: 3194.06,
  invoice_pdf_url: "https://storage.example.com/invoice-1014.pdf",
  amount_paid: 0,
  remaining_balance: 3194.06,
};

const SENT_RECORD: InvoiceRecord = { ...DRAFT_RECORD, invoice_status: "sent" };

describe("worklist row refresh", () => {
  it("creating a Gmail draft moves the row from Needs Invoice to Draft", () => {
    const rows = applyInvoiceUpdate([NEEDS_INVOICE_ROW], "evt123", DRAFT_RECORD);
    expect(statusLabel(rows[0]!.invoiceStatus)).toBe("Draft");
  });

  it("a Gmail draft alone never reads Sent", () => {
    const rows = applyInvoiceUpdate([NEEDS_INVOICE_ROW], "evt123", DRAFT_RECORD);
    expect(rows[0]!.invoiceStatus).not.toBe("sent");
    expect(statusLabel(rows[0]!.invoiceStatus)).not.toBe("Sent");
  });

  it("marking sent updates the badge immediately — no reload", () => {
    const drafted = applyInvoiceUpdate([NEEDS_INVOICE_ROW], "evt123", DRAFT_RECORD);
    const sent = applyInvoiceUpdate(drafted, "evt123", SENT_RECORD);
    expect(statusLabel(sent[0]!.invoiceStatus)).toBe("Sent");
  });

  it("carries the invoice number and total onto the row", () => {
    const rows = applyInvoiceUpdate([NEEDS_INVOICE_ROW], "evt123", SENT_RECORD);
    expect(rows[0]!.invoiceNumber).toBe("1014");
    expect(rows[0]!.invoiceTotal).toBe(3194.06);
    expect(rows[0]!.invoicePdfUrl).toBe("https://storage.example.com/invoice-1014.pdf");
    expect(rows[0]!.remainingBalance).toBe(3194.06);
  });

  it("touches only the matching row", () => {
    const rows = applyInvoiceUpdate([NEEDS_INVOICE_ROW, OTHER_ROW], "evt123", SENT_RECORD);
    expect(rows[1]).toBe(OTHER_ROW);
    expect(statusLabel(rows[1]!.invoiceStatus)).toBe("Needs Invoice");
  });

  it("leaves non-invoice row fields alone", () => {
    const rows = applyInvoiceUpdate([NEEDS_INVOICE_ROW], "evt123", SENT_RECORD);
    expect(rows[0]!.gigName).toBe("Cole Swindell After game concert");
    expect(rows[0]!.startDate).toBe("2026-08-27");
    expect(rows[0]!.eventId).toBe("evt123");
  });
});
