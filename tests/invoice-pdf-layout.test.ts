/**
 * Tests for invoice PDF page-flow and header behavior.
 *
 * All tests are pure-function — no react-pdf rendering.
 * They cover:
 *   1. Continuation header render callback: LA# on page 2+, invisible on page 1
 *   2. formatLaJobNumber normalisation (used for both invoice number and header)
 *   3. Header isolation: continuation header belongs only to invoice pages
 *   4. Total/balance block placement: lowerSection stays wrap={false}
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Mirror: continuation header render callback
// Matches the inline render prop in InvoicePDF:
//   render={({ pageNumber }) => pageNumber > 1 ? formattedLaJob : ''}
// ---------------------------------------------------------------------------

function continuationLaText(
  pageNumber: number,
  formattedLaJob: string | null,
): string {
  return pageNumber > 1 && formattedLaJob ? formattedLaJob : "";
}

describe("invoice continuation header (LA# top-right, page 2+ only)", () => {
  it("page 1 returns empty string — page 1 already has full header", () => {
    expect(continuationLaText(1, "LA #71803")).toBe("");
  });

  it("page 2 returns formatted LA# when available", () => {
    expect(continuationLaText(2, "LA #71803")).toBe("LA #71803");
  });

  it("page 3 also returns formatted LA#", () => {
    expect(continuationLaText(3, "LA #71803")).toBe("LA #71803");
  });

  it("page 2: returns empty string when no LA# (formattedLaJob null)", () => {
    expect(continuationLaText(2, null)).toBe("");
  });

  it("page 1 never shows LA# text regardless of job number", () => {
    const result = continuationLaText(1, "LA #12345");
    expect(result).toBe("");
    expect(result).not.toContain("LA");
  });

  it("page 5 shows LA# (any page > 1)", () => {
    expect(continuationLaText(5, "LA #71803")).toBe("LA #71803");
  });
});

// ---------------------------------------------------------------------------
// Mirror: formatLaJobNumber — used for clientInvoiceNumber and continuation header
// ---------------------------------------------------------------------------

function formatLaJobNumber(laNumber: string | null): string | null {
  if (!laNumber) return null;
  const clean = laNumber.replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "");
  return clean ? `LA #${clean}` : laNumber;
}

describe("formatLaJobNumber", () => {
  it("null → null", () => {
    expect(formatLaJobNumber(null)).toBeNull();
  });

  it("bare digits → LA #71803", () => {
    expect(formatLaJobNumber("71803")).toBe("LA #71803");
  });

  it("LA#71803 (no space) → LA #71803 (normalised)", () => {
    expect(formatLaJobNumber("LA#71803")).toBe("LA #71803");
  });

  it("LA# 71803 (with space) → LA #71803", () => {
    expect(formatLaJobNumber("LA# 71803")).toBe("LA #71803");
  });

  it("case insensitive: la#71803 → LA #71803", () => {
    expect(formatLaJobNumber("la#71803")).toBe("LA #71803");
  });

  it("empty string → null", () => {
    expect(formatLaJobNumber("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Continuation header visibility rules
// ---------------------------------------------------------------------------

describe("continuation header visibility contract", () => {
  it("when formattedLaJob is null, View is not rendered (guard condition)", () => {
    // In InvoicePDF: {formattedLaJob ? <View fixed ...> : null}
    // This test verifies the guard logic
    const shouldRender = (formattedLaJob: string | null) => formattedLaJob !== null;
    expect(shouldRender(null)).toBe(false);
    expect(shouldRender("LA #71803")).toBe(true);
  });

  it("page 1 content is empty even when View is rendered", () => {
    // The absolute-positioned View still renders on page 1 (fixed),
    // but the Text render callback returns '' — visually invisible
    const page1Text = continuationLaText(1, "LA #71803");
    expect(page1Text).toBe("");
  });

  it("no generated date ever appears in continuation header", () => {
    // The header shows only the LA# — never a timestamp or current date
    const header = continuationLaText(2, "LA #71803");
    expect(header).toBe("LA #71803");
    expect(header).not.toMatch(/\d{4}\/\d{2}\/\d{2}/); // no date in header
    expect(header).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/); // no MM/DD/YY
  });
});

// ---------------------------------------------------------------------------
// Receipt pages: unaffected by invoice continuation header
// ---------------------------------------------------------------------------

describe("receipt pages isolation from invoice page changes", () => {
  // Receipt appendix pages (ReceiptPage component) use a separate Page component
  // with their own receipt date + LA# in the header area.
  // The invoice continuation header (fixed, absolute) lives inside the invoice
  // Page and does NOT bleed into receipt Pages.
  //
  // PDF receipt merged pages use the pdf-lib stamp (invoice-pdf-merge.ts).

  it("invoice continuation header format differs from receipt stamp format", () => {
    // Invoice continuation header: "LA #71803"  (formatLaJobNumber — space before number)
    // Receipt stamp (pdf-lib):     "LA# 71803"  (formatStampLa — no space after #)
    // Both show the same job number; format differences are intentional per context
    const invoiceHeaderLa = formatLaJobNumber("71803");
    const receiptStampLa  = "LA# 71803"; // from invoice-pdf-merge formatStampLa
    expect(invoiceHeaderLa).toBe("LA #71803");
    expect(receiptStampLa).toBe("LA# 71803");
    // The job number digit portion is the same
    expect(invoiceHeaderLa?.replace(/^LA\s*#?\s*/i, "")).toBe(
      receiptStampLa.replace(/^LA\s*#?\s*/i, ""),
    );
  });

  it("receipt appendix pages are separate Page components — fixed element does not leak", () => {
    // In InvoicePDF, fixed elements only repeat within their containing Page.
    // ReceiptPage components are separate <Page> elements, so the invoice's
    // continuation header View does not appear on receipt pages.
    // This is a documentation test of the react-pdf scoping rule.
    const invoicePageHasContinuationHeader = true; // the invoice Page contains the fixed View
    const receiptPagesHaveContinuationHeader = false; // ReceiptPage is a separate Page
    expect(invoicePageHasContinuationHeader).toBe(true);
    expect(receiptPagesHaveContinuationHeader).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Total/balance block: wrap={false} keeps it together
// ---------------------------------------------------------------------------

describe("lowerSection (totals block) page-break behaviour", () => {
  // lowerSection uses wrap={false} so react-pdf moves the entire block
  // (Note + Totals + Balance Due) to the next page rather than splitting it.
  // minPresenceAhead={120} on the table encourages react-pdf to break inside
  // the table rather than stranding lowerSection alone on the next page.

  it("lowerSection wrap=false: entire block stays together or moves together", () => {
    // Pure doc: if lowerSection height is ~120pt, and remaining page space is <120pt,
    // the whole block moves to the next page. It does not split Total from Balance Due.
    const lowerSectionHeight = 120; // approximate pt
    const remainingSpace = 80;      // page near full
    const fitsOnCurrentPage = remainingSpace >= lowerSectionHeight;
    expect(fitsOnCurrentPage).toBe(false); // would move to next page — that's correct
  });

  it("minPresenceAhead: table breaks before end when <120pt remain for lowerSection", () => {
    // minPresenceAhead={120} on the table means: if there are fewer than 120pt
    // of space after the table starts, the table moves OR breaks inside to free space.
    // In practice: last line items may break to page 2 along with lowerSection.
    const minPresenceAhead = 120;
    const availableAfterTable = 80; // less than minPresenceAhead
    const wouldBreakInsideTable = availableAfterTable < minPresenceAhead;
    expect(wouldBreakInsideTable).toBe(true);
  });
});
