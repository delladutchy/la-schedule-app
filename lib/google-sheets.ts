import "server-only";
import { getStore } from "@netlify/blobs";
import { google } from "googleapis";
import type { SheetRow } from "./invoice-types";

/**
 * Google Sheets sync for invoice rows.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  — service account email with Sheets Editor access
 *   GOOGLE_SHEET_ID               — spreadsheet ID from the URL
 *   GOOGLE_SHEET_NAME             — tab name (default: "LA PAY (2026)")
 *
 * GOOGLE_PRIVATE_KEY is read from env first; if absent, falls back to Netlify
 * Blobs ("app-secrets" / "google-private-key"). This lets you remove the key
 * from Netlify env vars (keeping Lambda payloads under the 4KB AWS limit) after
 * running POST /api/admin/migrate-sheets-key once.
 */

export const SHEETS_KEY_STORE = "app-secrets";
export const SHEETS_KEY_BLOB  = "google-private-key";

const SHEET_NAME = process.env.GOOGLE_SHEET_NAME ?? "LA PAY (2026)";

// Sheet names with spaces or parens must be single-quoted in A1 notation.
const QUOTED_SHEET_NAME = `'${SHEET_NAME}'`;

// Tax-row column layout (A–U, indices 0–20 — NEVER REORDER):
//   A  INV#            B  DATE           C  LA JOB#        D  GIG
//   E  TOTAL PAY       F  LABOR          G  OT             H  PER DIEM
//   I  MILEAGE ($)     J  PARKING        K  HOTEL          L  TOLLS
//   M  BAG FEES        N  UBER           O  OTHER EXPENSES
//   P  TOTAL MILES     Q  LA PAID MILES  R  UNREIMBURSED MILEAGE (miles)
//   S  MILEAGE PAID$   T  STATUS         U  PAID DATE
//
// Native invoicing columns (V–AB, indices 21–27):
//   V  PDF LINK   W  SENT DATE   X  AMOUNT PAID   Y  REMAINING BALANCE
//   Z  PAYMENT METHOD   AA  PAYMENT RECEIVED DATE   AB  PAYMENT BATCH REF
//
// Optional extended columns (AC–AG, indices 28–32):
//   AC  SENT TO   AD  SENT SUBJECT   AE  JOB NAME OVERRIDE
//   AF  DAY RATE DESC OVERRIDE   AG  INVOICE NOTE OVERRIDE
//
// Tax deduction column (AH, index 33 — optional, added after existing columns):
//   AH  UNREIMBURSED MILEAGE VALUE (unreimbursed miles × IRS standard rate)
const COLUMN_ORDER: Array<keyof SheetRow> = [
  "invoiceNumber",       // A
  "date",               // B
  "laJobNumber",        // C
  "gigEvent",           // D
  "totalPay",           // E
  "labor",              // F
  "ot",                 // G
  "perDiem",            // H
  "mileage",            // I — mileage dollars charged to LA
  "parking",            // J
  "hotel",              // K
  "tolls",              // L
  "bagFees",            // M
  "uber",               // N
  "otherExpenses",      // O
  "totalBusinessMiles", // P — total miles driven (miles, not dollars)
  "laPaidMiles",        // Q — miles LA reimbursed (miles, not dollars)
  "unreimbursedMiles",  // R — totalMiles − laPaidMiles (miles, NOT dollars)
  "mileagePaid",        // S — mileage dollars LA paid (same as col I)
  "status",             // T
  "paidDate",           // U
  // Native invoicing columns — appended at right; existing rows leave them blank.
  "invoicePdfUrl",          // V
  "invoiceSentDate",        // W
  "amountPaid",             // X
  "remainingBalance",       // Y
  "paymentMethod",          // Z
  "paymentReceivedDate",    // AA
  "paymentBatchRef",        // AB
  // Optional extended columns (AC–AG).
  "sentTo",                        // AC
  "sentSubject",                   // AD
  "jobNameOverride",               // AE
  "dayRateDescriptionOverride",    // AF
  "noteOverride",                  // AG
  // Tax deduction column (AH) — unreimbursed miles × IRS standard mileage rate.
  "unreimbursedMileageValue",      // AH
];

// ---------------------------------------------------------------------------
// Row-matching helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an LA number for comparison.
 * "LA#5555", "LA #5555", "5555" all normalize to "5555".
 * This prevents duplicates caused by format mismatches between syncs.
 */
