/**
 * Column B of LA PAY (2026) must carry the actual service date.
 *
 * generateSheetRow used to stamp `new Date()` — the moment the row was synced —
 * into the DATE column that the Sheet's own Import Map documents as "Use actual
 * job/invoice date". Live rows were off by up to 15 days (job 6/8 → row 6/23),
 * which made period allocation from the Sheet impossible.
 */

import { describe, it, expect } from "vitest";
import { resolveSheetServiceDate } from "@/lib/invoice-calculations";

const TODAY = "2026-09-01";

describe("resolveSheetServiceDate", () => {
  it("uses the only workday", () => {
    expect(resolveSheetServiceDate([{ date: "2026-06-08" }], TODAY)).toBe("2026-06-08");
  });

  it("uses the earliest workday of a multi-day job", () => {
    expect(resolveSheetServiceDate(
      [{ date: "2026-08-29" }, { date: "2026-08-27" }, { date: "2026-08-28" }], TODAY,
    )).toBe("2026-08-27");
  });

  it("is independent of the sync date", () => {
    const job = [{ date: "2026-06-08" }];
    expect(resolveSheetServiceDate(job, "2026-06-23")).toBe("2026-06-08");
    expect(resolveSheetServiceDate(job, "2026-12-31")).toBe("2026-06-08");
  });

  it("falls back to today when a record has no workdays", () => {
    expect(resolveSheetServiceDate([], TODAY)).toBe(TODAY);
  });

  it("ignores malformed dates rather than emitting them", () => {
    expect(resolveSheetServiceDate(
      [{ date: "" }, { date: "not-a-date" }, { date: "2026-07-24" }], TODAY,
    )).toBe("2026-07-24");
    expect(resolveSheetServiceDate([{ date: "6/8/2026" }], TODAY)).toBe(TODAY);
  });

  it("does not mutate the input order", () => {
    const wd = [{ date: "2026-08-29" }, { date: "2026-08-27" }];
    resolveSheetServiceDate(wd, TODAY);
    expect(wd[0]!.date).toBe("2026-08-29");
  });
});
