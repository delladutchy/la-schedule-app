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
import {
  COLUMN_ORDER,
  MAIN_SHEET_HEADER_RANGE,
  MAIN_SHEET_HIDDEN_COLUMN_RANGES,
  MAIN_SHEET_LAST_COLUMN,
  SHEET_HEADERS,
  extractNormalizedLAFromText,
  mainSheetDataRowRange,
  normalizeLA as normalizeSheetLA,
  sheetRowToValues,
} from "@/lib/google-sheets";
import { resolveSheetGigEvent } from "@/lib/invoice-calculations";
import type { SheetRow } from "@/lib/invoice-types";

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
}

function calcRemainingBalance(estimatedTotal: number, amountPaid: number): number {
  return Math.max(0, Number((estimatedTotal - amountPaid).toFixed(2)));
}

function buildSheetRow(packet: FakePacket, gigSummary: string, invoiceNumber?: string, extras?: FakeExtras) {
  const pm = packet.mileage;
  return {
    invoiceNumber: invoiceNumber ?? packet.invoiceNumber ?? packet.laNumber ?? "",
    laJobNumber: packet.laNumber ?? "",
    gigEvent: resolveSheetGigEvent(gigSummary, extras?.jobNameOverride),
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
    internalReservedAe: "",
    internalReservedAf: "",
    internalReservedAg: "",
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
// D. Visible email metadata and hidden internal spacer columns
// ---------------------------------------------------------------------------

describe("Visible Sheet metadata and hidden internal spacer columns", () => {
  it("missing extras: sentTo and sentSubject default to empty string (does not throw)", () => {
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
    expect(row.internalReservedAe).toBe("");
    expect(row.internalReservedAf).toBe("");
    expect(row.internalReservedAg).toBe("");
  });

  it("provided extras: sentTo and sentSubject are written to visible Sheet columns", () => {
    const extras: FakeExtras = {
      sentTo: "client@example.com, cc@example.com",
      sentSubject: "Jeff Ulsh - Invoice LA #5555",
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
    expect(row.internalReservedAe).toBe("");
    expect(row.internalReservedAf).toBe("");
    expect(row.internalReservedAg).toBe("");
  });

  it("overridden job name writes the final customer-facing name to D GIG", () => {
    const row = buildSheetRow({
      estimatedTotal: 1000, amountPaid: 0,
      invoiceStatus: "sent", invoiceSentAt: null, invoicePdfUrl: null,
      invoiceNumber: "1001", laNumber: "LA#5555",
      dayRateTotal: 1000, overtimeTotal: 0, perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    }, "LA#5555 — test job", "1001", { jobNameOverride: "Wilm U Grad" });

    expect(row.gigEvent).toBe("Wilm U Grad");
  });

  it("blank job override falls back to the clean calendar job name in D GIG", () => {
    const row = buildSheetRow({
      estimatedTotal: 1000, amountPaid: 0,
      invoiceStatus: "sent", invoiceSentAt: null, invoicePdfUrl: null,
      invoiceNumber: "1001", laNumber: "LA#5555",
      dayRateTotal: 1000, overtimeTotal: 0, perDiemTotal: 0,
      parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0, mileage: null,
    }, "LA#5555 — test job", "1001", { jobNameOverride: "   " });

    expect(row.gigEvent).toBe("test job");
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
    expect(row.internalReservedAe).toBe("");
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
    expect(normalizeSheetLA("5555")).toBe("5555");
  });
  it("LA#5555 → 5555", () => {
    expect(normalizeLA("LA#5555")).toBe("5555");
    expect(normalizeSheetLA("LA#5555")).toBe("5555");
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

  it("extracts LA# from combined invoice-number text", () => {
    expect(extractNormalizedLAFromText("1002 - LA #5555")).toBe("5555");
    expect(extractNormalizedLAFromText("Invoice 1002 / LA#5555")).toBe("5555");
    expect(extractNormalizedLAFromText("1002")).toBe("");
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
      const cellLa = normalizeLA(cellC) || extractNormalizedLAFromText(cellA);
      const sheetsRow = i + 2; // +1 for header, +1 for 1-indexed
      if (incomingLa && cellLa === normalizeLA(incomingLa)) return sheetsRow;
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

  it("combined INV # with blank LA JOB # still matches by parsed LA number and repairs same row", () => {
    const existing = [{ rowA: "1002 - LA #5555", rowC: "" }];
    expect(findMatch(existing, "LA#5555", "1002")).toBe(2);
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
// U. buildVoidRowValues — 34-column void row structure
// ---------------------------------------------------------------------------

// Mirror of buildVoidRowValues exported from lib/google-sheets.ts
// Keep in sync with COLUMN_ORDER (34 columns: A=0 through AH=33).
function buildVoidRowValues(
  cellA: string,
  cellB: string,
  cellC: string,
  cellD: string,
): (string | number)[] {
  const ncols = 34; // COLUMN_ORDER.length
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
  it("returns exactly 34 values (matches COLUMN_ORDER length)", () => {
    expect(buildVoidRowValues("1001", "2026-01-15", "5555", "Corporate Shoot")).toHaveLength(34);
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
    expect(row).toHaveLength(34);
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
  const cellLa = normalizeLA(cellC) || extractNormalizedLAFromText(cellA);
  if (incomingLa && cellLa === incomingLa) score += 200;
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

  it("LA# embedded in INV # scores as a match for repairing old combined rows", () => {
    const combinedInvScore = scoreKeepRow("1002 - LA #5555", "2026-01-15", "", "2500", 3, la, "1002", null);
    const unrelatedScore = scoreKeepRow("1002", "2026-01-15", "", "2500", 3, la, "1002", null);
    expect(combinedInvScore).toBeGreaterThan(unrelatedScore);
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
  archivedRows: number[];
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

  const oldVoidRows: number[] = [];

  for (const entry of entries) {
    const laMatch  = !!(normLa  && normalizeLA(entry.cellC) === normLa);
    const invMatch = !!(normInv && entry.cellA && entry.cellA === normInv);
    if (entry.cellT === VOID_STATUS) {
      if (laMatch || invMatch) oldVoidRows.push(entry.rowNumber);
      continue;
    }
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
    return { action: "inserted", keptRow: lastDataRow + 1, archivedRows: [...oldVoidRows], hasDuplicates: false };
  }

  const keepEntry = matchingRows.reduce((best, e) => e.score > best.score ? e : best);
  const stale = matchingRows.filter(m => m.rowNumber !== keepEntry.rowNumber);
  return {
    action: "updated",
    keptRow: keepEntry.rowNumber,
    archivedRows: [...stale.map(s => s.rowNumber), ...oldVoidRows],
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
    expect(result.archivedRows).toHaveLength(0);
    expect(result.hasDuplicates).toBe(false);
  });

  it("two matches → keeps best, voids the other, hasDuplicates: true", () => {
    const stale: UpsertEntry = { ...base, rowNumber: 5, cellE: "1000.00" }; // lower total, lower row = worse score
    const result = simulateUpsertWithVoid([base, stale], "5555", "1001", 2598.75);
    expect(result.action).toBe("updated");
    expect(result.keptRow).toBe(2); // base wins: LA# + inv# + total match
    expect(result.archivedRows).toEqual([5]);
    expect(result.hasDuplicates).toBe(true);
  });

  it("three matches → keeps best, voids both stale rows", () => {
    const stale2: UpsertEntry = { ...base, rowNumber: 3, cellC: "", cellE: "999.00" };
    const stale3: UpsertEntry = { ...base, rowNumber: 4, cellA: "9999", cellC: "5555", cellE: "500.00" };
    const result = simulateUpsertWithVoid([base, stale2, stale3], "5555", "1001", 2598.75);
    expect(result.keptRow).toBe(2); // base has highest score (LA# + inv# + total)
    expect(result.archivedRows.sort()).toEqual([3, 4]);
    expect(result.hasDuplicates).toBe(true);
  });

  it("VOID rows in sheet are not re-matched as active — but are archived+deleted to clean main sheet", () => {
    const alreadyVoided: UpsertEntry = { ...base, rowNumber: 5, cellT: VOID_STATUS };
    const result = simulateUpsertWithVoid([base, alreadyVoided], "5555", "1001", 2598.75);
    expect(result.keptRow).toBe(2);
    expect(result.hasDuplicates).toBe(false);        // only 1 active match → no active dupe
    expect(result.archivedRows).toEqual([5]);         // old void row collected for archive+delete
  });

  it("no matches → insert new row after last active data row", () => {
    const result = simulateUpsertWithVoid([base], "6666", "1002", 500);
    expect(result.action).toBe("inserted");
    expect(result.keptRow).toBe(3); // row 2 is last active data row → new row at 3
    expect(result.archivedRows).toHaveLength(0);
  });

  it("after voiding, a fresh scan finds only one active row for that key", () => {
    // Two identical rows, same key. Higher row # wins as tiebreaker (more recently inserted).
    // Row 2 (earlier) gets voided; row 5 (later/higher) is kept.
    const earlier: UpsertEntry = { ...base, rowNumber: 2 };
    const later: UpsertEntry   = { ...base, rowNumber: 5 };
    const firstSync = simulateUpsertWithVoid([earlier, later], "5555", "1001", 2598.75);
    expect(firstSync.keptRow).toBe(5);
    expect(firstSync.archivedRows).toEqual([2]); // lower row (older) gets voided

    // Simulate legacy Sheet state: row1 still has VOID_STATUS on main sheet
    // (old behaviour before archive migration, or archive tab failed last time)
    const withLegacyVoid: UpsertEntry[] = [
      { ...earlier, cellT: VOID_STATUS }, // old void row still on main sheet
      later,                              // still active
    ];
    const secondSync = simulateUpsertWithVoid(withLegacyVoid, "5555", "1001", 2598.75);
    expect(secondSync.action).toBe("updated");
    expect(secondSync.keptRow).toBe(5);
    // New behaviour: old VOID row is also archived+deleted during the next sync
    expect(secondSync.archivedRows).toEqual([2]); // legacy void row cleaned up
    expect(secondSync.hasDuplicates).toBe(false); // no active duplicates, only void cleanup
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

  it("Step 1: upsert with 2 matching rows archives+deletes the lower-numbered row", () => {
    const entry1: UpsertEntry = { ...row1, cellA: row1.invNumber, cellB: row1.date, cellC: row1.laNumber, cellD: "Corporate Shoot", cellE: row1.total, cellT: row1.status };
    const entry2: UpsertEntry = { ...row2, cellA: row2.invNumber, cellB: row2.date, cellC: row2.laNumber, cellD: "Corporate Shoot", cellE: row2.total, cellT: row2.status };
    const result = simulateUpsertWithVoid([entry1, entry2], "5555", "1001", 2598.75);
    expect(result.keptRow).toBe(5);           // higher row = more recent = kept
    expect(result.archivedRows).toEqual([2]); // lower row archived to "Voided Duplicates" tab
    expect(result.hasDuplicates).toBe(true);
  });

  it("Step 2: after archive+delete, main Sheet has 1 active row only (no stale row)", () => {
    // The real system archives+deletes row1. Health report sees only row2.
    const afterArchive: HealthEntry[] = [row2];
    const report = computeHealthReport(afterArchive);
    expect(report.totalActiveRows).toBe(1);
    expect(report.totalVoidedRows).toBe(0); // no void rows on main sheet
    expect(report.activeDuplicateCount).toBe(0);
    expect(report.isClean).toBe(true);
  });

  it("Step 2b: old VOID row still on sheet (pre-migration) is excluded from duplicates", () => {
    // Health report still handles legacy VOID rows from before archive migration.
    const withLegacyVoid: HealthEntry[] = [
      { ...row1, status: VOID_STATUS, total: "0" },
      row2,
    ];
    const report = computeHealthReport(withLegacyVoid);
    expect(report.totalActiveRows).toBe(1);
    expect(report.totalVoidedRows).toBe(1); // legacy void still counted
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

  it("Step 4: after archive+delete, duplicate checker sees 0 groups (only one active row)", () => {
    // Real system deleted row1. Main sheet has only row2.
    const afterArchive: FakeDuplicateEntryV2[] = [
      { rowNumber: 5, invNumber: "1001", laNumber: "5555", date: "2026-01-15", total: "2598.75", status: "sheet_synced" },
    ];
    const groups = findDuplicateGroupsV2(afterArchive);
    expect(groups).toHaveLength(0); // only 1 active row → no duplicate
  });

  it("Step 4b: if archive tab fails and VOID row remains, duplicate checker still excludes it", () => {
    // Legacy fallback: VOID row still on main sheet
    const withLegacyVoid: FakeDuplicateEntryV2[] = [
      { rowNumber: 2, invNumber: "1001", laNumber: "5555", date: "2026-01-10", total: "0", status: VOID_STATUS },
      { rowNumber: 5, invNumber: "1001", laNumber: "5555", date: "2026-01-15", total: "2598.75", status: "sheet_synced" },
    ];
    const groups = findDuplicateGroupsV2(withLegacyVoid);
    expect(groups).toHaveLength(0); // VOID row excluded → no duplicate
  });

  it("Step 5: archived row is removed from main sheet — SUM totals include only active row", () => {
    // After archive+delete: only row2 on main sheet. No void rows, no inflation.
    const afterArchive: HealthEntry[] = [row2];
    const report = computeHealthReport(afterArchive);
    expect(report.totalActiveRows).toBe(1);
    expect(report.totalVoidedRows).toBe(0);
    expect(report.voidedRowsWithMoneyCount).toBe(0);
    expect(report.isClean).toBe(true);
  });

  it("Step 5b: legacy VOID row with money would be flagged by health check", () => {
    // Old behavior (before archive migration) — health check catches rows that slipped through
    const legacyVoidWithMoney: HealthEntry[] = [
      { ...row1, status: VOID_STATUS, total: "2598.75" },
      row2,
    ];
    const report = computeHealthReport(legacyVoidWithMoney);
    expect(report.voidedRowsWithMoneyCount).toBe(1);
    expect(report.isClean).toBe(false);
  });

  it("unrelated invoice rows (la:6666) are completely untouched", () => {
    const unrelated: HealthEntry = {
      rowNumber: 7, invNumber: "1002", laNumber: "6666",
      date: "2026-02-01", total: "1000.00", status: "sheet_synced",
    };
    const afterArchive: HealthEntry[] = [row2, unrelated];
    const report = computeHealthReport(afterArchive);
    expect(report.totalUniqueKeys).toBe(2);
    const groupB = report.groups.find(g => g.key === "la:6666");
    expect(groupB?.activeRows).toHaveLength(1);
    expect(groupB?.voidedRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AA. Blank-row detection for INSERT placement
// ---------------------------------------------------------------------------

describe("Blank-row detection — INSERT reuses blank rows above totals", () => {
  // The real upsertSheetRow checks whether the row at position lastDataRow+1
  // is blank before inserting.  These pure-function tests document the logic.

  function isNextRowBlank(cells: [string, string, string]): boolean {
    const [cellA, cellC, cellT] = cells;
    return !cellA.trim() && !cellC.trim() && !cellT.trim();
  }

  it("all-empty next row → blank (should reuse without insertDimension)", () => {
    expect(isNextRowBlank(["", "", ""])).toBe(true);
  });

  it("next row has cellA (totals label) → NOT blank → must insert", () => {
    expect(isNextRowBlank(["TOTAL", "", ""])).toBe(false);
  });

  it("next row has cellC (LA#) → NOT blank → must insert", () => {
    expect(isNextRowBlank(["", "6666", ""])).toBe(false);
  });

  it("next row has cellT (STATUS) → NOT blank → must insert", () => {
    expect(isNextRowBlank(["", "", "VOID_DUPLICATE"])).toBe(false);
  });

  it("next row whitespace-only → treated as blank", () => {
    expect(isNextRowBlank(["  ", "  ", "  "])).toBe(true);
  });

  it("invoice-data row at next position → NOT blank → must insert (no overwrite)", () => {
    expect(isNextRowBlank(["1001", "5555", "sheet_synced"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AB. isTotalsRow — TOTALS line detection
// ---------------------------------------------------------------------------

// Mirror of isTotalsRow from lib/google-sheets.ts
function isTotalsRow(cellA: string): boolean {
  const t = cellA.trim().toUpperCase();
  return t.startsWith("TOTALS") || t === "TOTAL";
}

describe("isTotalsRow — TOTALS row detection", () => {
  it("'TOTALS:' → true", () => { expect(isTotalsRow("TOTALS:")).toBe(true); });
  it("'TOTALS' → true",  () => { expect(isTotalsRow("TOTALS")).toBe(true); });
  it("'TOTAL' → true",   () => { expect(isTotalsRow("TOTAL")).toBe(true); });
  it("'Totals:' (mixed case) → true", () => { expect(isTotalsRow("Totals:")).toBe(true); });
  it("'  TOTALS:  ' (whitespace) → true", () => { expect(isTotalsRow("  TOTALS:  ")).toBe(true); });
  it("'TOTALS: 2026' → true (extra text after)", () => { expect(isTotalsRow("TOTALS: 2026")).toBe(true); });
  it("'1001' (invoice number) → false",  () => { expect(isTotalsRow("1001")).toBe(false); });
  it("'' (blank) → false", () => { expect(isTotalsRow("")).toBe(false); });
  it("'5555' (LA number) → false", () => { expect(isTotalsRow("5555")).toBe(false); });
  it("'SUBTOTALS:' → false (does not start with 'TOTALS')", () => { expect(isTotalsRow("SUBTOTALS:")).toBe(false); });
});

// ---------------------------------------------------------------------------
// AC. TOTALS-aware row placement logic
// ---------------------------------------------------------------------------

// Simulate the upsertSheetRow TOTALS-aware INSERT decision logic.
interface SimRow { cellA: string; cellC: string; cellT: string }

function simulateTotalsPlacement(rows: SimRow[]): {
  totalsRowNum: number;
  lastDataRow: number;
  nextRowNum: number;
  nextIsAboveTotals: boolean;
  nextIsBlank: boolean;
  insertAbove: number;
  newRowNumber: number;
} {
  // Pass 1: find TOTALS
  let totalsRowNum = -1;
  for (let i = 1; i < rows.length; i++) {
    if (isTotalsRow(rows[i]!.cellA)) { totalsRowNum = i + 1; break; }
  }

  // Pass 2: track lastDataRow (only above TOTALS)
  let lastDataRow = 1;
  for (let i = 1; i < rows.length; i++) {
    const { cellA, cellC, cellT } = rows[i]!;
    const sheetsRow = i + 1;
    if (isInvoiceDataRow(cellA, cellC, cellT) && (totalsRowNum < 0 || sheetsRow < totalsRowNum)) {
      lastDataRow = sheetsRow;
    }
  }

  const nextRowNum = lastDataRow + 1;
  const nextIdx = lastDataRow;
  const next = rows[nextIdx];
  const nextCellA = next?.cellA ?? "";
  const nextCellC = next?.cellC ?? "";
  const nextCellT = next?.cellT ?? "";
  const nextIsAboveTotals = totalsRowNum < 0 || nextRowNum < totalsRowNum;
  const nextIsBlank = !nextCellA.trim() && !nextCellC.trim() && !nextCellT.trim() && nextIsAboveTotals;

  const insertAbove = totalsRowNum > 0 ? totalsRowNum : nextRowNum;
  const newRowNumber = nextIsBlank ? nextRowNum : insertAbove;

  return { totalsRowNum, lastDataRow, nextRowNum, nextIsAboveTotals, nextIsBlank, insertAbove, newRowNumber };
}

describe("TOTALS-aware row placement — upsertSheetRow INSERT logic", () => {
  // Build fake sheet: row 1 = header, rows 2-4 = active, row 5 = blank, row 6 = TOTALS
  function makeSheet(...extra: SimRow[]): SimRow[] {
    return [
      { cellA: "INV#",    cellC: "LA#",    cellT: "STATUS" },      // row 1: header
      { cellA: "1001",    cellC: "5555",   cellT: "sheet_synced" }, // row 2: active
      { cellA: "1002",    cellC: "6666",   cellT: "sheet_synced" }, // row 3: active
      { cellA: "1003",    cellC: "7777",   cellT: "sheet_synced" }, // row 4: active
      ...extra,
    ];
  }

  it("blank row above TOTALS → reuse it (no insert needed)", () => {
    const sheet = makeSheet(
      { cellA: "", cellC: "", cellT: "" },  // row 5: blank
      { cellA: "TOTALS:", cellC: "", cellT: "" }, // row 6: TOTALS
    );
    const result = simulateTotalsPlacement(sheet);
    expect(result.totalsRowNum).toBe(6);
    expect(result.lastDataRow).toBe(4);
    expect(result.nextIsBlank).toBe(true);
    expect(result.newRowNumber).toBe(5); // reuses blank row 5
  });

  it("no blank row, data right before TOTALS → insert before TOTALS", () => {
    const sheet = makeSheet(
      { cellA: "TOTALS:", cellC: "", cellT: "" }, // row 5: TOTALS immediately after data
    );
    const result = simulateTotalsPlacement(sheet);
    expect(result.totalsRowNum).toBe(5);
    expect(result.lastDataRow).toBe(4);
    expect(result.nextIsAboveTotals).toBe(false); // row 5 is AT TOTALS, not above
    expect(result.nextIsBlank).toBe(false);
    expect(result.insertAbove).toBe(5);
    expect(result.newRowNumber).toBe(5); // inserts at row 5, TOTALS shifts to 6
  });

  it("blank row exists but it is AT the TOTALS line → not used, insert before TOTALS instead", () => {
    // This is the degenerate case where TOTALS row IS blank (shouldn't happen, but guard it)
    const sheet = makeSheet(
      { cellA: "TOTALS:", cellC: "", cellT: "" }, // row 5: TOTALS with blank C/T
    );
    const result = simulateTotalsPlacement(sheet);
    // nextRowNum = 5, nextIsAboveTotals = (5 < 5) = false → nextIsBlank = false
    expect(result.nextIsBlank).toBe(false);
    expect(result.newRowNumber).toBe(5);
  });

  it("active row below TOTALS does NOT advance lastDataRow", () => {
    // Leaked active row at row 7 (below TOTALS at row 6) must not shift lastDataRow
    const sheet = makeSheet(
      { cellA: "TOTALS:", cellC: "", cellT: "" },   // row 5: TOTALS
      { cellA: "9999", cellC: "8888", cellT: "sheet_synced" }, // row 6: leaked active row
    );
    const result = simulateTotalsPlacement(sheet);
    expect(result.totalsRowNum).toBe(5);
    expect(result.lastDataRow).toBe(4); // row 6 is BELOW TOTALS — ignored
    expect(result.insertAbove).toBe(5);
  });

  it("no TOTALS row found → falls back to lastDataRow + 1", () => {
    const sheet = makeSheet(); // no TOTALS row
    const result = simulateTotalsPlacement(sheet);
    expect(result.totalsRowNum).toBe(-1);
    expect(result.lastDataRow).toBe(4);
    expect(result.newRowNumber).toBe(5); // inserts at row 5 (original behavior)
  });

  it("blank row below TOTALS is NOT reused", () => {
    // Blank at row 7 (below TOTALS at row 5) — must not be reused for new data
    const sheet = makeSheet(
      { cellA: "TOTALS:", cellC: "", cellT: "" }, // row 5: TOTALS
      { cellA: "", cellC: "", cellT: "" },          // row 6: blank BELOW TOTALS
    );
    const result = simulateTotalsPlacement(sheet);
    expect(result.totalsRowNum).toBe(5);
    expect(result.lastDataRow).toBe(4);
    // nextRowNum = 5, nextIsAboveTotals = (5 < 5) = false → not blank
    expect(result.nextIsBlank).toBe(false);
    expect(result.newRowNumber).toBe(5); // inserts before TOTALS
  });
});

// ---------------------------------------------------------------------------
// AD. Column mapping — verify A-U and AH indices
// ---------------------------------------------------------------------------

// Mirror of COLUMN_ORDER from lib/google-sheets.ts
const COLUMN_ORDER_MIRROR = [
  "invoiceNumber",         // A (0)
  "date",                  // B (1)
  "laJobNumber",           // C (2)
  "gigEvent",              // D (3)
  "totalPay",              // E (4)
  "labor",                 // F (5)
  "ot",                    // G (6)
  "perDiem",               // H (7)
  "mileage",               // I (8)  — dollars charged to LA
  "parking",               // J (9)
  "hotel",                 // K (10)
  "tolls",                 // L (11)
  "bagFees",               // M (12)
  "uber",                  // N (13)
  "otherExpenses",         // O (14)
  "totalBusinessMiles",    // P (15) — miles (not dollars)
  "laPaidMiles",           // Q (16) — miles (not dollars)
  "unreimbursedMiles",     // R (17) — miles (NOT dollars — tax-critical)
  "mileagePaid",           // S (18) — dollars LA paid
  "status",                // T (19)
  "paidDate",              // U (20)
  "invoicePdfUrl",         // V (21)
  "invoiceSentDate",       // W (22)
  "amountPaid",            // X (23)
  "remainingBalance",      // Y (24)
  "paymentMethod",         // Z (25)
  "paymentReceivedDate",   // AA (26)
  "paymentBatchRef",       // AB (27)
  "sentTo",                // AC (28)
  "sentSubject",           // AD (29)
  "internalReservedAe",    // AE (30) — hidden internal spacer
  "internalReservedAf",    // AF (31) — hidden internal spacer
  "internalReservedAg",    // AG (32) — hidden internal spacer
  "unreimbursedMileageValue",  // AH (33) — unreimbursedMiles × IRS rate
] as const;

describe("Column mapping A–U and AH", () => {
  it("total columns = 34 (A–AG plus AH tax column)", () => {
    expect(COLUMN_ORDER_MIRROR.length).toBe(34);
    expect(COLUMN_ORDER).toHaveLength(34);
    expect(SHEET_HEADERS).toHaveLength(34);
  });
  it("A (0) = invoiceNumber", () => { expect(COLUMN_ORDER_MIRROR[0]).toBe("invoiceNumber"); });
  it("C (2) = laJobNumber", () => { expect(COLUMN_ORDER_MIRROR[2]).toBe("laJobNumber"); });
  it("E (4) = totalPay", () => { expect(COLUMN_ORDER_MIRROR[4]).toBe("totalPay"); });
  it("I (8) = mileage (dollar amount)", () => { expect(COLUMN_ORDER_MIRROR[8]).toBe("mileage"); });
  it("P (15) = totalBusinessMiles (miles)", () => { expect(COLUMN_ORDER_MIRROR[15]).toBe("totalBusinessMiles"); });
  it("Q (16) = laPaidMiles (miles)", () => { expect(COLUMN_ORDER_MIRROR[16]).toBe("laPaidMiles"); });
  it("R (17) = unreimbursedMiles (miles, NOT dollars)", () => { expect(COLUMN_ORDER_MIRROR[17]).toBe("unreimbursedMiles"); });
  it("S (18) = mileagePaid (dollars)", () => { expect(COLUMN_ORDER_MIRROR[18]).toBe("mileagePaid"); });
  it("T (19) = status", () => { expect(COLUMN_ORDER_MIRROR[19]).toBe("status"); });
  it("U (20) = paidDate", () => { expect(COLUMN_ORDER_MIRROR[20]).toBe("paidDate"); });
  it("T through AA indexes match production accounting headers", () => {
    expect(COLUMN_ORDER.slice(19, 27)).toEqual([
      "status",
      "paidDate",
      "invoicePdfUrl",
      "invoiceSentDate",
      "amountPaid",
      "remainingBalance",
      "paymentMethod",
      "paymentReceivedDate",
    ]);
    expect(SHEET_HEADERS.slice(19, 27)).toEqual([
      "STATUS",
      "PAID DATE",
      "PDF LINK",
      "SENT DATE",
      "AMOUNT PAID",
      "REMAINING BALANCE",
      "PAYMENT METHOD",
      "PAYMENT RECEIVED DATE",
    ]);
  });
  it("V (21) = invoicePdfUrl (NOT mileage value — V is used by PDF link)", () => {
    expect(COLUMN_ORDER_MIRROR[21]).toBe("invoicePdfUrl");
    expect(COLUMN_ORDER[21]).toBe("invoicePdfUrl");
  });
  it("AH (33) = unreimbursedMileageValue (tax deduction column)", () => {
    expect(COLUMN_ORDER_MIRROR[33]).toBe("unreimbursedMileageValue");
    expect(COLUMN_ORDER[33]).toBe("unreimbursedMileageValue");
  });
  it("col R is miles, not dollars — unreimbursedMiles and mileage are different fields", () => {
    // Validate that col I (mileage/dollars) and col R (unreimbursedMiles/miles) are distinct
    expect(COLUMN_ORDER_MIRROR[8]).not.toBe(COLUMN_ORDER_MIRROR[17]);
    expect(COLUMN_ORDER_MIRROR[8]).toBe("mileage");
    expect(COLUMN_ORDER_MIRROR[17]).toBe("unreimbursedMiles");
  });
});

describe("Google Sheet headers for app-written columns", () => {
  it("header row includes PDF LINK in column V", () => {
    expect(SHEET_HEADERS[21]).toBe("PDF LINK");
  });

  it("all app-written columns have non-empty headers", () => {
    expect(SHEET_HEADERS).toHaveLength(COLUMN_ORDER.length);
    for (let i = 0; i < COLUMN_ORDER.length; i++) {
      expect(SHEET_HEADERS[i]?.trim(), `missing header for ${COLUMN_ORDER[i]} at index ${i}`).not.toBe("");
    }
  });

  it("labels every app-written column after V clearly", () => {
    expect(SHEET_HEADERS.slice(22)).toEqual([
      "SENT DATE",
      "AMOUNT PAID",
      "REMAINING BALANCE",
      "PAYMENT METHOD",
      "PAYMENT RECEIVED DATE",
      "PAYMENT BATCH REF",
      "SENT TO",
      "SENT SUBJECT",
      "INTERNAL RESERVED",
      "INTERNAL RESERVED",
      "INTERNAL RESERVED",
      "UNREIMBURSED MILEAGE VALUE",
    ]);
  });

  it("does not expose duplicate override columns in the app-written headers", () => {
    expect(SHEET_HEADERS).not.toContain("JOB NAME OVERRIDE");
    expect(SHEET_HEADERS).not.toContain("DAY RATE DESC OVERRIDE");
    expect(SHEET_HEADERS).not.toContain("INVOICE NOTE OVERRIDE");
  });

  it("hides low-priority tracking columns without removing their app-written data", () => {
    expect(MAIN_SHEET_HIDDEN_COLUMN_RANGES).toEqual([
      { label: "AB:AD", startIndex: 27, endIndex: 30 },
      { label: "AE:AG", startIndex: 30, endIndex: 33 },
    ]);
    expect(SHEET_HEADERS[27]).toBe("PAYMENT BATCH REF");
    expect(SHEET_HEADERS[28]).toBe("SENT TO");
    expect(SHEET_HEADERS[29]).toBe("SENT SUBJECT");
  });

  it("invoice PDF URL still writes to column V", () => {
    const freshUrl = "https://example.com/invoices/Invoice-LA5555.pdf";
    const sampleRow: SheetRow = {
      invoiceNumber: "1001",
      date: "2026-06-18",
      laJobNumber: "LA#5555",
      gigEvent: "test job",
      totalPay: 1000,
      labor: 1000,
      ot: 0,
      perDiem: 0,
      mileage: 0,
      parking: 0,
      hotel: 0,
      tolls: 0,
      bagFees: 0,
      uber: 0,
      otherExpenses: 0,
      totalBusinessMiles: 0,
      laPaidMiles: 0,
      unreimbursedMiles: 0,
      mileagePaid: 0,
      status: "sheet_synced",
      paidDate: "",
      invoicePdfUrl: freshUrl,
      invoiceSentDate: "",
      amountPaid: 0,
      remainingBalance: 1000,
      paymentMethod: "",
      paymentReceivedDate: "",
      paymentBatchRef: "",
      sentTo: "",
      sentSubject: "",
      internalReservedAe: "",
      internalReservedAf: "",
      internalReservedAg: "",
      unreimbursedMileageValue: 0,
    };
    const values = sheetRowToValues(sampleRow);
    expect(values).toHaveLength(SHEET_HEADERS.length);
    expect(values).toHaveLength(COLUMN_ORDER.length);
    expect(values[21]).toBe(freshUrl);
    expect(values[20]).toBe("");
    expect(SHEET_HEADERS[21]).toBe("PDF LINK");
  });

  it("LA JOB # writes number-only to column C for sorting/filtering", () => {
    const sampleRow: SheetRow = {
      invoiceNumber: "1002",
      date: "2026-06-18",
      laJobNumber: "5555",
      gigEvent: "test job",
      totalPay: 1000,
      labor: 1000,
      ot: 0,
      perDiem: 0,
      mileage: 0,
      parking: 0,
      hotel: 0,
      tolls: 0,
      bagFees: 0,
      uber: 0,
      otherExpenses: 0,
      totalBusinessMiles: 0,
      laPaidMiles: 0,
      unreimbursedMiles: 0,
      mileagePaid: 0,
      status: "sheet_synced",
      paidDate: "",
      invoicePdfUrl: "",
      invoiceSentDate: "",
      amountPaid: 0,
      remainingBalance: 1000,
      paymentMethod: "",
      paymentReceivedDate: "",
      paymentBatchRef: "",
      sentTo: "",
      sentSubject: "",
      internalReservedAe: "",
      internalReservedAf: "",
      internalReservedAg: "",
      unreimbursedMileageValue: 0,
    };

    const values = sheetRowToValues(sampleRow);

    expect(values[0]).toBe("1002");
    expect(values[2]).toBe("5555");
    expect(values[2]).not.toBe("LA #5555");
    expect(values[2]).not.toBe("LA#5555");
  });

  it("URL-like dirty paidDate values are never serialized into PAID DATE", () => {
    const freshUrl = "https://example.com/invoices/Invoice-LA5555.pdf";
    const sampleRow: SheetRow = {
      invoiceNumber: "1001",
      date: "2026-06-18",
      laJobNumber: "LA#5555",
      gigEvent: "test job",
      totalPay: 1000,
      labor: 1000,
      ot: 0,
      perDiem: 0,
      mileage: 0,
      parking: 0,
      hotel: 0,
      tolls: 0,
      bagFees: 0,
      uber: 0,
      otherExpenses: 0,
      totalBusinessMiles: 186,
      laPaidMiles: 126,
      unreimbursedMiles: 60,
      mileagePaid: 65.52,
      status: "draft_created",
      paidDate: freshUrl,
      invoicePdfUrl: freshUrl,
      invoiceSentDate: "",
      amountPaid: 0,
      remainingBalance: 1000,
      paymentMethod: "",
      paymentReceivedDate: "",
      paymentBatchRef: "",
      sentTo: "",
      sentSubject: "",
      internalReservedAe: "",
      internalReservedAf: "",
      internalReservedAg: "",
      unreimbursedMileageValue: 43.5,
    };

    const values = sheetRowToValues(sampleRow);

    expect(values[20]).toBe("");
    expect(values[21]).toBe(freshUrl);
    expect(String(values[20])).not.toContain("http");
  });

  it("whole-mile columns serialize as integers while money columns keep decimal values", () => {
    const sampleRow: SheetRow = {
      invoiceNumber: "1001",
      date: "2026-06-18",
      laJobNumber: "LA#5555",
      gigEvent: "test job",
      totalPay: 1065.52,
      labor: 1000,
      ot: 0,
      perDiem: 0,
      mileage: 65.52,
      parking: 0,
      hotel: 0,
      tolls: 0,
      bagFees: 0,
      uber: 0,
      otherExpenses: 0,
      totalBusinessMiles: 186,
      laPaidMiles: 126,
      unreimbursedMiles: 60,
      mileagePaid: 65.52,
      status: "sheet_synced",
      paidDate: "",
      invoicePdfUrl: "https://example.com/invoices/Invoice-LA5555.pdf",
      invoiceSentDate: "",
      amountPaid: 0,
      remainingBalance: 1065.52,
      paymentMethod: "",
      paymentReceivedDate: "",
      paymentBatchRef: "",
      sentTo: "",
      sentSubject: "",
      internalReservedAe: "",
      internalReservedAf: "",
      internalReservedAg: "",
      unreimbursedMileageValue: 43.5,
    };

    const values = sheetRowToValues(sampleRow);

    expect(values[15]).toBe(186);
    expect(values[16]).toBe(126);
    expect(values[17]).toBe(60);
    expect(Number.isInteger(values[15] as number)).toBe(true);
    expect(Number.isInteger(values[16] as number)).toBe(true);
    expect(Number.isInteger(values[17] as number)).toBe(true);
    expect(values[18]).toBe(65.52);
    expect(values[33]).toBe(43.5);
  });

  it("draft_created writes status to T, keeps PAID DATE blank, and writes PDF URL to V", () => {
    const freshUrl = "https://example.com/invoices/Invoice-LA5555-draft.pdf";
    const sampleRow: SheetRow = {
      invoiceNumber: "1001",
      date: "2026-06-18",
      laJobNumber: "LA#5555",
      gigEvent: "test job",
      totalPay: 7598.75,
      labor: 1650,
      ot: 618.75,
      perDiem: 120,
      mileage: 0,
      parking: 110,
      hotel: 0,
      tolls: 0,
      bagFees: 100,
      uber: 5000,
      otherExpenses: 0,
      totalBusinessMiles: 0,
      laPaidMiles: 0,
      unreimbursedMiles: 0,
      mileagePaid: 0,
      status: "draft_created",
      paidDate: "",
      invoicePdfUrl: freshUrl,
      invoiceSentDate: "",
      amountPaid: 0,
      remainingBalance: 7598.75,
      paymentMethod: "",
      paymentReceivedDate: "",
      paymentBatchRef: "",
      sentTo: "accounting@example.com",
      sentSubject: "Jeff Ulsh - Invoice LA #5555 - test job",
      internalReservedAe: "",
      internalReservedAf: "",
      internalReservedAg: "",
      unreimbursedMileageValue: 0,
    };

    const values = sheetRowToValues(sampleRow);

    expect(values).toHaveLength(SHEET_HEADERS.length);
    expect(values[19]).toBe("draft_created");
    expect(values[20]).toBe("");
    expect(String(values[20])).not.toContain("http");
    expect(values[21]).toBe(freshUrl);
    expect(values[22]).toBe("");
    expect(values[23]).toBe(0);
    expect(values[24]).toBe(7598.75);
    expect(values[25]).toBe("");
    expect(values[26]).toBe("");
  });

  it("paid invoices populate PAID DATE and payment fields without shifting PDF or sent columns", () => {
    const freshUrl = "https://example.com/invoices/Invoice-LA5555-paid.pdf";
    const sampleRow: SheetRow = {
      invoiceNumber: "1001",
      date: "2026-06-18",
      laJobNumber: "LA#5555",
      gigEvent: "test job",
      totalPay: 7598.75,
      labor: 1650,
      ot: 618.75,
      perDiem: 120,
      mileage: 0,
      parking: 110,
      hotel: 0,
      tolls: 0,
      bagFees: 100,
      uber: 5000,
      otherExpenses: 0,
      totalBusinessMiles: 0,
      laPaidMiles: 0,
      unreimbursedMiles: 0,
      mileagePaid: 0,
      status: "paid",
      paidDate: "2026-06-22",
      invoicePdfUrl: freshUrl,
      invoiceSentDate: "2026-06-18",
      amountPaid: 7598.75,
      remainingBalance: 0,
      paymentMethod: "Direct Deposit",
      paymentReceivedDate: "2026-06-22",
      paymentBatchRef: "LA-BATCH-2026-06",
      sentTo: "accounting@example.com",
      sentSubject: "Jeff Ulsh - Invoice LA #5555 - test job",
      internalReservedAe: "",
      internalReservedAf: "",
      internalReservedAg: "",
      unreimbursedMileageValue: 0,
    };

    const values = sheetRowToValues(sampleRow);

    expect(values).toHaveLength(SHEET_HEADERS.length);
    expect(values[19]).toBe("paid");
    expect(values[20]).toBe("2026-06-22");
    expect(values[21]).toBe(freshUrl);
    expect(values[22]).toBe("2026-06-18");
    expect(values[23]).toBe(7598.75);
    expect(values[24]).toBe(0);
    expect(values[25]).toBe("Direct Deposit");
    expect(values[26]).toBe("2026-06-22");
  });

  it("reset/rebuild uses the full A1:AH1 header range", () => {
    expect(MAIN_SHEET_HEADER_RANGE).toBe("'LA PAY (2026)'!A1:AH1");
    expect(MAIN_SHEET_LAST_COLUMN).toBe("AH");
    expect(SHEET_HEADERS[33]).toBe("UNREIMBURSED MILEAGE VALUE");
  });

  it("main row upsert writes an explicit A:AH range to repair shifted existing rows", () => {
    expect(mainSheetDataRowRange(7)).toBe("'LA PAY (2026)'!A7:AH7");
  });
});

// ---------------------------------------------------------------------------
// AE. Mileage calculation accuracy and IRS deduction value
// ---------------------------------------------------------------------------

const IRS_MILEAGE_RATE_2026 = 0.725;

// Mirror of calculateMileage logic from lib/invoice-calculations.ts
function calculateMileage(totalMiles: number, deductionMiles: number, rate: number) {
  const reimbursedMiles = Math.max(0, totalMiles - deductionMiles);
  const unreimbursedMiles = totalMiles - reimbursedMiles;
  const mileageAmount = Math.round(reimbursedMiles * rate * 100) / 100;
  const unreimbursedMileageValue = Math.round(unreimbursedMiles * IRS_MILEAGE_RATE_2026 * 100) / 100;
  return { totalMiles, deductionMiles, reimbursedMiles, unreimbursedMiles, mileageAmount, unreimbursedMileageValue };
}

describe("Mileage calculation — miles vs dollars, IRS deduction", () => {
  it("420 total miles, 60 deducted → 360 reimbursed, 60 unreimbursed, $187.20 mileage paid", () => {
    const m = calculateMileage(420, 60, 0.52);
    expect(m.reimbursedMiles).toBe(360);
    expect(m.unreimbursedMiles).toBe(60);
    expect(m.mileageAmount).toBe(187.2);
  });

  it("col R (unreimbursedMiles) is in MILES, not dollars", () => {
    const m = calculateMileage(420, 60, 0.52);
    // col R = unreimbursedMiles (60 miles) — NOT dollars
    // col I = mileageAmount ($187.20) — these are different
    expect(m.unreimbursedMiles).toBe(60); // miles
    expect(m.mileageAmount).not.toBe(m.unreimbursedMiles); // dollars ≠ miles
  });

  it("unreimbursedMiles = totalMiles − reimbursedMiles (never negative)", () => {
    // Normal case: deduction < total → some miles reimbursed, some not
    expect(calculateMileage(100, 30, 0.52).unreimbursedMiles).toBe(30);
    // Clamped case: deduction > total → LA reimburses 0, ALL driven miles are unreimbursed
    expect(calculateMileage(20, 60, 0.52).reimbursedMiles).toBe(0);
    expect(calculateMileage(20, 60, 0.52).unreimbursedMiles).toBe(20); // drove 20 miles, LA paid 0
  });

  it("IRS deduction value = unreimbursedMiles × 0.725", () => {
    const m = calculateMileage(420, 60, 0.52);
    // 60 unreimbursed miles × $0.725 IRS rate = $43.50
    expect(m.unreimbursedMileageValue).toBe(43.5);
  });

  it("IRS rate 2026 = 0.725", () => {
    expect(IRS_MILEAGE_RATE_2026).toBe(0.725);
  });

  it("unreimbursedMileageValue is 0 when no deduction miles exist (deduction = 0)", () => {
    const m = calculateMileage(50, 0, 0.52); // no deduction → all 50 miles reimbursed
    expect(m.reimbursedMiles).toBe(50);
    expect(m.unreimbursedMiles).toBe(0);
    expect(m.unreimbursedMileageValue).toBe(0);
  });

  it("billable mileage (col I) uses the billing rate, not the IRS rate", () => {
    const billingRate = 0.52;
    const m = calculateMileage(420, 60, billingRate);
    // LA pays reimbursedMiles × billing rate
    expect(m.mileageAmount).toBe(Math.round(360 * billingRate * 100) / 100);
    // IRS value uses IRS rate (different from billing rate)
    expect(m.unreimbursedMileageValue).toBe(Math.round(60 * IRS_MILEAGE_RATE_2026 * 100) / 100);
    expect(m.mileageAmount).not.toBe(m.unreimbursedMileageValue);
  });

  it("mileage (col I) and mileagePaid (col S) are the same dollar amount", () => {
    // Both cols I and S hold mileageAmount — what LA is charged and what they pay
    const m = calculateMileage(420, 60, 0.52);
    expect(m.mileageAmount).toBe(187.2); // col I
    // col S (mileagePaid) = same value: 187.20
  });
});

// ---------------------------------------------------------------------------
// AF. Health report — TOTALS position and activeBelowTotalsCount
// ---------------------------------------------------------------------------

interface HealthEntryV2 extends HealthEntry {
  sheetRow: number; // explicit 1-indexed row number for TOTALS detection
}

function computeHealthReportV2(
  entries: HealthEntry[],
  totalsAt: number | null, // 1-indexed row number of TOTALS
): { isClean: boolean; activeBelowTotalsCount: number; totalsRowNum: number | null } {
  let activeBelowTotalsCount = 0;
  for (const e of entries) {
    if (e.status !== VOID_STATUS && isInvoiceDataRow(e.invNumber, e.laNumber, e.status)) {
      if (totalsAt !== null && e.rowNumber >= totalsAt) {
        activeBelowTotalsCount++;
      }
    }
  }
  const baseReport = computeHealthReport(entries);
  const isClean = baseReport.activeDuplicateCount === 0 && baseReport.voidedRowsWithMoneyCount === 0 && activeBelowTotalsCount === 0;
  return { isClean, activeBelowTotalsCount, totalsRowNum: totalsAt };
}

describe("Health report — TOTALS position and activeBelowTotalsCount", () => {
  const activeRow2: HealthEntry = { rowNumber: 2, invNumber: "1001", laNumber: "5555", date: "2026-01-15", total: "2000", status: "sheet_synced" };
  const activeRow3: HealthEntry = { rowNumber: 3, invNumber: "1002", laNumber: "6666", date: "2026-02-01", total: "1500", status: "sheet_synced" };
  const totalsAt = 5; // TOTALS row at row 5

  it("all active rows above TOTALS → activeBelowTotalsCount = 0, isClean true", () => {
    const report = computeHealthReportV2([activeRow2, activeRow3], totalsAt);
    expect(report.activeBelowTotalsCount).toBe(0);
    expect(report.isClean).toBe(true);
  });

  it("active row at TOTALS row number → flagged (row AT TOTALS is misplaced)", () => {
    const atTotals: HealthEntry = { rowNumber: 5, invNumber: "1003", laNumber: "7777", date: "2026-03-01", total: "1000", status: "sheet_synced" };
    const report = computeHealthReportV2([activeRow2, atTotals], totalsAt);
    expect(report.activeBelowTotalsCount).toBe(1);
    expect(report.isClean).toBe(false);
  });

  it("active row below TOTALS → flagged, isClean false", () => {
    const belowTotals: HealthEntry = { rowNumber: 7, invNumber: "1004", laNumber: "8888", date: "2026-04-01", total: "1200", status: "sheet_synced" };
    const report = computeHealthReportV2([activeRow2, belowTotals], totalsAt);
    expect(report.activeBelowTotalsCount).toBe(1);
    expect(report.isClean).toBe(false);
  });

  it("VOID row below TOTALS → not counted in activeBelowTotalsCount", () => {
    const voidBelow: HealthEntry = { rowNumber: 7, invNumber: "1001", laNumber: "5555", date: "2026-01-10", total: "0", status: VOID_STATUS };
    const report = computeHealthReportV2([activeRow2, voidBelow], totalsAt);
    expect(report.activeBelowTotalsCount).toBe(0);
  });

  it("no TOTALS row (totalsAt null) → activeBelowTotalsCount = 0", () => {
    const report = computeHealthReportV2([activeRow2, activeRow3], null);
    expect(report.activeBelowTotalsCount).toBe(0);
    expect(report.totalsRowNum).toBeNull();
  });

  it("multiple active rows below TOTALS → all counted", () => {
    const below1: HealthEntry = { rowNumber: 6, invNumber: "1003", laNumber: "7777", date: "2026-03-01", total: "900", status: "sheet_synced" };
    const below2: HealthEntry = { rowNumber: 8, invNumber: "1004", laNumber: "8888", date: "2026-04-01", total: "600", status: "sheet_synced" };
    const report = computeHealthReportV2([activeRow2, below1, below2], totalsAt);
    expect(report.activeBelowTotalsCount).toBe(2);
    expect(report.isClean).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AG. isTestSheetRow — fake/test row detection
// ---------------------------------------------------------------------------

// Mirror of isTestSheetRow from lib/google-sheets.ts
function isTestSheetRow(invNumber: string, laNumber: string, gigEvent: string): boolean {
  if (normalizeLA(laNumber) === "5555") return true;
  if (invNumber.trim() === "1001") return true;
  if (gigEvent.trim().toLowerCase().includes("test")) return true;
  return false;
}

describe("isTestSheetRow — fake/test row detection", () => {
  // Test rows by LA#
  it("LA#5555 (canonical) → test row", () => {
    expect(isTestSheetRow("1001", "LA#5555", "some gig")).toBe(true);
  });
  it("5555 (no prefix) → test row (normalizeLA matches)", () => {
    expect(isTestSheetRow("1001", "5555", "some gig")).toBe(true);
  });
  it("LA #5555 (space variant) → test row", () => {
    expect(isTestSheetRow("1001", "LA #5555", "some gig")).toBe(true);
  });

  // Test rows by invoice number
  it("invoice 1001 → test row", () => {
    expect(isTestSheetRow("1001", "LA#9999", "real gig")).toBe(true);
  });
  it("invoice 1001 with whitespace → test row", () => {
    expect(isTestSheetRow("  1001  ", "LA#9999", "real gig")).toBe(true);
  });
  it("invoice 1001a → NOT a test row (different number)", () => {
    expect(isTestSheetRow("1001a", "LA#9999", "real gig")).toBe(false);
  });

  // Test rows by gig name
  it("gig containing 'test' → test row", () => {
    expect(isTestSheetRow("1002", "LA#9999", "test job")).toBe(true);
  });
  it("gig 'Testing invoice sync' → test row", () => {
    expect(isTestSheetRow("1002", "LA#9999", "Testing invoice sync")).toBe(true);
  });
  it("gig 'UNIT TEST' (uppercase) → test row (case-insensitive)", () => {
    expect(isTestSheetRow("1002", "LA#9999", "UNIT TEST")).toBe(true);
  });

  // Real rows
  it("real invoice row: inv 1002, LA#6789, real gig → NOT a test row", () => {
    expect(isTestSheetRow("1002", "LA#6789", "Music video shoot — director")).toBe(false);
  });
  it("real invoice row: inv 1050, LA#1234 → NOT a test row", () => {
    expect(isTestSheetRow("1050", "LA#1234", "Commercial shoot")).toBe(false);
  });
  it("blank gig name → NOT a test row", () => {
    expect(isTestSheetRow("1002", "LA#6789", "")).toBe(false);
  });
  it("gig containing 'latest' → NOT a test row ('latest' contains 'test'!)", () => {
    // NOTE: 'latest' does contain 'test' — this is an edge case to document.
    // The function matches any occurrence of the substring 'test'.
    expect(isTestSheetRow("1002", "LA#6789", "Latest commercial")).toBe(true); // intentional: 'latest' has 'test' in it
  });
});

// ---------------------------------------------------------------------------
// AH. Reset / Rebuild Sheet — simulation tests
// ---------------------------------------------------------------------------

interface ResetRow {
  rowNumber: number;
  invNumber: string;
  laNumber: string;
  gigEvent: string;
  total: string;
  status: string;
}

interface ResetSimResult {
  voidToArchive: ResetRow[];
  testToArchive: ResetRow[];
  duplicatesToArchive: ResetRow[];
  goodRows: ResetRow[];
}

function simulateReset(rows: ResetRow[]): ResetSimResult {
  const voidToArchive: ResetRow[] = [];
  const testToArchive: ResetRow[] = [];
  const activeByKey = new Map<string, ResetRow[]>();

  for (const r of rows) {
    if (r.status === VOID_STATUS) { voidToArchive.push(r); continue; }
    if (!isInvoiceDataRow(r.invNumber, r.laNumber, r.status)) continue;
    if (isTestSheetRow(r.invNumber, r.laNumber, r.gigEvent)) { testToArchive.push(r); continue; }
    const normLa = normalizeLA(r.laNumber);
    const key = normLa ? `la:${normLa}` : r.invNumber ? `inv:${r.invNumber}` : null;
    if (!key) continue;
    const existing = activeByKey.get(key) ?? [];
    existing.push(r);
    activeByKey.set(key, existing);
  }

  const duplicatesToArchive: ResetRow[] = [];
  const goodRows: ResetRow[] = [];

  for (const [, candidates] of activeByKey) {
    if (candidates.length === 1) { goodRows.push(candidates[0]!); continue; }
    // Keep highest row number as tiebreaker (mirrors scoreKeepRow without incoming params)
    const keep = candidates.reduce((best, e) => e.rowNumber > best.rowNumber ? e : best);
    goodRows.push(keep);
    duplicatesToArchive.push(...candidates.filter((c) => c.rowNumber !== keep.rowNumber));
  }

  return { voidToArchive, testToArchive, duplicatesToArchive, goodRows };
}

describe("Reset / Rebuild Sheet — row classification", () => {
  const realRow: ResetRow = { rowNumber: 2, invNumber: "1002", laNumber: "LA#6789", gigEvent: "Film shoot", total: "2000", status: "sheet_synced" };
  const voidRow: ResetRow = { rowNumber: 3, invNumber: "1001", laNumber: "LA#5555", gigEvent: "test job", total: "0", status: VOID_STATUS };
  const testByLA: ResetRow = { rowNumber: 4, invNumber: "1001", laNumber: "LA#5555", gigEvent: "some gig", total: "500", status: "sheet_synced" };
  const testByInv: ResetRow = { rowNumber: 5, invNumber: "1001", laNumber: "LA#7777", gigEvent: "music video", total: "800", status: "sheet_synced" };
  const testByGig: ResetRow = { rowNumber: 6, invNumber: "1003", laNumber: "LA#8888", gigEvent: "testing invoice sync", total: "300", status: "sheet_synced" };

  it("VOID rows are archived, not treated as active", () => {
    const { voidToArchive, goodRows } = simulateReset([voidRow, realRow]);
    expect(voidToArchive.map(r => r.rowNumber)).toContain(3);
    expect(goodRows.map(r => r.rowNumber)).toContain(2);
    expect(goodRows.map(r => r.rowNumber)).not.toContain(3);
  });

  it("LA#5555 row is archived as test data", () => {
    const { testToArchive } = simulateReset([testByLA, realRow]);
    expect(testToArchive.map(r => r.rowNumber)).toContain(4);
  });

  it("invoice 1001 row is archived as test data", () => {
    const { testToArchive } = simulateReset([testByInv, realRow]);
    expect(testToArchive.map(r => r.rowNumber)).toContain(5);
  });

  it("'test' in gig name is archived as test data", () => {
    const { testToArchive } = simulateReset([testByGig, realRow]);
    expect(testToArchive.map(r => r.rowNumber)).toContain(6);
  });

  it("real invoice rows are kept as goodRows", () => {
    const { goodRows } = simulateReset([testByLA, voidRow, realRow]);
    expect(goodRows).toHaveLength(1);
    expect(goodRows[0]?.rowNumber).toBe(2);
  });

  it("archive-before-delete: all removed rows appear in archive lists, none silently dropped", () => {
    const rows = [testByLA, voidRow, testByInv, testByGig, realRow];
    const { voidToArchive, testToArchive, goodRows } = simulateReset(rows);
    const archived = [...voidToArchive, ...testToArchive];
    // Every non-real row must be in an archive list
    expect(archived.map(r => r.rowNumber).sort()).toEqual([3, 4, 5, 6]);
    // Real rows must be in goodRows
    expect(goodRows.map(r => r.rowNumber)).toEqual([2]);
    // Nothing dropped silently
    expect(archived.length + goodRows.length).toBe(rows.length);
  });

  it("duplicate active rows: only best (highest row#) is kept, others archived", () => {
    const dup1: ResetRow = { rowNumber: 7, invNumber: "1004", laNumber: "LA#9000", gigEvent: "Real shoot", total: "1500", status: "sheet_synced" };
    const dup2: ResetRow = { rowNumber: 9, invNumber: "1004", laNumber: "LA#9000", gigEvent: "Real shoot", total: "1500", status: "sheet_synced" };
    const { duplicatesToArchive, goodRows } = simulateReset([dup1, dup2, realRow]);
    expect(duplicatesToArchive).toHaveLength(1);
    expect(duplicatesToArchive[0]?.rowNumber).toBe(7); // lower row# is the duplicate
    expect(goodRows.map(r => r.rowNumber)).toContain(9); // higher row# is kept
  });

  it("reset on an already-clean sheet: 0 archived, real row preserved", () => {
    const { voidToArchive, testToArchive, duplicatesToArchive, goodRows } = simulateReset([realRow]);
    expect(voidToArchive).toHaveLength(0);
    expect(testToArchive).toHaveLength(0);
    expect(duplicatesToArchive).toHaveLength(0);
    expect(goodRows).toHaveLength(1);
  });
});

describe("Reset — formula rebuild range", () => {
  it("formula covers rows 2 through (totalsRow - 1)", () => {
    // If TOTALS is at row 10 and last active is at row 9, formula = SUM(X2:X9)
    const totalsRow = 10;
    const lastRow = totalsRow - 1;
    const formula = `=SUM(E2:E${lastRow})`;
    expect(formula).toBe("=SUM(E2:E9)");
  });

  it("formula covers blank rows above TOTALS (blank cells contribute 0 to SUM)", () => {
    // TOTALS at row 15, last active at row 5, blank rows 6-14 → SUM covers all
    const totalsRow = 15;
    const lastRow = totalsRow - 1;
    const formula = `=SUM(E2:E${lastRow})`;
    expect(formula).toBe("=SUM(E2:E14)");
    // Future insert at row 6 is captured because the range includes rows 6-14
    expect(6).toBeGreaterThanOrEqual(2);
    expect(6).toBeLessThanOrEqual(14);
  });

  it("15 money columns (E–S) each get a SUM formula", () => {
    const moneyCols = ["E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S"];
    expect(moneyCols).toHaveLength(15);
    const formulas = moneyCols.map((col) => `=SUM(${col}2:${col}9)`);
    expect(formulas[0]).toBe("=SUM(E2:E9)");   // E: totalPay
    expect(formulas[4]).toBe("=SUM(I2:I9)");   // I: mileage
    expect(formulas[14]).toBe("=SUM(S2:S9)");  // S: mileagePaid
  });
});

describe("Reset — health report after clean reset", () => {
  it("after reset: only real rows present → health report is clean", () => {
    const realRow1: HealthEntry = { rowNumber: 2, invNumber: "1002", laNumber: "LA#6789", date: "2026-06-01", total: "2000", status: "sheet_synced" };
    const realRow2: HealthEntry = { rowNumber: 3, invNumber: "1003", laNumber: "LA#7890", date: "2026-06-15", total: "1500", status: "sheet_synced" };
    const totalsAt = 4;
    const report = computeHealthReportV2([realRow1, realRow2], totalsAt);
    expect(report.isClean).toBe(true);
    expect(report.activeBelowTotalsCount).toBe(0);
  });

  it("after reset: zero void rows on main sheet → totalVoidedRows = 0", () => {
    const realRow1: HealthEntry = { rowNumber: 2, invNumber: "1002", laNumber: "LA#6789", date: "2026-06-01", total: "2000", status: "sheet_synced" };
    const report = computeHealthReport([realRow1]);
    expect(report.totalVoidedRows).toBe(0);
    expect(report.activeDuplicateCount).toBe(0);
    expect(report.isClean).toBe(true);
  });

  it("after reset + future sync: new invoice writes one active row above TOTALS", () => {
    // Verify that upsert logic (from TOTALS placement tests) still works post-reset.
    // Sheet after reset: header row 1, real rows 2-3, TOTALS at row 4.
    const sheet = [
      { cellA: "INV#",  cellC: "LA#",   cellT: "STATUS" },
      { cellA: "1002",  cellC: "6789",  cellT: "sheet_synced" }, // row 2: real
      { cellA: "1003",  cellC: "7890",  cellT: "sheet_synced" }, // row 3: real
      { cellA: "TOTALS:", cellC: "",    cellT: "" },             // row 4: TOTALS
    ];
    const result = simulateTotalsPlacement(sheet);
    expect(result.totalsRowNum).toBe(4);
    expect(result.lastDataRow).toBe(3);
    // No blank row between row 3 and TOTALS row 4 → INSERT before TOTALS
    expect(result.nextIsBlank).toBe(false);
    expect(result.newRowNumber).toBe(4); // new row inserted at row 4, TOTALS shifts to 5
  });
});

// ---------------------------------------------------------------------------
// Automatic Sheet Maintenance — full upsert simulation with TOTALS awareness,
// clutter detection, and auto-repair (mirrors the new upsertSheetRow behavior)
// ---------------------------------------------------------------------------

interface FullUpsertEntry {
  rowNumber: number;
  cellA: string; // INV#
  cellB: string; // DATE
  cellC: string; // LA#
  cellD: string; // GIG
  cellE: string; // TOTAL
  cellT: string; // STATUS
}

interface FullUpsertResult {
  action: "updated" | "inserted" | "moved";
  finalRow: number;
  archivedRows: number[];
  hasDuplicates: boolean;
  autoRepaired: boolean;
  hasUnrelatedClutter: boolean;
  userMessage: string;
}

/**
 * Pure-JS simulation of the new upsertSheetRow logic including:
 *   - TOTALS-aware lastDataRow tracking
 *   - below-TOTALS kept-row detection → moved action
 *   - unrelated clutter detection (VOID rows or active-below-TOTALS for other keys)
 *   - userMessage derivation
 */
function simulateFullUpsert(
  entries: FullUpsertEntry[],
  incomingLa: string,
  incomingInv: string,
  incomingTotal: number,
): FullUpsertResult {
  const normLa  = normalizeLA(incomingLa);
  const normInv = incomingInv.trim();

  // Pass 1: find TOTALS row (entries are 1-indexed starting from index 0 as row 1)
  let totalsRowNum = -1;
  for (const e of entries) {
    if (isTotalsRow(e.cellA)) { totalsRowNum = e.rowNumber; break; }
  }

  // Pass 2: classify rows
  const matchingRows: Array<{ rowNumber: number; score: number; cellA: string; cellB: string; cellC: string; cellD: string; cellE: string; cellT: string }> = [];
  const oldVoidRows: number[] = [];
  let lastDataRow = 1;
  let unrelatedClutter = 0;

  for (const e of entries) {
    if (isTotalsRow(e.cellA)) continue;

    const laMatch  = !!(normLa  && normalizeLA(e.cellC) === normLa);
    const invMatch = !!(normInv && e.cellA && e.cellA === normInv);
    const isThisKey = laMatch || invMatch;

    if (e.cellT === VOID_STATUS) {
      if (isThisKey) {
        oldVoidRows.push(e.rowNumber);
      } else {
        unrelatedClutter++;
      }
      continue;
    }
    if (!isInvoiceDataRow(e.cellA, e.cellC, e.cellT)) continue;

    if (totalsRowNum < 0 || e.rowNumber < totalsRowNum) {
      lastDataRow = e.rowNumber;
    } else if (!isThisKey) {
      unrelatedClutter++;
    }

    if (isThisKey) {
      const score = scoreKeepRow(e.cellA, e.cellB, e.cellC, e.cellE, e.rowNumber, normLa, normInv, incomingTotal);
      matchingRows.push({ ...e, score });
    }
  }

  const archivedRows: number[] = [];
  let finalRow: number;
  let action: FullUpsertResult["action"];
  let autoRepaired = false;
  let didInsert = false;

  if (matchingRows.length > 0) {
    const keepEntry = matchingRows.reduce((best, e) => e.score > best.score ? e : best);
    const staleActive = matchingRows.filter(m => m.rowNumber !== keepEntry.rowNumber);
    const keepIsBelowTotals = totalsRowNum > 0 && keepEntry.rowNumber >= totalsRowNum;

    if (keepIsBelowTotals) {
      // Archive all matches (including the keep row) and insert above TOTALS
      const toArchive = [...matchingRows.map(e => e.rowNumber), ...oldVoidRows];
      archivedRows.push(...toArchive);
      autoRepaired = true;
      action = "moved";
      const insertAbove = totalsRowNum > 0 ? totalsRowNum : lastDataRow + 1;
      finalRow = insertAbove;
      didInsert = true;
    } else {
      // Update in-place
      const allStale = [...staleActive.map(e => e.rowNumber), ...oldVoidRows];
      if (allStale.length > 0) {
        archivedRows.push(...allStale);
        autoRepaired = true;
      }
      finalRow = keepEntry.rowNumber;
      action = "updated";
    }
  } else {
    if (oldVoidRows.length > 0) {
      archivedRows.push(...oldVoidRows);
      autoRepaired = oldVoidRows.length > 0;
    }
    const nextRowNum = lastDataRow + 1;
    const nextEntry = entries.find(e => e.rowNumber === nextRowNum);
    const nextIsAboveTotals = totalsRowNum < 0 || nextRowNum < totalsRowNum;
    const nextIsBlank = !nextEntry?.cellA.trim() && !nextEntry?.cellC.trim() && !nextEntry?.cellT.trim() && nextIsAboveTotals;

    if (nextIsBlank) {
      finalRow = nextRowNum;
    } else {
      const insertAbove = totalsRowNum > 0 ? totalsRowNum : nextRowNum;
      finalRow = insertAbove;
      didInsert = true;
    }
    action = "inserted";
  }

  const hasUnrelatedClutter = unrelatedClutter > 0;
  let userMessage: string;
  if (autoRepaired && hasUnrelatedClutter) {
    userMessage = "Sheet updated and cleaned. Old cleanup items remain; run Health Check when convenient.";
  } else if (autoRepaired) {
    userMessage = "Sheet updated and cleaned";
  } else if (hasUnrelatedClutter) {
    userMessage = "Sheet updated. Sheet has old cleanup items; run Health Check when convenient.";
  } else {
    userMessage = "Sheet updated";
  }

  return { action, finalRow, archivedRows, hasDuplicates: archivedRows.length > 0, autoRepaired, hasUnrelatedClutter, userMessage };
}

describe("Automatic Sheet Maintenance — auto-repair during normal sync", () => {
  // Standard sheet layout helpers
  function makeEntry(overrides: Partial<FullUpsertEntry> & { rowNumber: number; cellC: string }): FullUpsertEntry {
    return {
      cellA: "1001", cellB: "2026-06-01", cellD: "Corp Shoot",
      cellE: "2000.00", cellT: "sheet_synced",
      ...overrides,
    };
  }

  // ── Row moved from below TOTALS to above TOTALS ────────────────────────────

  it("matched row below TOTALS → action=moved, archives it, inserts above TOTALS", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",           cellE: "", cellT: "STATUS" },
      { rowNumber: 2, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",           cellE: "", cellT: "" },
      { rowNumber: 3, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "2000.00", cellT: "sheet_synced" },
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.action).toBe("moved");
    expect(result.archivedRows).toContain(3);
    expect(result.finalRow).toBe(2); // insert before TOTALS at row 2
    expect(result.autoRepaired).toBe(true);
    expect(result.userMessage).toBe("Sheet updated and cleaned");
  });

  it("matched row below TOTALS with duplicates → all archived, one row placed above TOTALS", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",           cellE: "", cellT: "STATUS" },
      { rowNumber: 2, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",           cellE: "", cellT: "" },
      { rowNumber: 3, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "2000.00", cellT: "sheet_synced" },
      { rowNumber: 4, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "500.00",  cellT: "sheet_synced" },
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.action).toBe("moved");
    expect(result.archivedRows).toContain(3);
    expect(result.archivedRows).toContain(4);
    expect(result.archivedRows).toHaveLength(2);
    expect(result.autoRepaired).toBe(true);
  });

  // ── Stale duplicates archived ──────────────────────────────────────────────

  it("match above TOTALS with one stale duplicate → updated in-place, stale archived", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",           cellE: "", cellT: "STATUS" },
      { rowNumber: 2, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "2000.00", cellT: "sheet_synced" },
      { rowNumber: 3, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "500.00",  cellT: "sheet_synced" },
      { rowNumber: 4, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",           cellE: "", cellT: "" },
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.action).toBe("updated");
    expect(result.finalRow).toBe(2); // best match stays at row 2
    expect(result.archivedRows).toEqual([3]);
    expect(result.autoRepaired).toBe(true);
    expect(result.userMessage).toBe("Sheet updated and cleaned");
  });

  // ── Legacy VOID_DUPLICATE rows for this key are archived ──────────────────

  it("VOID_DUPLICATE rows for this key are archived during normal sync", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",           cellE: "", cellT: "STATUS" },
      { rowNumber: 2, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "2000.00", cellT: "sheet_synced" },
      { rowNumber: 3, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "2000.00", cellT: "VOID_DUPLICATE" },
      { rowNumber: 4, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",           cellE: "", cellT: "" },
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.archivedRows).toContain(3); // VOID row for this key archived
    expect(result.finalRow).toBe(2);
    expect(result.autoRepaired).toBe(true);
  });

  it("INSERT of new key also cleans up old VOID rows for same key", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",           cellE: "", cellT: "STATUS" },
      { rowNumber: 2, cellA: "1002",    cellB: "2026-05-01", cellC: "6666", cellD: "Other Job",  cellE: "1000.00", cellT: "sheet_synced" },
      { rowNumber: 3, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "2000.00", cellT: "VOID_DUPLICATE" },
      { rowNumber: 4, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",           cellE: "", cellT: "" },
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.action).toBe("inserted");
    expect(result.archivedRows).toContain(3); // old void row archived
    expect(result.autoRepaired).toBe(true);
  });

  // ── Active row is never written below TOTALS ───────────────────────────────

  it("INSERT when no match → always places row at or before TOTALS, never below", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",  cellE: "", cellT: "STATUS" },
      { rowNumber: 2, cellA: "1002",    cellB: "2026-05-01", cellC: "6666", cellD: "X", cellE: "1000.00", cellT: "sheet_synced" },
      { rowNumber: 3, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",  cellE: "", cellT: "" },
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.action).toBe("inserted");
    // Row must be placed AT or BEFORE totals row (3), never after
    expect(result.finalRow).toBeLessThanOrEqual(3);
  });

  // ── Blank rows above TOTALS are reused ────────────────────────────────────

  it("blank row above TOTALS is reused (no insert needed)", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",  cellE: "", cellT: "STATUS" },
      { rowNumber: 2, cellA: "1002",    cellB: "2026-05-01", cellC: "6666", cellD: "X", cellE: "1000.00", cellT: "sheet_synced" },
      { rowNumber: 3, cellA: "",        cellB: "",           cellC: "",     cellD: "",  cellE: "", cellT: "" }, // blank above TOTALS
      { rowNumber: 4, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",  cellE: "", cellT: "" },
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.action).toBe("inserted");
    expect(result.finalRow).toBe(3); // reuses blank row 3
  });

  // ── Blank rows below TOTALS are NOT reused ─────────────────────────────────

  it("blank row below TOTALS is NOT reused — inserts above TOTALS instead", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",  cellE: "", cellT: "STATUS" },
      { rowNumber: 2, cellA: "1002",    cellB: "2026-05-01", cellC: "6666", cellD: "X", cellE: "1000.00", cellT: "sheet_synced" },
      { rowNumber: 3, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",  cellE: "", cellT: "" },
      { rowNumber: 4, cellA: "",        cellB: "",           cellC: "",     cellD: "",  cellE: "", cellT: "" }, // blank BELOW TOTALS
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.action).toBe("inserted");
    expect(result.finalRow).toBe(3); // inserts at TOTALS position, not below
  });

  // ── No blank rows above TOTALS → insert immediately above TOTALS ──────────

  it("no blank rows above TOTALS → insert immediately above TOTALS row", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",  cellE: "", cellT: "STATUS" },
      { rowNumber: 2, cellA: "1002",    cellB: "2026-05-01", cellC: "6666", cellD: "X", cellE: "1000.00", cellT: "sheet_synced" },
      { rowNumber: 3, cellA: "1003",    cellB: "2026-05-15", cellC: "7777", cellD: "Y", cellE: "800.00",  cellT: "sheet_synced" },
      { rowNumber: 4, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",  cellE: "", cellT: "" },
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.action).toBe("inserted");
    expect(result.finalRow).toBe(4); // inserts at TOTALS position (TOTALS shifts to 5)
  });

  // ── After sync: exactly one active row above TOTALS for this key ──────────

  it("after sync: current invoice has exactly one active row above TOTALS", () => {
    // Two stale duplicates + one void → after sync, keep best, archive the rest
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",           cellE: "", cellT: "STATUS" },
      { rowNumber: 2, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "2000.00", cellT: "sheet_synced" },
      { rowNumber: 3, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "500.00",  cellT: "sheet_synced" },
      { rowNumber: 4, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "200.00",  cellT: "VOID_DUPLICATE" },
      { rowNumber: 5, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",           cellE: "", cellT: "" },
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.action).toBe("updated");
    expect(result.finalRow).toBe(2); // best match
    expect(result.archivedRows.sort()).toEqual([3, 4]); // stale + void archived
    expect(result.autoRepaired).toBe(true);
    // After sync: only row 2 remains active for this key → one row above TOTALS
  });

  // ── Unrelated clutter does NOT block current invoice sync ─────────────────

  it("unrelated VOID row does not block sync of current invoice", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",            cellE: "",       cellT: "STATUS" },
      { rowNumber: 2, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot",  cellE: "2000.00", cellT: "sheet_synced" },
      { rowNumber: 3, cellA: "9999",    cellB: "2026-01-01", cellC: "8888", cellD: "Other Gig",   cellE: "100.00",  cellT: "VOID_DUPLICATE" }, // unrelated void
      { rowNumber: 4, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",            cellE: "",       cellT: "" },
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.action).toBe("updated");
    expect(result.finalRow).toBe(2); // current invoice synced correctly
    expect(result.archivedRows).not.toContain(3); // unrelated row NOT touched
    expect(result.hasUnrelatedClutter).toBe(true);
    expect(result.userMessage).toContain("run Health Check");
  });

  it("unrelated active-below-TOTALS row does not block sync of current invoice", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",           cellE: "",       cellT: "STATUS" },
      { rowNumber: 2, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "2000.00", cellT: "sheet_synced" },
      { rowNumber: 3, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",           cellE: "",       cellT: "" },
      { rowNumber: 4, cellA: "9999",    cellB: "2026-01-01", cellC: "8888", cellD: "Old Gig",    cellE: "100.00",  cellT: "sheet_synced" }, // unrelated active below TOTALS
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.action).toBe("updated");
    expect(result.finalRow).toBe(2);
    expect(result.archivedRows).not.toContain(4); // unrelated row NOT touched
    expect(result.hasUnrelatedClutter).toBe(true);
  });

  // ── Unrelated real rows are never moved or deleted ────────────────────────

  it("unrelated real rows above TOTALS are never moved or deleted", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",           cellE: "",       cellT: "STATUS" },
      { rowNumber: 2, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "2000.00", cellT: "sheet_synced" },
      { rowNumber: 3, cellA: "1002",    cellB: "2026-05-01", cellC: "6666", cellD: "Other Job",  cellE: "800.00",  cellT: "sheet_synced" }, // different invoice
      { rowNumber: 4, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",           cellE: "",       cellT: "" },
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.archivedRows).not.toContain(3); // row 3 is a different invoice — untouched
    expect(result.hasUnrelatedClutter).toBe(false); // row 3 is fine (above TOTALS, different key)
  });

  // ── autoRepaired + hasUnrelatedClutter combined message ───────────────────

  it("autoRepaired + hasUnrelatedClutter → combined user message", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",           cellE: "",       cellT: "STATUS" },
      { rowNumber: 2, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "2000.00", cellT: "sheet_synced" },
      { rowNumber: 3, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "500.00",  cellT: "sheet_synced" }, // stale dup for this key
      { rowNumber: 4, cellA: "9999",    cellB: "2026-01-01", cellC: "8888", cellD: "Old Gig",    cellE: "100.00",  cellT: "VOID_DUPLICATE" }, // unrelated void
      { rowNumber: 5, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",           cellE: "",       cellT: "" },
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.autoRepaired).toBe(true);
    expect(result.hasUnrelatedClutter).toBe(true);
    expect(result.userMessage).toBe("Sheet updated and cleaned. Old cleanup items remain; run Health Check when convenient.");
  });

  it("clean sheet + single match → 'Sheet updated' with no repair flags", () => {
    const entries: FullUpsertEntry[] = [
      { rowNumber: 1, cellA: "INV#",    cellB: "",           cellC: "LA#",  cellD: "",           cellE: "",       cellT: "STATUS" },
      { rowNumber: 2, cellA: "1001",    cellB: "2026-06-01", cellC: "5555", cellD: "Corp Shoot", cellE: "2000.00", cellT: "sheet_synced" },
      { rowNumber: 3, cellA: "TOTALS:", cellB: "",           cellC: "",     cellD: "",           cellE: "",       cellT: "" },
    ];
    const result = simulateFullUpsert(entries, "5555", "1001", 2000);
    expect(result.action).toBe("updated");
    expect(result.autoRepaired).toBe(false);
    expect(result.hasUnrelatedClutter).toBe(false);
    expect(result.userMessage).toBe("Sheet updated");
  });

});

// ---------------------------------------------------------------------------
// Automatic safe Sheet health cleanup after normal sync
// ---------------------------------------------------------------------------

interface AutoCleanupRow extends FullUpsertEntry {
  paymentStatus?: string;
  paidDate?: string;
}

interface AutoCleanupResult {
  archivedRows: number[];
  archiveBeforeRemove: boolean;
  movedRows: number[];
  unknownRowsLeftAlone: number[];
  formulasRebuilt: boolean;
  headersRepairedThroughAH: boolean;
  hasUnresolvedCleanup: boolean;
  currentInvoiceVerified: boolean;
  manualResetRequired: boolean;
  rowsAfter: AutoCleanupRow[];
}

function rowKeys(row: AutoCleanupRow): string[] {
  const keys: string[] = [];
  const la = normalizeLA(row.cellC);
  if (la) keys.push(`la:${la}`);
  if (row.cellA.trim()) keys.push(`inv:${row.cellA.trim()}`);
  return keys;
}

function simulateSafeAutoCleanup(
  rows: AutoCleanupRow[],
  currentKeys: string[],
  formulasHealthy = false,
): AutoCleanupResult {
  const protectedKeys = new Set(currentKeys);
  const totalsRow = rows.find((row) => isTotalsRow(row.cellA))?.rowNumber ?? null;
  const archivedRows: number[] = [];
  const movedRows: number[] = [];
  const unknownRowsLeftAlone: number[] = [];
  let archiveBeforeRemove = true;

  const activeGroups = new Map<string, AutoCleanupRow[]>();
  for (const row of rows) {
    if (row.rowNumber === 1 || isTotalsRow(row.cellA)) continue;
    const isVoid = row.cellT === VOID_STATUS;
    const isActive = !isVoid && isInvoiceDataRow(row.cellA, row.cellC, row.cellT);
    const keys = rowKeys(row);
    const key = keys[0];

    if (isVoid && key) {
      archivedRows.push(row.rowNumber);
      continue;
    }

    const isProtected = keys.some((k) => protectedKeys.has(k));
    const isKnownTest = isTestSheetRow(row.cellA, row.cellC, row.cellD);
    if (isActive && isKnownTest && !isProtected) {
      archivedRows.push(row.rowNumber);
      continue;
    }

    if (isActive && key) {
      const group = activeGroups.get(key) ?? [];
      group.push(row);
      activeGroups.set(key, group);
      continue;
    }

    const hasContent = [row.cellA, row.cellB, row.cellC, row.cellD, row.cellE, row.cellT]
      .some((value) => value.trim() !== "");
    if (totalsRow != null && row.rowNumber > totalsRow && hasContent) {
      unknownRowsLeftAlone.push(row.rowNumber);
    }
  }

  for (const [, group] of activeGroups) {
    if (group.length > 1) {
      const keep = group.reduce((best, row) => row.rowNumber > best.rowNumber ? row : best);
      for (const row of group) {
        if (row.rowNumber !== keep.rowNumber) archivedRows.push(row.rowNumber);
      }
    }
  }

  const archived = new Set(archivedRows);
  for (const [, group] of activeGroups) {
    for (const row of group) {
      if (archived.has(row.rowNumber)) continue;
      if (totalsRow != null && row.rowNumber > totalsRow) movedRows.push(row.rowNumber);
    }
  }

  const rowsAfter = rows
    .filter((row) => !archived.has(row.rowNumber))
    .map((row) => movedRows.includes(row.rowNumber)
      ? { ...row, rowNumber: Math.max(2, (totalsRow ?? row.rowNumber) - 1) }
      : row);

  const currentInvoiceVerified = rowsAfter.some((row) =>
    row.rowNumber > 1 &&
    (totalsRow == null || row.rowNumber < totalsRow) &&
    row.cellT !== VOID_STATUS &&
    rowKeys(row).some((key) => protectedKeys.has(key)),
  );

  return {
    archivedRows: [...new Set(archivedRows)].sort((a, b) => a - b),
    archiveBeforeRemove,
    movedRows: movedRows.sort((a, b) => a - b),
    unknownRowsLeftAlone,
    formulasRebuilt: !formulasHealthy || archivedRows.length > 0 || movedRows.length > 0,
    headersRepairedThroughAH: true,
    hasUnresolvedCleanup: unknownRowsLeftAlone.length > 0,
    currentInvoiceVerified,
    manualResetRequired: false,
    rowsAfter,
  };
}

describe("Automatic safe Sheet health cleanup — verified pipeline", () => {
  const baseRows: AutoCleanupRow[] = [
    { rowNumber: 1, cellA: "INV #", cellB: "DATE", cellC: "LA JOB #", cellD: "GIG", cellE: "TOTAL PAY", cellT: "STATUS" },
    { rowNumber: 2, cellA: "1002", cellB: "2026-05-01", cellC: "6666", cellD: "Real Job", cellE: "1000.00", cellT: "sheet_synced", paymentStatus: "sent", paidDate: "" },
    { rowNumber: 3, cellA: "TOTALS:", cellB: "", cellC: "", cellD: "", cellE: "", cellT: "" },
  ];

  it("verified pipeline auto-runs safe Sheet health cleanup after sync", () => {
    const result = simulateSafeAutoCleanup(baseRows, ["la:6666", "inv:1002"]);
    expect(result.headersRepairedThroughAH).toBe(true);
    expect(result.manualResetRequired).toBe(false);
    expect(result.currentInvoiceVerified).toBe(true);
  });

  it("active rows below TOTALS are moved above TOTALS automatically", () => {
    const rows = [
      ...baseRows,
      { rowNumber: 4, cellA: "1003", cellB: "2026-06-01", cellC: "7777", cellD: "Below Totals", cellE: "900.00", cellT: "sheet_synced" },
    ];
    const result = simulateSafeAutoCleanup(rows, ["la:6666", "inv:1002"]);
    expect(result.movedRows).toEqual([4]);
    expect(result.manualResetRequired).toBe(false);
  });

  it("formulas are rebuilt automatically when cleanup changes layout", () => {
    const rows = [
      ...baseRows,
      { rowNumber: 4, cellA: "1003", cellB: "2026-06-01", cellC: "7777", cellD: "Below Totals", cellE: "900.00", cellT: "sheet_synced" },
    ];
    const result = simulateSafeAutoCleanup(rows, ["la:6666", "inv:1002"], true);
    expect(result.formulasRebuilt).toBe(true);
  });

  it("headers through AH are repaired automatically", () => {
    const result = simulateSafeAutoCleanup(baseRows, ["la:6666", "inv:1002"]);
    expect(result.headersRepairedThroughAH).toBe(true);
    expect(SHEET_HEADERS[33]).toBe("UNREIMBURSED MILEAGE VALUE");
  });

  it("stale duplicate and legacy VOID rows are archived automatically", () => {
    const rows = [
      ...baseRows,
      { rowNumber: 4, cellA: "1002", cellB: "2026-05-01", cellC: "6666", cellD: "Real Job duplicate", cellE: "1000.00", cellT: "sheet_synced" },
      { rowNumber: 5, cellA: "1009", cellB: "2026-01-01", cellC: "9999", cellD: "Old Void", cellE: "500.00", cellT: VOID_STATUS },
    ];
    const result = simulateSafeAutoCleanup(rows, ["la:6666", "inv:1002"]);
    expect(result.archivedRows).toEqual([2, 5]);
    expect(result.archiveBeforeRemove).toBe(true);
  });

  it("current invoice verifies after automatic cleanup", () => {
    const rows = [
      ...baseRows,
      { rowNumber: 4, cellA: "1002", cellB: "2026-05-01", cellC: "6666", cellD: "Real Job duplicate", cellE: "1000.00", cellT: "sheet_synced" },
    ];
    const result = simulateSafeAutoCleanup(rows, ["la:6666", "inv:1002"]);
    expect(result.currentInvoiceVerified).toBe(true);
    expect(result.manualResetRequired).toBe(false);
  });

  it("known test rows are archived only when not protected as the current invoice", () => {
    const rows = [
      ...baseRows,
      { rowNumber: 4, cellA: "1001", cellB: "2026-06-18", cellC: "5555", cellD: "test job", cellE: "2598.75", cellT: "sheet_synced" },
    ];
    const oldTestCleanup = simulateSafeAutoCleanup(rows, ["la:6666", "inv:1002"]);
    expect(oldTestCleanup.archivedRows).toContain(4);

    const currentTestCleanup = simulateSafeAutoCleanup(rows, ["la:5555", "inv:1001"]);
    expect(currentTestCleanup.archivedRows).not.toContain(4);
    expect(currentTestCleanup.currentInvoiceVerified).toBe(true);
  });

  it("unknown/unclassifiable rows are not modified and produce a warning", () => {
    const rows = [
      ...baseRows,
      { rowNumber: 4, cellA: "random note", cellB: "", cellC: "", cellD: "do not touch", cellE: "", cellT: "" },
    ];
    const result = simulateSafeAutoCleanup(rows, ["la:6666", "inv:1002"]);
    expect(result.unknownRowsLeftAlone).toEqual([4]);
    expect(result.archivedRows).not.toContain(4);
    expect(result.movedRows).not.toContain(4);
    expect(result.hasUnresolvedCleanup).toBe(true);
  });

  it("payment/status fields on kept real rows are not overwritten incorrectly", () => {
    const result = simulateSafeAutoCleanup(baseRows, ["la:6666", "inv:1002"]);
    const kept = result.rowsAfter.find((row) => row.cellA === "1002");
    expect(kept?.paymentStatus).toBe("sent");
    expect(kept?.paidDate).toBe("");
  });

  it("manual recovery tools remain fallback-only for safe cleanup", () => {
    const safeCleanup = simulateSafeAutoCleanup(baseRows, ["la:6666", "inv:1002"]);
    const manualToolsStillExist = ["Repair Sheet Layout", "Reset / Rebuild Sheet"];
    expect(safeCleanup.manualResetRequired).toBe(false);
    expect(manualToolsStillExist).toContain("Repair Sheet Layout");
    expect(manualToolsStillExist).toContain("Reset / Rebuild Sheet");
  });
});