export function normalizeLA(la: string): string {
  return la.replace(/^LA\s*#?\s*/i, "").trim();
}

/**
 * STATUS value written to col T when a row is automatically voided during sync
 * because a better (more-current) row exists for the same invoice key.
 * Voided rows have all money columns zeroed so plain SUM formulas exclude them.
 */
export const VOID_STATUS = "VOID_DUPLICATE";

/**
 * Name of the archive tab where stale duplicate rows are moved during sync.
 * Rows land here instead of cluttering the main Sheet with VOID_DUPLICATE markers.
 */
export const ARCHIVE_SHEET_NAME = "Voided Duplicates";
const QUOTED_ARCHIVE_SHEET_NAME = `'${ARCHIVE_SHEET_NAME}'`;

/**
 * True if a sheet row looks like an active invoice data row rather than a
 * totals/summary row or an auto-voided duplicate.
 *
 * cellA = col A (INV#), cellC = col C (LA Job#), cellT = col T (STATUS, optional).
 * Rows with STATUS = VOID_STATUS are always skipped — they represent stale
 * duplicates that the app has already zeroed out for tax accuracy.
 */
export function isInvoiceDataRow(cellA: string, cellC: string, cellT?: string): boolean {
  if (cellT?.trim() === VOID_STATUS) return false; // voided — never count
  if (cellC.trim()) return true;               // col C (LA#) present → invoice row
  const a = cellA.trim();
  if (!a) return false;
  return /^\d/.test(a) || /^JU-/i.test(a);    // numeric or JU-format invoice number
}

/**
 * Returns true when col A of a row is the TOTALS summary line.
 * Matches "TOTALS:", "TOTALS", "TOTAL", etc. (case-insensitive).
 */
export function isTotalsRow(cellA: string): boolean {
  const t = cellA.trim().toUpperCase();
  return t.startsWith("TOTALS") || t === "TOTAL";
}

/**
 * Build the 34-column value array written to a stale duplicate row to neutralise it.
 * - Keeps cols A–D (INV#, DATE, LA#, GIG) so the row is still identifiable.
 * - Zeros all money columns E–S so SUM formulas exclude this row automatically.
 * - Sets col T (STATUS) = VOID_STATUS.
 * - Clears cols U–AH (payment tracking, extended fields, tax column).
 */
export function buildVoidRowValues(
  cellA: string,
  cellB: string,
  cellC: string,
  cellD: string,
): (string | number)[] {
  const ncols = COLUMN_ORDER.length; // 34
  const row: (string | number)[] = new Array(ncols).fill("");
  row[0] = cellA; // A: INV# (kept for identification)
  row[1] = cellB; // B: DATE (kept)
  row[2] = cellC; // C: LA# (kept)
  row[3] = cellD; // D: GIG (kept)
  for (let i = 4; i <= 18; i++) row[i] = 0; // E–S: all money columns → 0
  row[19] = VOID_STATUS;                      // T: STATUS = "VOID_DUPLICATE"
  // U–AH (indices 20–33): already "" from fill — dates and text stay empty
  return row;
}

// ---------------------------------------------------------------------------
// Auth / client helpers
// ---------------------------------------------------------------------------

async function getPrivateKey(): Promise<string> {
  // Env var takes priority — required for local dev and during migration window.
  const envKey = process.env.GOOGLE_PRIVATE_KEY;
  if (envKey) return envKey;

  // Fallback: Netlify Blobs (production after env var removal).
  try {
    const store = getStore(SHEETS_KEY_STORE);
    const key = await store.get(SHEETS_KEY_BLOB);
    if (key) return key;
  } catch {
    // Blobs unavailable (local dev without netlify dev context).
  }

  throw new Error(
    "[google-sheets] GOOGLE_PRIVATE_KEY not found in env or Netlify Blobs. " +
    "Set the env var, or call POST /api/admin/migrate-sheets-key to upload it.",
  );
}

async function getSheetAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (!email) {
    throw new Error("[google-sheets] GOOGLE_SERVICE_ACCOUNT_EMAIL must be set");
  }
  const rawKey = await getPrivateKey();
  const privateKey = rawKey.replace(/\\n/g, "\n");
  return new google.auth.GoogleAuth({
    credentials: { client_email: email, private_key: privateKey },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function rowToValues(row: SheetRow): (string | number)[] {
  return COLUMN_ORDER.map((key) => {
    const val = row[key];
    if (val == null) return "";
    return val;
  });
}

// ---------------------------------------------------------------------------
// Main upsert
// ---------------------------------------------------------------------------

export interface UpsertSheetRowResult {
  action: "updated" | "inserted";
  rowNumber: number;
  /** True when stale duplicate rows were found and archived during sync. */
  hasDuplicates: boolean;
  /** Row numbers that were archived to "Voided Duplicates" tab and removed from main sheet. */
  archivedRows: number[];
}

// Score a candidate sheet row for selection as the "keep" row when multiple
// non-void rows match the same invoice key. Higher score = better candidate.
// Factors (descending weight): LA# match > invoice# match > total match > date recency > row position.
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
  if (dateMs !== null) score += dateMs / 1e13;  // small recency boost
  if (incomingTotal != null) {
    const tIn = typeof incomingTotal === "number" ? incomingTotal : parseFloat(String(incomingTotal));
    const tEx = parseFloat(cellE.replace(/[$,\s]/g, ""));
    if (!isNaN(tIn) && !isNaN(tEx) && Math.abs(tEx - tIn) < 0.01) score += 50;
  }
  score += rowNumber * 0.0001;  // prefer highest row (most recently inserted) as final tiebreaker
  return score;
}

/**
 * Upsert one invoice row in the Google Sheet.
 *
 * Stable key: normalised LA job # (col C) first; invoice number (col A) as
 * fallback for rows written before a LA # was recorded.  Both keys are
 * normalised to prevent format-mismatch duplicates ("5555" vs "LA#5555").
 *
 * AUTOMATIC DUPLICATE HANDLING:
 * If multiple non-voided rows match the same key, the highest-scoring row is
 * updated with current data.  All other matching rows are immediately voided:
 * their money columns (E–S) are zeroed so existing SUM formulas exclude them,
 * and their STATUS (col T) is set to VOID_STATUS.  No manual cleanup needed.
 *
 * New rows are inserted with insertDimension immediately after the last
 * detected invoice-data row, so they are never placed inside totals/summary
 * sections.
 *
 * Throws on auth/API failure so the caller can surface/log the error.
 */
export async function upsertSheetRow(row: SheetRow): Promise<UpsertSheetRowResult> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("[google-sheets] GOOGLE_SHEET_ID must be set");

  const auth = await getSheetAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Normalise the incoming keys once.
  const incomingLa  = normalizeLA(row.laJobNumber);
  const incomingInv = String(row.invoiceNumber ?? "").trim();

  if (!incomingLa && !incomingInv) {
    throw new Error(
      "[google-sheets] upsertSheetRow: both laJobNumber and invoiceNumber are empty. " +
      "Cannot safely upsert without a stable row key.",
    );
  }

  // Parallel reads: spreadsheet metadata (needed for insertDimension's numeric sheet ID)
  // + columns A:T (INV# through STATUS) for duplicate detection, void-row detection,
  // placement, and keep-row scoring.
  const [spreadsheetRes, readRes] = await Promise.all([
    sheets.spreadsheets.get({ spreadsheetId: sheetId }),
    sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${QUOTED_SHEET_NAME}!A:T`,
    }),
  ]);

  const tabMeta = spreadsheetRes.data.sheets?.find(
    (s) => s.properties?.title === SHEET_NAME,
  );
  if (!tabMeta || tabMeta.properties?.sheetId == null) {
    throw new Error(
      `[google-sheets] Tab "${SHEET_NAME}" not found in spreadsheet. ` +
      `Check GOOGLE_SHEET_NAME env var (currently: "${SHEET_NAME}").`,
    );
  }
  const numericTabId = tabMeta.properties.sheetId;

  const existingRows = readRes.data.values ?? [];

  // Pass 1: Locate the TOTALS row so all active data rows are guaranteed to land above it.
  let totalsRowNum = -1;
  for (let i = 1; i < existingRows.length; i++) {
    if (isTotalsRow(String(existingRows[i]?.[0] ?? "").trim())) { totalsRowNum = i + 1; break; }
  }

  // Active rows matching this invoice's key → candidates for the "keep" selection.
  const matchingRows: Array<{
    rowNumber: number;
    score:     number;
    cellA: string; cellB: string; cellC: string; cellD: string;
    cellE: string; cellT: string;
  }> = [];

  // Old VOID_DUPLICATE rows on the main sheet for this key → clean them up too.
  const oldVoidRows: ArchiveEntry[] = [];

  // lastDataRow tracks only rows ABOVE the TOTALS line for INSERT placement.
  let lastDataRow = 1;

  for (let i = 1; i < existingRows.length; i++) {
    const cellA = String(existingRows[i]?.[0]  ?? "").trim(); // A: INV#
    const cellB = String(existingRows[i]?.[1]  ?? "").trim(); // B: DATE
    const cellC = String(existingRows[i]?.[2]  ?? "").trim(); // C: LA Job #
    const cellD = String(existingRows[i]?.[3]  ?? "").trim(); // D: GIG
    const cellE = String(existingRows[i]?.[4]  ?? "").trim(); // E: TOTAL
    const cellT = String(existingRows[i]?.[19] ?? "").trim(); // T: STATUS
    const sheetsRow = i + 1;

    // Only advance lastDataRow for rows strictly above TOTALS.
    if (isInvoiceDataRow(cellA, cellC, cellT) && (totalsRowNum < 0 || sheetsRow < totalsRowNum)) {
      lastDataRow = sheetsRow;
    }

    const laMatch  = !!(incomingLa  && normalizeLA(cellC) === incomingLa);
    const invMatch = !!(incomingInv && cellA && cellA === incomingInv);

    if (cellT === VOID_STATUS) {
      // Collect old void rows for the same key so they are cleaned off the main sheet.
      if (laMatch || invMatch) {
        oldVoidRows.push({ rowNumber: sheetsRow, invNumber: cellA, date: cellB, laNumber: cellC, gigEvent: cellD, total: cellE, originalStatus: cellT });
      }
      continue;
    }

    if (laMatch || invMatch) {
      const score = scoreKeepRow(cellA, cellB, cellC, cellE, sheetsRow, incomingLa, incomingInv, row.totalPay);
      matchingRows.push({ rowNumber: sheetsRow, score, cellA, cellB, cellC, cellD, cellE, cellT });
    }
  }

  const values = [rowToValues(row)];

  if (matchingRows.length > 0) {
    // ── UPDATE the best-scored matching row ──────────────────────────────────
    const keepEntry = matchingRows.reduce((best, e) => e.score > best.score ? e : best);
    const staleActive = matchingRows.filter((m) => m.rowNumber !== keepEntry.rowNumber);

    // Write current invoice data to the kept row.
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${QUOTED_SHEET_NAME}!A${keepEntry.rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

    // ── ARCHIVE + DELETE all stale rows (active duplicates + old void rows) ──
    // Rows are moved to "Voided Duplicates" tab and deleted from the main sheet
    // so the main sheet stays clean and SUM formulas are never inflated.
    const allStale: ArchiveEntry[] = [
      ...staleActive.map((e) => ({ rowNumber: e.rowNumber, invNumber: e.cellA, date: e.cellB, laNumber: e.cellC, gigEvent: e.cellD, total: e.cellE, originalStatus: e.cellT })),
      ...oldVoidRows,
    ];
    if (allStale.length > 0) {
      await archiveAndDeleteRows(sheets, sheetId, numericTabId, allStale, spreadsheetRes.data.sheets);
    }

    return {
      action:        "updated",
      rowNumber:     keepEntry.rowNumber,
      hasDuplicates: staleActive.length > 0,
      archivedRows:  allStale.map((e) => e.rowNumber),
    };
  }

  // ── INSERT new row — always above the TOTALS line ────────────────────────
  //
  // First clean any old void rows for this key that are still on the main sheet.
  if (oldVoidRows.length > 0) {
    await archiveAndDeleteRows(sheets, sheetId, numericTabId, oldVoidRows, spreadsheetRes.data.sheets);
    // lastDataRow was calculated excluding void rows, so it remains valid after deletion.
  }

  // Check whether the row immediately after the last data row is a usable blank.
  // A blank row is only reused if it is strictly ABOVE the TOTALS line.
  const nextRowNum  = lastDataRow + 1;          // 1-indexed candidate row
  const nextIndex   = lastDataRow;              // 0-indexed position in existingRows
  const nextRow     = existingRows[nextIndex];
  const nextCellA   = String(nextRow?.[0]  ?? "").trim();
  const nextCellC   = String(nextRow?.[2]  ?? "").trim();
  const nextCellT   = String(nextRow?.[19] ?? "").trim();
  const nextIsAboveTotals = totalsRowNum < 0 || nextRowNum < totalsRowNum;
  const nextIsBlank = !nextCellA && !nextCellC && !nextCellT && nextIsAboveTotals;

  let newRowNumber: number;

  if (nextIsBlank) {
    // Reuse the existing blank row above TOTALS — no insertDimension needed.
    newRowNumber = nextRowNum;
  } else {
    // Insert a new blank row. Always go immediately above TOTALS when known,
    // so no active data ever lands in or below the TOTALS/summary area.
    const insertAbove    = totalsRowNum > 0 ? totalsRowNum : nextRowNum;
    const insertStart0   = insertAbove - 1; // 0-indexed: insert before this position
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          insertDimension: {
            range: {
              sheetId:    numericTabId,
              dimension:  "ROWS",
              startIndex: insertStart0,
              endIndex:   insertStart0 + 1,
            },
            inheritFromBefore: insertStart0 > 1,
          },
        }],
      },
    });
    newRowNumber = insertAbove; // new blank row is now at this 1-indexed position
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${QUOTED_SHEET_NAME}!A${newRowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  return {
    action:        "inserted",
    rowNumber:     newRowNumber,
    hasDuplicates: false,
    archivedRows:  [],
  };
}

// ---------------------------------------------------------------------------
// Targeted payment-status update
// ---------------------------------------------------------------------------

export interface SheetPaymentUpdate {
  laJobNumber:         string; // key to find the row (column C)
  invoiceNumber:       string; // column A — updated to fix any stale values
  status:              string; // column T
  paidDate:            string; // column U
  invoicePdfUrl:       string; // column V
  invoiceSentDate:     string; // column W
  amountPaid:          number; // column X
  remainingBalance:    number; // column Y
  paymentMethod:       string; // column Z
  paymentReceivedDate: string; // column AA
  paymentBatchRef:     string; // column AB
}

/**
 * Targeted update of payment columns (T:AB) in an existing sheet row.
 * Also refreshes column A (invoice number) in case it was generated in the old JU-format.
 *
 * Matches by normalised LA Job # (col C) first, then invoice number (col A).
 * No-op if the row does not exist yet — it will be written on the next full
 * upsertSheetRow call. Does NOT append new rows.
 *
 * Throws on auth/API failure so callers can catch and handle non-fatally.
 */
export async function updateSheetPaymentColumns(update: SheetPaymentUpdate): Promise<void> {
  const normLa = normalizeLA(update.laJobNumber);
  const normInv = update.invoiceNumber.trim();
  if (!normLa && !normInv) return; // can't find a row without a key

  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("[google-sheets] GOOGLE_SHEET_ID must be set");

  const auth = await getSheetAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${QUOTED_SHEET_NAME}!A:T`, // read through STATUS column to skip void rows
  });

  const rows = readRes.data.values ?? [];
  let matchRowIndex = -1;

  for (let i = 1; i < rows.length; i++) {
    const cellA = String(rows[i]?.[0]  ?? "").trim();
    const cellC = String(rows[i]?.[2]  ?? "").trim();
    const cellT = String(rows[i]?.[19] ?? "").trim(); // T: STATUS
    if (cellT === VOID_STATUS) continue; // skip voided rows — they are neutralised
    if (normLa && normalizeLA(cellC) === normLa) {
      matchRowIndex = i + 1;
      break;
    }
    if (normInv && cellA === normInv) {
      matchRowIndex = i + 1;
      break;
    }
  }

  if (matchRowIndex < 0) return; // row not in sheet yet — no-op

  // Columns T:AB = COLUMN_ORDER indices 19–27 (status → paymentBatchRef).
  // We also refresh column A (invoiceNumber) via a separate range.
  const tAbValues = [
    update.status,               // T  col 20
    update.paidDate,             // U  col 21
    update.invoicePdfUrl,        // V  col 22
    update.invoiceSentDate,      // W  col 23
    update.amountPaid,           // X  col 24
    update.remainingBalance,     // Y  col 25
    update.paymentMethod,        // Z  col 26
    update.paymentReceivedDate,  // AA col 27
    update.paymentBatchRef,      // AB col 28
  ];

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `${QUOTED_SHEET_NAME}!A${matchRowIndex}`, values: [[update.invoiceNumber]] },
        { range: `${QUOTED_SHEET_NAME}!T${matchRowIndex}:AB${matchRowIndex}`, values: [tAbValues] },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Duplicate-row report (read-only — never deletes)
// ---------------------------------------------------------------------------

export interface SheetDuplicateGroup {
  key: string;
  rows: Array<{ rowNumber: number; invNumber: string; laNumber: string; date: string; total: string; gigEvent?: string }>;
  keepRow: number;    // suggested row to keep (latest date or last in list)
  deleteRows: number[]; // row numbers safe to delete after review
}

type SheetDuplicateEntry = SheetDuplicateGroup["rows"][number];

function parseSheetDateValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function chooseSheetDuplicateRows(entries: SheetDuplicateEntry[]): {
  keepRow: number;
  deleteRows: number[];
} {
  if (entries.length === 0) return { keepRow: -1, deleteRows: [] };

  const keep = entries.reduce((best, entry) => {
    const bestDate = parseSheetDateValue(best.date);
    const entryDate = parseSheetDateValue(entry.date);

    if (entryDate != null && bestDate != null && entryDate !== bestDate) {
      return entryDate > bestDate ? entry : best;
    }
    if (entryDate != null && bestDate == null) return entry;
    if (entryDate == null && bestDate != null) return best;

    // Same or unparseable date: keep the lower-most row, which is the latest
    // physical insertion/sync under the current Sheet layout.
    return entry.rowNumber > best.rowNumber ? entry : best;
  }, entries[0]!);

  return {
    keepRow: keep.rowNumber,
    deleteRows: entries
      .filter((entry) => entry.rowNumber !== keep.rowNumber)
      .map((entry) => entry.rowNumber),
  };
}

/**
 * Reads the sheet and returns groups of duplicate rows (same invoice# or LA#).
 * READ-ONLY — never modifies the sheet. Use the result to decide which rows
 * to manually delete.
 */
export async function findSheetDuplicates(): Promise<SheetDuplicateGroup[]> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("[google-sheets] GOOGLE_SHEET_ID must be set");

  const auth = await getSheetAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${QUOTED_SHEET_NAME}!A:T`, // read through STATUS column to exclude void rows
  });

  const rows = readRes.data.values ?? [];

  // Group rows by (normalised LA# OR invoice#).
  const groups = new Map<string, Array<{ rowNumber: number; invNumber: string; laNumber: string; date: string; total: string }>>();

  for (let i = 1; i < rows.length; i++) {
    const cellA = String(rows[i]?.[0]  ?? "").trim();
    const cellB = String(rows[i]?.[1]  ?? "").trim();
    const cellC = String(rows[i]?.[2]  ?? "").trim();
    const cellD = String(rows[i]?.[3]  ?? "").trim(); // D: GIG
    const cellE = String(rows[i]?.[4]  ?? "").trim();
    const cellT = String(rows[i]?.[19] ?? "").trim();

    if (!isInvoiceDataRow(cellA, cellC, cellT)) continue;

    const normLa  = normalizeLA(cellC);
    const normInv = cellA;
    const key     = normLa ? `la:${normLa}` : normInv ? `inv:${normInv}` : null;
    if (!key) continue;

    const entry = { rowNumber: i + 1, invNumber: cellA, laNumber: cellC, date: cellB, total: cellE, gigEvent: cellD };
    const existing = groups.get(key) ?? [];
    existing.push(entry);
    groups.set(key, existing);
  }

  // Return only groups with more than one row.
  const duplicates: SheetDuplicateGroup[] = [];
  for (const [key, entries] of groups) {
    if (entries.length <= 1) continue;
    // Keep latest sync date when available; otherwise keep the lower-most row.
    const { keepRow, deleteRows } = chooseSheetDuplicateRows(entries);
    duplicates.push({ key, rows: entries, keepRow, deleteRows });
  }

  return duplicates;
}

export interface SheetDuplicateCleanupResult {
  before: SheetDuplicateGroup[];
  after: SheetDuplicateGroup[];
  deletedRows: number[];
}

/** Row data needed to write an entry to the archive tab. */
interface ArchiveEntry {
  rowNumber:      number;
  invNumber:      string;
  date:           string;
  laNumber:       string;
  gigEvent:       string;
  total:          string;
  originalStatus: string;
}

type SpreadsheetSheetList = Array<{
  properties?: { sheetId?: number | null; title?: string | null } | null;
}>;

/**
 * Create the "Voided Duplicates" archive tab if it doesn't already exist.
 * Writes a header row so the tab is readable at a glance.
 */
async function ensureArchiveTab(
  sheets:          ReturnType<typeof google.sheets>,
  sheetId:         string,
  existingSheets:  SpreadsheetSheetList | null | undefined,
): Promise<void> {
  if (existingSheets?.find((s) => s.properties?.title === ARCHIVE_SHEET_NAME)) return;

  const createRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: { title: ARCHIVE_SHEET_NAME, gridProperties: { frozenRowCount: 1 } },
        },
      }],
    },
  });
  if (createRes.data.replies?.[0]?.addSheet?.properties?.sheetId == null) {
    throw new Error("[google-sheets] Failed to create 'Voided Duplicates' archive tab");
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${QUOTED_ARCHIVE_SHEET_NAME}!A1:I1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [["Original Row", "Invoice #", "Date", "LA Job #", "Gig/Event", "Total", "Original Status", "Archive Status", "Archived At"]],
    },
  });
}

/**
 * Append entries to the "Voided Duplicates" archive tab (create tab if needed),
 * then delete those rows from the main sheet using the provided numeric tab ID.
 * Archive is written BEFORE deletion so data is never lost if delete fails.
 */
async function archiveAndDeleteRows(
  sheets:         ReturnType<typeof google.sheets>,
  sheetId:        string,
  numericTabId:   number,
  entries:        ArchiveEntry[],
  existingSheets: SpreadsheetSheetList | null | undefined,
): Promise<void> {
  if (entries.length === 0) return;

  // 1. Ensure archive tab exists.
  await ensureArchiveTab(sheets, sheetId, existingSheets);

  // 2. Append to archive tab.
  const timestamp = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${QUOTED_ARCHIVE_SHEET_NAME}!A:I`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: entries.map((e) => [
        e.rowNumber,
        e.invNumber,
        e.date,
        e.laNumber,
        e.gigEvent,
        e.total,
        e.originalStatus || "sheet_synced",
        VOID_STATUS,
        timestamp,
      ]),
    },
  });

  // 3. Delete from main sheet in descending row order so indices stay valid.
  const safeRows = [...new Set(entries.map((e) => e.rowNumber))]
    .filter((n) => Number.isInteger(n) && n > 1)
    .sort((a, b) => b - a);
  if (safeRows.length === 0) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: safeRows.map((rowNumber) => ({
        deleteDimension: {
          range: {
            sheetId: numericTabId,
            dimension: "ROWS",
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      })),
    },
  });
}

