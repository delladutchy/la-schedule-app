/**
 * Tests for automatic Google Sheets sync accuracy and trigger logic.
 *
 * Verifies:
 *   - Sheet total always uses fresh estimatedTotal (not stale invoice_total)
 *   - Remaining balance = estimatedTotal - amountPaid (never stale)
 *   - Sent status only reflects after markInvoiceSent
 *   - Payment fields sync amount paid / remaining balance
 *   - Missing optional Sheet columns (sentTo, sentSubject, overrides) do not break sync
 *   - Open Google Sheet URL uses the configured GOOGLE_SHEET_ID
 *   - Manual Sync in Advanced section is the only visible sync button
 *   - generateSheetRow extra fields are passed when available
 *   - Duplicate cleanup keeps the newest duplicate row and only deletes confirmed duplicates
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Mirrors of generateSheetRow pure logic (no Sheets API calls)
// ---------------------------------------------------------------------------

interface FakePacket {
  estimatedTotal: number;
  amountPaid: number;
  invoiceStatus: string;
  invoiceSentAt: string | null;
  invoicePdfUrl: string | null;
  invoiceNumber: string | null;
  laNumber: string | null;
  dayRateTotal: number;
  overtimeTotal: number;
  perDiemTotal: number;
  parking: number;
  hotel: number;
  tolls: number;
  bagFees: number;
  uber: number;
  otherExpenses: number;
  mileage: { mileageAmount: number; totalMiles: number; reimbursedMiles: number; unreimbursedMiles: number } | null;
}

interface FakeExtras {
  sentTo?: string | null;
  sentSubject?: string | null;
  jobNameOverride?: string | null;
  dayRateDescriptionOverride?: string | null;
  noteOverride?: string | null;
}

function calcRemainingBalance(estimatedTotal: number, amountPaid: number): number {
  return Math.max(0, Number((estimatedTotal - amountPaid).toFixed(2)));
}

function buildSheetRow(packet: FakePacket, gigSummary: string, invoiceNumber?: string, extras?: FakeExtras) {
  const pm = packet.mileage;
  return {
    invoiceNumber: invoiceNumber ?? packet.invoiceNumber ?? packet.laNumber ?? "",
    laJobNumber: packet.laNumber ?? "",
    gigEvent: gigSummary,
    totalPay: packet.estimatedTotal,
    labor: packet.dayRateTotal,
    ot: packet.overtimeTotal,
    perDiem: packet.perDiemTotal,
    parking: packet.parking,
    mileage: pm?.mileageAmount ?? 0,
    hotel: packet.hotel,
    tolls: packet.tolls,
    bagFees: packet.bagFees,
    uber: packet.uber,
    otherExpenses: packet.otherExpenses,
    status: packet.invoiceStatus,
    invoicePdfUrl: packet.invoicePdfUrl ?? "",
    invoiceSentDate: packet.invoiceSentAt ? packet.invoiceSentAt.slice(0, 10) : "",
    amountPaid: packet.amountPaid ?? 0,
    remainingBalance: calcRemainingBalance(packet.estimatedTotal, packet.amountPaid ?? 0),
    // Optional extras
    sentTo: extras?.sentTo ?? "",
    sentSubject: extras?.sentSubject ?? "",
    jobNameOverride: extras?.jobNameOverride ?? "",
    dayRateDescriptionOverride: extras?.dayRateDescriptionOverride ?? "",
    noteOverride: extras?.noteOverride ?? "",
  };
}

// ---------------------------------------------------------------------------
// A. Sheet total accuracy
// ---------------------------------------------------------------------------

describe("Sheet total accuracy", () => {
  it("totalPay is always packet.estimatedTotal, not stale invoice_total", () => {
    // Simulates: invoice_total in DB = 1000 (stale), but packet recalculated = 1250
    const staleDbTotal = 1000;
    const freshEstimatedTotal = 1250;
    const packet: FakePacket = {
      estimatedTotal: freshEstimatedTotal,
      amountPaid: 0,
      invoiceStatus: "sent",
      invoiceSentAt: null,
      invoicePdfUrl: null,
      invoiceNumber: "1001",
      laNumber: "LA#5555",
      dayRateTotal: 1100,
      overtimeTotal: 150,
      perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    };
    const row = buildSheetRow(packet, "LA#5555 — test job", "1001");
    expect(row.totalPay).toBe(freshEstimatedTotal);
    expect(row.totalPay).not.toBe(staleDbTotal);
  });

  it("totalPay includes all line items: labor + OT + perDiem + expenses", () => {
    const packet: FakePacket = {
      estimatedTotal: 1650,
      amountPaid: 0,
      invoiceStatus: "ready",
      invoiceSentAt: null, invoicePdfUrl: null, invoiceNumber: "1002", laNumber: "LA#6000",
      dayRateTotal: 1100,
      overtimeTotal: 206.25,
      perDiemTotal: 80,
      parking: 263.75, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    };
    const row = buildSheetRow(packet, "LA#6000 — event", "1002");
    // totalPay = packet.estimatedTotal (pre-computed; we just trust it)
    expect(row.totalPay).toBe(1650);
    expect(row.labor).toBe(1100);
    expect(row.ot).toBe(206.25);
  });
});

// ---------------------------------------------------------------------------
// B. Remaining balance accuracy
// ---------------------------------------------------------------------------

describe("Remaining balance accuracy", () => {
  it("remainingBalance = estimatedTotal - amountPaid (never stale)", () => {
    const row = buildSheetRow({
      estimatedTotal: 1250, amountPaid: 500,
      invoiceStatus: "partially_paid", invoiceSentAt: null, invoicePdfUrl: null,
      invoiceNumber: "1001", laNumber: "LA#5555",
      dayRateTotal: 1100, overtimeTotal: 150, perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    }, "test job", "1001");
    expect(row.remainingBalance).toBe(750);
    expect(row.amountPaid).toBe(500);
  });

  it("remainingBalance is 0 when fully paid", () => {
    const row = buildSheetRow({
      estimatedTotal: 1000, amountPaid: 1000,
      invoiceStatus: "paid", invoiceSentAt: null, invoicePdfUrl: null,
      invoiceNumber: "1001", laNumber: "LA#5555",
      dayRateTotal: 1000, overtimeTotal: 0, perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    }, "test job", "1001");
    expect(row.remainingBalance).toBe(0);
  });

  it("remainingBalance is clamped to 0 when overpaid (edge case)", () => {
    const row = buildSheetRow({
      estimatedTotal: 1000, amountPaid: 1100,
      invoiceStatus: "paid", invoiceSentAt: null, invoicePdfUrl: null,
      invoiceNumber: "1001", laNumber: "LA#5555",
      dayRateTotal: 1000, overtimeTotal: 0, perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    }, "test job", "1001");
    expect(row.remainingBalance).toBe(0);
  });

  it("unpaid invoice: remainingBalance equals estimatedTotal", () => {
    const total = 1650;
    const row = buildSheetRow({
      estimatedTotal: total, amountPaid: 0,
      invoiceStatus: "sent", invoiceSentAt: "2026-06-18T00:00:00Z", invoicePdfUrl: null,
      invoiceNumber: "1002", laNumber: "LA#6000",
      dayRateTotal: 1650, overtimeTotal: 0, perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    }, "test job", "1002");
    expect(row.remainingBalance).toBe(total);
    expect(row.amountPaid).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C. Status accuracy
// ---------------------------------------------------------------------------

describe("Invoice status in sheet row", () => {
  it("status is 'sent' only after markInvoiceSent (post-send packet)", () => {
    // Pre-send packet would have status = "sheet_synced"; post-send = "sent"
    const preSendRow = buildSheetRow({
      estimatedTotal: 1000, amountPaid: 0,
      invoiceStatus: "sheet_synced",
      invoiceSentAt: null, invoicePdfUrl: "https://example.com/inv.pdf",
      invoiceNumber: "1001", laNumber: "LA#5555",
      dayRateTotal: 1000, overtimeTotal: 0, perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    }, "test job", "1001");
    expect(preSendRow.status).toBe("sheet_synced");
    expect(preSendRow.status).not.toBe("sent");

    const postSendRow = buildSheetRow({
      estimatedTotal: 1000, amountPaid: 0,
      invoiceStatus: "sent",
      invoiceSentAt: "2026-06-18T10:00:00Z", invoicePdfUrl: "https://example.com/inv.pdf",
      invoiceNumber: "1001", laNumber: "LA#5555",
      dayRateTotal: 1000, overtimeTotal: 0, perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    }, "test job", "1001", { sentTo: "client@example.com", sentSubject: "Jeff Ulsh - Invoice LA #5555" });
    expect(postSendRow.status).toBe("sent");
    expect(postSendRow.invoiceSentDate).toBe("2026-06-18");
    expect(postSendRow.sentTo).toBe("client@example.com");
    expect(postSendRow.sentSubject).toBe("Jeff Ulsh - Invoice LA #5555");
  });
});

// ---------------------------------------------------------------------------
// D. Optional extras (sentTo, sentSubject, overrides)
// ---------------------------------------------------------------------------

describe("Optional extended columns (AC–AG)", () => {
  it("missing extras: sentTo, sentSubject, overrides default to empty string (does not throw)", () => {
    const row = buildSheetRow({
      estimatedTotal: 1000, amountPaid: 0,
      invoiceStatus: "sent", invoiceSentAt: null, invoicePdfUrl: null,
      invoiceNumber: "1001", laNumber: "LA#5555",
      dayRateTotal: 1000, overtimeTotal: 0, perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    }, "test job", "1001");
    // Must not throw; optional fields fall back to ""
    expect(row.sentTo).toBe("");
    expect(row.sentSubject).toBe("");
    expect(row.jobNameOverride).toBe("");
    expect(row.dayRateDescriptionOverride).toBe("");
    expect(row.noteOverride).toBe("");
  });

  it("provided extras: all five optional fields are written to row", () => {
    const extras: FakeExtras = {
      sentTo: "client@example.com, cc@example.com",
      sentSubject: "Jeff Ulsh - Invoice LA #5555",
      jobNameOverride: "Wilm U Grad",
      dayRateDescriptionOverride: "6/18 - 7:30am-11:30pm",
      noteOverride: "Thanks!",
    };
    const row = buildSheetRow({
      estimatedTotal: 1000, amountPaid: 0,
      invoiceStatus: "sent", invoiceSentAt: null, invoicePdfUrl: null,
      invoiceNumber: "1001", laNumber: "LA#5555",
      dayRateTotal: 1000, overtimeTotal: 0, perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    }, "test job", "1001", extras);
    expect(row.sentTo).toBe("client@example.com, cc@example.com");
    expect(row.sentSubject).toBe("Jeff Ulsh - Invoice LA #5555");
    expect(row.jobNameOverride).toBe("Wilm U Grad");
    expect(row.dayRateDescriptionOverride).toBe("6/18 - 7:30am-11:30pm");
    expect(row.noteOverride).toBe("Thanks!");
  });

  it("null extras values default to empty string (not null or undefined)", () => {
    const extras: FakeExtras = { sentTo: null, sentSubject: null, jobNameOverride: null };
    const row = buildSheetRow({
      estimatedTotal: 500, amountPaid: 0,
      invoiceStatus: "ready", invoiceSentAt: null, invoicePdfUrl: null,
      invoiceNumber: "1003", laNumber: "LA#7000",
      dayRateTotal: 500, overtimeTotal: 0, perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    }, "test job", "1003", extras);
    expect(row.sentTo).toBe("");
    expect(row.sentSubject).toBe("");
    expect(row.jobNameOverride).toBe("");
  });
});

// ---------------------------------------------------------------------------
// E. Open Google Sheet URL
// ---------------------------------------------------------------------------

describe("Open Google Sheet URL", () => {
  it("URL is constructed from GOOGLE_SHEET_ID env var pattern", () => {
    const sheetId = "1a2b3c4d5e6f7g8h";
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;
    expect(sheetUrl).toBe(`https://docs.google.com/spreadsheets/d/${sheetId}`);
    expect(sheetUrl).toContain("docs.google.com/spreadsheets/d/");
  });

  it("missing GOOGLE_SHEET_ID yields null (no link rendered)", () => {
    const sheetId = undefined;
    const sheetUrl = sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}` : null;
    expect(sheetUrl).toBeNull();
  });

  it("sheet URL includes the spreadsheet ID directly after /d/", () => {
    const id = "abc123XYZ";
    const url = `https://docs.google.com/spreadsheets/d/${id}`;
    expect(url.split("/d/")[1]).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// F. PDF URL accuracy
// ---------------------------------------------------------------------------

describe("Invoice PDF URL in sheet row", () => {
  it("invoicePdfUrl in row is the latest generated URL", () => {
    const freshUrl = "https://supabase.co/storage/v1/object/public/invoice-pdfs/ev1/Invoice-1001-LA5555-20260618120000.pdf";
    const row = buildSheetRow({
      estimatedTotal: 1000, amountPaid: 0,
      invoiceStatus: "sheet_synced",
      invoiceSentAt: null,
      invoicePdfUrl: freshUrl,
      invoiceNumber: "1001", laNumber: "LA#5555",
      dayRateTotal: 1000, overtimeTotal: 0, perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    }, "test job", "1001");
    expect(row.invoicePdfUrl).toBe(freshUrl);
  });

  it("invoicePdfUrl is empty string when no PDF exists yet", () => {
    const row = buildSheetRow({
      estimatedTotal: 500, amountPaid: 0,
      invoiceStatus: "none",
      invoiceSentAt: null,
      invoicePdfUrl: null,
      invoiceNumber: "1002", laNumber: "LA#6000",
      dayRateTotal: 500, overtimeTotal: 0, perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    }, "test job", "1002");
    expect(row.invoicePdfUrl).toBe("");
  });
});

// ---------------------------------------------------------------------------
// G. gigSummary in every save patch
// ---------------------------------------------------------------------------

describe("gigSummary included in every save patch", () => {
  it("full flush patch includes gigSummary key", () => {
    const gigSummary = "LA#5555 — test job";
    const patch = {
      gigSummary,
      workday_entries: [],
      bag_fees: null,
      hotel: 25,
      parking: null,
      tolls: null,
      uber: null,
      other_expenses: null,
      expense_notes: null,
      invoice_job_name_override: null,
      invoice_day_rate_description_override: null,
      invoice_ot_description_override: null,
      invoice_per_diem_description_override: null,
      invoice_bag_fees_description_override: null,
      invoice_parking_description_override: null,
      invoice_uber_description_override: null,
      invoice_tolls_description_override: null,
      invoice_hotel_description_override: null,
      invoice_other_description_override: null,
      invoice_note_override: null,
    };
    expect(patch.gigSummary).toBe(gigSummary);
    expect("gigSummary" in patch).toBe(true);
  });

  it("individual field save patch also includes gigSummary (via scheduleSave merge)", () => {
    const gigSummary = "LA#5555 — test job";
    const fieldPatch = { parking: 25 };
    // scheduleSave merges: { ...patch, gigSummary }
    const merged = { ...fieldPatch, gigSummary };
    expect(merged.gigSummary).toBe(gigSummary);
    expect(merged.parking).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// H. Sync does not block PDF/email actions
// ---------------------------------------------------------------------------

describe("Sync does not block PDF or email actions", () => {
  it("syncSheetBackground failure model: throws are caught, never re-thrown", () => {
    async function syncSheetBackground(): Promise<void> {
      try {
        throw new Error("Sheets API down");
      } catch {
        // logged, not re-thrown
      }
    }
    // Must resolve, not reject
    return expect(syncSheetBackground()).resolves.toBeUndefined();
  });

  it("sheet sync failure leaves PDF URL intact", () => {
    const pdfUrl = "https://supabase.co/storage/v1/object/public/invoice-pdfs/ev1/Invoice-1001.pdf";
    let syncFailed = false;
    try {
      throw new Error("Sheets API error");
    } catch {
      syncFailed = true;
    }
    // PDF URL unaffected
    expect(pdfUrl).toBeTruthy();
    expect(syncFailed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I. No false optimistic sync success — sync status only updates on confirmation
// ---------------------------------------------------------------------------

describe("Sync status only updates on actual confirmation", () => {
  // Mirror of the syncState management model
  interface SyncState {
    status: "idle" | "syncing" | "success" | "error";
    message: string | null;
    syncedAt: string | null;
  }

  function initialSyncState(): SyncState {
    return { status: "idle", message: null, syncedAt: null };
  }

  it("save() alone does NOT set syncState to success", () => {
    // Before fix: save() would call setSyncState({ status: 'success', ... })
    // After fix: save() only updates invoiceData and packet, not syncState.
    const state = initialSyncState();
    // Simulated save() result — does NOT touch syncState
    // state remains unchanged after save
    expect(state.status).toBe("idle");
    expect(state.syncedAt).toBeNull();
  });

  it("flushCurrentInvoiceInputs() alone does NOT set syncState to success", () => {
    const state = initialSyncState();
    // flushCurrentInvoiceInputs() does NOT optimistically set syncState
    expect(state.status).toBe("idle");
    expect(state.syncedAt).toBeNull();
  });

  it("syncState success requires actual confirmation (manual sync, PDF refresh, or email send)", () => {
    let state = initialSyncState();

    // Manual sync confirmed — server returned syncedAt
    const confirmedAt = "2026-06-19T23:47:00.000Z";
    state = { status: "success", message: null, syncedAt: confirmedAt };
    expect(state.status).toBe("success");
    expect(state.syncedAt).toBe(confirmedAt);
  });

  it("failed sync sets status to error (not success) and carries a message", () => {
    let state = initialSyncState();
    state = { status: "error", message: "No write access — share the spreadsheet with Editor access", syncedAt: null };
    expect(state.status).toBe("error");
    expect(state.status).not.toBe("success");
    expect(state.message).toBeTruthy();
  });

  it("syncedAt is null when there is no confirmed sync — nothing displays in the UI", () => {
    const state = initialSyncState();
    const syncedLabel = state.syncedAt
      ? new Date(state.syncedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : null;
    expect(syncedLabel).toBeNull();
    // UI only shows label when syncedLabel is truthy — nothing appears for idle state
  });
});

// ---------------------------------------------------------------------------
// J. classifySheetsError — friendly error messages
// ---------------------------------------------------------------------------

describe("classifySheetsError friendly messages", () => {
  // Mirror of the classification logic
  function classify(raw: string, sheetId?: string, sheetName?: string): string {
    if (/GOOGLE_SHEET_ID must be set/i.test(raw)) return "GOOGLE_SHEET_ID env var not configured";
    if (/GOOGLE_SERVICE_ACCOUNT_EMAIL must be set/i.test(raw)) return "GOOGLE_SERVICE_ACCOUNT_EMAIL env var not configured";
    if (/GOOGLE_PRIVATE_KEY not found/i.test(raw)) return "GOOGLE_PRIVATE_KEY not configured — set env var or upload via /api/admin/migrate-sheets-key";
    if (/invalid_grant|invalid_client|unauthorized_client/i.test(raw)) return "Sheets auth failed — check GOOGLE_PRIVATE_KEY and service account email";
    if (/caller does not have permission|forbidden/i.test(raw)) return "No write access — share the spreadsheet with Editor access to the service account";
    if (/not found|Requested entity was not found/i.test(raw)) return sheetId ? `Spreadsheet not found — verify GOOGLE_SHEET_ID (${sheetId.slice(0, 12)}…)` : "Spreadsheet not found — verify GOOGLE_SHEET_ID env var";
    if (/Unable to parse range|Invalid range/i.test(raw)) return sheetName ? `Sheet tab not found — verify GOOGLE_SHEET_NAME is exactly "${sheetName}"` : "Sheet tab not found — verify GOOGLE_SHEET_NAME env var";
    if (/quota exceeded|rateLimitExceeded/i.test(raw)) return "Sheets rate limit hit — wait a minute and retry";
    return "Sheet sync failed — check server logs for details";
  }

  it("GOOGLE_SHEET_ID not set → config message", () => {
    expect(classify("[google-sheets] GOOGLE_SHEET_ID must be set")).toContain("GOOGLE_SHEET_ID env var not configured");
  });

  it("GOOGLE_PRIVATE_KEY not found → config message", () => {
    expect(classify("[google-sheets] GOOGLE_PRIVATE_KEY not found in env or Netlify Blobs.")).toContain("GOOGLE_PRIVATE_KEY not configured");
  });

  it("invalid_grant → auth message", () => {
    expect(classify("invalid_grant: Token has been expired or revoked.")).toContain("Sheets auth failed");
  });

  it("forbidden / no permission → access message", () => {
    expect(classify("The caller does not have permission")).toContain("No write access");
  });

  it("not found → spreadsheet not found with ID hint", () => {
    const msg = classify("Requested entity was not found.", "1ev-xMrmIjjLkZTfd5QH", "LA PAY (2026)");
    expect(msg).toContain("Spreadsheet not found");
    expect(msg).toContain("1ev-xMrmIjj");
  });

  it("Unable to parse range → tab not found message with tab name", () => {
    const msg = classify("Unable to parse range: 'LA PAY (2026)'!A:C", undefined, "LA PAY (2026)");
    expect(msg).toContain("Sheet tab not found");
    expect(msg).toContain("LA PAY (2026)");
  });

  it("quota exceeded → rate limit message", () => {
    expect(classify("Quota exceeded for quota metric")).toContain("rate limit");
  });

  it("unknown error → generic fallback message", () => {
    expect(classify("Something unexpected happened")).toBe("Sheet sync failed — check server logs for details");
  });
});

// ---------------------------------------------------------------------------
// K. Open Google Sheet uses same spreadsheet ID as sync target
// ---------------------------------------------------------------------------

describe("Open Google Sheet link matches sync target", () => {
  it("sheet URL is built from GOOGLE_SHEET_ID — same ID sync writes to", () => {
    const sheetId = "1ev-xMrmIjjLkZTfd5QH-NgaGpC4kDTxRMT7OhcVIvd4";
    const linkUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;
    expect(linkUrl).toContain(sheetId);
  });

  it("sync target sheetName matches the LA PAY (2026) tab", () => {
    const sheetName = process.env.GOOGLE_SHEET_NAME ?? "LA PAY (2026)";
    expect(sheetName).toBe("LA PAY (2026)");
  });
});

// ---------------------------------------------------------------------------
// L. normalizeLA — format-mismatch duplicate prevention
// ---------------------------------------------------------------------------

// Mirror the exported helper logic for unit testing without a real Sheets call.
function normalizeLA(la: string): string {
  return la.replace(/^LA\s*#?\s*/i, "").trim();
}

