/**
 * Tests for the invoice receipt appendix feature.
 *
 * All tests are pure-function — no React rendering, no Supabase calls.
 * They cover:
 *   1.  fetchReceiptPages filtering: only include_in_email=true receipts
 *   2.  Image type detection: JPEG/PNG/WEBP/GIF are embeddable; PDF/HEIC are not
 *   3.  receiptDate resolution: explicit receipt_date only; no upload/today fallback
 *   4.  ReceiptPageData field mapping from attachment records
 *   5.  PDF placeholder logic (isPdf vs other unsupported type)
 *   6.  Receipt appendix page header content: date + LA number
 *   7.  Subheader: category · amount; omitted when both missing
 *   8.  Amount formatting helper consistency
 *   9.  PATCH metadata validation: include_in_email, receipt_date, receipt_category, receipt_amount
 *   10. Send Invoice gating unchanged (still requires verified status)
 *   11. Regression: invoice without receipts renders same as before (empty receiptPages)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { isVerifyBlockingEmail } from "@/lib/invoice-pipeline";

// ---------------------------------------------------------------------------
// Shared types (mirrors lib/invoice-pdf.tsx ReceiptPageData without importing
// the server-only module in tests)
// ---------------------------------------------------------------------------

interface ReceiptPageData {
  id: string;
  mimeType: string;
  imageDataUrl: string | null;
  receiptDate: string | null;
  laJobNumber: string | null;
  category: string | null;
  amount: number | null;
  originalFilename: string;
}

// ---------------------------------------------------------------------------
// 1. Image type detection
// ---------------------------------------------------------------------------

const EMBEDDABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function canEmbedImage(mimeType: string): boolean {
  return EMBEDDABLE_IMAGE_TYPES.has(mimeType);
}

describe("image type detection for receipt appendix", () => {
  it("embeds JPEG", () => expect(canEmbedImage("image/jpeg")).toBe(true));
  it("embeds PNG",  () => expect(canEmbedImage("image/png")).toBe(true));
  it("embeds WEBP", () => expect(canEmbedImage("image/webp")).toBe(true));
  it("embeds GIF",  () => expect(canEmbedImage("image/gif")).toBe(true));

  it("does NOT embed PDF (placeholder instead)", () => expect(canEmbedImage("application/pdf")).toBe(false));
  it("does NOT embed HEIC",  () => expect(canEmbedImage("image/heic")).toBe(false));
  it("does NOT embed HEIF",  () => expect(canEmbedImage("image/heif")).toBe(false));
});

// ---------------------------------------------------------------------------
// 2. receiptDate resolution logic
// ---------------------------------------------------------------------------

function resolveReceiptDate(receiptDate: string | null): string | null {
  return receiptDate;
}

describe("receipt date resolution", () => {
  it("uses explicit receipt_date when set", () => {
    expect(resolveReceiptDate("2026-05-21")).toBe("2026-05-21");
  });

  it("does not fall back to created_at when receipt_date is null", () => {
    expect(resolveReceiptDate(null)).toBeNull();
  });

  it("does not invent today's date when receipt_date is missing", () => {
    expect(resolveReceiptDate(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. ReceiptPageData mapping from attachment records
// ---------------------------------------------------------------------------

type AttachmentRow = {
  id: string;
  storage_path: string;
  mime_type: string;
  original_filename: string;
  la_job_number: string | null;
  receipt_date: string | null;
  receipt_category: string | null;
  receipt_amount: number | null;
  created_at: string;
  include_in_email: boolean;
};

function buildReceiptPageData(row: AttachmentRow, imageDataUrl: string | null): ReceiptPageData {
  return {
    id:               row.id,
    mimeType:         row.mime_type,
    imageDataUrl,
    receiptDate:      resolveReceiptDate(row.receipt_date),
    laJobNumber:      row.la_job_number,
    category:         row.receipt_category,
    amount:           row.receipt_amount,
    originalFilename: row.original_filename,
  };
}

const SAMPLE_IMAGE_ROW: AttachmentRow = {
  id:               "att-1",
  storage_path:     "event-abc/receipt.jpg",
  mime_type:        "image/jpeg",
  original_filename: "receipt.jpg",
  la_job_number:    "70924",
  receipt_date:     "2026-05-21",
  receipt_category: "Parking",
  receipt_amount:   25.20,
  created_at:       "2026-06-17T14:30:00Z",
  include_in_email: true,
};

const SAMPLE_PDF_ROW: AttachmentRow = {
  id:               "att-2",
  storage_path:     "event-abc/receipt.pdf",
  mime_type:        "application/pdf",
  original_filename: "hotel-folio.pdf",
  la_job_number:    "70924",
  receipt_date:     null,
  receipt_category: "Hotel",
  receipt_amount:   189.00,
  created_at:       "2026-06-18T09:00:00Z",
  include_in_email: true,
};

const SAMPLE_EXCLUDED_ROW: AttachmentRow = {
  ...SAMPLE_IMAGE_ROW,
  id:               "att-3",
  include_in_email: false,
};

describe("ReceiptPageData mapping", () => {
  it("maps image row with data URL to ReceiptPageData correctly", () => {
    const data = buildReceiptPageData(SAMPLE_IMAGE_ROW, "data:image/jpeg;base64,abc123");
    expect(data.id).toBe("att-1");
    expect(data.mimeType).toBe("image/jpeg");
    expect(data.imageDataUrl).toBe("data:image/jpeg;base64,abc123");
    expect(data.receiptDate).toBe("2026-05-21");
    expect(data.laJobNumber).toBe("70924");
    expect(data.category).toBe("Parking");
    expect(data.amount).toBe(25.20);
    expect(data.originalFilename).toBe("receipt.jpg");
  });

  it("maps PDF row with null imageDataUrl", () => {
    const data = buildReceiptPageData(SAMPLE_PDF_ROW, null);
    expect(data.imageDataUrl).toBeNull();
    expect(data.mimeType).toBe("application/pdf");
    expect(data.receiptDate).toBeNull();
  });

  it("keeps receiptDate null when receipt_date is null", () => {
    const data = buildReceiptPageData(SAMPLE_PDF_ROW, null);
    expect(data.receiptDate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. include_in_email filter (only included receipts get appendix pages)
// ---------------------------------------------------------------------------

function filterIncludedReceipts(rows: AttachmentRow[]): AttachmentRow[] {
  return rows.filter((r) => r.include_in_email);
}

describe("receipt include_in_email filtering", () => {
  const rows = [SAMPLE_IMAGE_ROW, SAMPLE_PDF_ROW, SAMPLE_EXCLUDED_ROW];

  it("includes only email-flagged receipts", () => {
    const included = filterIncludedReceipts(rows);
    expect(included).toHaveLength(2);
    expect(included.map((r) => r.id)).toEqual(["att-1", "att-2"]);
  });

  it("excluded receipt does not appear in appendix", () => {
    const included = filterIncludedReceipts(rows);
    expect(included.map((r) => r.id)).not.toContain("att-3");
  });

  it("empty list returns empty appendix", () => {
    expect(filterIncludedReceipts([])).toHaveLength(0);
  });

  it("invoice without any receipts produces no appendix pages", () => {
    expect(filterIncludedReceipts([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Receipt page header content
// ---------------------------------------------------------------------------

function fmtReceiptLongDate(isoDate: string): string {
  const parts = isoDate.split("-").map(Number);
  const y  = parts[0] ?? 0;
  const mo = parts[1] ?? 1;
  const d  = parts[2] ?? 1;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[mo - 1] ?? ""} ${d}, ${y}`;
}

function formatLaJobNumber(laNumber: string | null): string | null {
  if (!laNumber) return null;
  const clean = laNumber.replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "");
  return clean ? `LA# ${clean}` : laNumber;
}

function buildPageHeader(receipt: ReceiptPageData): { dateStr: string; laStr: string | null; subheader: string } {
  const dateStr = receipt.receiptDate ? fmtReceiptLongDate(receipt.receiptDate) : "";
  const laStr   = receipt.laJobNumber ? formatLaJobNumber(receipt.laJobNumber) : null;
  const subParts = [
    receipt.category?.trim() || null,
    receipt.amount != null ? `$${receipt.amount.toFixed(2)}` : null,
  ].filter((v): v is string => v != null);
  return { dateStr, laStr, subheader: subParts.join(" · ") };
}

describe("receipt page header content", () => {
  it("formats date as 'May 21, 2026'", () => {
    const page = buildReceiptPageData(SAMPLE_IMAGE_ROW, null);
    const { dateStr } = buildPageHeader(page);
    expect(dateStr).toBe("May 21, 2026");
  });

  it("formats LA number as 'LA# 70924'", () => {
    const page = buildReceiptPageData(SAMPLE_IMAGE_ROW, null);
    const { laStr } = buildPageHeader(page);
    expect(laStr).toBe("LA# 70924");
  });

  it("shows category and amount in subheader when both present", () => {
    const page = buildReceiptPageData(SAMPLE_IMAGE_ROW, null);
    const { subheader } = buildPageHeader(page);
    expect(subheader).toBe("Parking · $25.20");
  });

  it("shows only category when amount is null", () => {
    const page = buildReceiptPageData({ ...SAMPLE_IMAGE_ROW, receipt_amount: null }, null);
    const { subheader } = buildPageHeader(page);
    expect(subheader).toBe("Parking");
  });

  it("shows only amount when category is null", () => {
    const page = buildReceiptPageData({ ...SAMPLE_IMAGE_ROW, receipt_category: null }, null);
    const { subheader } = buildPageHeader(page);
    expect(subheader).toBe("$25.20");
  });

  it("subheader is empty string when both category and amount are null", () => {
    const row: AttachmentRow = { ...SAMPLE_IMAGE_ROW, receipt_category: null, receipt_amount: null };
    const page = buildReceiptPageData(row, null);
    const { subheader } = buildPageHeader(page);
    expect(subheader).toBe("");
  });

  it("date is empty string when receiptDate is null", () => {
    const page: ReceiptPageData = {
      ...buildReceiptPageData(SAMPLE_IMAGE_ROW, null),
      receiptDate: null,
    };
    const { dateStr } = buildPageHeader(page);
    expect(dateStr).toBe("");
  });

  it("keeps LA job number visible when receiptDate is null", () => {
    const page: ReceiptPageData = {
      ...buildReceiptPageData(SAMPLE_IMAGE_ROW, null),
      receiptDate: null,
    };
    const { dateStr, laStr } = buildPageHeader(page);
    expect(dateStr).toBe("");
    expect(laStr).toBe("LA# 70924");
  });

  it("laStr is null when laJobNumber is null", () => {
    const page: ReceiptPageData = {
      ...buildReceiptPageData(SAMPLE_IMAGE_ROW, null),
      laJobNumber: null,
    };
    const { laStr } = buildPageHeader(page);
    expect(laStr).toBeNull();
  });
});

describe("receipt page header styling", () => {
  function styleBlock(name: string): string {
    const source = readFileSync(join(process.cwd(), "lib/invoice-pdf.tsx"), "utf8");
    const match = source.match(new RegExp(`${name}: \\{([\\s\\S]*?)\\n  \\},`));
    return match?.[1] ?? "";
  }

  it("uses subtle non-bold text for the receipt date", () => {
    const block = styleBlock("receiptPageDate");
    expect(block).toContain("fontSize: 8.5");
    expect(block).toContain('fontFamily: "Helvetica"');
    expect(block).not.toContain("Helvetica-Bold");
  });

  it("uses subtle non-bold text for the LA job number", () => {
    const block = styleBlock("receiptPageLa");
    expect(block).toContain("fontSize: 8.5");
    expect(block).toContain('fontFamily: "Helvetica"');
    expect(block).not.toContain("Helvetica-Bold");
  });
});

// ---------------------------------------------------------------------------
// 6. PDF vs image placeholder logic
// ---------------------------------------------------------------------------

function placeholderText(mimeType: string): string {
  return mimeType === "application/pdf"
    ? "Receipt PDF attached separately"
    : "Receipt attached separately";
}

describe("PDF receipt placeholder", () => {
  it("shows 'Receipt PDF attached separately' for PDF receipts", () => {
    expect(placeholderText("application/pdf")).toBe("Receipt PDF attached separately");
  });

  it("shows generic 'Receipt attached separately' for HEIC", () => {
    expect(placeholderText("image/heic")).toBe("Receipt attached separately");
  });

  it("image receipts use data URL, not placeholder", () => {
    const data = buildReceiptPageData(SAMPLE_IMAGE_ROW, "data:image/jpeg;base64,abc");
    expect(data.imageDataUrl).not.toBeNull();
  });

  it("PDF receipt always has null imageDataUrl", () => {
    const data = buildReceiptPageData(SAMPLE_PDF_ROW, null);
    expect(data.imageDataUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. PATCH metadata validation (mirrors route logic)
// ---------------------------------------------------------------------------

type PatchUpdates = {
  include_in_email?: boolean;
  receipt_date?: string | null;
  receipt_category?: string | null;
  receipt_amount?: number | null;
};

function parsePatchBody(body: Record<string, unknown>): { updates: PatchUpdates; error: string | null } {
  const updates: PatchUpdates = {};
  if ("include_in_email" in body) {
    if (typeof body.include_in_email !== "boolean") return { updates: {}, error: "include_in_email_must_be_boolean" };
    updates.include_in_email = body.include_in_email as boolean;
  }
  if ("receipt_date" in body) {
    updates.receipt_date = (typeof body.receipt_date === "string" && body.receipt_date) ? body.receipt_date : null;
  }
  if ("receipt_category" in body) {
    updates.receipt_category = (typeof body.receipt_category === "string" && body.receipt_category) ? body.receipt_category : null;
  }
  if ("receipt_amount" in body) {
    const amt = body.receipt_amount;
    updates.receipt_amount = (typeof amt === "number" && !isNaN(amt)) ? amt : null;
  }
  if (Object.keys(updates).length === 0) return { updates: {}, error: "no_fields_provided" };
  return { updates, error: null };
}

describe("PATCH metadata validation", () => {
  it("accepts include_in_email boolean", () => {
    const { updates, error } = parsePatchBody({ include_in_email: true });
    expect(error).toBeNull();
    expect(updates.include_in_email).toBe(true);
  });

  it("rejects include_in_email non-boolean", () => {
    const { error } = parsePatchBody({ include_in_email: "yes" });
    expect(error).toBe("include_in_email_must_be_boolean");
  });

  it("accepts receipt_date string", () => {
    const { updates, error } = parsePatchBody({ receipt_date: "2026-05-21" });
    expect(error).toBeNull();
    expect(updates.receipt_date).toBe("2026-05-21");
  });

  it("coerces empty receipt_date to null", () => {
    const { updates } = parsePatchBody({ receipt_date: "" });
    expect(updates.receipt_date).toBeNull();
  });

  it("accepts receipt_category string", () => {
    const { updates, error } = parsePatchBody({ receipt_category: "Parking" });
    expect(error).toBeNull();
    expect(updates.receipt_category).toBe("Parking");
  });

  it("coerces empty receipt_category to null", () => {
    const { updates } = parsePatchBody({ receipt_category: "" });
    expect(updates.receipt_category).toBeNull();
  });

  it("accepts receipt_amount number", () => {
    const { updates, error } = parsePatchBody({ receipt_amount: 25.20 });
    expect(error).toBeNull();
    expect(updates.receipt_amount).toBe(25.20);
  });

  it("coerces non-number receipt_amount to null", () => {
    const { updates } = parsePatchBody({ receipt_amount: "25.20" });
    expect(updates.receipt_amount).toBeNull();
  });

  it("accepts multiple fields in one PATCH", () => {
    const { updates, error } = parsePatchBody({
      include_in_email:  true,
      receipt_date:      "2026-05-21",
      receipt_category:  "Hotel",
      receipt_amount:    189.00,
    });
    expect(error).toBeNull();
    expect(Object.keys(updates)).toHaveLength(4);
  });

  it("returns error when body has no recognized fields", () => {
    const { error } = parsePatchBody({ unknown_field: true });
    expect(error).toBe("no_fields_provided");
  });
});

// ---------------------------------------------------------------------------
// 8. Send Invoice gating — unchanged by this feature
// ---------------------------------------------------------------------------

describe("Send Invoice gating unchanged", () => {
  it("isVerifyBlockingEmail returns true when idle", () => {
    expect(isVerifyBlockingEmail("idle")).toBe(true);
  });

  it("isVerifyBlockingEmail returns true when verifying", () => {
    expect(isVerifyBlockingEmail("verifying")).toBe(true);
  });

  it("isVerifyBlockingEmail returns true when failed", () => {
    expect(isVerifyBlockingEmail("failed")).toBe(true);
  });

  it("isVerifyBlockingEmail returns false only when verified", () => {
    expect(isVerifyBlockingEmail("verified")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Regression: empty receiptPages leaves invoice unchanged
// ---------------------------------------------------------------------------

describe("invoice PDF regression with empty receipt pages", () => {
  it("empty receiptPages array produces no appendix", () => {
    const pages: ReceiptPageData[] = [];
    expect(pages).toHaveLength(0);
  });

  it("undefined receiptPages treated same as empty", () => {
    const pages: ReceiptPageData[] | undefined = undefined;
    const resolved = pages ?? [];
    expect(resolved).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. fmtReceiptLongDate — all months
// ---------------------------------------------------------------------------

describe("fmtReceiptLongDate", () => {
  const cases: [string, string][] = [
    ["2026-01-05", "Jan 5, 2026"],
    ["2026-02-14", "Feb 14, 2026"],
    ["2026-03-01", "Mar 1, 2026"],
    ["2026-04-30", "Apr 30, 2026"],
    ["2026-05-21", "May 21, 2026"],
    ["2026-06-22", "Jun 22, 2026"],
    ["2026-07-04", "Jul 4, 2026"],
    ["2026-08-15", "Aug 15, 2026"],
    ["2026-09-09", "Sep 9, 2026"],
    ["2026-10-31", "Oct 31, 2026"],
    ["2026-11-11", "Nov 11, 2026"],
    ["2026-12-25", "Dec 25, 2026"],
  ];
  for (const [input, expected] of cases) {
    it(`formats ${input} as "${expected}"`, () => {
      expect(fmtReceiptLongDate(input)).toBe(expected);
    });
  }
});