async function deleteSheetRows(rowNumbers: number[]): Promise<void> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("[google-sheets] GOOGLE_SHEET_ID must be set");

  const safeRows = [...new Set(rowNumbers)]
    .filter((rowNumber) => Number.isInteger(rowNumber) && rowNumber > 1)
    .sort((a, b) => b - a);
  if (safeRows.length === 0) return;

  const auth = await getSheetAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const spreadsheetRes = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const tabMeta = spreadsheetRes.data.sheets?.find(
    (s) => s.properties?.title === SHEET_NAME,
  );
  if (!tabMeta || tabMeta.properties?.sheetId == null) {
    throw new Error(
      `[google-sheets] Tab "${SHEET_NAME}" not found in spreadsheet. ` +
      `Check GOOGLE_SHEET_NAME env var (currently: "${SHEET_NAME}").`,
    );
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: safeRows.map((rowNumber) => ({
        deleteDimension: {
          range: {
            sheetId: tabMeta.properties!.sheetId!,
            dimension: "ROWS",
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      })),
    },
  });
}

/**
 * Archive stale duplicate rows to "Voided Duplicates" then delete them from main sheet.
 * Creates its own auth/sheets client so it can be called from any context.
 */
async function archiveAndDeleteByRows(entries: ArchiveEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("[google-sheets] GOOGLE_SHEET_ID must be set");

  const auth = await getSheetAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const spreadsheetRes = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const tabMeta = spreadsheetRes.data.sheets?.find((s) => s.properties?.title === SHEET_NAME);
  if (!tabMeta || tabMeta.properties?.sheetId == null) {
    throw new Error(`[google-sheets] Tab "${SHEET_NAME}" not found`);
  }

  await archiveAndDeleteRows(sheets, sheetId, tabMeta.properties.sheetId, entries, spreadsheetRes.data.sheets);
}

