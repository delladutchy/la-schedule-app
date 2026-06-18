import { describe, it, expect } from "vitest";
import { resolveInvoiceNumber, isNumericInvoiceNumber } from "@/lib/invoice-number";

describe("isNumericInvoiceNumber", () => {
  it("accepts pure digit strings", () => {
    expect(isNumericInvoiceNumber("1001")).toBe(true);
    expect(isNumericInvoiceNumber("9999")).toBe(true);
    expect(isNumericInvoiceNumber("1")).toBe(true);
  });

  it("rejects JU-date style numbers", () => {
    expect(isNumericInvoiceNumber("JU-20260618")).toBe(false);
    expect(isNumericInvoiceNumber("JU-12345")).toBe(false);
  });

  it("rejects empty, null, undefined, and whitespace", () => {
    expect(isNumericInvoiceNumber("")).toBe(false);
    expect(isNumericInvoiceNumber(null)).toBe(false);
    expect(isNumericInvoiceNumber(undefined)).toBe(false);
    expect(isNumericInvoiceNumber("   ")).toBe(false);
  });

  it("rejects strings with letters or punctuation", () => {
    expect(isNumericInvoiceNumber("1001a")).toBe(false);
    expect(isNumericInvoiceNumber("LA71760")).toBe(false);
  });
});

describe("resolveInvoiceNumber", () => {
  // ── New invoice (no existing in DB) ────────────────────────────────────────

  it("defaults to 1001 when no numeric invoice numbers exist yet", () => {
    expect(resolveInvoiceNumber(null, [])).toBe("1001");
  });

  it("defaults to 1001 when allExistingNums is empty", () => {
    expect(resolveInvoiceNumber(undefined, [])).toBe("1001");
  });

  it("defaults to 1001 when existing is empty string and no prior nums", () => {
    expect(resolveInvoiceNumber("", [])).toBe("1001");
  });

  it("defaults to 1001 when existing is whitespace-only and no prior nums", () => {
    expect(resolveInvoiceNumber("   ", [])).toBe("1001");
  });

  // ── Sequential numbering ───────────────────────────────────────────────────

  it("returns 1002 after 1001 exists in DB", () => {
    expect(resolveInvoiceNumber(null, ["1001"])).toBe("1002");
  });

  it("returns max+1 when multiple numeric numbers exist", () => {
    expect(resolveInvoiceNumber(null, ["1001", "1003", "1002"])).toBe("1004");
  });

  it("returns 2001 after 2000", () => {
    expect(resolveInvoiceNumber(null, ["2000"])).toBe("2001");
  });

  // ── Reuse existing numeric number ──────────────────────────────────────────

  it("reuses an existing numeric invoice number unchanged", () => {
    expect(resolveInvoiceNumber("1001", ["1001", "1002"])).toBe("1001");
  });

  it("trims whitespace from an existing numeric number before reuse", () => {
    expect(resolveInvoiceNumber("  1005  ", ["1005"])).toBe("1005");
  });

  // ── Old non-numeric numbers are ignored ───────────────────────────────────

  it("ignores old JU-date-style existing and generates 1001", () => {
    expect(resolveInvoiceNumber("JU-20260618", [])).toBe("1001");
  });

  it("ignores JU-date-style entries in allExistingNums when finding max", () => {
    // Only numeric "1001" should count; "JU-20260618" is ignored
    expect(resolveInvoiceNumber(null, ["1001", "JU-20260618"])).toBe("1002");
  });

  it("returns 1001 when allExistingNums contains only non-numeric values", () => {
    expect(resolveInvoiceNumber(null, ["JU-20260101", "JU-20260618", ""])).toBe("1001");
  });

  // ── LA job number stays separate ──────────────────────────────────────────

  it("never includes JU prefix in output", () => {
    const result = resolveInvoiceNumber(null, []);
    expect(result).not.toMatch(/^JU/i);
  });

  it("never includes LA job number in the invoice number", () => {
    // LA numbers go on the invoice separately; they must not bleed into invoice numbering
    const result = resolveInvoiceNumber(null, []);
    expect(result).toMatch(/^\d+$/);
  });

  it("returns a purely numeric string for all new invoices", () => {
    const cases = [
      resolveInvoiceNumber(null, []),
      resolveInvoiceNumber(null, ["1001"]),
      resolveInvoiceNumber(null, ["1001", "1002", "1003"]),
      resolveInvoiceNumber("", []),
      resolveInvoiceNumber("JU-20260618", []),
    ];
    for (const result of cases) {
      expect(result).toMatch(/^\d+$/);
    }
  });
});
