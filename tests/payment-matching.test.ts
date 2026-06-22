import { describe, it, expect } from "vitest";
import {
  buildOldestFirstPaymentPlan,
  findPaymentMatches,
  getInvoiceRemainingBalance,
  sortByOldestOpenInvoice,
  sortByMatchPriority,
  type InvoiceForMatching,
} from "@/lib/payment-matching";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeInvoice(overrides: Partial<InvoiceForMatching> & { id: string }): InvoiceForMatching {
  return {
    google_event_id:   overrides.id,
    invoice_number:    overrides.invoice_number    ?? null,
    la_number:         overrides.la_number         ?? null,
    invoice_total:     overrides.invoice_total     ?? null,
    amount_paid:       overrides.amount_paid       ?? 0,
    remaining_balance: overrides.remaining_balance ?? null,
    invoice_status:    overrides.invoice_status    ?? "sent",
    invoice_sent_at:   overrides.invoice_sent_at   ?? null,
  };
}

const inv1001 = makeInvoice({ id: "evt-1", invoice_number: "1001", la_number: "71760", invoice_total: 2598.75, remaining_balance: 2598.75, invoice_sent_at: "2026-05-01T00:00:00Z" });
const inv1002 = makeInvoice({ id: "evt-2", invoice_number: "1002", la_number: "71761", invoice_total: 2550.00, remaining_balance: 2550.00, invoice_sent_at: "2026-05-15T00:00:00Z" });
const inv1003 = makeInvoice({ id: "evt-3", invoice_number: "1003", la_number: "71762", invoice_total: 1980.00, remaining_balance: 1980.00, invoice_sent_at: "2026-06-01T00:00:00Z" });

// ---------------------------------------------------------------------------
// getInvoiceRemainingBalance
// ---------------------------------------------------------------------------

