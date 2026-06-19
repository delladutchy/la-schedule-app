import { describe, it, expect } from "vitest";
import {
  parseTimeToMinutes,
  calculateHours,
  calculateMileage,
  calculateWorkdayMileage,
  getDefaultDeductionForMode,
  initWorkdayEntries,
  calculateInvoicePacket,
  generateSheetRow,
  round2,
} from "@/lib/invoice-calculations";
import type { InvoiceData, WorkdayEntry } from "@/lib/invoice-types";

describe("parseTimeToMinutes", () => {
  it("parses 8:00 AM", () => expect(parseTimeToMinutes("8:00 AM")).toBe(480));
  it("parses 6:00 PM", () => expect(parseTimeToMinutes("6:00 PM")).toBe(1080));
  it("parses 8:30 PM", () => expect(parseTimeToMinutes("8:30 PM")).toBe(1230));
  it("parses 12:00 PM (noon)", () => expect(parseTimeToMinutes("12:00 PM")).toBe(720));
  it("parses 12:00 AM (midnight)", () => expect(parseTimeToMinutes("12:00 AM")).toBe(0));
  it("returns null for empty string", () => expect(parseTimeToMinutes("")).toBeNull());
  it("returns null for garbage", () => expect(parseTimeToMinutes("not a time")).toBeNull());
});

describe("calculateHours", () => {
  it("8:00 AM to 6:00 PM = 10 h total, 0 OT", () => {
    const result = calculateHours("8:00 AM", "6:00 PM");
    expect(result.totalHours).toBeCloseTo(10);
    expect(result.overtimeHours).toBe(0);
  });

  it("8:00 AM to 7:00 PM = 11 h total, 1 OT", () => {
    const result = calculateHours("8:00 AM", "7:00 PM");
    expect(result.totalHours).toBeCloseTo(11);
    expect(result.overtimeHours).toBeCloseTo(1);
  });

  it("8:00 AM to 8:30 PM = 12.5 h total, 2.5 OT", () => {
    const result = calculateHours("8:00 AM", "8:30 PM");
    expect(result.totalHours).toBeCloseTo(12.5);
    expect(result.overtimeHours).toBeCloseTo(2.5);
  });

  it("overnight: 8:00 PM to 2:00 AM = 6 h total, 0 OT", () => {
    const result = calculateHours("8:00 PM", "2:00 AM");
    expect(result.totalHours).toBeCloseTo(6);
    expect(result.overtimeHours).toBe(0);
  });

  it("overnight: 8:00 PM to 7:00 AM = 11 h total, 1 OT", () => {
    const result = calculateHours("8:00 PM", "7:00 AM");
    expect(result.totalHours).toBeCloseTo(11);
    expect(result.overtimeHours).toBeCloseTo(1);
  });

  it("exact 10 hours = 0 OT", () => {
    const result = calculateHours("7:00 AM", "5:00 PM");
    expect(result.totalHours).toBeCloseTo(10);
    expect(result.overtimeHours).toBe(0);
  });

  it("same start and end = 0 h (not 24 h)", () => {
    const result = calculateHours("8:00 AM", "8:00 AM");
    expect(result.totalHours).toBe(0);
    expect(result.overtimeHours).toBe(0);
  });
});

describe("calculateMileage", () => {
  it("420 miles → 360 reimbursed, 60 unreimbursed, $187.20 paid", () => {
    const result = calculateMileage(420, 60, 0.52);
    expect(result.reimbursedMiles).toBe(360);
    expect(result.unreimbursedMiles).toBe(60);
    expect(result.mileageAmount).toBeCloseTo(187.2);
    expect(result.mileageAdjustmentAmount).toBeCloseTo(-31.2);
  });

  it("50 miles (under deduction) → 0 reimbursed", () => {
    const result = calculateMileage(50, 60, 0.52);
    expect(result.reimbursedMiles).toBe(0);
    expect(result.unreimbursedMiles).toBe(50);
    expect(result.mileageAmount).toBe(0);
    expect(result.mileageAdjustmentAmount).toBeCloseTo(-31.2);
  });

  it("exactly 60 miles → 0 reimbursed", () => {
    const result = calculateMileage(60, 60, 0.52);
    expect(result.reimbursedMiles).toBe(0);
    expect(result.unreimbursedMiles).toBe(60);
    expect(result.mileageAmount).toBe(0);
  });

  it("manual mileage: calculates correctly for given input (no auto-override)", () => {
    const result = calculateMileage(120, 60, 0.52);
    expect(result.totalMiles).toBe(120);
    expect(result.reimbursedMiles).toBe(60);
    expect(result.mileageAmount).toBeCloseTo(31.2);
  });
});