export async function deleteSheetDuplicateRows(requestedRows?: number[]): Promise<SheetDuplicateCleanupResult> {
  const before = await findSheetDuplicates();
  const recommendedRows = new Set(before.flatMap((g) => g.deleteRows));
  const requestedSet = requestedRows?.length
    ? new Set(requestedRows.filter((n) => Number.isInteger(n)))
    : null;
  const rowsToDelete = [...recommendedRows]
    .filter((n) => (requestedSet ? requestedSet.has(n) : true))
    .sort((a, b) => b - a);

  if (rowsToDelete.length > 0) {
    const toArchive: ArchiveEntry[] = before.flatMap((g) =>
      g.rows
        .filter((r) => rowsToDelete.includes(r.rowNumber))
        .map((r) => ({
          rowNumber:      r.rowNumber,
          invNumber:      r.invNumber,
          date:           r.date,
          laNumber:       r.laNumber,
          gigEvent:       r.gigEvent ?? "",
          total:          r.total,
          originalStatus: "sheet_synced",
        })),
    );
    await archiveAndDeleteByRows(toArchive);
  }

  const after = rowsToDelete.length > 0 ? await findSheetDuplicates() : before;
  return { before, after, deletedRows: rowsToDelete };
}

/**
 * Delete duplicate rows for one specific invoice key only.
 * Safe for invoice-specific cleanup: archives + deletes nothing outside the matching group.
 *
 * @param invoiceKey — canonical key from findSheetDuplicates, e.g. "la:5555" or "inv:1001"
 */
