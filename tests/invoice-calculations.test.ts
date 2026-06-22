import { describe, it, expect } from "vitest";
import {
  buildMileageInvoicePresentationLines,
  buildInvoiceWorkDates,
  parseTimeToMinutes,
  calculateHours,
  calculateMileage,
  calculateWorkdayMileage,
  getDefaultDeductionForMode,
  initWorkdayEntries,
  mergeInvoiceWorkDates,
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

  it("overnight: 3:00 PM to 4:30 AM = 13.5 h total, 3.5 OT", () => {
    const result = calculateHours("3:00 PM", "4:30 AM");
    expect(result.totalHours).toBeCloseTo(13.5);
    expect(result.overtimeHours).toBeCloseTo(3.5);
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
    expect(result.grossMileageAmount).toBeCloseTo(218.4);
    expect(result.mileageAmount).toBeCloseTo(187.2);
    expect(result.mileageAdjustmentAmount).toBeCloseTo(-31.2);
  });

  it("50 miles (under deduction) → 0 reimbursed", () => {
    const result = calculateMileage(50, 60, 0.52);
    expect(result.reimbursedMiles).toBe(0);
    expect(result.unreimbursedMiles).toBe(50);
    expect(result.grossMileageAmount).toBe(26);
    expect(result.mileageAmount).toBe(0);
    expect(result.mileageAdjustmentAmount).toBeCloseTo(-26);
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
    expect(result.grossMileageAmount).toBeCloseTo(62.4);
    expect(result.mileageAmount).toBeCloseTo(31.2);
  });
});