describe("round2", () => {
  it("rounds to 2 decimal places", () => {
    expect(round2(187.200000001)).toBe(187.2);
    expect(round2(0.005)).toBe(0.01);
  });
});

// ---------------------------------------------------------------------------
// getDefaultDeductionForMode
// ---------------------------------------------------------------------------

describe("getDefaultDeductionForMode", () => {
  it("from_dewey → 30 mi deduction", () => {
    expect(getDefaultDeductionForMode("from_dewey")).toBe(30);
  });
  it("to_dewey → 30 mi deduction", () => {
    expect(getDefaultDeductionForMode("to_dewey")).toBe(30);
  });
  it("round_trip_dewey → 60 mi deduction", () => {
    expect(getDefaultDeductionForMode("round_trip_dewey")).toBe(60);
  });
  it("custom → 60 mi deduction (default)", () => {
    expect(getDefaultDeductionForMode("custom")).toBe(60);
  });
  it("none → 0 mi deduction", () => {
    expect(getDefaultDeductionForMode("none")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// calculateWorkdayMileage
// ---------------------------------------------------------------------------

describe("calculateWorkdayMileage", () => {
  it("returns null when mileageMode is none", () => {
    const entry: WorkdayEntry = { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "none" };
    expect(calculateWorkdayMileage(entry)).toBeNull();
  });

  it("returns null when mileageMode is undefined", () => {
    const entry: WorkdayEntry = { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" };
    expect(calculateWorkdayMileage(entry)).toBeNull();
  });

  it("returns null when milesDriven is 0", () => {
    const entry: WorkdayEntry = { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "round_trip_dewey", milesDriven: 0 };
    expect(calculateWorkdayMileage(entry)).toBeNull();
  });

  it("from_dewey: 80 mi driven → 50 billable (deduct 30)", () => {
    const entry: WorkdayEntry = { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "from_dewey", milesDriven: 80 };
    const result = calculateWorkdayMileage(entry);
    expect(result).not.toBeNull();
    expect(result!.deduction).toBe(30);
    expect(result!.billableMiles).toBe(50);
  });

  it("to_dewey: 80 mi driven → 50 billable (deduct 30)", () => {
    const entry: WorkdayEntry = { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "to_dewey", milesDriven: 80 };
    const result = calculateWorkdayMileage(entry);
    expect(result).not.toBeNull();
    expect(result!.deduction).toBe(30);
    expect(result!.billableMiles).toBe(50);
  });

  it("round_trip_dewey: 120 mi driven → 60 billable (deduct 60)", () => {
    const entry: WorkdayEntry = { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "round_trip_dewey", milesDriven: 120 };
    const result = calculateWorkdayMileage(entry);
    expect(result).not.toBeNull();
    expect(result!.deduction).toBe(60);
    expect(result!.billableMiles).toBe(60);
  });

  it("custom: uses explicit mileageDeduction override", () => {
    const entry: WorkdayEntry = { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "custom", milesDriven: 100, mileageDeduction: 20 };
    const result = calculateWorkdayMileage(entry);
    expect(result).not.toBeNull();
    expect(result!.deduction).toBe(20);
    expect(result!.billableMiles).toBe(80);
  });

  it("billable miles never goes below 0 (deduction > miles driven)", () => {
    const entry: WorkdayEntry = { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "round_trip_dewey", milesDriven: 40 };
    const result = calculateWorkdayMileage(entry);
    expect(result).not.toBeNull();
    expect(result!.billableMiles).toBe(0);
  });

  it("custom with null mileageDeduction falls back to mode default (60)", () => {
    const entry: WorkdayEntry = { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "custom", milesDriven: 100, mileageDeduction: null };
    const result = calculateWorkdayMileage(entry);
    expect(result).not.toBeNull();
    expect(result!.deduction).toBe(60);
    expect(result!.billableMiles).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// calculateInvoicePacket — per-day mileage aggregation and legacy fallback
// ---------------------------------------------------------------------------

function makeInvoiceData(overrides: Partial<InvoiceData> = {}): InvoiceData {
  return {
    id: "test-id",
    google_event_id: "evt-1",
    la_number: "LA-2026-001",
    invoice_status: "none",
    client: "Test Client",
    day_rate: 800,
    per_diem_rate: 0,
    overtime_rate: 100,
    bag_fees: null,
    hotel: null,
    parking: null,
    tolls: null,
    uber: null,
    other_expenses: null,
    expense_notes: null,
    job_address: null,
    total_miles: null,
    mileage_rate: 0.52,
    mileage_deduction_miles: 60,
    sheet_synced_at: null,
    sheet_sync_error: null,
    paid_date: null,
    // Native invoicing fields
    invoice_number: null,
    invoice_pdf_url: null,
    invoice_created_at: null,
    invoice_sent_at: null,
    invoice_sent_to: null,
    invoice_total: null,
    amount_paid: 0,
    remaining_balance: null,
    quickbooks_invoice_id: null,
    quickbooks_invoice_link: null,
    quickbooks_synced_at: null,
    quickbooks_sync_error: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    workday_entries: [],
    ...overrides,
  };
}

describe("calculateInvoicePacket — per-day mileage aggregation", () => {
  it("single day round_trip_dewey: sums correctly", () => {
    const data = makeInvoiceData({
      workday_entries: [
        { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "round_trip_dewey", milesDriven: 120 },
      ],
    });
    const p = calculateInvoicePacket(data);
    expect(p.mileage).not.toBeNull();
    expect(p.mileage!.totalMiles).toBe(120);
    expect(p.mileage!.deductionMiles).toBe(60);
    expect(p.mileage!.reimbursedMiles).toBe(60);
    expect(p.mileage!.mileageAmount).toBeCloseTo(31.2);
  });

  it("multi-day mileage aggregates across all days", () => {
    const data = makeInvoiceData({
      workday_entries: [
        { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "from_dewey", milesDriven: 80 },
        { date: "2026-06-02", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "to_dewey", milesDriven: 80 },
      ],
    });
    const p = calculateInvoicePacket(data);
    expect(p.mileage).not.toBeNull();
    expect(p.mileage!.totalMiles).toBe(160);
    expect(p.mileage!.deductionMiles).toBe(60); // 30 + 30
    expect(p.mileage!.reimbursedMiles).toBe(100); // 50 + 50
    expect(p.mileage!.unreimbursedMiles).toBe(60);
  });

  it("billable miles sum never below 0 across multiple days", () => {
    const data = makeInvoiceData({
      workday_entries: [
        { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "round_trip_dewey", milesDriven: 20 }, // 0 billable
        { date: "2026-06-02", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "round_trip_dewey", milesDriven: 20 }, // 0 billable
      ],
    });
    const p = calculateInvoicePacket(data);
    expect(p.mileage!.reimbursedMiles).toBe(0);
    expect(p.mileage!.mileageAmount).toBe(0);
  });

  it("no per-day mileage + no total_miles → mileage is null", () => {
    const data = makeInvoiceData({
      workday_entries: [{ date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" }],
    });
    const p = calculateInvoicePacket(data);
    expect(p.mileage).toBeNull();
  });

  it("legacy fallback: uses total_miles when no per-day mileage set", () => {
    const data = makeInvoiceData({
      total_miles: 420,
      mileage_deduction_miles: 60,
      workday_entries: [{ date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" }],
    });
    const p = calculateInvoicePacket(data);
    expect(p.mileage).not.toBeNull();
    expect(p.mileage!.totalMiles).toBe(420);
    expect(p.mileage!.reimbursedMiles).toBe(360);
    expect(p.mileage!.mileageAmount).toBeCloseTo(187.2);
  });

  it("per-day mileage takes precedence over legacy total_miles", () => {
    const data = makeInvoiceData({
      total_miles: 999,
      workday_entries: [
        { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "round_trip_dewey", milesDriven: 120 },
      ],
    });
    const p = calculateInvoicePacket(data);
    expect(p.mileage!.totalMiles).toBe(120); // per-day wins
  });
});

// ---------------------------------------------------------------------------
// generateSheetRow — mileage columns
// ---------------------------------------------------------------------------

describe("generateSheetRow — mileage columns", () => {
  it("exports totalBusinessMiles, laPaidMiles, unreimbursedMiles, mileagePaid correctly", () => {
    const data = makeInvoiceData({
      workday_entries: [
        { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "round_trip_dewey", milesDriven: 120 },
      ],
    });
    const p = calculateInvoicePacket(data);
    const row = generateSheetRow(p, "Test Gig");
    expect(row.totalBusinessMiles).toBe(120);
    expect(row.laPaidMiles).toBe(60);
    expect(row.unreimbursedMiles).toBe(60);
    expect(row.mileagePaid).toBeCloseTo(31.2);
  });

  it("all mileage sheet columns are 0 when no mileage set", () => {
    const data = makeInvoiceData({
      workday_entries: [{ date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" }],
    });
    const p = calculateInvoicePacket(data);
    const row = generateSheetRow(p, "Test Gig");
    expect(row.totalBusinessMiles).toBe(0);
    expect(row.laPaidMiles).toBe(0);
    expect(row.unreimbursedMiles).toBe(0);
    expect(row.mileagePaid).toBe(0);
  });

  it("legacy total_miles is ignored for sheet export when per-day mileage exists", () => {
    const data = makeInvoiceData({
      total_miles: 644,              // old legacy value
      mileage_deduction_miles: 60,
      workday_entries: [
        { date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM", mileageMode: "round_trip_dewey", milesDriven: 120 },
      ],
    });
    const p = calculateInvoicePacket(data);
    const row = generateSheetRow(p, "Test Gig");
    expect(row.totalBusinessMiles).toBe(120);  // per-day wins; legacy 644 ignored
    expect(row.laPaidMiles).toBe(60);
    expect(row.unreimbursedMiles).toBe(60);
    expect(row.mileagePaid).toBeCloseTo(31.2);
  });
});

// ---------------------------------------------------------------------------
// Legacy mileage → per-day conversion (calculation layer)
// ---------------------------------------------------------------------------

describe("legacy total_miles → custom per-day conversion", () => {
  it("after conversion: packet uses per-day entry, not total_miles", () => {
    // Simulate the result after UI calls: workday_entries[0] = custom 644 mi,
    // total_miles = null (cleared by the PATCH).
    const data = makeInvoiceData({
      total_miles: null,             // cleared after conversion
      mileage_deduction_miles: 60,
      workday_entries: [
        {
          date: "2026-06-01",
          startTime: "8:00 AM",
          endTime: "6:00 PM",
          mileageMode: "custom",
          milesDriven: 644,
          mileageDeduction: 60,
        },
      ],
    });
    const p = calculateInvoicePacket(data);
    expect(p.mileage).not.toBeNull();
    expect(p.mileage!.totalMiles).toBe(644);
    expect(p.mileage!.deductionMiles).toBe(60);
    expect(p.mileage!.reimbursedMiles).toBe(584);
    expect(p.mileage!.mileageAmount).toBeCloseTo(584 * 0.52);
  });

  it("after conversion: sheet export reflects per-day values", () => {
    const data = makeInvoiceData({
      total_miles: null,
      mileage_deduction_miles: 60,
      workday_entries: [
        {
          date: "2026-06-01",
          startTime: "8:00 AM",
          endTime: "6:00 PM",
          mileageMode: "custom",
          milesDriven: 644,
          mileageDeduction: 60,
        },
      ],
    });
    const p = calculateInvoicePacket(data);
    const row = generateSheetRow(p, "Test Gig");
    expect(row.totalBusinessMiles).toBe(644);
    expect(row.laPaidMiles).toBe(584);
    expect(row.unreimbursedMiles).toBe(60);
    expect(row.mileagePaid).toBeCloseTo(584 * 0.52);
  });

  it("legacy total_miles still used when total_miles set and no per-day mileage", () => {
    const data = makeInvoiceData({
      total_miles: 644,
      mileage_deduction_miles: 60,
      workday_entries: [{ date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" }],
    });
    const p = calculateInvoicePacket(data);
    expect(p.mileage!.totalMiles).toBe(644);
    expect(p.mileage!.reimbursedMiles).toBe(584);
  });

  it("legacy total_miles NOT used in invoice preview when per-day mileage present", () => {
    const data = makeInvoiceData({
      total_miles: 644,              // would produce wrong total if used
      mileage_deduction_miles: 60,
      workday_entries: [
        {
          date: "2026-06-01",
          startTime: "8:00 AM",
          endTime: "6:00 PM",
          mileageMode: "from_dewey",
          milesDriven: 80,
        },
      ],
    });
    const p = calculateInvoicePacket(data);
    // Only the per-day entry (80 mi, 30 mi deduction) should appear
    expect(p.mileage!.totalMiles).toBe(80);
    expect(p.mileage!.deductionMiles).toBe(30);
    expect(p.mileage!.reimbursedMiles).toBe(50);
    // The legacy 644 total is completely ignored
    expect(p.mileage!.totalMiles).not.toBe(644);
  });
});

// ---------------------------------------------------------------------------
// initWorkdayEntries — default time seeding and saved-data precedence
// ---------------------------------------------------------------------------

describe("initWorkdayEntries — default time behavior", () => {
  const DATES = ["2026-06-18", "2026-06-19", "2026-06-20"];
  const DEFAULT_START = "6:00 AM";
  const DEFAULT_END = "5:00 PM";

  it("new job (no saved data): seeds all dates with scheduled event times", () => {
    const entries = initWorkdayEntries([], DATES, DEFAULT_START, DEFAULT_END);
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(e.startTime).toBe(DEFAULT_START);
      expect(e.endTime).toBe(DEFAULT_END);
    }
  });

  it("new job (no saved data, no defaults): creates empty entries", () => {
    const entries = initWorkdayEntries([], DATES);
    for (const e of entries) {
      expect(e.startTime).toBe("");
      expect(e.endTime).toBe("");
    }
  });

  it("manual edits persist: saved start/end are returned unchanged", () => {
    const saved: WorkdayEntry[] = [
      { date: "2026-06-18", startTime: "7:30 AM", endTime: "8:00 PM" },
    ];
    const entries = initWorkdayEntries(saved, DATES, DEFAULT_START, DEFAULT_END);
    const first = entries.find((e) => e.date === "2026-06-18")!;
    // Saved values, not defaults
    expect(first.startTime).toBe("7:30 AM");
    expect(first.endTime).toBe("8:00 PM");
    // Dates without saved data still get defaults
    const second = entries.find((e) => e.date === "2026-06-19")!;
    expect(second.startTime).toBe(DEFAULT_START);
    expect(second.endTime).toBe(DEFAULT_END);
  });

  it("saved values are never overwritten by defaults: even empty strings are preserved", () => {
    // User explicitly cleared start/end times — empty string is a valid saved state.
    const saved: WorkdayEntry[] = [
      { date: "2026-06-18", startTime: "", endTime: "" },
    ];
    const entries = initWorkdayEntries(saved, ["2026-06-18"], DEFAULT_START, DEFAULT_END);
    expect(entries[0]!.startTime).toBe(""); // empty saved value preserved, not replaced
    expect(entries[0]!.endTime).toBe("");
  });

  it("calendar event time change: existing saved invoice times are untouched", () => {
    const saved: WorkdayEntry[] = [
      { date: "2026-06-18", startTime: "8:00 AM", endTime: "6:00 PM" },
      { date: "2026-06-19", startTime: "9:00 AM", endTime: "7:00 PM" },
    ];
    // Calendar event moved to 5 AM start — should NOT affect already-saved entries.
    const newDefaultStart = "5:00 AM";
    const newDefaultEnd = "3:00 PM";
    const entries = initWorkdayEntries(saved, DATES, newDefaultStart, newDefaultEnd);
    expect(entries.find((e) => e.date === "2026-06-18")!.startTime).toBe("8:00 AM");
    expect(entries.find((e) => e.date === "2026-06-19")!.startTime).toBe("9:00 AM");
    // Only a brand-new date (no saved entry) picks up the new default.
    expect(entries.find((e) => e.date === "2026-06-20")!.startTime).toBe(newDefaultStart);
  });

  it("does not mutate the existing entries array", () => {
    const saved: WorkdayEntry[] = [
      { date: "2026-06-18", startTime: "8:00 AM", endTime: "6:00 PM" },
    ];
    const original = JSON.stringify(saved);
    initWorkdayEntries(saved, DATES, DEFAULT_START, DEFAULT_END);
    expect(JSON.stringify(saved)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Balance due: estimatedTotal drives balance, not stale remainingBalance
// ---------------------------------------------------------------------------

describe("balance due — fresh calculation", () => {
  it("unpaid invoice: balance = total (amount_paid = 0)", () => {
    const data = makeInvoiceData({
      day_rate: 800,
      workday_entries: [{ date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" }],
    });
    const p = calculateInvoicePacket(data);
    const balanceDue = Math.max(0, Number((p.estimatedTotal - p.amountPaid).toFixed(2)));
    expect(balanceDue).toBe(p.estimatedTotal);
  });

  it("adding an expense increases estimatedTotal", () => {
    const base = makeInvoiceData({
      day_rate: 800,
      workday_entries: [{ date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" }],
    });
    const withUber = makeInvoiceData({
      day_rate: 800,
      uber: 5000,
      workday_entries: [{ date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" }],
    });
    const pBase = calculateInvoicePacket(base);
    const pUber = calculateInvoicePacket(withUber);
    expect(pUber.estimatedTotal).toBe(pBase.estimatedTotal + 5000);
  });

  it("stale remaining_balance is ignored: balance = estimatedTotal - amountPaid", () => {
    // Simulate: DB has stale remaining_balance from before Uber was added
    const data = makeInvoiceData({
      day_rate: 800,
      uber: 5000,
      amount_paid: 0,
      remaining_balance: 800, // stale — doesn't include Uber
      workday_entries: [{ date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" }],
    });
    const p = calculateInvoicePacket(data);
    // Fresh balance ignores packet.remainingBalance and uses estimatedTotal - amountPaid
    const freshBalance = Math.max(0, Number((p.estimatedTotal - p.amountPaid).toFixed(2)));
    expect(freshBalance).toBe(p.estimatedTotal); // = 800 + 5000 = 5800
    expect(freshBalance).not.toBe(p.remainingBalance); // 5800 ≠ stale 800
  });

  it("partially paid: balance = total - amountPaid", () => {
    const data = makeInvoiceData({
      day_rate: 800,
      uber: 5000,
      amount_paid: 2598.75,
      workday_entries: [{ date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" }],
    });
    const p = calculateInvoicePacket(data);
    const freshBalance = Math.max(0, Number((p.estimatedTotal - p.amountPaid).toFixed(2)));
    expect(freshBalance).toBeCloseTo(p.estimatedTotal - 2598.75);
  });

  it("generateSheetRow uses fresh balance, not stale remainingBalance", () => {
    const data = makeInvoiceData({
      day_rate: 800,
      uber: 5000,
      amount_paid: 0,
      remaining_balance: 800, // stale
      workday_entries: [{ date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" }],
    });
    const p = calculateInvoicePacket(data);
    const row = generateSheetRow(p, "Test Gig");
    expect(row.remainingBalance).toBe(p.estimatedTotal); // 5800, not stale 800
  });
});