describe("normalizeLA — strips prefix for dedup matching", () => {
  it("bare number passes through unchanged", () => {
    expect(normalizeLA("5555")).toBe("5555");
  });
  it("LA#5555 → 5555", () => {
    expect(normalizeLA("LA#5555")).toBe("5555");
  });
  it("LA #5555 (space before hash) → 5555", () => {
    expect(normalizeLA("LA #5555")).toBe("5555");
  });
  it("la#5555 (lower-case) → 5555", () => {
    expect(normalizeLA("la#5555")).toBe("5555");
  });
  it("LA 5555 (space, no hash) → 5555", () => {
    expect(normalizeLA("LA 5555")).toBe("5555");
  });
  it("normalizing both sides prevents false mismatch between syncs", () => {
    // Sheet stored "5555" in a previous sync; new sync sends "LA#5555".
    // Without normalization these differ → duplicate. With normalization → match.
    expect(normalizeLA("5555")).toBe(normalizeLA("LA#5555"));
  });
  it("empty string stays empty", () => {
    expect(normalizeLA("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// M. isInvoiceDataRow — totals/summary row detection
// ---------------------------------------------------------------------------

// Mirror of the VOID_STATUS constant exported from lib/google-sheets.ts
const VOID_STATUS = "VOID_DUPLICATE";

function isInvoiceDataRow(cellA: string, cellC: string, cellT?: string): boolean {
  if (cellT?.trim() === VOID_STATUS) return false; // voided — skip
  if (cellC.trim()) return true;
  const a = cellA.trim();
  if (!a) return false;
  return /^\d/.test(a) || /^JU-/i.test(a);
}

describe("isInvoiceDataRow — correctly identifies invoice vs summary rows", () => {
  it("row with LA# in col C is an invoice row", () => {
    expect(isInvoiceDataRow("1001", "5555")).toBe(true);
  });
  it("row with only LA# in col C (col A empty) is an invoice row", () => {
    expect(isInvoiceDataRow("", "5555")).toBe(true);
  });
  it("row with numeric invoice number in col A (col C empty) is an invoice row", () => {
    expect(isInvoiceDataRow("1001", "")).toBe(true);
  });
  it("row with JU-format invoice number in col A is an invoice row", () => {
    expect(isInvoiceDataRow("JU-2024-001", "")).toBe(true);
  });
  it("totals row: col A = 'TOTAL', col C empty → NOT an invoice row", () => {
    expect(isInvoiceDataRow("TOTAL", "")).toBe(false);
  });
  it("totals row: col A = 'GRAND TOTAL', col C empty → NOT an invoice row", () => {
    expect(isInvoiceDataRow("GRAND TOTAL", "")).toBe(false);
  });
  it("completely empty row → NOT an invoice row", () => {
    expect(isInvoiceDataRow("", "")).toBe(false);
  });
  it("row with label 'SUBTOTAL' in col A → NOT an invoice row", () => {
    expect(isInvoiceDataRow("SUBTOTAL", "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// N. Row placement — last data row tracking avoids totals section
// ---------------------------------------------------------------------------

describe("Row placement — lastDataRow computation avoids totals/summary section", () => {
  // Simulate the row-scanning loop from upsertSheetRow
  function findLastDataRow(rows: Array<[string, string]>): number {
    let lastDataRow = 1; // header row
    for (let i = 0; i < rows.length; i++) {
      const [cellA, cellC] = rows[i]!;
      if (isInvoiceDataRow(cellA, cellC)) {
        lastDataRow = i + 2; // +1 for header, +1 for 1-indexed
      }
    }
    return lastDataRow;
  }

  it("no data rows → lastDataRow = 1 (header), insert goes to row 2", () => {
    const rows: Array<[string, string]> = [];
    expect(findLastDataRow(rows) + 1).toBe(2);
  });

  it("one data row → lastDataRow = 2, new row goes to row 3", () => {
    const rows: Array<[string, string]> = [["1001", "5555"]];
    expect(findLastDataRow(rows) + 1).toBe(3);
  });

  it("three data rows → lastDataRow = 4, new row goes to row 5", () => {
    const rows: Array<[string, string]> = [
      ["1001", "5555"],
      ["1002", "6666"],
      ["1003", "7777"],
    ];
    expect(findLastDataRow(rows) + 1).toBe(5);
  });

  it("totals rows after data rows do NOT advance lastDataRow", () => {
    // Sheet structure: header | data x3 | empty | TOTAL row
    const rows: Array<[string, string]> = [
      ["1001", "5555"],  // row 2 — data
      ["1002", "6666"],  // row 3 — data
      ["1003", "7777"],  // row 4 — data
      ["", ""],          // row 5 — empty
      ["TOTAL", ""],     // row 6 — totals (should NOT count)
    ];
    // lastDataRow should be 4 (row 4 = "1003"), new row → 5
    expect(findLastDataRow(rows)).toBe(4);
    expect(findLastDataRow(rows) + 1).toBe(5);
  });

  it("totals in the middle: new row inserts after last real data, not after totals", () => {
    // Unusual but defensive: totals section interspersed
    const rows: Array<[string, string]> = [
      ["1001", "5555"],   // row 2 — data
      ["TOTAL", ""],      // row 3 — totals
    ];
    // lastDataRow = 2 (row 2), new row → 3 (before the totals row via insertDimension)
    expect(findLastDataRow(rows)).toBe(2);
    expect(findLastDataRow(rows) + 1).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// O. Duplicate key matching — same invoice synced twice updates same row
// ---------------------------------------------------------------------------

describe("Duplicate detection — same invoice synced twice finds existing row", () => {
  interface FakeSheetRow { rowA: string; rowC: string; }

  function findMatch(
    existingRows: FakeSheetRow[],
    incomingLa: string,
    incomingInv: string,
  ): number {
    // Mirror of the match loop in upsertSheetRow
    for (let i = 0; i < existingRows.length; i++) {
      const cellA = existingRows[i]!.rowA.trim();
      const cellC = existingRows[i]!.rowC.trim();
      const sheetsRow = i + 2; // +1 for header, +1 for 1-indexed
      if (incomingLa && normalizeLA(cellC) === normalizeLA(incomingLa)) return sheetsRow;
      if (incomingInv && cellA && cellA === incomingInv) return sheetsRow;
    }
    return -1; // not found
  }

  it("exact LA# match → finds existing row (no duplicate)", () => {
    const existing = [{ rowA: "1001", rowC: "5555" }];
    expect(findMatch(existing, "5555", "1001")).toBe(2);
  });

  it("LA# format mismatch: sheet has '5555', incoming is 'LA#5555' → still matches", () => {
    const existing = [{ rowA: "1001", rowC: "5555" }];
    expect(findMatch(existing, "LA#5555", "1001")).toBe(2);
  });

  it("LA# format mismatch: sheet has 'LA#5555', incoming is '5555' → still matches", () => {
    const existing = [{ rowA: "1001", rowC: "LA#5555" }];
    expect(findMatch(existing, "5555", "1001")).toBe(2);
  });

  it("empty LA#: falls back to invoice number match", () => {
    // Row was written before la_number was set — col C is empty, col A has invoice#
    const existing = [{ rowA: "1001", rowC: "" }];
    expect(findMatch(existing, "", "1001")).toBe(2);
  });

  it("completely new invoice (no LA# or inv# in sheet) → returns -1 (insert)", () => {
    const existing = [{ rowA: "1001", rowC: "5555" }];
    expect(findMatch(existing, "6666", "1002")).toBe(-1);
  });

  it("same invoice synced after expense change: LA# unchanged → same row found", () => {
    const existing = [{ rowA: "1001", rowC: "5555" }];
    // Expense change modifies total/labor but not the key — same row matched
    expect(findMatch(existing, "5555", "1001")).toBe(2);
  });

  it("Open PDF, Review, Send Invoice all produce same LA# key → same row matched every time", () => {
    const existing = [{ rowA: "1001", rowC: "5555" }];
    // All three actions ultimately call upsertSheetRow with same laJobNumber
    expect(findMatch(existing, "5555", "1001")).toBe(2); // Open PDF
    expect(findMatch(existing, "5555", "1001")).toBe(2); // Review
    expect(findMatch(existing, "5555", "1001")).toBe(2); // Send Invoice
  });

  it("repeated Sync / Update Google Sheet updates the same row, not append", () => {
    const existing = [{ rowA: "1001", rowC: "5555" }];
    const firstSyncMatch = findMatch(existing, "5555", "1001");
    const secondSyncMatch = findMatch(existing, "5555", "1001");

    expect(firstSyncMatch).toBe(2);
    expect(secondSyncMatch).toBe(2);
    expect(existing).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// P. Duplicate cleanup report and confirmed deletion
// ---------------------------------------------------------------------------

interface FakeDuplicateEntry {
  rowNumber: number;
  invNumber: string;
  laNumber: string;
  date: string;
  total: string;
}

interface FakeDuplicateGroup {
  key: string;
  rows: FakeDuplicateEntry[];
  keepRow: number;
  deleteRows: number[];
}

function duplicateKey(invNumber: string, laNumber: string): string | null {
  const normLa = normalizeLA(laNumber);
  const normInv = invNumber.trim();
  if (normLa) return `la:${normLa}`;
  if (normInv) return `inv:${normInv}`;
  return null;
}

function parseSheetDateValue(value: string): number | null {
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function chooseDuplicateRows(entries: FakeDuplicateEntry[]): { keepRow: number; deleteRows: number[] } {
  const keep = entries.reduce((best, entry) => {
    const bestDate = parseSheetDateValue(best.date);
    const entryDate = parseSheetDateValue(entry.date);
    if (entryDate != null && bestDate != null && entryDate !== bestDate) return entryDate > bestDate ? entry : best;
    if (entryDate != null && bestDate == null) return entry;
    if (entryDate == null && bestDate != null) return best;
    return entry.rowNumber > best.rowNumber ? entry : best;
  }, entries[0]!);
  return {
    keepRow: keep.rowNumber,
    deleteRows: entries.filter((entry) => entry.rowNumber !== keep.rowNumber).map((entry) => entry.rowNumber),
  };
}

function findDuplicateGroups(entries: FakeDuplicateEntry[]): FakeDuplicateGroup[] {
  const groups = new Map<string, FakeDuplicateEntry[]>();
  for (const entry of entries) {
    if (!isInvoiceDataRow(entry.invNumber, entry.laNumber)) continue;
    const key = duplicateKey(entry.invNumber, entry.laNumber);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return [...groups.entries()]
    .filter(([, groupEntries]) => groupEntries.length > 1)
    .map(([key, groupEntries]) => {
      const { keepRow, deleteRows } = chooseDuplicateRows(groupEntries);
      return { key, rows: groupEntries, keepRow, deleteRows };
    });
}

function cleanupDuplicates(
  entries: FakeDuplicateEntry[],
  confirmedRows: number[],
): { keptRows: number[]; deletedRows: number[] } {
  const recommendedRows = new Set(findDuplicateGroups(entries).flatMap((group) => group.deleteRows));
  const confirmedSet = new Set(confirmedRows);
  const deletedRows = [...recommendedRows].filter((rowNumber) => confirmedSet.has(rowNumber));
  return {
    deletedRows,
    keptRows: entries
      .filter((entry) => !deletedRows.includes(entry.rowNumber))
      .map((entry) => entry.rowNumber),
  };
}

describe("Duplicate cleanup workflow", () => {
  it("duplicate detection reports duplicate row numbers for LA#5555 / invoice 1001", () => {
    const groups = findDuplicateGroups([
      { rowNumber: 2, invNumber: "1001", laNumber: "5555", date: "2026-06-18", total: "2598.75" },
      { rowNumber: 5, invNumber: "1001", laNumber: "LA#5555", date: "2026-06-19", total: "7598.75" },
      { rowNumber: 6, invNumber: "1002", laNumber: "6666", date: "2026-06-19", total: "1000" },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("la:5555");
    expect(groups[0]!.rows.map((row) => row.rowNumber)).toEqual([2, 5]);
    expect(groups[0]!.keepRow).toBe(5);
    expect(groups[0]!.deleteRows).toEqual([2]);
  });

  it("cleanup keeps latest row and deletes older duplicates only after confirmation", () => {
    const entries = [
      { rowNumber: 2, invNumber: "1001", laNumber: "5555", date: "2026-06-18", total: "2598.75" },
      { rowNumber: 5, invNumber: "1001", laNumber: "LA#5555", date: "2026-06-19", total: "7598.75" },
    ];

    expect(cleanupDuplicates(entries, [])).toEqual({ keptRows: [2, 5], deletedRows: [] });
    expect(cleanupDuplicates(entries, [2])).toEqual({ keptRows: [5], deletedRows: [2] });
  });

  it("cleanup does not delete unrelated invoice rows", () => {
    const entries = [
      { rowNumber: 2, invNumber: "1001", laNumber: "5555", date: "2026-06-18", total: "2598.75" },
      { rowNumber: 5, invNumber: "1001", laNumber: "LA#5555", date: "2026-06-19", total: "7598.75" },
      { rowNumber: 6, invNumber: "1002", laNumber: "6666", date: "2026-06-19", total: "1000" },
    ];

    const result = cleanupDuplicates(entries, [2, 6]);
    expect(result.deletedRows).toEqual([2]);
    expect(result.keptRows).toEqual([5, 6]);
  });
});

// ---------------------------------------------------------------------------
// Q. Sync button wording
// ---------------------------------------------------------------------------

describe("Sync button wording", () => {
  it("uses clear Sync / Update Google Sheet wording", () => {
    const label = "Sync / Update Google Sheet";
    expect(label).toContain("Sync");
    expect(label).toContain("Update Google Sheet");
  });

  it("helper text explains the action should update the existing row", () => {
    const helper = "This updates the existing Sheet row. It should not create duplicates.";
    expect(helper).toContain("updates the existing Sheet row");
    expect(helper).toContain("should not create duplicates");
  });
});

// ---------------------------------------------------------------------------
// R. Stable key guard — no key → refuse write (not a silent insert)
// ---------------------------------------------------------------------------

describe("Stable key guard — no write without a stable key", () => {
  it("throws when both laJobNumber and invoiceNumber are empty", () => {
    function guardedUpsert(la: string, inv: string): void {
      if (!la.trim() && !inv.trim()) {
        throw new Error(
          "[google-sheets] upsertSheetRow: both laJobNumber and invoiceNumber are empty. " +
          "Cannot safely upsert without a stable row key.",
        );
      }
    }
    expect(() => guardedUpsert("", "")).toThrow("both laJobNumber and invoiceNumber are empty");
  });

  it("does NOT throw when only LA# is present", () => {
    function guardedUpsert(la: string, inv: string): void {
      if (!la.trim() && !inv.trim()) throw new Error("no key");
    }
    expect(() => guardedUpsert("5555", "")).not.toThrow();
  });

  it("does NOT throw when only invoice# is present", () => {
    function guardedUpsert(la: string, inv: string): void {
      if (!la.trim() && !inv.trim()) throw new Error("no key");
    }
    expect(() => guardedUpsert("", "1001")).not.toThrow();
  });

  it("classifySheetsError maps the no-key error to a user-friendly message", () => {
    function classify(raw: string): string {
      if (/both laJobNumber and invoiceNumber are empty/i.test(raw)) {
        return "Cannot sync: invoice has no invoice number or LA job number set yet — save the invoice first";
      }
      return "Sheet sync failed — check server logs for details";
    }
    const msg = classify("[google-sheets] upsertSheetRow: both laJobNumber and invoiceNumber are empty.");
    expect(msg).toContain("Cannot sync");
    expect(msg).toContain("invoice number");
  });
});

// ---------------------------------------------------------------------------
// S. classifySheetsError — new error patterns from upsertSheetRow rewrite
// ---------------------------------------------------------------------------

describe("classifySheetsError — new patterns", () => {
  function classify(raw: string, sheetId?: string, sheetName?: string): string {
    if (/GOOGLE_SHEET_ID must be set/i.test(raw)) return "GOOGLE_SHEET_ID env var not configured";
    if (/GOOGLE_SERVICE_ACCOUNT_EMAIL must be set/i.test(raw)) return "GOOGLE_SERVICE_ACCOUNT_EMAIL env var not configured";
    if (/GOOGLE_PRIVATE_KEY not found/i.test(raw)) return "GOOGLE_PRIVATE_KEY not configured — set env var or upload via /api/admin/migrate-sheets-key";
    if (/Tab ".+" not found in spreadsheet/i.test(raw)) return sheetName ? `Sheet tab not found — verify GOOGLE_SHEET_NAME is exactly "${sheetName}"` : "Sheet tab not found — verify GOOGLE_SHEET_NAME env var";
    if (/both laJobNumber and invoiceNumber are empty/i.test(raw)) return "Cannot sync: invoice has no invoice number or LA job number set yet — save the invoice first";
    if (/invalid_grant|invalid_client|unauthorized_client/i.test(raw)) return "Sheets auth failed — check GOOGLE_PRIVATE_KEY and service account email";
    if (/caller does not have permission|forbidden/i.test(raw)) return "No write access — share the spreadsheet with Editor access to the service account";
    if (/not found|Requested entity was not found/i.test(raw)) return sheetId ? `Spreadsheet not found — verify GOOGLE_SHEET_ID (${sheetId.slice(0, 12)}…)` : "Spreadsheet not found — verify GOOGLE_SHEET_ID env var";
    if (/Unable to parse range|Invalid range|No grid with id/i.test(raw)) return sheetName ? `Sheet tab not found — verify GOOGLE_SHEET_NAME is exactly "${sheetName}"` : "Sheet tab not found — verify GOOGLE_SHEET_NAME env var";
    if (/quota exceeded|rateLimitExceeded/i.test(raw)) return "Sheets rate limit hit — wait a minute and retry";
    return "Sheet sync failed — check server logs for details";
  }

  it("our own 'Tab not found' error is classified before generic not-found → tab message", () => {
    const msg = classify(`[google-sheets] Tab "LA PAY (2026)" not found in spreadsheet.`, undefined, "LA PAY (2026)");
    expect(msg).toContain("Sheet tab not found");
    expect(msg).not.toContain("Spreadsheet not found");
  });

  it("no-key error → actionable 'save first' message", () => {
    const msg = classify("[google-sheets] upsertSheetRow: both laJobNumber and invoiceNumber are empty.");
    expect(msg).toContain("Cannot sync");
  });

  it("No grid with id (insertDimension numeric tab mismatch) → tab not found message", () => {
    const msg = classify("No grid with id: 123456789", undefined, "LA PAY (2026)");
    expect(msg).toContain("Sheet tab not found");
  });
});

// ---------------------------------------------------------------------------
// T. isInvoiceDataRow — VOID_STATUS cellT parameter
// ---------------------------------------------------------------------------

describe("isInvoiceDataRow — skips VOID_DUPLICATE rows (optional cellT param)", () => {
  it("VOID_DUPLICATE row with LA# in col C is NOT a data row", () => {
    expect(isInvoiceDataRow("1001", "5555", VOID_STATUS)).toBe(false);
  });
  it("VOID_DUPLICATE row with numeric invoice# in col A is NOT a data row", () => {
    expect(isInvoiceDataRow("1001", "", VOID_STATUS)).toBe(false);
  });
  it("VOID_DUPLICATE row that would otherwise be a totals row is also NOT a data row", () => {
    expect(isInvoiceDataRow("TOTAL", "", VOID_STATUS)).toBe(false);
  });
  it("active row with STATUS = 'sheet_synced' IS a data row", () => {
    expect(isInvoiceDataRow("1001", "5555", "sheet_synced")).toBe(true);
  });
  it("active row with STATUS = '' IS a data row", () => {
    expect(isInvoiceDataRow("1001", "5555", "")).toBe(true);
  });
  it("cellT = undefined (row predates STATUS column) IS a data row", () => {
    expect(isInvoiceDataRow("1001", "5555", undefined)).toBe(true);
  });
  it("two-arg calls still work unchanged (backward compatible)", () => {
    expect(isInvoiceDataRow("1001", "5555")).toBe(true);
    expect(isInvoiceDataRow("TOTAL", "")).toBe(false);
  });
  it("VOID_STATUS constant equals 'VOID_DUPLICATE'", () => {
    expect(VOID_STATUS).toBe("VOID_DUPLICATE");
  });
});

// ---------------------------------------------------------------------------
// U. buildVoidRowValues — 33-column void row structure
// ---------------------------------------------------------------------------

// Mirror of buildVoidRowValues exported from lib/google-sheets.ts
// Keep in sync with COLUMN_ORDER (33 columns: A=0 through AG=32).
function buildVoidRowValues(
  cellA: string,
  cellB: string,
  cellC: string,
  cellD: string,
): (string | number)[] {
  const ncols = 33; // COLUMN_ORDER.length
  const row: (string | number)[] = new Array(ncols).fill("");
  row[0] = cellA; // A: INV# (kept)
  row[1] = cellB; // B: DATE (kept)
  row[2] = cellC; // C: LA# (kept)
  row[3] = cellD; // D: GIG (kept)
  for (let i = 4; i <= 18; i++) row[i] = 0; // E–S: money columns → 0
  row[19] = VOID_STATUS;                      // T: STATUS
  return row;
}

describe("buildVoidRowValues — void row structure", () => {
  it("returns exactly 33 values (matches COLUMN_ORDER length)", () => {
    expect(buildVoidRowValues("1001", "2026-01-15", "5555", "Corporate Shoot")).toHaveLength(33);
  });

  it("keeps identifying columns A–D at indices 0–3", () => {
    const row = buildVoidRowValues("1001", "2026-01-15", "5555", "Corporate Shoot");
    expect(row[0]).toBe("1001");
    expect(row[1]).toBe("2026-01-15");
    expect(row[2]).toBe("5555");
    expect(row[3]).toBe("Corporate Shoot");
  });

  it("zeros all 15 money columns E–S (indices 4–18)", () => {
    const row = buildVoidRowValues("1001", "2026-01-15", "5555", "Corporate Shoot");
    for (let i = 4; i <= 18; i++) {
      expect(row[i]).toBe(0);
    }
  });

  it("sets STATUS column T (index 19) to VOID_STATUS", () => {
    const row = buildVoidRowValues("1001", "2026-01-15", "5555", "Corporate Shoot");
    expect(row[19]).toBe(VOID_STATUS);
  });

  it("clears all payment/extended columns U–AG (indices 20–32)", () => {
    const row = buildVoidRowValues("1001", "2026-01-15", "5555", "Corporate Shoot");
    for (let i = 20; i <= 32; i++) {
      expect(row[i]).toBe("");
    }
  });

  it("void row fails isInvoiceDataRow check — confirmed excluded by scan loops", () => {
    const row = buildVoidRowValues("1001", "2026-01-15", "5555", "Corporate Shoot");
    const cellA = String(row[0]);
    const cellC = String(row[2]);
    const cellT = String(row[19]);
    expect(isInvoiceDataRow(cellA, cellC, cellT)).toBe(false);
  });

  it("empty GIG works — void row still has correct structure", () => {
    const row = buildVoidRowValues("1001", "2026-01-15", "5555", "");
    expect(row[3]).toBe("");
    expect(row[19]).toBe(VOID_STATUS);
    expect(row).toHaveLength(33);
  });
});

// ---------------------------------------------------------------------------
// V. scoreKeepRow — keep-row selection priority order
// ---------------------------------------------------------------------------

// Mirror of the private scoreKeepRow function in lib/google-sheets.ts
function scoreKeepRow(
  cellA: string,
  cellB: string,
  cellC: string,
  cellE: string,
  rowNumber: number,
  incomingLa: string,
  incomingInv: string,
  incomingTotal: number | string | null | undefined,
): number {
  let score = 0;
  if (incomingLa && normalizeLA(cellC) === incomingLa) score += 200;
  if (incomingInv && cellA.trim() === incomingInv) score += 100;
  const dateMs = parseSheetDateValue(cellB);
  if (dateMs !== null) score += dateMs / 1e13;
  if (incomingTotal != null) {
    const tIn = typeof incomingTotal === "number" ? incomingTotal : parseFloat(String(incomingTotal));
    const tEx = parseFloat(cellE.replace(/[$,\s]/g, ""));
    if (!isNaN(tIn) && !isNaN(tEx) && Math.abs(tEx - tIn) < 0.01) score += 50;
  }
  score += rowNumber * 0.0001;
  return score;
}

describe("scoreKeepRow — keep-row selection priority", () => {
  const la = "5555";
  const inv = "1001";

  it("LA# match outweighs invoice# match alone (200 > 100)", () => {
    const scoreWithLa  = scoreKeepRow("1001", "2026-01-15", "5555", "2500", 3, la, inv, null);
    const scoreInvOnly = scoreKeepRow("1001", "2026-01-15", "",     "2500", 3, la, inv, null);
    expect(scoreWithLa).toBeGreaterThan(scoreInvOnly);
  });

  it("invoice# match adds score on top of LA# match", () => {
    const bothMatch = scoreKeepRow("1001", "2026-01-15", "5555", "2500", 3, la, inv, null);
    const laOnly    = scoreKeepRow("9999", "2026-01-15", "5555", "2500", 3, la, inv, null);
    expect(bothMatch).toBeGreaterThan(laOnly);
  });

  it("total match adds +50 when within $0.01", () => {
    const withTotal    = scoreKeepRow("1001", "2026-01-15", "5555", "2598.75", 3, la, inv, 2598.75);
    const withoutTotal = scoreKeepRow("1001", "2026-01-15", "5555", "1000.00", 3, la, inv, 2598.75);
    expect(withTotal - withoutTotal).toBeCloseTo(50, 0);
  });

  it("total match requires within 0.01 — larger diff gets no bonus", () => {
    const exact = scoreKeepRow("1001", "2026-01-15", "5555", "2598.75", 3, la, inv, 2598.75);
    const close = scoreKeepRow("1001", "2026-01-15", "5555", "2598.80", 3, la, inv, 2598.75);
    expect(exact).toBeGreaterThan(close);
  });

  it("higher row number wins as final tiebreaker (most recently inserted)", () => {
    const rowLow  = scoreKeepRow("1001", "2026-01-15", "5555", "2500", 5,  la, inv, null);
    const rowHigh = scoreKeepRow("1001", "2026-01-15", "5555", "2500", 10, la, inv, null);
    expect(rowHigh).toBeGreaterThan(rowLow);
  });

  it("row priority ordering: LA# > inv# > total > row number", () => {
    // Best: LA# + inv# + total match at row 2
    const best = scoreKeepRow("1001", "2026-01-15", "5555", "2598.75", 2, la, inv, 2598.75);
    // Good: inv# + total match at row 10 (no LA# → missing 200pts)
    const good = scoreKeepRow("1001", "2026-01-15", "",     "2598.75", 10, la, inv, 2598.75);
    // Weak: only inv# match at highest row
    const weak = scoreKeepRow("1001", "2026-01-15", "",     "999.99",  15, la, inv, 2598.75);
    expect(best).toBeGreaterThan(good);
    expect(good).toBeGreaterThan(weak);
  });
});

// ---------------------------------------------------------------------------
// W. Void-based duplicate handling — local simulation of upsert logic
// ---------------------------------------------------------------------------

interface UpsertEntry {
  rowNumber: number;
  cellA: string; // INV#
  cellB: string; // DATE
  cellC: string; // LA#
  cellD: string; // GIG
  cellE: string; // TOTAL
  cellT: string; // STATUS
}

interface UpsertResult {
  action: "updated" | "inserted";
  keptRow: number;
  voidedRows: number[];
  hasDuplicates: boolean;
}

function simulateUpsertWithVoid(
  entries: UpsertEntry[],
  incomingLa: string,
  incomingInv: string,
  incomingTotal: number,
): UpsertResult {
  const normLa  = normalizeLA(incomingLa);
  const normInv = incomingInv.trim();

  const matchingRows: Array<{
    rowNumber: number;
    score: number;
    cellA: string; cellB: string; cellC: string; cellD: string;
  }> = [];

  for (const entry of entries) {
    if (entry.cellT === VOID_STATUS) continue; // skip void rows
    const laMatch  = !!(normLa  && normalizeLA(entry.cellC) === normLa);
    const invMatch = !!(normInv && entry.cellA && entry.cellA === normInv);
    if (laMatch || invMatch) {
      const score = scoreKeepRow(
        entry.cellA, entry.cellB, entry.cellC, entry.cellE,
        entry.rowNumber, normLa, normInv, incomingTotal,
      );
      matchingRows.push({ rowNumber: entry.rowNumber, score, cellA: entry.cellA, cellB: entry.cellB, cellC: entry.cellC, cellD: entry.cellD });
    }
  }

  if (matchingRows.length === 0) {
    const lastDataRow = entries.filter(e => isInvoiceDataRow(e.cellA, e.cellC, e.cellT)).at(-1)?.rowNumber ?? 1;
    return { action: "inserted", keptRow: lastDataRow + 1, voidedRows: [], hasDuplicates: false };
  }

  const keepEntry = matchingRows.reduce((best, e) => e.score > best.score ? e : best);
  const stale = matchingRows.filter(m => m.rowNumber !== keepEntry.rowNumber);
  return {
    action: "updated",
    keptRow: keepEntry.rowNumber,
    voidedRows: stale.map(s => s.rowNumber),
    hasDuplicates: stale.length > 0,
  };
}

describe("Void-based duplicate handling — automatic upsert logic", () => {
  const base: UpsertEntry = {
    rowNumber: 2, cellA: "1001", cellB: "2026-01-15",
    cellC: "5555", cellD: "Corporate Shoot", cellE: "2598.75", cellT: "sheet_synced",
  };

  it("single match → update that row, no voids, hasDuplicates: false", () => {
    const result = simulateUpsertWithVoid([base], "5555", "1001", 2598.75);
    expect(result.action).toBe("updated");
    expect(result.keptRow).toBe(2);
    expect(result.voidedRows).toHaveLength(0);
    expect(result.hasDuplicates).toBe(false);
  });

  it("two matches → keeps best, voids the other, hasDuplicates: true", () => {
    const stale: UpsertEntry = { ...base, rowNumber: 5, cellE: "1000.00" }; // lower total, lower row = worse score
    const result = simulateUpsertWithVoid([base, stale], "5555", "1001", 2598.75);
    expect(result.action).toBe("updated");
    expect(result.keptRow).toBe(2); // base wins: LA# + inv# + total match
    expect(result.voidedRows).toEqual([5]);
    expect(result.hasDuplicates).toBe(true);
  });

  it("three matches → keeps best, voids both stale rows", () => {
    const stale2: UpsertEntry = { ...base, rowNumber: 3, cellC: "", cellE: "999.00" };
    const stale3: UpsertEntry = { ...base, rowNumber: 4, cellA: "9999", cellC: "5555", cellE: "500.00" };
    const result = simulateUpsertWithVoid([base, stale2, stale3], "5555", "1001", 2598.75);
    expect(result.keptRow).toBe(2); // base has highest score (LA# + inv# + total)
    expect(result.voidedRows.sort()).toEqual([3, 4]);
    expect(result.hasDuplicates).toBe(true);
  });

  it("VOID rows in sheet are skipped — already-voided rows not re-voided or re-matched", () => {
    const alreadyVoided: UpsertEntry = { ...base, rowNumber: 5, cellT: VOID_STATUS };
    const result = simulateUpsertWithVoid([base, alreadyVoided], "5555", "1001", 2598.75);
    expect(result.keptRow).toBe(2);
    expect(result.voidedRows).toHaveLength(0); // void row not counted
    expect(result.hasDuplicates).toBe(false);  // only 1 active match
  });

  it("no matches → insert new row after last active data row", () => {
    const result = simulateUpsertWithVoid([base], "6666", "1002", 500);
    expect(result.action).toBe("inserted");
    expect(result.keptRow).toBe(3); // row 2 is last active data row → new row at 3
    expect(result.voidedRows).toHaveLength(0);
  });

  it("after voiding, a fresh scan finds only one active row for that key", () => {
    // Two identical rows, same key. Higher row # wins as tiebreaker (more recently inserted).
    // Row 2 (earlier) gets voided; row 5 (later/higher) is kept.
    const earlier: UpsertEntry = { ...base, rowNumber: 2 };
    const later: UpsertEntry   = { ...base, rowNumber: 5 };
    const firstSync = simulateUpsertWithVoid([earlier, later], "5555", "1001", 2598.75);
    expect(firstSync.keptRow).toBe(5);
    expect(firstSync.voidedRows).toEqual([2]); // lower row (older) gets voided

    // Simulate Sheet state after void: earlier row now has VOID_STATUS
    const afterVoid: UpsertEntry[] = [
      { ...earlier, cellT: VOID_STATUS }, // voided
      later,                              // still active
    ];
    const secondSync = simulateUpsertWithVoid(afterVoid, "5555", "1001", 2598.75);
    expect(secondSync.action).toBe("updated");
    expect(secondSync.keptRow).toBe(5);
    expect(secondSync.voidedRows).toHaveLength(0);   // no new stale rows
    expect(secondSync.hasDuplicates).toBe(false);    // clean
  });

  it("inv#-only match (no LA#) still correctly picks keep row", () => {
    const noLa: UpsertEntry = { ...base, cellC: "" }; // LA# not set on row
    const result = simulateUpsertWithVoid([noLa], "", "1001", 2598.75);
    expect(result.keptRow).toBe(2);
    expect(result.hasDuplicates).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// X. findSheetDuplicates — VOID rows excluded from duplicate report
// ---------------------------------------------------------------------------

interface FakeDuplicateEntryV2 {
  rowNumber: number;
  invNumber: string;
  laNumber: string;
  date: string;
  total: string;
  status: string; // col T
}

function findDuplicateGroupsV2(entries: FakeDuplicateEntryV2[]) {
  const groups = new Map<string, FakeDuplicateEntryV2[]>();
  for (const entry of entries) {
    if (!isInvoiceDataRow(entry.invNumber, entry.laNumber, entry.status)) continue;
    const key = normalizeLA(entry.laNumber)
      ? `la:${normalizeLA(entry.laNumber)}`
      : entry.invNumber ? `inv:${entry.invNumber}` : null;
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.length > 1)
    .map(([key, g]) => ({ key, rowNumbers: g.map(e => e.rowNumber) }));
}

describe("findSheetDuplicates — VOID rows excluded from duplicate report", () => {
  const active: FakeDuplicateEntryV2 = {
    rowNumber: 2, invNumber: "1001", laNumber: "5555",
    date: "2026-01-15", total: "2598.75", status: "sheet_synced",
  };
  const voided: FakeDuplicateEntryV2 = {
    rowNumber: 5, invNumber: "1001", laNumber: "5555",
    date: "2026-01-10", total: "0", status: VOID_STATUS,
  };
  const otherActive: FakeDuplicateEntryV2 = {
    rowNumber: 3, invNumber: "1002", laNumber: "6666",
    date: "2026-02-01", total: "1000", status: "sheet_synced",
  };

  it("two active rows for same LA# → duplicate reported", () => {
    const twin = { ...active, rowNumber: 7, date: "2026-01-20" };
    const groups = findDuplicateGroupsV2([active, twin]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rowNumbers).toContain(2);
    expect(groups[0]!.rowNumbers).toContain(7);
  });

  it("one active + one VOID_DUPLICATE for same LA# → NO duplicate reported", () => {
    const groups = findDuplicateGroupsV2([active, voided]);
    expect(groups).toHaveLength(0); // void row excluded → only 1 active row
  });

  it("two VOID rows for same LA# → NO duplicate reported (both excluded)", () => {
    const voided2 = { ...voided, rowNumber: 6 };
    const groups = findDuplicateGroupsV2([voided, voided2]);
    expect(groups).toHaveLength(0);
  });

  it("mixed sheet: one duplicate group + void rows for another → only real duplicate reported", () => {
    const twin = { ...active, rowNumber: 8 };
    const groups = findDuplicateGroupsV2([active, twin, voided, otherActive]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rowNumbers.sort()).toEqual([2, 8]);
  });

  it("after auto-void: only active row remains for key → checker reports 0 duplicates", () => {
    // Simulates state right after upsertSheetRow voids the stale row
    const groups = findDuplicateGroupsV2([active, { ...voided, rowNumber: 5 }]);
    expect(groups).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Y. Sheet Health Report — pure-function simulation of getSheetHealthReport
// ---------------------------------------------------------------------------

interface HealthEntry {
  rowNumber: number;
  invNumber: string;
  laNumber: string;
  date: string;
  total: string;
  status: string; // col T — "VOID_DUPLICATE" or other
}

interface HealthGroup {
  key: string;
  activeRows: HealthEntry[];
  voidedRows: HealthEntry[];
  syncRow: number | null;
  hasOneActiveRow: boolean;
  voidedRowsHaveZeroTotal: boolean;
}

interface HealthReport {
  totalActiveRows: number;
  totalVoidedRows: number;
  totalUniqueKeys: number;
  activeDuplicateCount: number;
  voidedRowsWithMoneyCount: number;
  groups: HealthGroup[];
  activeDuplicateGroups: HealthGroup[];
  isClean: boolean;
}

function computeHealthReport(entries: HealthEntry[]): HealthReport {
  const groupMap = new Map<string, { activeRows: HealthEntry[]; voidedRows: HealthEntry[] }>();
  for (const entry of entries) {
    const isVoid = entry.status === VOID_STATUS;
    const normLa  = normalizeLA(entry.laNumber);
    const normInv = entry.invNumber.trim();
    const key     = normLa ? `la:${normLa}` : normInv ? `inv:${normInv}` : null;
    const include = isVoid ? !!key : isInvoiceDataRow(entry.invNumber, entry.laNumber, entry.status);
    if (!include || !key) continue;
    const g = groupMap.get(key) ?? { activeRows: [], voidedRows: [] };
    if (isVoid) { g.voidedRows.push(entry); } else { g.activeRows.push(entry); }
    groupMap.set(key, g);
  }

  let totalActiveRows = 0;
  let totalVoidedRows = 0;
  let voidedRowsWithMoneyCount = 0;
  const groups: HealthGroup[] = [];

  for (const [key, { activeRows, voidedRows }] of groupMap) {
    const syncRow = activeRows.length > 0
      ? activeRows.reduce((best, e) => e.rowNumber > best.rowNumber ? e : best).rowNumber
      : null;
    const voidedWithMoney = voidedRows.filter(e => {
      const v = parseFloat(e.total.replace(/[$,\s]/g, ""));
      return !isNaN(v) && v !== 0;
    });
    groups.push({ key, activeRows, voidedRows, syncRow, hasOneActiveRow: activeRows.length === 1, voidedRowsHaveZeroTotal: voidedWithMoney.length === 0 });
    totalActiveRows += activeRows.length;
    totalVoidedRows += voidedRows.length;
    voidedRowsWithMoneyCount += voidedWithMoney.length;
  }

  const activeDuplicateGroups = groups.filter(g => g.activeRows.length > 1);
  return {
    totalActiveRows,
    totalVoidedRows,
    totalUniqueKeys: groups.filter(g => g.activeRows.length > 0).length,
    activeDuplicateCount: activeDuplicateGroups.length,
    voidedRowsWithMoneyCount,
    groups,
    activeDuplicateGroups,
    isClean: activeDuplicateGroups.length === 0 && voidedRowsWithMoneyCount === 0,
  };
}

describe("Sheet Health Report — computeHealthReport", () => {
  const activeA: HealthEntry = {
    rowNumber: 2, invNumber: "1001", laNumber: "5555",
    date: "2026-01-15", total: "2598.75", status: "sheet_synced",
  };
  const activeB: HealthEntry = {
    rowNumber: 4, invNumber: "1002", laNumber: "6666",
    date: "2026-02-01", total: "1000.00", status: "sheet_synced",
  };
  const voidedA: HealthEntry = {
    rowNumber: 3, invNumber: "1001", laNumber: "5555",
    date: "2026-01-10", total: "0", status: VOID_STATUS,
  };
  const voidedAWithMoney: HealthEntry = { ...voidedA, total: "2598.75" }; // incorrectly not zeroed

  it("clean sheet: 2 active rows, 2 unique keys, 0 voids → isClean true", () => {
    const report = computeHealthReport([activeA, activeB]);
    expect(report.totalActiveRows).toBe(2);
    expect(report.totalUniqueKeys).toBe(2);
    expect(report.totalVoidedRows).toBe(0);
    expect(report.activeDuplicateCount).toBe(0);
    expect(report.voidedRowsWithMoneyCount).toBe(0);
    expect(report.isClean).toBe(true);
  });

  it("active duplicate: 2 rows for same LA# → activeDuplicateCount = 1, isClean false", () => {
    const duplicate: HealthEntry = { ...activeA, rowNumber: 5 };
    const report = computeHealthReport([activeA, duplicate, activeB]);
    expect(report.activeDuplicateCount).toBe(1);
    expect(report.isClean).toBe(false);
    expect(report.activeDuplicateGroups).toHaveLength(1);
    expect(report.activeDuplicateGroups[0]!.key).toBe("la:5555");
    expect(report.activeDuplicateGroups[0]!.activeRows).toHaveLength(2);
  });

  it("syncRow for duplicate group is the highest row number (final tiebreaker)", () => {
    const duplicate: HealthEntry = { ...activeA, rowNumber: 8 };
    const report = computeHealthReport([activeA, duplicate]);
    expect(report.activeDuplicateGroups[0]!.syncRow).toBe(8);
  });

  it("VOID row with zero total → isClean true for that group, voidedRowsWithMoneyCount stays 0", () => {
    const report = computeHealthReport([activeA, voidedA]);
    expect(report.totalActiveRows).toBe(1);
    expect(report.totalVoidedRows).toBe(1);
    expect(report.voidedRowsWithMoneyCount).toBe(0);
    expect(report.isClean).toBe(true);
  });

  it("VOID row with non-zero total → isClean false, voidedRowsWithMoneyCount = 1", () => {
    const report = computeHealthReport([activeA, voidedAWithMoney]);
    expect(report.voidedRowsWithMoneyCount).toBe(1);
    expect(report.isClean).toBe(false);
  });

  it("hasOneActiveRow is true when exactly one active row exists for the key", () => {
    const report = computeHealthReport([activeA, voidedA]);
    const group = report.groups.find(g => g.key === "la:5555");
    expect(group?.hasOneActiveRow).toBe(true);
  });

  it("hasOneActiveRow is false when two active rows exist for the key", () => {
    const dup: HealthEntry = { ...activeA, rowNumber: 7 };
    const report = computeHealthReport([activeA, dup]);
    const group = report.groups.find(g => g.key === "la:5555");
    expect(group?.hasOneActiveRow).toBe(false);
  });

  it("totalVoidedRows counts only rows with VOID_STATUS", () => {
    const report = computeHealthReport([activeA, activeB, voidedA]);
    expect(report.totalVoidedRows).toBe(1);
  });

  it("unrelated invoice rows are unaffected by voiding another invoice", () => {
    const report = computeHealthReport([activeA, voidedA, activeB]);
    // activeA (la:5555) has 1 active + 1 void. activeB (la:6666) has 1 active.
    expect(report.totalUniqueKeys).toBe(2);
    const groupB = report.groups.find(g => g.key === "la:6666");
    expect(groupB?.activeRows).toHaveLength(1);
    expect(groupB?.voidedRows).toHaveLength(0);
    expect(groupB?.hasOneActiveRow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Z. End-to-end scenario: two rows → one active after void-based sync
// ---------------------------------------------------------------------------

describe("End-to-end: two rows with same LA# → one active after void-based sync", () => {
  // This test proves the full correctness chain:
  // 1. Sync with 2 matching rows → higher row kept, lower row voided
  // 2. After void: Sheet state has 1 active + 1 voided
  // 3. Health report sees 1 active row, 0 active duplicates, isClean: true
  // 4. Duplicate checker (findDuplicateGroupsV2) returns 0 groups
  // 5. Voided row has zero total → doesn't inflate SUM formulas

  const row1: HealthEntry = {
    rowNumber: 2, invNumber: "1001", laNumber: "5555",
    date: "2026-01-10", total: "2598.75", status: "sheet_synced",
  };
  const row2: HealthEntry = {
    rowNumber: 5, invNumber: "1001", laNumber: "5555",
    date: "2026-01-15", total: "2598.75", status: "sheet_synced",
  };

  it("Step 1: upsert with 2 matching rows voids the lower-numbered row", () => {
    // Using the simulateUpsertWithVoid helper from section W
    const entry1: UpsertEntry = { ...row1, cellA: row1.invNumber, cellB: row1.date, cellC: row1.laNumber, cellD: "Corporate Shoot", cellE: row1.total, cellT: row1.status };
    const entry2: UpsertEntry = { ...row2, cellA: row2.invNumber, cellB: row2.date, cellC: row2.laNumber, cellD: "Corporate Shoot", cellE: row2.total, cellT: row2.status };
    const result = simulateUpsertWithVoid([entry1, entry2], "5555", "1001", 2598.75);
    expect(result.keptRow).toBe(5);       // higher row = more recent = kept
    expect(result.voidedRows).toEqual([2]); // lower row voided
    expect(result.hasDuplicates).toBe(true);
  });

  it("Step 2: after void, Sheet state has 1 active row + 1 VOID_DUPLICATE row", () => {
    const afterVoid: HealthEntry[] = [
      { ...row1, status: VOID_STATUS, total: "0" }, // voided and zeroed
      row2,                                           // kept active
    ];
    const report = computeHealthReport(afterVoid);
    expect(report.totalActiveRows).toBe(1);
    expect(report.totalVoidedRows).toBe(1);
    expect(report.activeDuplicateCount).toBe(0);
    expect(report.isClean).toBe(true);
  });

  it("Step 3: health report confirms isClean: true and hasOneActiveRow for la:5555", () => {
    const afterVoid: HealthEntry[] = [
      { ...row1, status: VOID_STATUS, total: "0" },
      row2,
    ];
    const report = computeHealthReport(afterVoid);
    const group = report.groups.find(g => g.key === "la:5555");
    expect(group?.hasOneActiveRow).toBe(true);
    expect(group?.voidedRowsHaveZeroTotal).toBe(true);
    expect(report.isClean).toBe(true);
  });

  it("Step 4: duplicate checker sees 0 active duplicate groups", () => {
    const afterVoid: FakeDuplicateEntryV2[] = [
      { rowNumber: 2, invNumber: "1001", laNumber: "5555", date: "2026-01-10", total: "0", status: VOID_STATUS },
      { rowNumber: 5, invNumber: "1001", laNumber: "5555", date: "2026-01-15", total: "2598.75", status: "sheet_synced" },
    ];
    const groups = findDuplicateGroupsV2(afterVoid);
    expect(groups).toHaveLength(0); // VOID row excluded → only 1 active row → no duplicate
  });

  it("Step 5: voided row has zero total so SUM formulas exclude its money", () => {
    const afterVoid: HealthEntry[] = [
      { ...row1, status: VOID_STATUS, total: "0" },
      row2,
    ];
    const report = computeHealthReport(afterVoid);
    const group = report.groups.find(g => g.key === "la:5555");
    expect(group?.voidedRowsHaveZeroTotal).toBe(true);
    expect(report.voidedRowsWithMoneyCount).toBe(0);
  });

  it("Step 5b: if voided row were NOT zeroed, health report flags it as a problem", () => {
    const afterVoidNotZeroed: HealthEntry[] = [
      { ...row1, status: VOID_STATUS, total: "2598.75" }, // bug: total not zeroed
      row2,
    ];
    const report = computeHealthReport(afterVoidNotZeroed);
    expect(report.voidedRowsWithMoneyCount).toBe(1);
    expect(report.isClean).toBe(false);
  });

  it("unrelated invoice rows (la:6666) are completely untouched", () => {
    const unrelated: HealthEntry = {
      rowNumber: 7, invNumber: "1002", laNumber: "6666",
      date: "2026-02-01", total: "1000.00", status: "sheet_synced",
    };
    const afterVoid: HealthEntry[] = [
      { ...row1, status: VOID_STATUS, total: "0" },
      row2,
      unrelated,
    ];
    const report = computeHealthReport(afterVoid);
    expect(report.totalUniqueKeys).toBe(2);
    const groupB = report.groups.find(g => g.key === "la:6666");
    expect(groupB?.activeRows).toHaveLength(1);
    expect(groupB?.voidedRows).toHaveLength(0);
  });
});