export async function deleteSheetDuplicatesForKey(invoiceKey: string): Promise<SheetDuplicateCleanupResult> {
  const before = await findSheetDuplicates();
  const group = before.find((g) => g.key === invoiceKey);

  if (!group || group.deleteRows.length === 0) {
    return { before, after: before, deletedRows: [] };
  }

  const toArchive: ArchiveEntry[] = group.rows
    .filter((r) => group.deleteRows.includes(r.rowNumber))
    .map((r) => ({
      rowNumber:      r.rowNumber,
      invNumber:      r.invNumber,
      date:           r.date,
      laNumber:       r.laNumber,
      gigEvent:       r.gigEvent ?? "",
      total:          r.total,
      originalStatus: "sheet_synced",
    }));

  await archiveAndDeleteByRows(toArchive);
  const after = await findSheetDuplicates();

  return { before, after, deletedRows: group.deleteRows };
}

// ---------------------------------------------------------------------------
// Sheet health report (read-only, no side effects)
// ---------------------------------------------------------------------------

export interface SheetHealthEntry {
  rowNumber: number;
  invNumber: string;
  laNumber: string;
  date: string;
  total: string;   // raw col E value
  status: string;  // col T
}

export interface SheetHealthGroup {
  key: string;
  activeRows: SheetHealthEntry[];
  voidedRows: SheetHealthEntry[];
  /** Active row that sync would update (highest row# = final tiebreaker). */
  syncRow: number | null;
  hasOneActiveRow: boolean;
  /** True when all voided rows have zero or empty total — confirms SUM formulas are safe. */
  voidedRowsHaveZeroTotal: boolean;
}

export interface SheetHealthReport {
  totalActiveRows: number;
  /** Rows on the main sheet still marked VOID_DUPLICATE (should be 0 after cleanup). */
  totalVoidedRows: number;
  /** Rows archived to "Voided Duplicates" tab. */
  totalArchivedRows: number;
  totalUniqueKeys: number;
  activeDuplicateCount: number;
  /** Number of voided rows that still have a non-zero total — should always be 0. */
  voidedRowsWithMoneyCount: number;
  groups: SheetHealthGroup[];
  activeDuplicateGroups: SheetHealthGroup[];
  /**
   * True when: no active duplicates, no void rows with money, no active rows below TOTALS.
   * A clean sheet guarantees SUM formulas cover exactly the right set of rows.
   */
  isClean: boolean;
  /** 1-indexed row number of the TOTALS row; null if no TOTALS row found. */
  totalsRowNum: number | null;
  /** Active invoice rows that exist below the TOTALS line (outside SUM formula range). */
  activeBelowTotalsCount: number;
}

/**
 * Read-only sheet health scan. Reads every row through col T and reports:
 *   - total active invoice rows
 *   - total VOID_DUPLICATE rows
 *   - any keys with more than one active row (active duplicates)
 *   - whether voided rows have been correctly zeroed
 *
 * Never writes to the sheet. Throws on auth/API failure.
 */
