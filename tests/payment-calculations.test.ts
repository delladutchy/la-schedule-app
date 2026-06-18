import { describe, it, expect } from "vitest";
import { calcPaymentResult } from "@/lib/payment-batches";

const TODAY = "2026-06-18";

describe("calcPaymentResult", () => {
  // ── Full payment ───────────────────────────────────────────────────────────

  it("marks invoice paid when fully allocated", () => {
    const r = calcPaymentResult(1980, 1980, TODAY);
    expect(r.status).toBe("paid");
    expect(r.amountPaid).toBe(1980);
    expect(r.remainingBalance).toBe(0);
    expect(r.paidDate).toBe(TODAY);
  });

  it("marks invoice paid when over-allocated (caps amountPaid to invoiceTotal)", () => {
    const r = calcPaymentResult(2000, 1980, TODAY);
    expect(r.status).toBe("paid");
    expect(r.amountPaid).toBe(1980);
    expect(r.remainingBalance).toBe(0);
    expect(r.paidDate).toBe(TODAY);
  });

  it("marks invoice paid when sub-cent remainder rounds to zero", () => {
    // 1979.998 → remaining = round2(0.002) = 0.00 → paid
    const r = calcPaymentResult(1979.998, 1980, TODAY);
    expect(r.status).toBe("paid");
    expect(r.paidDate).toBe(TODAY);
  });

  // ── Partial payment ────────────────────────────────────────────────────────

  it("marks invoice partially_paid when some but not all is allocated", () => {
    const r = calcPaymentResult(500, 1980, TODAY);
    expect(r.status).toBe("partially_paid");
    expect(r.amountPaid).toBe(500);
    expect(r.remainingBalance).toBe(1480);
    expect(r.paidDate).toBeNull();
  });

  it("calculates remaining balance correctly", () => {
    const r = calcPaymentResult(1000, 1980, TODAY);
    expect(r.remainingBalance).toBe(980);
  });

  it("rounds to 2 decimal places", () => {
    const r = calcPaymentResult(333.333, 1000, TODAY);
    expect(r.amountPaid).toBe(333.33);
    expect(r.remainingBalance).toBe(666.67);
  });

  // ── No payment / allocation removed ───────────────────────────────────────

  it("returns sent status when no amount allocated", () => {
    const r = calcPaymentResult(0, 1980, TODAY);
    expect(r.status).toBe("sent");
    expect(r.amountPaid).toBe(0);
    expect(r.remainingBalance).toBe(1980);
    expect(r.paidDate).toBeNull();
  });

  it("does not set paid_date for partial or no payment", () => {
    expect(calcPaymentResult(0,   1980, TODAY).paidDate).toBeNull();
    expect(calcPaymentResult(500, 1980, TODAY).paidDate).toBeNull();
  });

  // ── Allocation removal should revert status ────────────────────────────────

  it("reverts to sent when last allocation is removed (total = 0)", () => {
    // Simulate: invoice was partially_paid, then the allocation is removed.
    // After deletion, recalcInvoicePayments passes totalAllocated = 0.
    const r = calcPaymentResult(0, 1980, TODAY);
    expect(r.status).toBe("sent");
    expect(r.amountPaid).toBe(0);
    expect(r.remainingBalance).toBe(1980);
  });

  it("recalculates correctly when one of two allocations is removed", () => {
    // Two allocations: $500 + $480 = $980. Remove the $480 → $500 remains.
    const r = calcPaymentResult(500, 1980, TODAY);
    expect(r.status).toBe("partially_paid");
    expect(r.amountPaid).toBe(500);
    expect(r.remainingBalance).toBe(1480);
  });
});