describe("buildMileageInvoicePresentationLines", () => {
  it("mileage with no deduction shows one Mileage line", () => {
    const mileage = calculateMileage(300, 0, 0.52);
    const lines = buildMileageInvoicePresentationLines(mileage);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      service: "Mileage",
      description: "300 miles × $0.52",
      qty: 300,
      rate: 0.52,
      amount: 156,
    });
  });

  it("mileage with deduction shows Mileage plus negative Mileage Adjustment", () => {
    const mileage = calculateMileage(300, 60, 0.52);
    const lines = buildMileageInvoicePresentationLines(mileage);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      service: "Mileage",
      description: "300 miles × $0.52",
      qty: 300,
      amount: 156,
    });
    expect(lines[1]).toMatchObject({
      service: "Mileage Adjustment",
      description: "Per company policy: 60 miles excluded",
      qty: -60,
      amount: -31.2,
    });
    expect(round2(lines.reduce((sum, line) => sum + line.amount, 0))).toBe(mileage.mileageAmount);
    expect(mileage.mileageAmount).toBeCloseTo(240 * 0.52);
  });

  it("existing test-gig shape shows gross 300 miles and negative 120-mile adjustment", () => {
    const mileage = calculateMileage(300, 120, 0.52);
    const lines = buildMileageInvoicePresentationLines(mileage);

    expect(mileage.reimbursedMiles).toBe(180);
    expect(mileage.unreimbursedMiles).toBe(120);
    expect(lines.map((line) => line.service)).toEqual(["Mileage", "Mileage Adjustment"]);
    expect(lines[0]?.amount).toBe(156);
    expect(lines[1]?.amount).toBe(-62.4);
    expect(round2(lines.reduce((sum, line) => sum + line.amount, 0))).toBe(93.6);
    expect(mileage.mileageAmount).toBe(93.6);
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
    invoice_sent_subject: null,
    invoice_total: null,
    invoice_job_name_override: null,
    invoice_day_rate_description_override: null,
    invoice_ot_description_override: null,
    invoice_per_diem_description_override: null,
    invoice_bag_fees_description_override: null,
    invoice_parking_description_override: null,
    invoice_uber_description_override: null,
    invoice_tolls_description_override: null,
    invoice_hotel_description_override: null,
    invoice_other_description_override: null,
    invoice_note_override: null,
    invoice_line_item_overrides: {},
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

  it("invoice total uses net mileage after the adjustment", () => {
    const data = makeInvoiceData({
      day_rate: 0,
      per_diem_rate: 0,
      total_miles: 300,
      mileage_deduction_miles: 60,
      workday_entries: [{ date: "2026-06-01", startTime: "", endTime: "" }],
    });
    const p = calculateInvoicePacket(data);
    const mileageLines = buildMileageInvoicePresentationLines(p.mileage);

    expect(p.mileage!.grossMileageAmount).toBe(156);
    expect(p.mileage!.mileageAdjustmentAmount).toBe(-31.2);
    expect(p.mileage!.mileageAmount).toBe(124.8);
    expect(p.estimatedTotal).toBe(124.8);
    expect(round2(mileageLines.reduce((sum, line) => sum + line.amount, 0))).toBe(p.estimatedTotal);
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
  it("writes job name override to D GIG", () => {
    const data = makeInvoiceData({
      workday_entries: [{ date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" }],
    });
    const p = calculateInvoicePacket(data);
    const row = generateSheetRow(p, "LA#5555 — test job", "1001", undefined, {
      jobNameOverride: "Wilm U Grad",
    });
    expect(row.gigEvent).toBe("Wilm U Grad");
  });

  it("falls back to clean calendar job name in D GIG when no override exists", () => {
    const data = makeInvoiceData({
      workday_entries: [{ date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" }],
    });
    const p = calculateInvoicePacket(data);
    const row = generateSheetRow(p, "LA#5555 — test job", "1001");
    expect(row.gigEvent).toBe("test job");
  });

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

  it("keeps Sheet mileage fields as tax/payment tracking values for 300 total / 240 paid / 60 excluded", () => {
    const data = makeInvoiceData({
      total_miles: 300,
      mileage_deduction_miles: 60,
      workday_entries: [{ date: "2026-06-01", startTime: "8:00 AM", endTime: "6:00 PM" }],
    });
    const p = calculateInvoicePacket(data);
    const row = generateSheetRow(p, "Mileage Test");

    expect(row.totalBusinessMiles).toBe(300);
    expect(row.laPaidMiles).toBe(240);
    expect(row.unreimbursedMiles).toBe(60);
    expect(row.mileagePaid).toBe(124.8);
    expect(row.mileage).toBe(124.8);
    expect(row.unreimbursedMileageValue).toBe(43.5);
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

  it("builds the full event range for 6/18 - 6/20, independent of today/current day", () => {
    const afterEventToday = "2026-07-15";
    expect(afterEventToday > "2026-06-20").toBe(true);
    expect(buildInvoiceWorkDates("2026-06-18", "2026-06-20")).toEqual(DATES);
  });

  it("merges visible/current-day dates with saved past rows without dropping 6/18", () => {
    const visibleDates = ["2026-06-19", "2026-06-20"];
    const saved: WorkdayEntry[] = [
      { date: "2026-06-18", startTime: "7:30 AM", endTime: "8:00 PM" },
    ];

    expect(mergeInvoiceWorkDates(visibleDates, saved)).toEqual(DATES);
    expect(initWorkdayEntries(saved, visibleDates, DEFAULT_START, DEFAULT_END).map((e) => e.date)).toEqual(DATES);
  });

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

  it("editing 6/18 after the fact persists after closing/reopening the job", () => {
    const saved: WorkdayEntry[] = [
      { date: "2026-06-18", startTime: "7:30 AM", endTime: "8:00 PM" },
      { date: "2026-06-19", startTime: "9:00 AM", endTime: "7:00 PM" },
      { date: "2026-06-20", startTime: "9:00 AM", endTime: "6:00 PM" },
    ];

    const reopened = initWorkdayEntries(saved, DATES, DEFAULT_START, DEFAULT_END);
    expect(reopened.find((e) => e.date === "2026-06-18")).toMatchObject({
      startTime: "7:30 AM",
      endTime: "8:00 PM",
    });
  });

  it("clearing a manual time (empty string) falls back to calendar default", () => {
    // Empty string means "cleared / use calendar time" — not a locked blank.
    const saved: WorkdayEntry[] = [
      { date: "2026-06-18", startTime: "", endTime: "" },
    ];
    const entries = initWorkdayEntries(saved, ["2026-06-18"], DEFAULT_START, DEFAULT_END);
    expect(entries[0]!.startTime).toBe(DEFAULT_START);
    expect(entries[0]!.endTime).toBe(DEFAULT_END);
  });

  it("clearing a time with no calendar default → keeps blank (no time available)", () => {
    const saved: WorkdayEntry[] = [
      { date: "2026-06-18", startTime: "", endTime: "" },
    ];
    const entries = initWorkdayEntries(saved, ["2026-06-18"]); // no defaults passed
    expect(entries[0]!.startTime).toBe("");
    expect(entries[0]!.endTime).toBe("");
  });

  it("non-empty saved time always wins over calendar default", () => {
    const saved: WorkdayEntry[] = [
      { date: "2026-06-18", startTime: "7:30 AM", endTime: "8:00 PM" },
    ];
    const entries = initWorkdayEntries(saved, ["2026-06-18"], DEFAULT_START, DEFAULT_END);
    expect(entries[0]!.startTime).toBe("7:30 AM");
    expect(entries[0]!.endTime).toBe("8:00 PM");
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
// Complete workday pipeline — preview/PDF/sheet source data
// ---------------------------------------------------------------------------

describe("complete multi-day invoice workdays", () => {
  const COMPLETE_WORKDAYS: WorkdayEntry[] = [
    { date: "2026-06-18", startTime: "6:00 AM", endTime: "11:30 PM" },
    { date: "2026-06-19", startTime: "9:00 AM", endTime: "7:00 PM" },
    { date: "2026-06-20", startTime: "3:00 PM", endTime: "4:30 AM" },
  ];

  it("invoice preview calculations include all saved days and overnight OT", () => {
    const data = makeInvoiceData({
      day_rate: 800,
      overtime_rate: 100,
      per_diem_rate: 40,
      workday_entries: COMPLETE_WORKDAYS,
    });
    const p = calculateInvoicePacket(data);

    expect(p.workdays.map((w) => w.date)).toEqual(["2026-06-18", "2026-06-19", "2026-06-20"]);
    expect(p.dayRateQty).toBe(3);
    expect(p.dayRateTotal).toBe(2400);
    expect(p.totalOvertimeHours).toBe(11);
    expect(p.overtimeTotal).toBe(1100);
    expect(p.perDiemQty).toBe(3);
    expect(p.perDiemTotal).toBe(120);
    expect(p.estimatedTotal).toBe(3620);
  });

  it("Google Sheet row uses the complete saved workday packet", () => {
    const data = makeInvoiceData({
      day_rate: 800,
      overtime_rate: 100,
      per_diem_rate: 40,
      workday_entries: COMPLETE_WORKDAYS,
    });
    const p = calculateInvoicePacket(data);
    const row = generateSheetRow(p, "LA#5555 — Test Job");

    expect(row.labor).toBe(2400);
    expect(row.ot).toBe(1100);
    expect(row.perDiem).toBe(120);
    expect(row.totalPay).toBe(3620);
    expect(row.remainingBalance).toBe(3620);
  });
});

// ---------------------------------------------------------------------------
// Manual line-item quantity/rate/amount overrides
// ---------------------------------------------------------------------------

describe("calculateInvoicePacket — manual line-item overrides", () => {
  const WORKDAYS_3: WorkdayEntry[] = [
    { date: "2026-06-18", startTime: "8:00 AM", endTime: "6:00 PM" },
    { date: "2026-06-19", startTime: "8:00 AM", endTime: "6:00 PM" },
    { date: "2026-06-20", startTime: "8:00 AM", endTime: "6:00 PM" },
  ];

  it("editing Day Rate qty recalculates amount and total", () => {
    const p = calculateInvoicePacket(makeInvoiceData({
      day_rate: 550,
      workday_entries: WORKDAYS_3,
      invoice_line_item_overrides: {
        day_rate: { qty: 2.5 },
      },
    }));

    expect(p.dayRateQty).toBe(2.5);
    expect(p.dayRate).toBe(550);
    expect(p.dayRateTotal).toBe(1375);
    expect(p.estimatedTotal).toBe(1375);
  });

  it("editing Day Rate rate recalculates amount and total", () => {
    const p = calculateInvoicePacket(makeInvoiceData({
      day_rate: 550,
      workday_entries: WORKDAYS_3,
      invoice_line_item_overrides: {
        day_rate: { rate: 600 },
      },
    }));

    expect(p.dayRateQty).toBe(3);
    expect(p.dayRate).toBe(600);
    expect(p.dayRateTotal).toBe(1800);
    expect(p.estimatedTotal).toBe(1800);
  });

  it("editing OT qty recalculates amount and total", () => {
    const p = calculateInvoicePacket(makeInvoiceData({
      day_rate: 550,
      overtime_rate: 82.5,
      workday_entries: [
        { date: "2026-06-18", startTime: "8:00 AM", endTime: "8:00 PM" },
      ],
      invoice_line_item_overrides: {
        ot: { qty: 7.5 },
      },
    }));

    expect(p.dayRateTotal).toBe(550);
    expect(p.totalOvertimeHours).toBe(7.5);
    expect(p.overtimeRate).toBe(82.5);
    expect(p.overtimeTotal).toBe(618.75);
    expect(p.estimatedTotal).toBe(1168.75);
  });

  it("editing Per Diem qty/rate recalculates amount and total", () => {
    const p = calculateInvoicePacket(makeInvoiceData({
      day_rate: 550,
      per_diem_rate: 40,
      workday_entries: WORKDAYS_3,
      invoice_line_item_overrides: {
        per_diem: { qty: 2.5, rate: 45 },
      },
    }));

    expect(p.dayRateTotal).toBe(1650);
    expect(p.perDiemQty).toBe(2.5);
    expect(p.perDiemRate).toBe(45);
    expect(p.perDiemTotal).toBe(112.5);
    expect(p.estimatedTotal).toBe(1762.5);
  });

  it("editing Bag Fees amount updates total", () => {
    const p = calculateInvoicePacket(makeInvoiceData({
      day_rate: 550,
      bag_fees: 100,
      workday_entries: [WORKDAYS_3[0]!],
      invoice_line_item_overrides: {
        bag_fees: { amount: 250 },
      },
    }));

    expect(p.bagFees).toBe(250);
    expect(p.estimatedTotal).toBe(800);
  });

  it("editing Parking amount updates total", () => {
    const p = calculateInvoicePacket(makeInvoiceData({
      day_rate: 550,
      parking: 110,
      workday_entries: [WORKDAYS_3[0]!],
      invoice_line_item_overrides: {
        parking: { amount: 175 },
      },
    }));

    expect(p.parking).toBe(175);
    expect(p.estimatedTotal).toBe(725);
  });

  it("editing Uber/Tolls/Hotel/Other amounts update total", () => {
    const p = calculateInvoicePacket(makeInvoiceData({
      day_rate: 550,
      uber: 10,
      tolls: 20,
      hotel: 30,
      other_expenses: 40,
      workday_entries: [WORKDAYS_3[0]!],
      invoice_line_item_overrides: {
        uber: { amount: 100 },
        tolls: { amount: 200 },
        hotel: { amount: 300 },
        other: { amount: 400 },
      },
    }));

    expect(p.uber).toBe(100);
    expect(p.tolls).toBe(200);
    expect(p.hotel).toBe(300);
    expect(p.otherExpenses).toBe(400);
    expect(p.estimatedTotal).toBe(1550);
  });

  it("resetting a line returns to auto-calculated value", () => {
    const auto = calculateInvoicePacket(makeInvoiceData({
      day_rate: 550,
      parking: 110,
      workday_entries: WORKDAYS_3,
      invoice_line_item_overrides: {},
    }));
    const custom = calculateInvoicePacket(makeInvoiceData({
      day_rate: 550,
      parking: 110,
      workday_entries: WORKDAYS_3,
      invoice_line_item_overrides: {
        day_rate: { qty: 2.5, rate: 600 },
        parking: { amount: 175 },
      },
    }));
    const reset = calculateInvoicePacket(makeInvoiceData({
      day_rate: 550,
      parking: 110,
      workday_entries: WORKDAYS_3,
      invoice_line_item_overrides: {},
    }));

    expect(custom.estimatedTotal).not.toBe(auto.estimatedTotal);
    expect(reset.dayRateQty).toBe(auto.dayRateQty);
    expect(reset.dayRate).toBe(auto.dayRate);
    expect(reset.parking).toBe(auto.parking);
    expect(reset.estimatedTotal).toBe(auto.estimatedTotal);
  });

  it("PDF inputs can use edited qty/rate/amount values from the packet", () => {
    const p = calculateInvoicePacket(makeInvoiceData({
      day_rate: 550,
      overtime_rate: 82.5,
      parking: 110,
      workday_entries: WORKDAYS_3,
      invoice_line_item_overrides: {
        day_rate: { qty: 2.5, rate: 600 },
        ot: { qty: 7.5 },
        parking: { amount: 175 },
      },
    }));

    expect({
      qty: p.dayRateQty,
      rate: p.dayRate,
      amount: p.dayRateTotal,
      otQty: p.totalOvertimeHours,
      otAmount: p.overtimeTotal,
      parking: p.parking,
    }).toEqual({
      qty: 2.5,
      rate: 600,
      amount: 1500,
      otQty: 7.5,
      otAmount: 618.75,
      parking: 175,
    });
  });

  it("Google Sheet sync uses edited invoice total and line amounts", () => {
    const p = calculateInvoicePacket(makeInvoiceData({
      day_rate: 550,
      parking: 110,
      workday_entries: WORKDAYS_3,
      invoice_line_item_overrides: {
        day_rate: { qty: 2.5, rate: 600 },
        parking: { amount: 175 },
      },
    }));
    const row = generateSheetRow(p, "LA#5555 — Test Job");

    expect(row.labor).toBe(1500);
    expect(row.parking).toBe(175);
    expect(row.totalPay).toBe(1675);
    expect(row.remainingBalance).toBe(1675);
  });

  it("payment balance uses edited invoice total", () => {
    const p = calculateInvoicePacket(makeInvoiceData({
      day_rate: 550,
      amount_paid: 500,
      workday_entries: WORKDAYS_3,
      invoice_line_item_overrides: {
        day_rate: { qty: 2.5, rate: 600 },
      },
    }));
    const balanceDue = Math.max(0, Number((p.estimatedTotal - p.amountPaid).toFixed(2)));

    expect(p.estimatedTotal).toBe(1500);
    expect(balanceDue).toBe(1000);
  });

  it("closing/reopening preserves amount overrides from stored invoice data", () => {
    const stored = makeInvoiceData({
      day_rate: 550,
      parking: 110,
      workday_entries: WORKDAYS_3,
      invoice_line_item_overrides: {
        day_rate: { qty: 2.5, rate: 600 },
        parking: { amount: 175 },
      },
    });
    const reopened = makeInvoiceData(stored);
    const p = calculateInvoicePacket(reopened);

    expect(p.dayRateTotal).toBe(1500);
    expect(p.parking).toBe(175);
    expect(p.estimatedTotal).toBe(1675);
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

// ---------------------------------------------------------------------------
// snapUtcToTimeOption — calendar event time → invoice workday default
// (Tested via a local re-implementation that mirrors the exported function)
// ---------------------------------------------------------------------------

/**
 * Mirror of `snapUtcToTimeOption` from InvoiceSection for unit-testing without
 * importing the client component. The logic must stay in sync with the source.
 */
function testSnapUtcToTimeOption(utcIso: string): string | undefined {
  const d = new Date(utcIso);
  const totalMins = d.getHours() * 60 + d.getMinutes();
  if (totalMins === 0) return undefined;
  const snapped = Math.round(totalMins / 30) * 30;
  const hSnapped = Math.floor(snapped / 60) % 24;
  const mSnapped = snapped % 60;
  const period = hSnapped >= 12 ? "PM" : "AM";
  const h12 = hSnapped % 12 || 12;
  return `${h12}:${String(mSnapped).padStart(2, "0")} ${period}`;
}

describe("snapUtcToTimeOption — invoice workday default time from calendar", () => {
  // This function uses JS Date.getHours() (LOCAL timezone), so tests must be
  // timezone-agnostic. We compute UTC values that correspond to midnight / non-
  // midnight in the CURRENT test runner's local timezone.

  /** Returns the UTC ISO string for "midnight today" in the test runner's local timezone. */
  function localMidnightUtc(): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0); // midnight local time
    return d.toISOString();
  }

  /** Returns the UTC ISO string for "N hours from midnight" in the local timezone. */
  function localHoursUtc(hours: number, minutes = 0): string {
    const d = new Date();
    d.setHours(hours, minutes, 0, 0);
    return d.toISOString();
  }

  it("midnight local time → undefined (all-day event, no real scheduled time)", () => {
    // Whatever timezone the test runner is in, midnight local → getHours()=0 → undefined
    const result = testSnapUtcToTimeOption(localMidnightUtc());
    expect(result).toBeUndefined();
  });

  it("midnight local time → NOT '12:00 AM' (all-day detection prevents that string)", () => {
    const result = testSnapUtcToTimeOption(localMidnightUtc());
    expect(result).not.toBe("12:00 AM");
  });

  it("6:30 AM local → '6:30 AM' (exact 30-min boundary, no snapping needed)", () => {
    const result = testSnapUtcToTimeOption(localHoursUtc(6, 30));
    expect(result).toBe("6:30 AM");
  });

  it("7:00 AM local → '7:00 AM'", () => {
    expect(testSnapUtcToTimeOption(localHoursUtc(7, 0))).toBe("7:00 AM");
  });

  it("6:00 PM local → '6:00 PM'", () => {
    expect(testSnapUtcToTimeOption(localHoursUtc(18, 0))).toBe("6:00 PM");
  });

  it("6:15 AM local → '6:30 AM' (snaps up to nearest 30 min)", () => {
    expect(testSnapUtcToTimeOption(localHoursUtc(6, 15))).toBe("6:30 AM");
  });

  it("6:10 AM local → '6:00 AM' (snaps down to nearest 30 min)", () => {
    expect(testSnapUtcToTimeOption(localHoursUtc(6, 10))).toBe("6:00 AM");
  });

  it("non-midnight times always return a defined string", () => {
    for (const [h, m] of [[1,0],[6,30],[7,0],[12,0],[18,0],[22,30]]) {
      const result = testSnapUtcToTimeOption(localHoursUtc(h!, m!));
      expect(result, `expected string for ${h}:${m!.toString().padStart(2,"0")}`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// initWorkdayEntries — calendar-default integration with clear/reset
// ---------------------------------------------------------------------------

describe("initWorkdayEntries — calendar default fallback after clear", () => {
  const DATE = "2026-06-22";
  const CAL_START = "6:30 AM";
  const CAL_END = "6:00 PM";

  it("no saved entry + calendar time → work row shows calendar time", () => {
    const entries = initWorkdayEntries([], [DATE], CAL_START, CAL_END);
    expect(entries[0]!.startTime).toBe(CAL_START);
    expect(entries[0]!.endTime).toBe(CAL_END);
  });

  it("no saved entry + no calendar time → work row is blank", () => {
    const entries = initWorkdayEntries([], [DATE]);
    expect(entries[0]!.startTime).toBe("");
    expect(entries[0]!.endTime).toBe("");
  });

  it("saved manual time overrides calendar default", () => {
    const saved: WorkdayEntry[] = [{ date: DATE, startTime: "7:00 AM", endTime: "7:00 PM" }];
    const entries = initWorkdayEntries(saved, [DATE], CAL_START, CAL_END);
    expect(entries[0]!.startTime).toBe("7:00 AM");
    expect(entries[0]!.endTime).toBe("7:00 PM");
  });

  it("clearing to '' falls back to calendar default", () => {
    const saved: WorkdayEntry[] = [{ date: DATE, startTime: "", endTime: "" }];
    const entries = initWorkdayEntries(saved, [DATE], CAL_START, CAL_END);
    expect(entries[0]!.startTime).toBe(CAL_START);
    expect(entries[0]!.endTime).toBe(CAL_END);
  });

  it("reopening with saved time shows saved time, not calendar default", () => {
    const saved: WorkdayEntry[] = [{ date: DATE, startTime: "7:00 AM", endTime: "8:00 PM" }];
    const entries = initWorkdayEntries(saved, [DATE], CAL_START, CAL_END);
    expect(entries[0]!.startTime).toBe("7:00 AM");
    expect(entries[0]!.endTime).toBe("8:00 PM");
  });

  it("multi-day: all days get same calendar default when no saved entry", () => {
    const dates = ["2026-06-22", "2026-06-23", "2026-06-24"];
    const entries = initWorkdayEntries([], dates, CAL_START, CAL_END);
    for (const e of entries) {
      expect(e.startTime).toBe(CAL_START);
      expect(e.endTime).toBe(CAL_END);
    }
  });

  it("multi-day: saved times per day survive reopen; unsaved days get calendar default", () => {
    const saved: WorkdayEntry[] = [
      { date: "2026-06-22", startTime: "6:00 AM", endTime: "5:00 PM" }, // day 1 saved
    ];
    const dates = ["2026-06-22", "2026-06-23", "2026-06-24"];
    const entries = initWorkdayEntries(saved, dates, CAL_START, CAL_END);
    expect(entries.find(e => e.date === "2026-06-22")!.startTime).toBe("6:00 AM"); // saved
    expect(entries.find(e => e.date === "2026-06-23")!.startTime).toBe(CAL_START); // default
    expect(entries.find(e => e.date === "2026-06-24")!.startTime).toBe(CAL_START); // default
  });

  it("past job entries are fully editable (same logic as future/today jobs)", () => {
    const pastDate = "2020-01-15";
    const saved: WorkdayEntry[] = [{ date: pastDate, startTime: "8:00 AM", endTime: "6:00 PM" }];
    const entries = initWorkdayEntries(saved, [pastDate], CAL_START, CAL_END);
    expect(entries[0]!.startTime).toBe("8:00 AM");
  });
});
