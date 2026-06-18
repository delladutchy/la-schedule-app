import { describe, expect, it } from "vitest";
import {
  QB_LINE_NAMES,
  buildQBInvoiceLines,
  type QBItemConfig,
} from "../lib/quickbooks-types";
import type { InvoicePacket } from "../lib/invoice-types";

// All item IDs configured
const FULL_ITEMS: QBItemConfig = {
  dayRate:       "1",
  overtime:      "2",
  perDiem:       "3",
  mileage:       "4",
  mileageAdj:    "5",
  bagFees:       "6",
  hotel:         "7",
  parking:       "8",
  tolls:         "9",
  uber:          "10",
  otherExpenses: "11",
};

// No item IDs configured
const EMPTY_ITEMS: QBItemConfig = {
  dayRate:       null,
  overtime:      null,
  perDiem:       null,
  mileage:       null,
  mileageAdj:    null,
  bagFees:       null,
  hotel:         null,
  parking:       null,
  tolls:         null,
  uber:          null,
  otherExpenses: null,
};

function makePacket(overrides: Partial<InvoicePacket> = {}): InvoicePacket {
  return {
    googleEventId:      "evt_test",
    laNumber:           "LA-001",
    invoiceStatus:      "ready",
    client:             "Light Action",
    workdays:           [],
    dayRateQty:         2,
    dayRate:            550,
    dayRateTotal:       1100,
    totalOvertimeHours: 0,
    overtimeRate:       82.5,
    overtimeTotal:      0,
    perDiemQty:         2,
    perDiemRate:        40,
    perDiemTotal:       80,
    mileage:            null,
    bagFees:            0,
    hotel:              0,
    parking:            0,
    tolls:              0,
    uber:               0,
    otherExpenses:      0,
    expenseNotes:       null,
    estimatedTotal:     1180,
    ...overrides,
  };
}

// ── QB_LINE_NAMES ─────────────────────────────────────────────────────────────

describe("QB_LINE_NAMES", () => {
  it("has a non-empty name for every QBItemConfig key", () => {
    const keys: Array<keyof QBItemConfig> = [
      "dayRate", "overtime", "perDiem", "mileage", "mileageAdj",
      "bagFees", "hotel", "parking", "tolls", "uber", "otherExpenses",
    ];
    for (const key of keys) {
      expect(QB_LINE_NAMES[key]).toBeTruthy();
    }
  });

  it("uses the exact line names required by the spec", () => {
    expect(QB_LINE_NAMES.dayRate).toBe("Freelance Audio Engineer / Day Rate");
    expect(QB_LINE_NAMES.overtime).toBe("Overtime");
    expect(QB_LINE_NAMES.perDiem).toBe("Per Diem");
    expect(QB_LINE_NAMES.mileage).toBe("Mileage");
    expect(QB_LINE_NAMES.mileageAdj).toBe("Mileage Adjustment");
    expect(QB_LINE_NAMES.bagFees).toBe("Bag Fees");
    expect(QB_LINE_NAMES.hotel).toBe("Hotel");
    expect(QB_LINE_NAMES.parking).toBe("Parking");
    expect(QB_LINE_NAMES.tolls).toBe("Tolls");
    expect(QB_LINE_NAMES.uber).toBe("Uber");
    expect(QB_LINE_NAMES.otherExpenses).toBe("Other Expenses");
  });
});

// ── buildQBInvoiceLines ───────────────────────────────────────────────────────