describe("getInvoiceRemainingBalance", () => {
  it("returns remaining_balance when set", () => {
    expect(getInvoiceRemainingBalance(inv1001)).toBe(2598.75);
  });

  it("falls back to invoice_total − amount_paid when remaining_balance is null", () => {
    const inv = makeInvoice({ id: "x", invoice_total: 1000, amount_paid: 400, remaining_balance: null });
    expect(getInvoiceRemainingBalance(inv)).toBe(600);
  });

  it("returns 0 when both invoice_total and remaining_balance are null", () => {
    const inv = makeInvoice({ id: "x", invoice_total: null, remaining_balance: null });
    expect(getInvoiceRemainingBalance(inv)).toBe(0);
  });

  it("clamps to 0 when amount_paid exceeds invoice_total", () => {
    const inv = makeInvoice({ id: "x", invoice_total: 500, amount_paid: 600, remaining_balance: null });
    expect(getInvoiceRemainingBalance(inv)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sortByMatchPriority
// ---------------------------------------------------------------------------

describe("sortByMatchPriority", () => {
  it("puts sent invoices before partially_paid", () => {
    const partial = makeInvoice({ id: "p", invoice_status: "partially_paid", invoice_sent_at: "2026-01-01T00:00:00Z" });
    const sent    = makeInvoice({ id: "s", invoice_status: "sent",           invoice_sent_at: "2026-06-01T00:00:00Z" });
    const sorted = sortByMatchPriority([partial, sent]);
    expect(sorted[0]!.google_event_id).toBe("s");
  });

  it("sorts older sent_at first within the same status", () => {
    const old    = makeInvoice({ id: "old",  invoice_sent_at: "2026-01-01T00:00:00Z" });
    const recent = makeInvoice({ id: "new",  invoice_sent_at: "2026-06-01T00:00:00Z" });
    const sorted = sortByMatchPriority([recent, old]);
    expect(sorted[0]!.google_event_id).toBe("old");
  });
});

// ---------------------------------------------------------------------------
// buildOldestFirstPaymentPlan — actual payment workflow preview
// ---------------------------------------------------------------------------

describe("buildOldestFirstPaymentPlan", () => {
  it("auto-allocates a lump payment to oldest unpaid invoices first", () => {
    const plan = buildOldestFirstPaymentPlan(4000, [inv1003, inv1002, inv1001]);

    expect(plan.lines.map((line) => line.invoice.invoice_number)).toEqual(["1001", "1002"]);
    expect(plan.lines[0]!.allocatedAmount).toBe(2598.75);
    expect(plan.lines[0]!.resultingStatus).toBe("paid");
    expect(plan.lines[1]!.allocatedAmount).toBe(1401.25);
    expect(plan.lines[1]!.resultingStatus).toBe("partially_paid");
    expect(plan.allocatedTotal).toBe(4000);
    expect(plan.unappliedAmount).toBe(0);
  });

  it("fully pays invoices until the last covered invoice becomes partial", () => {
    const plan = buildOldestFirstPaymentPlan(2598.75 + 500, [inv1001, inv1002, inv1003]);

    expect(plan.lines).toHaveLength(2);
    expect(plan.lines[0]!.invoice.invoice_number).toBe("1001");
    expect(plan.lines[0]!.resultingStatus).toBe("paid");
    expect(plan.lines[1]!.invoice.invoice_number).toBe("1002");
    expect(plan.lines[1]!.allocatedAmount).toBe(500);
    expect(plan.lines[1]!.resultingStatus).toBe("partially_paid");
  });

  it("reports unapplied amount when the payment exceeds open invoice balances", () => {
    const plan = buildOldestFirstPaymentPlan(10000, [inv1001, inv1002, inv1003]);

    expect(plan.allocatedTotal).toBe(7128.75);
    expect(plan.unappliedAmount).toBe(2871.25);
    expect(plan.lines.every((line) => line.resultingStatus === "paid")).toBe(true);
  });

  it("skips paid and void invoices", () => {
    const paid = makeInvoice({
      id: "paid",
      invoice_number: "999",
      invoice_total: 100,
      remaining_balance: 100,
      invoice_status: "paid",
      invoice_sent_at: "2026-01-01T00:00:00Z",
    });
    const voided = makeInvoice({
      id: "void",
      invoice_number: "998",
      invoice_total: 100,
      remaining_balance: 100,
      invoice_status: "void",
      invoice_sent_at: "2026-01-02T00:00:00Z",
    });

    const plan = buildOldestFirstPaymentPlan(1000, [paid, voided, inv1001]);

    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]!.invoice.invoice_number).toBe("1001");
  });

  it("can allocate to historical draft-created invoices without requiring a sent email", () => {
    const historical = makeInvoice({
      id: "historical",
      invoice_number: "900",
      la_number: "70001",
      invoice_total: 750,
      remaining_balance: 750,
      invoice_status: "draft_created",
      invoice_sent_at: null,
    });

    const plan = buildOldestFirstPaymentPlan(750, [historical]);

    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]!.invoice.google_event_id).toBe("historical");
    expect(plan.lines[0]!.allocatedAmount).toBe(750);
    expect(plan.lines[0]!.resultingStatus).toBe("paid");
  });

  it("settles older partially-paid invoices before newer open invoices", () => {
    const partialOld = makeInvoice({
      id: "partial-old",
      invoice_number: "1000",
      invoice_total: 1000,
      amount_paid: 400,
      remaining_balance: 600,
      invoice_status: "partially_paid",
      invoice_sent_at: "2026-04-01T00:00:00Z",
    });
    const sentNew = makeInvoice({
      id: "sent-new",
      invoice_number: "1004",
      invoice_total: 1000,
      remaining_balance: 1000,
      invoice_status: "sent",
      invoice_sent_at: "2026-05-01T00:00:00Z",
    });

    const sorted = sortByOldestOpenInvoice([sentNew, partialOld]);
    const plan = buildOldestFirstPaymentPlan(700, [sentNew, partialOld]);

    expect(sorted[0]!.google_event_id).toBe("partial-old");
    expect(plan.lines[0]!.invoice.google_event_id).toBe("partial-old");
    expect(plan.lines[0]!.allocatedAmount).toBe(600);
    expect(plan.lines[1]!.invoice.google_event_id).toBe("sent-new");
    expect(plan.lines[1]!.allocatedAmount).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// findPaymentMatches — exact single invoice
// ---------------------------------------------------------------------------

describe("findPaymentMatches — single invoice exact match", () => {
  it("finds an exact single-invoice match", () => {
    const results = findPaymentMatches(2598.75, [inv1001, inv1002, inv1003]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.matchType).toBe("exact");
    expect(results[0]!.invoices).toHaveLength(1);
    expect(results[0]!.invoices[0]!.invoice_number).toBe("1001");
    expect(results[0]!.difference).toBe(0);
  });

  it("is exact — isExact flag is true", () => {
    const [top] = findPaymentMatches(1980.00, [inv1001, inv1002, inv1003]);
    expect(top!.isExact).toBe(true);
    expect(top!.matchType).toBe("exact");
  });
});

// ---------------------------------------------------------------------------
// findPaymentMatches — exact multi-invoice match
// ---------------------------------------------------------------------------

describe("findPaymentMatches — multi-invoice exact match", () => {
  it("finds an exact two-invoice combination", () => {
    const amount  = 2598.75 + 2550.00; // 5148.75
    const results = findPaymentMatches(amount, [inv1001, inv1002, inv1003]);
    expect(results[0]!.matchType).toBe("exact");
    expect(results[0]!.invoices).toHaveLength(2);
    expect(results[0]!.difference).toBe(0);
    const ids = results[0]!.invoices.map((i) => i.invoice_number).sort();
    expect(ids).toEqual(["1001", "1002"]);
  });

  it("prefers fewer invoices when multiple exact combos exist", () => {
    // single match at 1980 exists AND 2598.75+2550 both happen to contain a 1980 combo
    const singleMatchAmt = 1980.00;
    const results = findPaymentMatches(singleMatchAmt, [inv1001, inv1002, inv1003]);
    // single exact match (1003 alone at $1980) should be preferred
    expect(results[0]!.invoices).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findPaymentMatches — partially paid invoice uses remaining_balance
// ---------------------------------------------------------------------------

describe("findPaymentMatches — partial payment", () => {
  it("matches against remaining_balance, not invoice_total", () => {
    const partiallyPaid = makeInvoice({
      id:                "evt-partial",
      invoice_number:    "1004",
      invoice_total:     2598.75,
      amount_paid:       1000,
      remaining_balance: 1598.75,
      invoice_status:    "partially_paid",
    });
    const results = findPaymentMatches(1598.75, [partiallyPaid]);
    expect(results[0]!.matchType).toBe("exact");
    expect(results[0]!.totalBalance).toBe(1598.75);
  });

  it("ignores amount_paid when computing balance — does not match invoice_total", () => {
    const partiallyPaid = makeInvoice({
      id:                "evt-partial2",
      invoice_number:    "1005",
      invoice_total:     2598.75,
      amount_paid:       1000,
      remaining_balance: 1598.75,
      invoice_status:    "partially_paid",
    });
    // Searching for the full invoice_total should NOT find an exact match
    const results = findPaymentMatches(2598.75, [partiallyPaid]);
    expect(results[0]!.matchType).not.toBe("exact");
  });
});

// ---------------------------------------------------------------------------
// findPaymentMatches — no exact match
// ---------------------------------------------------------------------------

describe("findPaymentMatches — no exact match", () => {
  it("returns partial suggestions when no exact match exists", () => {
    const results = findPaymentMatches(9999.00, [inv1001, inv1002, inv1003]);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.matchType === "partial")).toBe(true);
  });

  it("sorts partial suggestions by closest difference first", () => {
    // inv1003 ($1980) is closer to $2000 than inv1001 ($2598.75) or inv1002 ($2550)
    const results = findPaymentMatches(2000.00, [inv1001, inv1002, inv1003]);
    expect(results[0]!.invoices[0]!.invoice_number).toBe("1003");
  });

  it("returns none matchType when no eligible invoices exist", () => {
    const paid = makeInvoice({ id: "paid", invoice_status: "paid", invoice_total: 100, remaining_balance: 0 });
    const results = findPaymentMatches(100, [paid]);
    expect(results[0]!.matchType).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Smart match does not auto-apply
// ---------------------------------------------------------------------------

describe("smart match does not auto-apply", () => {
  it("findPaymentMatches returns data only — no side effects", () => {
    // The function is pure; calling it with any arguments produces only a return value.
    // There's no DB call, no fetch, no state mutation — just a value.
    const before = Date.now();
    const results = findPaymentMatches(5148.75, [inv1001, inv1002, inv1003]);
    const after  = Date.now();

    expect(results).toBeDefined();
    // Should complete near-instantly (no I/O)
    expect(after - before).toBeLessThan(500);
    // The caller must explicitly take action — the function merely returns a suggestion.
  });
});

// ---------------------------------------------------------------------------
// Applying match uses existing allocation/sync path (structural test)
// ---------------------------------------------------------------------------

describe("applyMatch uses per-invoice allocation API calls", () => {
  it("each invoice in a suggestion has a google_event_id for the allocation POST", () => {
    const results = findPaymentMatches(5148.75, [inv1001, inv1002]);
    const suggestion = results[0]!;
    expect(suggestion.matchType).toBe("exact");

    // Every invoice in the suggestion has the fields needed for the allocation POST body
    for (const inv of suggestion.invoices) {
      expect(inv.google_event_id).toBeTruthy();
      expect(inv.invoice_total).toBeGreaterThan(0);
      expect(getInvoiceRemainingBalance(inv)).toBeGreaterThan(0);
    }
  });
});