export async function getSheetHealthReport(): Promise<SheetHealthReport> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("[google-sheets] GOOGLE_SHEET_ID must be set");

  const auth = await getSheetAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Read main sheet + archive tab in parallel.
  const [readRes, archiveRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${QUOTED_SHEET_NAME}!A:T`,
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${QUOTED_ARCHIVE_SHEET_NAME}!A:A`,
    }).catch(() => ({ data: { values: [] } })), // archive tab may not exist yet
  ]);

  const archiveRows = archiveRes.data.values ?? [];
  const totalArchivedRows = Math.max(0, archiveRows.length - 1); // subtract header row

  const rows = readRes.data.values ?? [];

  // Find TOTALS row position so we can flag active rows that sit below it.
  let totalsRowNum: number | null = null;
  for (let i = 1; i < rows.length; i++) {
    if (isTotalsRow(String(rows[i]?.[0] ?? "").trim())) { totalsRowNum = i + 1; break; }
  }

  let activeBelowTotalsCount = 0;
  const groupMap = new Map<string, { activeRows: SheetHealthEntry[]; voidedRows: SheetHealthEntry[] }>();

  for (let i = 1; i < rows.length; i++) {
    const cellA = String(rows[i]?.[0]  ?? "").trim(); // A: INV#
    const cellB = String(rows[i]?.[1]  ?? "").trim(); // B: DATE
    const cellC = String(rows[i]?.[2]  ?? "").trim(); // C: LA#
    const cellE = String(rows[i]?.[4]  ?? "").trim(); // E: TOTAL
    const cellT = String(rows[i]?.[19] ?? "").trim(); // T: STATUS
    const sheetsRow = i + 1;

    const isVoid = cellT === VOID_STATUS;

    // Build key using same logic as the upsert/duplicate scan
    const normLa  = normalizeLA(cellC);
    const normInv = cellA;
    const key     = normLa ? `la:${normLa}` : normInv ? `inv:${normInv}` : null;

    // Count active rows below TOTALS — these are outside the SUM formula range.
    if (!isVoid && key && isInvoiceDataRow(cellA, cellC, cellT) && totalsRowNum !== null && sheetsRow >= totalsRowNum) {
      activeBelowTotalsCount++;
    }

    // Include active invoice rows and void rows that have a recognisable key
    const include = isVoid ? !!key : isInvoiceDataRow(cellA, cellC, cellT);
    if (!include || !key) continue;

    const entry: SheetHealthEntry = {
      rowNumber: sheetsRow,
      invNumber: cellA,
      laNumber: cellC,
      date: cellB,
      total: cellE,
      status: cellT,
    };

    const group = groupMap.get(key) ?? { activeRows: [], voidedRows: [] };
    if (isVoid) {
      group.voidedRows.push(entry);
    } else {
      group.activeRows.push(entry);
    }
    groupMap.set(key, group);
  }

  let totalActiveRows = 0;
  let totalVoidedRows = 0;
  let voidedRowsWithMoneyCount = 0;

  const groups: SheetHealthGroup[] = [];

  for (const [key, { activeRows, voidedRows }] of groupMap) {
    // Skip keys with no rows at all (shouldn't happen, but guard)
    if (activeRows.length === 0 && voidedRows.length === 0) continue;

    // syncRow: highest row number among active rows (final tiebreaker in scoreKeepRow)
    const syncRow = activeRows.length > 0
      ? activeRows.reduce((best, e) => e.rowNumber > best.rowNumber ? e : best).rowNumber
      : null;

    // Voided rows must have total = 0 or empty for SUM formulas to ignore them
    const voidedWithMoney = voidedRows.filter((e) => {
      const v = parseFloat(e.total.replace(/[$,\s]/g, ""));
      return !isNaN(v) && v !== 0;
    });

    groups.push({
      key,
      activeRows,
      voidedRows,
      syncRow,
      hasOneActiveRow: activeRows.length === 1,
      voidedRowsHaveZeroTotal: voidedWithMoney.length === 0,
    });

    totalActiveRows += activeRows.length;
    totalVoidedRows += voidedRows.length;
    voidedRowsWithMoneyCount += voidedWithMoney.length;
  }

  const activeDuplicateGroups = groups.filter((g) => g.activeRows.length > 1);

  return {
    totalActiveRows,
    totalVoidedRows,
    totalArchivedRows,
    totalUniqueKeys: groups.filter((g) => g.activeRows.length > 0).length,
    activeDuplicateCount: activeDuplicateGroups.length,
    voidedRowsWithMoneyCount,
    groups,
    activeDuplicateGroups,
    isClean: activeDuplicateGroups.length === 0 && voidedRowsWithMoneyCount === 0 && activeBelowTotalsCount === 0,
    totalsRowNum,
    activeBelowTotalsCount,
  };
}

// ---------------------------------------------------------------------------
// Sheet layout repair (admin-only)
// ---------------------------------------------------------------------------

export interface SheetRepairResult {
  ok: boolean;
  message: string;
  /** Original 1-indexed TOTALS row position (before repair). */
  totalsRowNum: number;
  /** VOID_DUPLICATE rows archived + deleted from main sheet. */
  voidArchivedCount: number;
  /** Active duplicate rows below TOTALS archived + deleted (key already existed above). */
  duplicatesArchivedCount: number;
  /** Active orphan rows below TOTALS (no match above) moved to above TOTALS. */
  rowsMovedCount: number;
  healthAfter: SheetHealthReport;
}

/**
 * Repairs the Sheet layout:
 *   1. Archives + deletes all VOID_DUPLICATE rows still on the main sheet.
 *   2. Archives + deletes active duplicate rows that are below TOTALS when the
 *      same key already exists above TOTALS.
 *   3. Moves active orphan rows from below TOTALS (no match above) to immediately
 *      above TOTALS so they are captured by SUM formulas.
 *
 * Archive-before-delete guarantee: nothing is permanently removed unless it was
 * first written to the "Voided Duplicates" tab.
 * Never touches unrelated rows or rows above TOTALS.
 */