describe("buildQBInvoiceLines", () => {
  describe("day rate", () => {
    it("always includes the day rate line when item is configured", () => {
      const lines = buildQBInvoiceLines(makePacket(), FULL_ITEMS);
      const line = lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "1");
      expect(line).toBeDefined();
      expect(line!.Amount).toBe(1100);
      expect(line!.SalesItemLineDetail.Qty).toBe(2);
      expect(line!.SalesItemLineDetail.UnitPrice).toBe(550);
    });

    it("sets the item ref name to the QB line name", () => {
      const lines = buildQBInvoiceLines(makePacket(), FULL_ITEMS);
      const line = lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "1");
      expect(line!.SalesItemLineDetail.ItemRef.name).toBe("Freelance Audio Engineer / Day Rate");
    });

    it("uses DetailType: SalesItemLineDetail", () => {
      const lines = buildQBInvoiceLines(makePacket(), FULL_ITEMS);
      for (const line of lines) {
        expect(line.DetailType).toBe("SalesItemLineDetail");
      }
    });
  });

  describe("overtime", () => {
    it("excludes overtime when overtimeTotal is 0", () => {
      const lines = buildQBInvoiceLines(makePacket({ overtimeTotal: 0 }), FULL_ITEMS);
      expect(lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "2")).toBeUndefined();
    });

    it("includes overtime with correct qty and unit price", () => {
      const packet = makePacket({ overtimeTotal: 165, totalOvertimeHours: 2 });
      const lines = buildQBInvoiceLines(packet, FULL_ITEMS);
      const line = lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "2");
      expect(line).toBeDefined();
      expect(line!.Amount).toBe(165);
      expect(line!.SalesItemLineDetail.Qty).toBe(2);
      expect(line!.SalesItemLineDetail.UnitPrice).toBe(82.5);
    });
  });

  describe("per diem", () => {
    it("includes per diem when non-zero", () => {
      const lines = buildQBInvoiceLines(makePacket(), FULL_ITEMS);
      const line = lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "3");
      expect(line).toBeDefined();
      expect(line!.Amount).toBe(80);
      expect(line!.SalesItemLineDetail.Qty).toBe(2);
      expect(line!.SalesItemLineDetail.UnitPrice).toBe(40);
    });

    it("excludes per diem when zero", () => {
      const lines = buildQBInvoiceLines(makePacket({ perDiemTotal: 0 }), FULL_ITEMS);
      expect(lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "3")).toBeUndefined();
    });
  });

  describe("mileage", () => {
    const mileagePacket = makePacket({
      mileage: {
        totalMiles: 120,
        deductionMiles: 60,
        reimbursedMiles: 60,
        unreimbursedMiles: 60,
        mileageAmount: 31.2,
        mileageAdjustmentAmount: -31.2,
        mileageRate: 0.52,
      },
    });

    it("includes mileage line for reimbursed miles", () => {
      const lines = buildQBInvoiceLines(mileagePacket, FULL_ITEMS);
      const line = lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "4");
      expect(line).toBeDefined();
      expect(line!.Amount).toBe(31.2);
      expect(line!.SalesItemLineDetail.Qty).toBe(60);
      expect(line!.SalesItemLineDetail.UnitPrice).toBe(0.52);
    });

    it("includes a negative mileage adjustment line for the deduction", () => {
      const lines = buildQBInvoiceLines(mileagePacket, FULL_ITEMS);
      const adj = lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "5");
      expect(adj).toBeDefined();
      expect(adj!.Amount).toBe(-31.2);
      expect(adj!.SalesItemLineDetail.Qty).toBe(-60);
      expect(adj!.SalesItemLineDetail.UnitPrice).toBe(0.52);
    });

    it("attaches a description to the mileage adjustment line", () => {
      const lines = buildQBInvoiceLines(mileagePacket, FULL_ITEMS);
      const adj = lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "5");
      expect(adj!.Description).toContain("60");
    });

    it("excludes mileage adjustment when deduction is zero", () => {
      const packet = makePacket({
        mileage: {
          totalMiles: 50,
          deductionMiles: 0,
          reimbursedMiles: 50,
          unreimbursedMiles: 0,
          mileageAmount: 26,
          mileageAdjustmentAmount: 0,
          mileageRate: 0.52,
        },
      });
      const lines = buildQBInvoiceLines(packet, FULL_ITEMS);
      expect(lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "5")).toBeUndefined();
    });

    it("excludes both mileage lines when mileage is null", () => {
      const lines = buildQBInvoiceLines(makePacket({ mileage: null }), FULL_ITEMS);
      expect(lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "4")).toBeUndefined();
      expect(lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "5")).toBeUndefined();
    });
  });

  describe("expenses", () => {
    const expensePacket = makePacket({
      bagFees:       35,
      hotel:         150,
      parking:       20,
      tolls:         5,
      uber:          18,
      otherExpenses: 45,
      expenseNotes:  "Extra cable rental",
    });

    it("includes bag fees", () => {
      const lines = buildQBInvoiceLines(expensePacket, FULL_ITEMS);
      expect(lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "6")?.Amount).toBe(35);
    });

    it("includes hotel", () => {
      const lines = buildQBInvoiceLines(expensePacket, FULL_ITEMS);
      expect(lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "7")?.Amount).toBe(150);
    });

    it("includes parking", () => {
      const lines = buildQBInvoiceLines(expensePacket, FULL_ITEMS);
      expect(lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "8")?.Amount).toBe(20);
    });

    it("includes tolls", () => {
      const lines = buildQBInvoiceLines(expensePacket, FULL_ITEMS);
      expect(lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "9")?.Amount).toBe(5);
    });

    it("includes uber", () => {
      const lines = buildQBInvoiceLines(expensePacket, FULL_ITEMS);
      expect(lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "10")?.Amount).toBe(18);
    });

    it("includes other expenses with expense notes as description", () => {
      const lines = buildQBInvoiceLines(expensePacket, FULL_ITEMS);
      const other = lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "11");
      expect(other?.Amount).toBe(45);
      expect(other?.Description).toBe("Extra cable rental");
    });

    it("excludes zero-value expense lines", () => {
      const lines = buildQBInvoiceLines(makePacket(), FULL_ITEMS);
      const expenseIds = ["6", "7", "8", "9", "10", "11"];
      // perDiem (id 3) is present, but expense-type items (6-11) should not be
      for (const id of expenseIds) {
        expect(lines.find((l) => l.SalesItemLineDetail.ItemRef.value === id)).toBeUndefined();
      }
    });
  });

  describe("item ID configuration", () => {
    it("returns empty array when no item IDs are configured", () => {
      const lines = buildQBInvoiceLines(makePacket(), EMPTY_ITEMS);
      expect(lines).toHaveLength(0);
    });

    it("skips lines for unconfigured item IDs", () => {
      const partialItems: QBItemConfig = { ...EMPTY_ITEMS, dayRate: "1" };
      const packet = makePacket({
        overtimeTotal:      82.5,
        totalOvertimeHours: 1,
        bagFees:            50,
      });
      const lines = buildQBInvoiceLines(packet, partialItems);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.SalesItemLineDetail.ItemRef.value).toBe("1");
    });

    it("uses the provided item ID values", () => {
      const customItems: QBItemConfig = { ...EMPTY_ITEMS, dayRate: "999" };
      const lines = buildQBInvoiceLines(makePacket({ perDiemTotal: 0 }), customItems);
      expect(lines[0]!.SalesItemLineDetail.ItemRef.value).toBe("999");
    });
  });

  describe("amount rounding", () => {
    it("rounds amounts to 2 decimal places", () => {
      // 0.52 × 61 = 31.72, 0.52 × 60 = 31.2 — test floats stay clean
      const packet = makePacket({
        mileage: {
          totalMiles: 61,
          deductionMiles: 0,
          reimbursedMiles: 61,
          unreimbursedMiles: 0,
          mileageAmount: 31.72,
          mileageAdjustmentAmount: 0,
          mileageRate: 0.52,
        },
      });
      const lines = buildQBInvoiceLines(packet, FULL_ITEMS);
      const line = lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "4");
      expect(line!.Amount).toBe(31.72);
    });

    it("rounds unit prices to 2 decimal places", () => {
      const packet = makePacket({ dayRate: 183.333, dayRateQty: 3, dayRateTotal: 549.999 });
      const lines = buildQBInvoiceLines(packet, FULL_ITEMS);
      const line = lines.find((l) => l.SalesItemLineDetail.ItemRef.value === "1");
      expect(line!.SalesItemLineDetail.UnitPrice).toBe(183.33);
      expect(line!.Amount).toBe(550);
    });
  });

  describe("full invoice", () => {
    it("builds all 11 line types when fully configured and all amounts non-zero", () => {
      const packet = makePacket({
        overtimeTotal:      165,
        totalOvertimeHours: 2,
        mileage: {
          totalMiles: 120,
          deductionMiles: 60,
          reimbursedMiles: 60,
          unreimbursedMiles: 60,
          mileageAmount: 31.2,
          mileageAdjustmentAmount: -31.2,
          mileageRate: 0.52,
        },
        bagFees:       25,
        hotel:         120,
        parking:       15,
        tolls:         4,
        uber:          22,
        otherExpenses: 50,
      });
      const lines = buildQBInvoiceLines(packet, FULL_ITEMS);
      expect(lines).toHaveLength(11);
    });
  });
});
