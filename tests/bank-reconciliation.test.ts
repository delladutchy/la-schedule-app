import { describe, expect, it } from "vitest";
import {
  decideAutomaticReconciliation,
  dedupeBankTransactionImports,
  resolveLaPaySheetName,
} from "@/lib/bank-reconciliation";
import { parseWellsFargoCsv } from "@/lib/wells-fargo-csv";
import type { InvoiceForMatching } from "@/lib/payment-matching";

function invoice(
  number: string,
  balance: number,
  status = "sent",
  eventId = `event-${number}`,
): InvoiceForMatching {
  return {
    google_event_id: eventId,
    client: "Light Action",
    invoice_number: number,
    la_number: null,
    invoice_total: balance,
    amount_paid: status === "paid" ? balance : 0,
    remaining_balance: status === "paid" ? 0 : balance,
    invoice_status: status,
    invoice_sent_at: `2026-08-${String(Number(number.replace(/\D/g, "").slice(-2)) || 1).padStart(2, "0")}T00:00:00Z`,
  };
}

describe("automatic bank reconciliation", () => {
  it("uniquely matches the verified 8/26 deposit to #1010 + #1012 + #1011", () => {
    const decision = decideAutomaticReconciliation(10336.22, [
      invoice("1007", 944.27),
      invoice("1010", 3020),
      invoice("1011", 3702.11),
      invoice("1012", 3614.11),
      invoice("1013", 821.56),
      invoice("1014", 3194.06),
    ]);

    expect(decision.action).toBe("auto_apply");
    if (decision.action !== "auto_apply") throw new Error("Expected auto_apply");
    expect(decision.allocations.map((allocation) => allocation.invoiceNumber).sort()).toEqual(["1010", "1011", "1012"]);
    expect(decision.allocations.reduce((sum, allocation) => sum + allocation.amount, 0)).toBeCloseTo(10336.22, 2);
  });

  it("uniquely matches the verified 7/1 deposit to #1003 + #1004 + #1005", () => {
    const decision = decideAutomaticReconciliation(9836.09, [
      invoice("1003", 1081.89),
      invoice("1004", 4824.84),
      invoice("1005", 3929.36),
      invoice("1006", 2913.62),
    ]);
    expect(decision.action).toBe("auto_apply");
    if (decision.action !== "auto_apply") throw new Error("Expected auto_apply");
    expect(decision.allocations.map((allocation) => allocation.invoiceNumber).sort()).toEqual(["1003", "1004", "1005"]);
  });

  it("sends duplicate $656.56 invoice candidates to review instead of guessing", () => {
    const decision = decideAutomaticReconciliation(656.56, [
      invoice("1009", 656.56),
      invoice("QB-UAE-20260602", 656.56, "sent", "event-uae-20260602"),
    ]);
    expect(decision.action).toBe("review");
    expect(decision.reason).toBe("ambiguous_exact_match");
    expect(decision.candidateMatches).toHaveLength(2);
  });

  it("does not auto-post ambiguous multi-invoice combinations", () => {
    const decision = decideAutomaticReconciliation(300, [
      invoice("A", 100), invoice("B", 200), invoice("C", 150), invoice("D", 150),
    ]);
    expect(decision.action).toBe("review");
    expect(decision.reason).toBe("ambiguous_exact_match");
  });

  it("treats an exact single invoice versus an exact combination as ambiguous", () => {
    const decision = decideAutomaticReconciliation(300, [
      invoice("single", 300), invoice("part-a", 100), invoice("part-b", 200),
    ]);
    expect(decision.action).toBe("review");
    expect(decision.reason).toBe("ambiguous_exact_match");
  });

  it("excludes paid, void, and test invoices", () => {
    const decision = decideAutomaticReconciliation(500, [
      invoice("paid", 500, "paid"),
      invoice("void", 500, "void"),
      invoice("test", 500, "sent", "test-fixture"),
      invoice("real", 500),
    ]);
    expect(decision.action).toBe("auto_apply");
    if (decision.action !== "auto_apply") throw new Error("Expected auto_apply");
    expect(decision.allocations[0]!.invoiceNumber).toBe("real");
  });

  it("excludes invoices belonging to another client", () => {
    const otherClient = { ...invoice("other", 500), client: "Different Client" };
    const decision = decideAutomaticReconciliation(500, [otherClient, invoice("light-action", 500)]);
    expect(decision.action).toBe("auto_apply");
    if (decision.action !== "auto_apply") throw new Error("Expected auto_apply");
    expect(decision.allocations[0]!.invoiceNumber).toBe("light-action");
  });

  it("ignores withdrawals rather than putting them in the deposit review queue", () => {
    const decision = decideAutomaticReconciliation(-100, [invoice("1007", 944.27)]);
    expect(decision.action).toBe("ignore");
    expect(decision.reason).toBe("not_a_deposit");
  });

  it("routes deposits with no exact match to review", () => {
    const decision = decideAutomaticReconciliation(999.99, [invoice("1007", 944.27)]);
    expect(decision.action).toBe("review");
    expect(decision.reason).toBe("no_exact_match");
  });
});

describe("Wells Fargo CSV ingestion", () => {
  const csv = [
    "Posted Date,Amount,Transaction ID,Description",
    '08/26/2026,"$10,336.22",wf-direct-20260826,"LIGHT ACTION, payroll deposit"',
  ].join("\n");

  it("normalizes a Wells Fargo row into the provider-independent transaction shape", () => {
    const [transaction] = parseWellsFargoCsv(csv, "WF checking");
    expect(transaction).toMatchObject({
      source: "wells_fargo_csv",
      externalTransactionId: "wf-direct-20260826",
      postedDate: "2026-08-26",
      amount: 10336.22,
      description: "LIGHT ACTION, payroll deposit",
      sourceAccount: "WF checking",
    });
  });

  it("derives the same stable ID every time when the CSV has no transaction ID", () => {
    const headerless = '08/26/2026,10336.22,*,,"LIGHT ACTION PAYROLL"';
    const first = parseWellsFargoCsv(headerless, "WF checking")[0]!;
    const second = parseWellsFargoCsv(headerless, "WF checking")[0]!;
    expect(first.externalTransactionId).toMatch(/^wf_[a-f0-9]{64}$/);
    expect(second.externalTransactionId).toBe(first.externalTransactionId);
  });

  it("drops duplicate imports with the same source and stable transaction ID", () => {
    const transaction = parseWellsFargoCsv(csv)[0]!;
    expect(dedupeBankTransactionImports([transaction, transaction])).toEqual([transaction]);
  });
});

describe("year-specific Sheet routing", () => {
  it("routes an invoice using its earliest workday year", () => {
    expect(resolveLaPaySheetName(["2027-01-02", "2026-12-31"], "LA PAY (2026)"))
      .toBe("LA PAY (2026)");
    expect(resolveLaPaySheetName(["2027-01-02"], "LA PAY (2026)"))
      .toBe("LA PAY (2027)");
  });
});