export async function repairSheetLayout(): Promise<SheetRepairResult> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("[google-sheets] GOOGLE_SHEET_ID must be set");

  const auth = await getSheetAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Read spreadsheet metadata + full row data (A:AG covers all 33 existing columns).
  const [spreadsheetRes, readRes] = await Promise.all([
    sheets.spreadsheets.get({ spreadsheetId: sheetId }),
    sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${QUOTED_SHEET_NAME}!A:AG`,
    }),
  ]);

  const tabMeta = spreadsheetRes.data.sheets?.find((s) => s.properties?.title === SHEET_NAME);
  if (!tabMeta || tabMeta.properties?.sheetId == null) {
    throw new Error(`[google-sheets] Tab "${SHEET_NAME}" not found`);
  }
  const numericTabId = tabMeta.properties.sheetId;
  const existingSheets = spreadsheetRes.data.sheets;
  const rows = readRes.data.values ?? [];

  // Locate TOTALS row.
  let totalsRowNum = -1;
  for (let i = 1; i < rows.length; i++) {
    if (isTotalsRow(String(rows[i]?.[0] ?? "").trim())) { totalsRowNum = i + 1; break; }
  }
  if (totalsRowNum < 0) {
    const healthAfter = await getSheetHealthReport();
    return {
      ok: false,
      message: "No TOTALS row found — repair aborted. Add a TOTALS row to the sheet first.",
      totalsRowNum: -1,
      voidArchivedCount: 0,
      duplicatesArchivedCount: 0,
      rowsMovedCount: 0,
      healthAfter,
    };
  }

  // Classify every row relative to the TOTALS line.
  const activeAbove = new Map<string, number>(); // key → row number
  const voidOnMain: ArchiveEntry[] = [];
  const duplicatesBelow: ArchiveEntry[] = [];
  // Orphans: active rows below TOTALS with no match above — need to be moved.
  const orphansBelow: Array<{ rowNumber: number; rawData: (string | number)[] }> = [];

  for (let i = 1; i < rows.length; i++) {
    const sheetsRow = i + 1;
    const cellA = String(rows[i]?.[0] ?? "").trim();
    const cellB = String(rows[i]?.[1] ?? "").trim();
    const cellC = String(rows[i]?.[2] ?? "").trim();
    const cellD = String(rows[i]?.[3] ?? "").trim();
    const cellE = String(rows[i]?.[4] ?? "").trim();
    const cellT = String(rows[i]?.[19] ?? "").trim();

    if (isTotalsRow(cellA)) continue; // skip the TOTALS row itself

    if (cellT === VOID_STATUS) {
      voidOnMain.push({ rowNumber: sheetsRow, invNumber: cellA, date: cellB, laNumber: cellC, gigEvent: cellD, total: cellE, originalStatus: cellT });
      continue;
    }

    if (!isInvoiceDataRow(cellA, cellC, cellT)) continue;

    const normLa = normalizeLA(cellC);
    const key = normLa ? `la:${normLa}` : cellA ? `inv:${cellA}` : null;
    if (!key) continue;

    const entry: ArchiveEntry = { rowNumber: sheetsRow, invNumber: cellA, date: cellB, laNumber: cellC, gigEvent: cellD, total: cellE, originalStatus: cellT };

    if (sheetsRow < totalsRowNum) {
      if (!activeAbove.has(key)) activeAbove.set(key, sheetsRow);
    } else {
      if (activeAbove.has(key)) {
        // Key already present above TOTALS → this is a stale duplicate.
        duplicatesBelow.push(entry);
      } else {
        // No match above TOTALS → orphan that must be moved.
        orphansBelow.push({ rowNumber: sheetsRow, rawData: (rows[i] ?? []) as (string | number)[] });
        activeAbove.set(key, sheetsRow); // claim the key to catch further duplicates of this orphan
      }
    }
  }

  // Phase A: Archive + delete VOID rows and duplicate rows below TOTALS.
  const toArchive = [...voidOnMain, ...duplicatesBelow];
  if (toArchive.length > 0) {
    await archiveAndDeleteRows(sheets, sheetId, numericTabId, toArchive, existingSheets);
  }

  // Phase B: Move orphan rows above TOTALS.
  let rowsMovedCount = 0;

  if (orphansBelow.length > 0) {
    // Re-read after Phase A deletions to get current row positions.
    const reReadRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${QUOTED_SHEET_NAME}!A:AG`,
    });
    const currentRows = reReadRes.data.values ?? [];

    // Locate TOTALS again (row numbers may have shifted after Phase A deletions).
    let newTotalsRow = -1;
    for (let i = 1; i < currentRows.length; i++) {
      if (isTotalsRow(String(currentRows[i]?.[0] ?? "").trim())) { newTotalsRow = i + 1; break; }
    }
    if (newTotalsRow < 0) throw new Error("[repair] TOTALS row disappeared during repair");

    // Match orphan rows by their A+B+C signature (inv# + date + LA#) to find current positions.
    type OrphanSignature = { rawData: (string | number)[]; sig: string };
    const sigMap = new Map<string, OrphanSignature>();
    for (const o of orphansBelow) {
      const sig = `${String(o.rawData[0] ?? "").trim()}|${String(o.rawData[1] ?? "").trim()}|${String(o.rawData[2] ?? "").trim()}`;
      if (sig && !sigMap.has(sig)) sigMap.set(sig, { rawData: o.rawData, sig });
    }

    const movedData: (string | number)[][] = [];
    const currentOrphanRowNums: number[] = [];

    for (let i = 1; i < currentRows.length; i++) {
      const sheetsRow = i + 1;
      if (sheetsRow <= newTotalsRow) continue;
      const sig = `${String(currentRows[i]?.[0] ?? "").trim()}|${String(currentRows[i]?.[1] ?? "").trim()}|${String(currentRows[i]?.[2] ?? "").trim()}`;
      if (sig && sigMap.has(sig)) {
        movedData.push(sigMap.get(sig)!.rawData);
        currentOrphanRowNums.push(sheetsRow);
        sigMap.delete(sig); // consume to avoid double-moving if somehow duplicated
      }
    }

    // Insert rows above TOTALS and write full row data, tracking offset as we go.
    let insertOffset = 0;
    for (const data of movedData) {
      const insertAt0 = newTotalsRow - 1 + insertOffset; // 0-indexed insert position
      const writeRow  = newTotalsRow + insertOffset;     // 1-indexed destination

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            insertDimension: {
              range: { sheetId: numericTabId, dimension: "ROWS", startIndex: insertAt0, endIndex: insertAt0 + 1 },
              inheritFromBefore: insertAt0 > 1,
            },
          }],
        },
      });

      // Pad to 33 columns so all cells in A:AG are written cleanly.
      const paddedData = [...data];
      while (paddedData.length < 33) paddedData.push("");

      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${QUOTED_SHEET_NAME}!A${writeRow}:AG${writeRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [paddedData] },
      });

      insertOffset++;
      rowsMovedCount++;
    }

    // Delete original orphan rows from below TOTALS (each shifted by insertOffset).
    const toDelete = currentOrphanRowNums
      .map((r) => r + insertOffset)
      .sort((a, b) => b - a);

    if (toDelete.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: toDelete.map((rowNumber) => ({
            deleteDimension: {
              range: { sheetId: numericTabId, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber },
            },
          })),
        },
      });
    }
  }

  const healthAfter = await getSheetHealthReport();

  return {
    ok: true,
    message: `Repair complete: ${voidOnMain.length} void rows archived, ${duplicatesBelow.length} duplicates archived, ${rowsMovedCount} rows moved above TOTALS.`,
    totalsRowNum,
    voidArchivedCount:       voidOnMain.length,
    duplicatesArchivedCount: duplicatesBelow.length,
    rowsMovedCount,
    healthAfter,
  };
}

// ---------------------------------------------------------------------------
// Sheet reset / clean start (admin-only)
// ---------------------------------------------------------------------------

/**
 * Returns true when a sheet row looks like fake/test data that should be
 * removed during a reset. Criteria:
 *   - LA# normalises to "5555"       (canonical test LA number)
 *   - Invoice number is exactly "1001" (canonical test invoice)
 *   - Gig/event name contains "test" (case-insensitive)
 *
 * Real jobs with genuinely matching identifiers are extremely unlikely
 * (LA assigns real numbers; gig names are production event summaries).
 */
export function isTestSheetRow(invNumber: string, laNumber: string, gigEvent: string): boolean {
  if (normalizeLA(laNumber) === "5555") return true;
  if (invNumber.trim() === "1001") return true;
  if (gigEvent.trim().toLowerCase().includes("test")) return true;
  return false;
}

export interface SheetResetResult {
  ok: boolean;
  message: string;
  voidArchivedCount: number;
  testArchivedCount: number;
  duplicatesArchivedCount: number;
  /** Good rows that were below TOTALS and moved to above TOTALS (not archived). */
  belowTotalsMovedCount: number;
  /** Real active rows that survived the reset (now above TOTALS). */
  goodRowsKept: number;
  formulasRebuilt: boolean;
  totalsRowNumAfter: number;
  healthAfter: SheetHealthReport;
}

/**
 * Resets the Sheet to a clean state suitable for real invoice use:
 *
 *   1. Archives + deletes all VOID_DUPLICATE rows.
 *   2. Archives + deletes all fake/test rows (LA#5555, inv#1001, gig "test").
 *   3. Deduplicates remaining active rows — best row per key kept, extras archived.
 *   4. Moves any remaining good rows below TOTALS to above TOTALS.
 *   5. Rebuilds TOTALS row SUM formulas (E–S) to cover all rows above TOTALS.
 *   6. Returns SheetResetResult with health report.
 *
 * Archive-before-delete: every removed row is written to "Voided Duplicates"
 * before deletion. The header row, TOTALS row, and unrecognised rows are
 * never touched. Never emails, syncs, or modifies invoice DB records.
 */
