/**
 * Tests for invoice email subject/body/filename formatting.
 * These functions mirror the server-side logic in app/api/invoice/email/[eventId]/route.ts.
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Pure helpers extracted from email route (mirrored here for unit testing)
// ---------------------------------------------------------------------------

function cleanLaNumber(laNumber: string | null): string {
  return (laNumber ?? "").replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatJobTitle(gigSummary: string, laNumber: string | null): string {
  let title = gigSummary.trim();
  const cleanLa = cleanLaNumber(laNumber);
  if (cleanLa) {
    title = title
      .replace(
        new RegExp(`^\\s*LA\\s*#?\\s*${escapeRegExp(cleanLa)}\\s*(?:[-–—:|]+\\s*)?`, "i"),
        "",
      )
      .trim();
  }
  return title.replace(/^[\s\-–—:|]+/, "").trim();
}

function fmtWorkDateRange(workdays: { date: string }[]): string {
  if (workdays.length === 0) return "";
  const dates = workdays.map((w) => w.date).sort();
  const fmtShort = (iso: string) => {
    const [, mo, d] = iso.split("-").map(Number);
    return `${mo}/${d}`;
  };
  if (dates.length === 1) return fmtShort(dates[0]!);
  return `${fmtShort(dates[0]!)} - ${fmtShort(dates[dates.length - 1]!)}`;
}

function buildSubject(cleanLa: string, jobTitle: string): string {
  if (cleanLa) return `Jeff Ulsh - Invoice LA #${cleanLa}`;
  return `Jeff Ulsh - Invoice${jobTitle ? ` ${jobTitle}` : ""}`;
}

function buildAttachmentFilename(cleanLa: string, jobTitle: string, invoiceNumber: string): string {
  const nameSlug = jobTitle
    ? "-" + jobTitle.replace(/[^a-zA-Z0-9]/g, " ").trim().replace(/\s+/g, "-").slice(0, 30).replace(/-+$/, "")
    : "";
  if (cleanLa) return `Invoice-LA${cleanLa}${nameSlug}.pdf`;
  const numSlug = invoiceNumber.replace(/[^a-zA-Z0-9]/g, "");
  return `Invoice-${numSlug}${nameSlug}.pdf`;
}

function buildInvoiceLine(cleanLa: string, jobTitle: string, workDateStr: string): string {
  let line = "Invoice for";
  if (cleanLa) line += ` LA#${cleanLa}`;
  if (jobTitle) line += ` ${jobTitle}`;
  if (workDateStr) line += ` - ${workDateStr}`;
  return line + ".";
}

function buildEmailText(cleanLa: string, jobTitle: string, workDateStr: string): string {
  return [buildInvoiceLine(cleanLa, jobTitle, workDateStr), "", "Thank you guys,", "", "Jeff Ulsh"].join("\n");
}

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

describe("buildSubject", () => {
  it("LA-centric: uses LA number, no job name, no internal invoice number", () => {
    expect(buildSubject("71852", "Wilm U Grad")).toBe("Jeff Ulsh - Invoice LA #71852");
  });

  it("no LA number: falls back to job title", () => {
    expect(buildSubject("", "Wilm U Grad")).toBe("Jeff Ulsh - Invoice Wilm U Grad");
  });

  it("no LA and no job title: omits both", () => {
    expect(buildSubject("", "")).toBe("Jeff Ulsh - Invoice");
  });

  it("LA with hyphens preserved", () => {
    expect(buildSubject("71852", "")).toBe("Jeff Ulsh - Invoice LA #71852");
  });
});

// ---------------------------------------------------------------------------
// cleanLaNumber
// ---------------------------------------------------------------------------

describe("cleanLaNumber", () => {
  it("strips LA# prefix", () => expect(cleanLaNumber("LA#71852")).toBe("71852"));
  it("strips LA # prefix with space", () => expect(cleanLaNumber("LA #71852")).toBe("71852"));
  it("strips leading LA prefix", () => expect(cleanLaNumber("LA71852")).toBe("71852"));
  it("returns raw digits when no prefix", () => expect(cleanLaNumber("71852")).toBe("71852"));
  it("returns empty string for null", () => expect(cleanLaNumber(null)).toBe(""));
});

// ---------------------------------------------------------------------------
// formatJobTitle — strips LA prefix from gig summary
// ---------------------------------------------------------------------------

describe("formatJobTitle", () => {
  it("strips LA# prefix from gig summary", () => {
    expect(formatJobTitle("LA#71852 - Wilm U Grad", "LA#71852")).toBe("Wilm U Grad");
  });

  it("strips LA # prefix with space", () => {
    expect(formatJobTitle("LA #71852 Wilm U Grad", "LA#71852")).toBe("Wilm U Grad");
  });

  it("preserves job name when no LA overlap", () => {
    expect(formatJobTitle("Wilm U Grad", null)).toBe("Wilm U Grad");
  });

  it("handles dash separators after LA number", () => {
    expect(formatJobTitle("LA71852 — Wilm U Grad", "LA71852")).toBe("Wilm U Grad");
  });
});

// ---------------------------------------------------------------------------
// buildAttachmentFilename
// ---------------------------------------------------------------------------

describe("buildAttachmentFilename", () => {
  it("LA with job: Invoice-LA71852-Wilm-U-Grad.pdf", () => {
    expect(buildAttachmentFilename("71852", "Wilm U Grad", "1001")).toBe("Invoice-LA71852-Wilm-U-Grad.pdf");
  });

  it("LA without job: Invoice-LA71852.pdf", () => {
    expect(buildAttachmentFilename("71852", "", "1001")).toBe("Invoice-LA71852.pdf");
  });

  it("no LA with job: uses invoice number", () => {
    expect(buildAttachmentFilename("", "Wilm U Grad", "1001")).toBe("Invoice-1001-Wilm-U-Grad.pdf");
  });

  it("no LA no job: uses invoice number only", () => {
    expect(buildAttachmentFilename("", "", "1001")).toBe("Invoice-1001.pdf");
  });

  it("special chars stripped from job name", () => {
    // "/" "&" "!" all become spaces; whitespace runs collapse to single hyphen
    expect(buildAttachmentFilename("71852", "Test/Job & More!", "1001")).toBe("Invoice-LA71852-Test-Job-More.pdf");
  });

  it("job name capped at 30 chars", () => {
    const longName = "A Very Long Job Name That Exceeds Thirty Chars";
    const result = buildAttachmentFilename("71852", longName, "1001");
    // Should be Invoice-LA71852-{slug}.pdf where slug ≤ 30
    const slug = result.replace("Invoice-LA71852-", "").replace(".pdf", "");
    expect(slug.length).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// Email body
// ---------------------------------------------------------------------------

describe("buildEmailText", () => {
  it("full body: invoice line + thank you + signature", () => {
    const text = buildEmailText("71852", "Wilm U Grad", "5/31 - 6/1");
    expect(text).toBe(
      "Invoice for LA#71852 Wilm U Grad - 5/31 - 6/1.\n\nThank you guys,\n\nJeff Ulsh"
    );
  });

  it("no balance due in body", () => {
    const text = buildEmailText("71852", "Wilm U Grad", "5/31 - 6/1");
    expect(text).not.toContain("Balance due");
    expect(text).not.toContain("balance");
  });

  it("no 'Hi,' greeting", () => {
    const text = buildEmailText("71852", "Wilm U Grad", "5/31 - 6/1");
    expect(text).not.toContain("Hi,");
  });

  it("no internal invoice number in body", () => {
    const text = buildEmailText("71852", "Wilm U Grad", "5/31 - 6/1");
    expect(text).not.toMatch(/Invoice 1001/);
  });

  it("no LA number: body uses job title", () => {
    const text = buildEmailText("", "Wilm U Grad", "5/31 - 6/1");
    expect(text).toContain("Invoice for Wilm U Grad - 5/31 - 6/1.");
    expect(text).not.toContain("LA#");
  });

  it("no work dates: omits date range", () => {
    const text = buildEmailText("71852", "Wilm U Grad", "");
    expect(text).toBe(
      "Invoice for LA#71852 Wilm U Grad.\n\nThank you guys,\n\nJeff Ulsh"
    );
  });
});

// ---------------------------------------------------------------------------
// fmtWorkDateRange
// ---------------------------------------------------------------------------

describe("fmtWorkDateRange", () => {
  it("single day: M/D", () => {
    expect(fmtWorkDateRange([{ date: "2026-05-31" }])).toBe("5/31");
  });

  it("multi-day range: first - last", () => {
    expect(fmtWorkDateRange([
      { date: "2026-05-31" },
      { date: "2026-06-01" },
    ])).toBe("5/31 - 6/1");
  });

  it("sorts dates regardless of input order", () => {
    expect(fmtWorkDateRange([
      { date: "2026-06-01" },
      { date: "2026-05-31" },
    ])).toBe("5/31 - 6/1");
  });

  it("empty workdays: empty string", () => {
    expect(fmtWorkDateRange([])).toBe("");
  });
});
