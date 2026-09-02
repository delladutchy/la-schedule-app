import { describe, expect, it } from "vitest";
import { decideCrossSourceOverlap, type CrossSourceOverlapInput } from "@/lib/bank-overlap";
import { decideAutomaticReconciliation } from "@/lib/bank-reconciliation";
import type { InvoiceForMatching } from "@/lib/payment-matching";

const input: CrossSourceOverlapInput = {
  source: "plaid", postedDate: "2026-08-26", amount: 10336.22,
  description: "LIGHT ACTION PAYROLL DEPOSIT", sourceAccount: "Wells Fargo — Checking ••••6789",
};
const empty = { bankTransactions: [], paymentBatches: [], paidInvoices: [] };

function invoice(number: string, total: number): InvoiceForMatching {
  return { google_event_id: `event-${number}`, client: "Light Action", invoice_number: number, la_number: null,
    invoice_total: total, amount_paid: 0, remaining_balance: total, invoice_status: "sent" };
}

describe("cross-source first-sync overlap guard", () => {
  it("links the Plaid 8/26 deposit to the existing CSV-backed payment instead of paying twice", () => {
    const result = decideCrossSourceOverlap(input, { ...empty, bankTransactions: [{
      bankTransactionId: "csv-transaction", source: "wells_fargo_verified", postedDate: "2026-08-26",
      amount: 10336.22, description: "Light Action payroll", sourceAccount: "Wells Fargo Checking 6789",
      paymentBatchId: "batch-826", paymentReference: "WF-2026-08-26", allocationIds: ["a1", "a2", "a3"],
      invoiceEventIds: ["1010", "1012", "1011"],
    }] });
    expect(result).toMatchObject({ action: "duplicate", candidate: { paymentBatchId: "batch-826" } });
  });

  it("recognizes the legacy paid 7/1 three-invoice combination without creating a payment", () => {
    const result = decideCrossSourceOverlap({ ...input, postedDate: "2026-07-01", amount: 9836.09 }, {
      ...empty, paidInvoices: [
        { googleEventId: "1003", invoiceNumber: "1003", paidDate: "2026-07-01", amountPaid: 1081.89 },
        { googleEventId: "1004", invoiceNumber: "1004", paidDate: "2026-07-01", amountPaid: 4824.84 },
        { googleEventId: "1005", invoiceNumber: "1005", paidDate: "2026-07-01", amountPaid: 3929.36 },
      ],
    });
    expect(result).toMatchObject({ action: "duplicate", candidate: { kind: "legacy_paid_invoices" } });
  });

  it("routes multiple same-date/same-amount candidates to review", () => {
    const candidate = (id: string) => ({ paymentBatchId: id, receivedDate: input.postedDate, amount: input.amount,
      bankAccount: input.sourceAccount, reference: id, bankTransactionId: null, allocationIds: [], invoiceEventIds: [] });
    expect(decideCrossSourceOverlap(input, { ...empty, paymentBatches: [candidate("one"), candidate("two")] })).toMatchObject({
      action: "review", reason: "ambiguous_cross_source_overlap",
    });
  });

  it("leaves a genuinely new unique outstanding match for the existing engine", () => {
    expect(decideCrossSourceOverlap({ ...input, amount: 944.27 }, empty).action).toBe("none");
    expect(decideAutomaticReconciliation(944.27, [invoice("1007", 944.27), invoice("1013", 821.56)])).toMatchObject({
      action: "auto_apply", allocations: [{ invoiceNumber: "1007", amount: 944.27 }],
    });
  });

  it("does not choose between duplicate $656.56 evidence", () => {
    const paidInvoices = ["1009", "older"].map((number) => ({ googleEventId: number, invoiceNumber: number, paidDate: "2026-08-12", amountPaid: 656.56 }));
    expect(decideCrossSourceOverlap({ ...input, postedDate: "2026-08-12", amount: 656.56 }, { ...empty, paidInvoices }).action).toBe("review");
  });
});
