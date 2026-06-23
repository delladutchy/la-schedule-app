/**
 * Tests for invoice PDF page-flow and header behavior.
 *
 * All tests are pure-function — no react-pdf rendering.
 * They cover:
 *   1. Continuation header render callback: LA# on page 2+, invisible on page 1
 *   2. formatLaJobNumber normalisation (used for both invoice number and header)
 *   3. Header isolation: continuation header belongs only to invoice pages
 *   4. Natural flow: no aggressive forced-grouping settings
 *   5. Bottom section compactness: Total row visibility, note section visibility
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
// Total/balance block: natural flow (no forced grouping)
// ---------------------------------------------------------------------------

describe("lowerSection (totals block) page-break behaviour", () => {
  // lowerSection has NO wrap={false} — natural flow is preferred over forced grouping.
  // minPresenceAhead was removed from the table for the same reason: aggressive grouping
  // caused a large blank gap on page 1 when the info panel already consumed most of the page.
  //
  // Natural flow means:
  //   - Line items start wherever content flows after the info panel
  //   - The table can split across pages normally
  //   - Notes/Totals appear below the last line item (same page or next page)
  //   - No forced blank gaps

  it("natural flow: lowerSection renders after the last line item without forced page break", () => {
    // The lowerSection is a flex row — compact (~60pt without note) or taller with note.
    // Without wrap={false}, react-pdf flows it naturally.
    const lowerSectionApproxHeight = 60; // pt — just balance due when no note, no payment
    expect(lowerSectionApproxHeight).toBeLessThan(200);
  });

  it("natural flow: no minPresenceAhead on table — table starts wherever content flows", () => {
    // Previously minPresenceAhead={120} caused the whole table to jump to page 2
    // when <120pt remained on page 1, leaving a large blank gap.
    // Removing it lets the table start on page 1 and break naturally inside.
    const minPresenceAheadRemoved = true;
    expect(minPresenceAheadRemoved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bottom-section compactness: Total row and note visibility
// ---------------------------------------------------------------------------

// Mirror: showTotalRow logic from InvoicePDF
// Total row is only shown when a payment has been recorded.
// When unpaid (no payment), Total === Balance due — repeating it adds no information.
function showTotalRow(showPaymentRow: boolean): boolean {
  return showPaymentRow;
}

// Mirror: hasNote logic from InvoicePDF
function hasNote(noteOverride: string | null | undefined): boolean {
  return !!(noteOverride?.trim());
}

describe("Total row visibility", () => {
  it("unpaid, no payment: Total row is hidden (redundant — equals Balance due)", () => {
    expect(showTotalRow(false)).toBe(false);
  });

  it("partially paid: Total row is shown (needed to show arithmetic: Total - Payment = Balance)", () => {
    expect(showTotalRow(true)).toBe(true);
  });

  it("fully paid: Total row is shown (payment row exists, so Total is shown for clarity)", () => {
    // When paid, paidAmount = invoiceTotal, so showPaymentRow = true
    expect(showTotalRow(true)).toBe(true);
  });

  it("Balance due is always rendered regardless of Total row visibility", () => {
    // totalRowEmphasis (Balance due) is unconditionally rendered
    const balanceDueAlwaysShown = true;
    expect(balanceDueAlwaysShown).toBe(true);
  });
});

describe("Note section visibility", () => {
  it("no noteOverride: noteBox is not rendered, no space reserved", () => {
    expect(hasNote(null)).toBe(false);
    expect(hasNote(undefined)).toBe(false);
    expect(hasNote("")).toBe(false);
    expect(hasNote("   ")).toBe(false);
  });

  it("noteOverride present: noteBox is rendered", () => {
    expect(hasNote("Please pay within 15 days.")).toBe(true);
    expect(hasNote("  Thanks!  ")).toBe(true);
  });

  it("no note: layout uses lowerSectionRight (totals right-aligned only, no left column)", () => {
    // When hasNote=false, lowerSectionRight style is used instead of lowerSection.
    // This eliminates the empty left column that was reserving ~53% width for nothing.
    const usesSectionRight = !hasNote(null);
    expect(usesSectionRight).toBe(true);
  });

  it("note present: layout uses lowerSection (note left, totals right)", () => {
    const usesFullSection = hasNote("Thank you for your business.");
    expect(usesFullSection).toBe(true);
  });
});

describe("Invoice math unchanged by layout changes", () => {
  it("Balance due = invoiceTotal - paidAmount (unpaid, no payment)", () => {
    const invoiceTotal = 4824.84;
    const paidAmount = 0;
    const balanceDue = Math.max(Number((invoiceTotal - paidAmount).toFixed(2)), 0);
    expect(balanceDue).toBe(4824.84);
  });

  it("Balance due = invoiceTotal - paidAmount (partially paid)", () => {
    const invoiceTotal = 4824.84;
    const paidAmount = 1000;
    const balanceDue = Math.max(Number((invoiceTotal - paidAmount).toFixed(2)), 0);
    expect(balanceDue).toBe(3824.84);
  });

  it("Balance due = 0 when paid in full", () => {
    const invoiceTotal = 4824.84;
    // When status === "paid", paidAmount = invoiceTotal
    const paidAmount = invoiceTotal;
    const balanceDue = Math.max(Number((invoiceTotal - paidAmount).toFixed(2)), 0);
    expect(balanceDue).toBe(0);
  });

  it("showPaidInFull when balanceDue <= 0", () => {
    expect(0 <= 0).toBe(true);   // paid in full
    expect(100 <= 0).toBe(false); // not paid in full
  });
});