export async function resetSheetLayout(): Promise<SheetResetResult> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("[google-sheets] GOOGLE_SHEET_ID must be set");

  const auth = await getSheetAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // ── Phase 0: Read full sheet ───────────────────────────────────────────────
  const [spreadsheetRes, readRes] = await Promise.all([
    sheets.spreadsheets.get({ spreadsheetId: sheetId }),
    sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${QUOTED_SHEET_NAME}!A:AG`,
    }),
  ]);

  const tabMeta = spreadsheetRes.data.sheets?.find((s) => s.properties?.title === SHEET_NAME);
  if (!tabMeta || tabMeta.properties?.sheetId == null) {
    throw new Error(`[google-sheets] Tab "${SHEET_NAME}" not found`);
  }
  const numericTabId = tabMeta.properties.sheetId;
  const existingSheets = spreadsheetRes.data.sheets;
  const rows = readRes.data.values ?? [];

  // ── Phase 1: Classify rows ────────────────────────────────────────────────
  const voidToArchive: ArchiveEntry[] = [];
  const testToArchive: ArchiveEntry[] = [];
  // Active, non-test rows grouped by key for deduplication.
  const activeByKey = new Map<string, Array<{ rowNumber: number; entry: ArchiveEntry }>>();

  for (let i = 1; i < rows.length; i++) {
    const sheetsRow = i + 1;
    const cellA = String(rows[i]?.[0] ?? "").trim();
    const cellB = String(rows[i]?.[1] ?? "").trim();
    const cellC = String(rows[i]?.[2] ?? "").trim();
    const cellD = String(rows[i]?.[3] ?? "").trim();
    const cellE = String(rows[i]?.[4] ?? "").trim();
    const cellT = String(rows[i]?.[19] ?? "").trim();

    if (isTotalsRow(cellA)) continue; // never touch the TOTALS row

    const entry: ArchiveEntry = {
      rowNumber: sheetsRow, invNumber: cellA, date: cellB,
      laNumber: cellC, gigEvent: cellD, total: cellE, originalStatus: cellT,
    };

    if (cellT === VOID_STATUS) {
      voidToArchive.push(entry);
      continue;
    }

    if (!isInvoiceDataRow(cellA, cellC, cellT)) continue; // blank/unrecognised — skip

    if (isTestSheetRow(cellA, cellC, cellD)) {
      testToArchive.push(entry);
      continue;
    }

    const normLa = normalizeLA(cellC);
    const key = normLa ? `la:${normLa}` : cellA ? `inv:${cellA}` : null;
    if (!key) continue;

    const existing = activeByKey.get(key) ?? [];
    existing.push({ rowNumber: sheetsRow, entry });
    activeByKey.set(key, existing);
  }

  // Dedup: keep best-scored row per key, archive the rest.
  const duplicatesToArchive: ArchiveEntry[] = [];
  let goodRowsKept = 0;
  for (const [, candidates] of activeByKey) {
    if (candidates.length === 1) { goodRowsKept++; continue; }
    // Score without incoming match bonuses (empty strings = no LA/inv bonus)
    // → falls back to date recency + row-number tiebreaker.
    const scored = candidates.map((c) => ({
      ...c,
      score: scoreKeepRow(c.entry.invNumber, c.entry.date, c.entry.laNumber, c.entry.total, c.rowNumber, "", "", undefined),
    }));
    const keep = scored.reduce((best, e) => e.score > best.score ? e : best);
    goodRowsKept++;
    duplicatesToArchive.push(
      ...scored.filter((e) => e.rowNumber !== keep.rowNumber).map((e) => e.entry),
    );
  }

  // ── Phase 2: Archive + delete ─────────────────────────────────────────────
  const allToArchive = [...voidToArchive, ...testToArchive, ...duplicatesToArchive];
  if (allToArchive.length > 0) {
    await archiveAndDeleteRows(sheets, sheetId, numericTabId, allToArchive, existingSheets);
  }

  // ── Phase 3: Re-read + move good rows from below TOTALS ───────────────────
  const reReadRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${QUOTED_SHEET_NAME}!A:AG`,
  });
  const currentRows = reReadRes.data.values ?? [];

  let curTotalsRow = -1;
  for (let i = 1; i < currentRows.length; i++) {
    if (isTotalsRow(String(currentRows[i]?.[0] ?? "").trim())) { curTotalsRow = i + 1; break; }
  }

  // Collect any good rows still below TOTALS (after phase 2) — move them above.
  const belowTotalsGood: Array<{ rowNumber: number; rawData: (string | number)[] }> = [];
  if (curTotalsRow > 0) {
    for (let i = 1; i < currentRows.length; i++) {
      const sheetsRow = i + 1;
      if (sheetsRow <= curTotalsRow) continue;
      const cellA = String(currentRows[i]?.[0] ?? "").trim();
      const cellC = String(currentRows[i]?.[2] ?? "").trim();
      const cellD = String(currentRows[i]?.[3] ?? "").trim();
      const cellT = String(currentRows[i]?.[19] ?? "").trim();
      if (cellT === VOID_STATUS || !isInvoiceDataRow(cellA, cellC, cellT)) continue;
      if (isTestSheetRow(cellA, cellC, cellD)) continue;
      belowTotalsGood.push({ rowNumber: sheetsRow, rawData: (currentRows[i] ?? []) as (string | number)[] });
    }
  }

  let belowTotalsMovedCount = 0;
  if (belowTotalsGood.length > 0 && curTotalsRow > 0) {
    let insertOffset = 0;
    for (const r of belowTotalsGood) {
      const insertAt0 = curTotalsRow - 1 + insertOffset;
      const writeRow  = curTotalsRow + insertOffset;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            insertDimension: {
              range: { sheetId: numericTabId, dimension: "ROWS", startIndex: insertAt0, endIndex: insertAt0 + 1 },
              inheritFromBefore: insertAt0 > 1,
            },
          }],
        },
      });
      const padded = [...r.rawData];
      while (padded.length < 33) padded.push("");
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${QUOTED_SHEET_NAME}!A${writeRow}:AG${writeRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [padded] },
      });
      insertOffset++;
      belowTotalsMovedCount++;
    }
    // Delete originals from their original positions (now shifted by insertOffset).
    const toDelete = belowTotalsGood.map((r) => r.rowNumber + insertOffset).sort((a, b) => b - a);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: toDelete.map((rowNumber) => ({
          deleteDimension: {
            range: { sheetId: numericTabId, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber },
          },
        })),
      },
    });
  }

  // ── Phase 4: Rebuild TOTALS row SUM formulas (E–S) ───────────────────────
  // Re-read column A only to find the final TOTALS position after all moves.
  const finalColARes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${QUOTED_SHEET_NAME}!A:A`,
  });
  const colA = finalColARes.data.values ?? [];
  let finalTotalsRow = -1;
  for (let i = 1; i < colA.length; i++) {
    if (isTotalsRow(String(colA[i]?.[0] ?? "").trim())) { finalTotalsRow = i + 1; break; }
  }

  let formulasRebuilt = false;
  if (finalTotalsRow > 1) {
    // Formula range covers rows 2 through (TOTALS - 1), capturing all rows above TOTALS.
    // Blanks in that range contribute 0 to SUM; future inserts are covered automatically.
    const lastRow = finalTotalsRow - 1;
    const moneyCols = ["E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S"];
    const formulaValues = moneyCols.map((col) => `=SUM(${col}2:${col}${lastRow})`);
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${QUOTED_SHEET_NAME}!E${finalTotalsRow}:S${finalTotalsRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [formulaValues] },
    });
    formulasRebuilt = true;
  }

  const healthAfter = await getSheetHealthReport();

  const parts: string[] = ["Reset complete."];
  if (voidToArchive.length)        parts.push(`${voidToArchive.length} void rows archived.`);
  if (testToArchive.length)        parts.push(`${testToArchive.length} test/fake rows archived.`);
  if (duplicatesToArchive.length)  parts.push(`${duplicatesToArchive.length} duplicate rows archived.`);
  if (belowTotalsMovedCount)       parts.push(`${belowTotalsMovedCount} rows moved above TOTALS.`);
  parts.push(`${goodRowsKept} real rows kept.`);
  if (formulasRebuilt)             parts.push(`TOTALS formulas rebuilt.`);

  return {
    ok:                      true,
    message:                 parts.join(" "),
    voidArchivedCount:       voidToArchive.length,
    testArchivedCount:       testToArchive.length,
    duplicatesArchivedCount: duplicatesToArchive.length,
    belowTotalsMovedCount,
    goodRowsKept,
    formulasRebuilt,
    totalsRowNumAfter:       finalTotalsRow,
    healthAfter,
  };
}
