/**
 * LA PAY ordering convention.
 *
 *   Master ledger      -> service date DESCENDING (newest work on top)
 *   Accountant Summary -> service date ASCENDING  (reads through the tax year)
 *
 * Both interleave QuickBooks-era ("QB-") and LA Schedule (numeric) invoices
 * strictly by service date; origin never groups them. Ties break on invoice
 * number so the order is deterministic. Ordering only — no value changes, and
 * the TOTALS row never participates.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

/** Mirrors the comparator in sortMainSheetByServiceDate. */
const masterSort = <T extends { date: number; inv: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (b.date - a.date) || a.inv.localeCompare(b.inv));

/** Mirrors the Accountant Summary generator. */
const summarySort = <T extends { date: number; inv: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (a.date - b.date) || a.inv.localeCompare(b.inv));

const SAMPLE = [
  { date: 3, inv: "1003" }, { date: 1, inv: "QB-70868" },
  { date: 5, inv: "1014" }, { date: 2, inv: "QB-70229" }, { date: 4, inv: "QB-72318" },
];

describe("master ledger: newest first", () => {
  it("sorts service date descending", () => {
    expect(masterSort(SAMPLE).map(r => r.date)).toEqual([5, 4, 3, 2, 1]);
  });

  it("interleaves QuickBooks and LA Schedule invoices by date", () => {
    const order = masterSort(SAMPLE).map(r => r.inv);
    expect(order).toEqual(["1014", "QB-72318", "1003", "QB-70229", "QB-70868"]);
    // origin alternates -> not grouped
    const isQb = order.map(i => i.startsWith("QB-"));
    expect(isQb.some((v, i) => i > 0 && v !== isQb[i - 1])).toBe(true);
  });

  it("breaks ties on invoice number deterministically", () => {
    const tied = [{ date: 9, inv: "1012" }, { date: 9, inv: "1005" }, { date: 9, inv: "QB-1" }];
    expect(masterSort(tied).map(r => r.inv)).toEqual(["1005", "1012", "QB-1"]);
    expect(masterSort(masterSort(tied))).toEqual(masterSort(tied)); // stable/idempotent
  });

  it("is idempotent — re-sorting changes nothing", () => {
    expect(masterSort(masterSort(SAMPLE))).toEqual(masterSort(SAMPLE));
  });
});

describe("accountant summary: oldest first", () => {
  it("sorts service date ascending for tax-year reading", () => {
    expect(summarySort(SAMPLE).map(r => r.date)).toEqual([1, 2, 3, 4, 5]);
  });

  it("is the exact reverse ordering of the master", () => {
    expect(summarySort(SAMPLE).map(r => r.inv)).toEqual(masterSort(SAMPLE).map(r => r.inv).reverse());
  });

  it("interleaves by date, not origin", () => {
    const order = summarySort(SAMPLE).map(r => r.inv);
    expect(order[0]).toBe("QB-70868");
    expect(order[order.length - 1]).toBe("1014");
  });
});

describe("sortMainSheetByServiceDate implementation", () => {
  const src = read("lib/google-sheets.ts");

  it("exists and is wired into every sheet write", () => {
    expect(src).toContain("export async function sortMainSheetByServiceDate");
    const upsert = src.slice(src.indexOf("export async function upsertSheetRow"));
    expect(upsert).toContain("await sortMainSheetByServiceDate(");
  });

  it("sorts newest-first with an invoice-number tiebreak", () => {
    const fn = src.slice(src.indexOf("export async function sortMainSheetByServiceDate"));
    expect(fn).toContain("serviceDate(b) - serviceDate(a)");
    expect(fn).toContain("invoiceKey(a).localeCompare(invoiceKey(b))");
  });

  it("never touches the TOTALS row", () => {
    const fn = src.slice(src.indexOf("export async function sortMainSheetByServiceDate"), src.indexOf("// Targeted payment-status update"));
    expect(fn).toContain("isTotalsRow");
    expect(fn).toContain("totalsRow - 1");
    expect(fn).toContain("!A2:");            // writes from row 2 only
  });

  it("is best-effort so a sort failure cannot fail an invoice sync", () => {
    const upsert = src.slice(src.indexOf("export async function upsertSheetRow"));
    const call = upsert.slice(upsert.indexOf("sortMainSheetByServiceDate") - 200, upsert.indexOf("sortMainSheetByServiceDate") + 300);
    expect(call).toContain("try {");
    expect(call).toContain("catch");
  });

  it("reports the post-sort row so callers never show a stale row number", () => {
    const upsert = src.slice(src.indexOf("export async function upsertSheetRow"));
    expect(upsert).toContain("if (movedTo !== null) finalRowNumber = movedTo;");
  });
});
