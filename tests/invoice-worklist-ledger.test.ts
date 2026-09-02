/**
 * Invoice-ledger boundary and calendar date-range derivation.
 *
 * 2025 belongs to the QuickBooks-era archive: those jobs were invoiced outside
 * LA Schedule, so the calendar-driven worklist was labelling six of them
 * "Needs Invoice" purely because no invoice_data row existed. The ledger start
 * date keeps archived years out of the worklist — a display boundary only.
 *
 * Separately, Google gives all-day events an exclusive end date. Subtracting a
 * day from TIMED events produced an end earlier than the start, visible on the
 * same-day flight entries.
 */

import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import {
  INVOICE_LEDGER_START_DATE,
  clampToInvoiceLedgerStart,
  deriveWorklistDateRange,
  isWithinInvoiceLedger,
} from "@/lib/invoice-worklist";

const TZ = "America/New_York";
const ms = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toMillis();

describe("ledger start date", () => {
  it("is 2026-01-01", () => {
    expect(INVOICE_LEDGER_START_DATE).toBe("2026-01-01");
  });
});

describe("1. events before 2026-01-01 cannot enter the worklist", () => {
  it("rejects the six known 2025 false positives", () => {
    // 8. the exact items the audit found showing "Needs Invoice"
    const known2025 = [
      "2025-08-04", // LSMLWX Flight AA 5832 PHL->CVG
      "2025-08-04", // Red Bull gig
      "2025-08-11", // LSMLWX Flight AA 5578 CVG->PHL
      "2025-08-14", // DC Nationals
      "2025-08-25", // UD gig
      "2025-10-24", // CHASE CENTER ROOM FLIP
    ];
    for (const d of known2025) expect(isWithinInvoiceLedger(d)).toBe(false);
    expect(known2025.filter((d) => isWithinInvoiceLedger(d))).toHaveLength(0);
  });

  it("rejects the last day of 2025 and accepts the first day of 2026", () => {
    expect(isWithinInvoiceLedger("2025-12-31")).toBe(false);
    expect(isWithinInvoiceLedger("2026-01-01")).toBe(true);
  });

  it("rejects a job that merely overlaps the boundary from 2025", () => {
    // Google returns events overlapping the window; a 2025-12-28 start is 2025 work.
    expect(isWithinInvoiceLedger("2025-12-28")).toBe(false);
  });

  it("rejects earlier archived years too", () => {
    for (const d of ["2024-06-01", "2023-01-01"]) expect(isWithinInvoiceLedger(d)).toBe(false);
  });
});

describe("2. a long Range cannot bring 2025 back", () => {
  it("clamps a 60-month request up to the ledger start", () => {
    const requested = ms("2021-09-02T00:00:00");
    const clamped = clampToInvoiceLedgerStart(requested, TZ);
    expect(clamped).toBe(ms("2026-01-01T00:00:00"));
    expect(clamped).toBeGreaterThan(requested);
  });

  it("clamps the 18-month default that previously reached 2025-03", () => {
    const requested = ms("2025-03-01T00:00:00");
    expect(clampToInvoiceLedgerStart(requested, TZ)).toBe(ms("2026-01-01T00:00:00"));
  });

  it("leaves a request already inside the ledger untouched", () => {
    const requested = ms("2026-06-01T00:00:00");
    expect(clampToInvoiceLedgerStart(requested, TZ)).toBe(requested);
  });

  it("is timezone-aware", () => {
    expect(clampToInvoiceLedgerStart(0, "UTC")).toBe(DateTime.fromISO("2026-01-01", { zone: "UTC" }).toMillis());
  });
});

describe("3/4. 2026 events still work normally", () => {
  it("accepts every real 2026 job date from the ledger", () => {
    for (const d of ["2026-01-05", "2026-03-15", "2026-04-12", "2026-06-08", "2026-08-27", "2026-11-06"]) {
      expect(isWithinInvoiceLedger(d)).toBe(true);
    }
  });

  it("accepts future-dated 2026 jobs", () => {
    for (const d of ["2026-09-09", "2026-10-28", "2026-12-31"]) {
      expect(isWithinInvoiceLedger(d)).toBe(true);
    }
  });
});

describe("5. all-day events keep the exclusive-end adjustment", () => {
  it("a single all-day job renders as one day", () => {
    const r = deriveWorklistDateRange({
      startMs: ms("2026-06-08T00:00:00"), endMs: ms("2026-06-09T00:00:00"),
      isAllDay: true, timezone: TZ,
    });
    expect(r).toEqual({ startDate: "2026-06-08", endDate: "2026-06-08" });
  });

  it("a multi-day all-day job ends on its last worked day", () => {
    const r = deriveWorklistDateRange({
      startMs: ms("2026-08-27T00:00:00"), endMs: ms("2026-08-30T00:00:00"),
      isAllDay: true, timezone: TZ,
    });
    expect(r).toEqual({ startDate: "2026-08-27", endDate: "2026-08-29" });
  });
});

describe("6/7. timed events lose no day and never invert", () => {
  it("6. a same-day timed event ends on its own day", () => {
    // The LSMLWX flight shape that produced 2025-08-04..2025-08-03.
    const r = deriveWorklistDateRange({
      startMs: ms("2026-08-04T10:00:00"), endMs: ms("2026-08-04T12:30:00"),
      isAllDay: false, timezone: TZ,
    });
    expect(r).toEqual({ startDate: "2026-08-04", endDate: "2026-08-04" });
  });

  it("7. a timed event can never display end before start", () => {
    const cases = [
      { s: "2026-08-04T06:00:00", e: "2026-08-04T07:00:00" },
      { s: "2026-01-01T23:00:00", e: "2026-01-02T01:00:00" },
      { s: "2026-05-06T09:00:00", e: "2026-05-07T17:00:00" },
    ];
    for (const c of cases) {
      const r = deriveWorklistDateRange({ startMs: ms(c.s), endMs: ms(c.e), isAllDay: false, timezone: TZ });
      expect(r.endDate >= r.startDate).toBe(true);
    }
  });

  it("an overnight timed event keeps its real end day", () => {
    const r = deriveWorklistDateRange({
      startMs: ms("2026-08-04T22:00:00"), endMs: ms("2026-08-05T02:00:00"),
      isAllDay: false, timezone: TZ,
    });
    expect(r).toEqual({ startDate: "2026-08-04", endDate: "2026-08-05" });
  });

  it("the defensive floor holds even for malformed input", () => {
    const r = deriveWorklistDateRange({
      startMs: ms("2026-08-04T10:00:00"), endMs: ms("2026-08-03T10:00:00"),
      isAllDay: false, timezone: TZ,
    });
    expect(r.endDate).toBe(r.startDate);
  });
});

describe("9. boundary logic mutates nothing", () => {
  it("the helpers are pure — no database or network imports", () => {
    const src = require("node:fs").readFileSync("lib/invoice-worklist.ts", "utf8") as string;
    const helpers = src.slice(src.indexOf("export const INVOICE_LEDGER_START_DATE"), src.indexOf("export async function listWorklistEntries"));
    for (const f of ["insert(", "update(", "upsert(", "delete(", "events.patch", "events.insert"]) {
      expect(helpers).not.toContain(f);
    }
  });

  it("listWorklistEntries remains read-only", () => {
    const src = require("node:fs").readFileSync("lib/invoice-worklist.ts", "utf8") as string;
    for (const f of ["events.patch", "events.insert", "events.delete", ".upsert(", ".insert("]) {
      expect(src).not.toContain(f);
    }
  });
});
