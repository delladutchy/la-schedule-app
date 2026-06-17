import { describe, it, expect } from "vitest";
import {
  parseTimeToMinutes,
  calculateHours,
  calculateMileage,
  round2,
} from "@/lib/invoice-calculations";

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

  it("8:00 AM to 8:30 PM = 12.5 h total, 2.5 OT", () => {
    const result = calculateHours("8:00 AM", "8:30 PM");
    expect(result.totalHours).toBeCloseTo(12.5);
    expect(result.overtimeHours).toBeCloseTo(2.5);
  });

  it("returns 0 when end is before start", () => {
    const result = calculateHours("6:00 PM", "8:00 AM");
    expect(result.totalHours).toBe(0);
    expect(result.overtimeHours).toBe(0);
  });

  it("exact 10 hours = 0 OT", () => {
    const result = calculateHours("7:00 AM", "5:00 PM");
    expect(result.totalHours).toBeCloseTo(10);
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
});

describe("round2", () => {
  it("rounds to 2 decimal places", () => {
    expect(round2(187.200000001)).toBe(187.2);
    expect(round2(0.005)).toBe(0.01);
  });
});
