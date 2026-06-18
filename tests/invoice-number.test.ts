import { describe, it, expect } from "vitest";
import { resolveInvoiceNumber } from "@/lib/invoice-number";

describe("resolveInvoiceNumber", () => {
  // Existing invoice number is always preserved
  it("returns existing number unchanged when set", () => {
    expect(resolveInvoiceNumber("JU-12345", "67890", ["2025-09-01"])).toBe("JU-12345");
  });

  it("returns trimmed existing number", () => {
    expect(resolveInvoiceNumber("  JU-99  ", null, [])).toBe("JU-99");
  });

  it("does not reuse existing when it is empty string", () => {
    const result = resolveInvoiceNumber("", "LA-001", ["2025-09-01"]);
    expect(result).toBe("JU-LA-001");
  });

  it("does not reuse existing when it is whitespace-only", () => {
    const result = resolveInvoiceNumber("   ", "LA-001", ["2025-09-01"]);
    expect(result).toBe("JU-LA-001");
  });

  // LA number format
  it("uses LA number as JU-{laNumber} when no existing", () => {
    expect(resolveInvoiceNumber(null, "12345", [])).toBe("JU-12345");
  });

  it("strips unsafe chars from LA number", () => {
    // Only alphanumeric, hyphens, underscores, dots should survive
    const result = resolveInvoiceNumber(null, "LA 001/B", []);
    expect(result).toMatch(/^JU-[A-Za-z0-9\-_.]+$/);
    expect(result).not.toContain(" ");
    expect(result).not.toContain("/");
  });

  it("falls back to date when LA number sanitizes to empty", () => {
    // A number made of only disallowed chars
    const result = resolveInvoiceNumber(null, "/ /!!", ["2025-09-01"]);
    expect(result).toBe("JU-20250901");
  });

  // Date fallback
  it("uses first valid work date as YYYYMMDD when no LA number", () => {
    expect(resolveInvoiceNumber(null, null, ["2025-09-01", "2025-09-02"])).toBe("JU-20250901");
  });

  it("skips invalid dates and uses first valid one", () => {
    expect(resolveInvoiceNumber(null, null, ["not-a-date", "2025-09-03"])).toBe("JU-20250903");
  });

  it("skips empty LA number and uses date", () => {
    expect(resolveInvoiceNumber(null, "  ", ["2025-10-15"])).toBe("JU-20251015");
  });

  // Today fallback
  it("returns a JU- prefixed string when no dates or LA number", () => {
    const result = resolveInvoiceNumber(null, null, []);
    expect(result).toMatch(/^JU-\d{8}$/);
  });

  it("returns a JU- prefixed string when dates array has only invalid entries", () => {
    const result = resolveInvoiceNumber(undefined, undefined, ["", "bad"]);
    expect(result).toMatch(/^JU-\d{8}$/);
  });
});
