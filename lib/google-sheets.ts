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

// Columns 1–21: original layout (never change position — existing data depends on it)
// INV#, DATE, LA#, GIG, TOTAL, LABOR, OT, PER DIEM, MILEAGE, PARKING,
// HOTEL, TOLLS, BAG FEES, UBER, OTHER, TOTAL MILES, LA PAID MILES,
// UNREIMBURSED MILES, MILEAGE PAID, STATUS, PAID DATE
//
// Columns 22–28: native invoicing / payment metadata (appended to the right)
// PDF LINK, SENT DATE, AMOUNT PAID, REMAINING BALANCE,
// PAYMENT METHOD, PAYMENT RECEIVED DATE, PAYMENT BATCH REF
//
// Columns 29–33 (optional AC–AG): extended sync fields
// SENT TO, SENT SUBJECT, JOB NAME OVERRIDE, DAY RATE DESC OVERRIDE, INVOICE NOTE OVERRIDE
const COLUMN_ORDER: Array<keyof SheetRow> = [
  "invoiceNumber",
  "date",
  "laJobNumber",
  "gigEvent",
  "totalPay",
  "labor",
  "ot",
  "perDiem",
  "mileage",
  "parking",
  "hotel",
  "tolls",
  "bagFees",
  "uber",
  "otherExpenses",
  "totalBusinessMiles",
  "laPaidMiles",
  "unreimbursedMiles",
  "mileagePaid",
  "status",
  "paidDate",
  // Native invoicing columns — appended at right; existing rows leave them blank.
  "invoicePdfUrl",
  "invoiceSentDate",
  "amountPaid",
  "remainingBalance",
  "paymentMethod",
  "paymentReceivedDate",
  "paymentBatchRef",
  // Optional extended columns (AC–AG). Add matching headers in the Sheet to label them.
  // Recommended: SENT TO | SENT SUBJECT | JOB NAME OVERRIDE | DAY RATE DESC OVERRIDE | INVOICE NOTE OVERRIDE
  "sentTo",
  "sentSubject",
  "jobNameOverride",
  "dayRateDescriptionOverride",
  "noteOverride",
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
 * Build the 33-column value array written to a stale duplicate row to neutralise it.
 * - Keeps cols A–D (INV#, DATE, LA#, GIG) so the row is still identifiable.
 * - Zeros all money columns E–S so SUM formulas exclude this row automatically.
 * - Sets col T (STATUS) = VOID_STATUS.
 * - Clears cols U–AG (payment tracking, extended fields).
 */
export function buildVoidRowValues(
  cellA: string,
  cellB: string,
  cellC: string,
  cellD: string,
): (string | number)[] {
  const ncols = COLUMN_ORDER.length; // 33
  const row: (string | number)[] = new Array(ncols).fill("");
  row[0] = cellA; // A: INV# (kept for identification)
  row[1] = cellB; // B: DATE (kept)
  row[2] = cellC; // C: LA# (kept)
  row[3] = cellD; // D: GIG (kept)
  for (let i = 4; i <= 18; i++) row[i] = 0; // E–S: all money columns → 0
  row[19] = VOID_STATUS;                      // T: STATUS = "VOID_DUPLICATE"
  // U–AG (indices 20–32): already "" from fill — dates and text stay empty
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
  /** True when stale duplicate rows were found and automatically voided during sync. */
  hasDuplicates: boolean;
  /** Row numbers that were voided (money zeroed, STATUS set to VOID_DUPLICATE). */
  voidedRows: number[];
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
  // matchingRows: all non-void rows that share this invoice's key, with cell data
  // so we can build void rows for the stale ones after choosing the keeper.
  const matchingRows: Array<{
    rowNumber: number;
    score: number;
    cellA: string;
    cellB: string;
    cellC: string;
    cellD: string;
  }> = [];
  let lastDataRow = 1;

  for (let i = 1; i < existingRows.length; i++) {
    const cellA = String(existingRows[i]?.[0]  ?? "").trim(); // A: INV#
    const cellB = String(existingRows[i]?.[1]  ?? "").trim(); // B: DATE
    const cellC = String(existingRows[i]?.[2]  ?? "").trim(); // C: LA Job #
    const cellD = String(existingRows[i]?.[3]  ?? "").trim(); // D: GIG (needed for void row)
    const cellE = String(existingRows[i]?.[4]  ?? "").trim(); // E: TOTAL (for scoring)
    const cellT = String(existingRows[i]?.[19] ?? "").trim(); // T: STATUS
    const sheetsRow = i + 1;

    // Track the last active invoice-data row for insert placement.
    // Void rows and totals rows are excluded from this counter.
    if (isInvoiceDataRow(cellA, cellC, cellT)) {
      lastDataRow = sheetsRow;
    }

    // Skip void rows — they are already neutralised and should not be re-matched.
    if (cellT === VOID_STATUS) continue;

    const laMatch  = !!(incomingLa  && normalizeLA(cellC) === incomingLa);
    const invMatch = !!(incomingInv && cellA && cellA === incomingInv);
    if (laMatch || invMatch) {
      const score = scoreKeepRow(cellA, cellB, cellC, cellE, sheetsRow, incomingLa, incomingInv, row.totalPay);
      matchingRows.push({ rowNumber: sheetsRow, score, cellA, cellB, cellC, cellD });
    }
  }

  const values = [rowToValues(row)];

  if (matchingRows.length > 0) {
    // ── UPDATE the best matching row ──────────────────────────────────────────
    const keepEntry = matchingRows.reduce((best, entry) =>
      entry.score > best.score ? entry : best,
    );
    const staleEntries = matchingRows.filter((m) => m.rowNumber !== keepEntry.rowNumber);

    // Write current invoice data to the kept row.
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${QUOTED_SHEET_NAME}!A${keepEntry.rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

    // ── VOID all stale duplicates in one batch call ───────────────────────────
    // Zero every money column so SUM formulas stop including these rows.
    // Identifying info (INV#, DATE, LA#, GIG) is preserved for audit trail.
    if (staleEntries.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: staleEntries.map((entry) => ({
            range: `${QUOTED_SHEET_NAME}!A${entry.rowNumber}`,
            values: [buildVoidRowValues(entry.cellA, entry.cellB, entry.cellC, entry.cellD)],
          })),
        },
      });
    }

    return {
      action: "updated",
      rowNumber: keepEntry.rowNumber,
      hasDuplicates: staleEntries.length > 0,
      voidedRows: staleEntries.map((e) => e.rowNumber),
    };
  }

  // ── INSERT new row after the last active invoice-data row ─────────────────
  //
  // insertDimension uses 0-indexed positions:
  //   startIndex = lastDataRow  → inserts before 0-indexed row lastDataRow,
  //   which is after 1-indexed row lastDataRow (the last active data row).
  //
  // Example: lastDataRow = 10  →  startIndex = 10
  //   New row lands at 1-indexed row 11.
  //   Old row 11 (first totals row) shifts to row 12.  ✓
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId: numericTabId,
              dimension: "ROWS",
              startIndex: lastDataRow,
              endIndex: lastDataRow + 1,
            },
            inheritFromBefore: lastDataRow > 1,
          },
        },
      ],
    },
  });

  const newRowNumber = lastDataRow + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${QUOTED_SHEET_NAME}!A${newRowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  return {
    action: "inserted",
    rowNumber: newRowNumber,
    hasDuplicates: false,
    voidedRows: [],
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
  key: string;                       // "INV#:LA#" or whichever keys exist
  rows: Array<{ rowNumber: number; invNumber: string; laNumber: string; date: string; total: string }>;
  keepRow: number;                   // suggested row to keep (latest date or last in list)
  deleteRows: number[];              // row numbers safe to delete after review
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
    const cellE = String(rows[i]?.[4]  ?? "").trim();
    const cellT = String(rows[i]?.[19] ?? "").trim(); // T: STATUS

    if (!isInvoiceDataRow(cellA, cellC, cellT)) continue; // skip totals, summaries, and void rows

    // Build a canonical key for this row. Prefer LA# since it's more stable.
    const normLa  = normalizeLA(cellC);
    const normInv = cellA;
    const key     = normLa ? `la:${normLa}` : normInv ? `inv:${normInv}` : null;
    if (!key) continue;

    const entry = { rowNumber: i + 1, invNumber: cellA, laNumber: cellC, date: cellB, total: cellE };
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

export async function deleteSheetDuplicateRows(requestedRows?: number[]): Promise<SheetDuplicateCleanupResult> {
  const before = await findSheetDuplicates();
  const recommendedRows = new Set(before.flatMap((group) => group.deleteRows));
  const requestedSet = requestedRows && requestedRows.length > 0
    ? new Set(requestedRows.filter((rowNumber) => Number.isInteger(rowNumber)))
    : null;
  const rowsToDelete = [...recommendedRows]
    .filter((rowNumber) => (requestedSet ? requestedSet.has(rowNumber) : true))
    .sort((a, b) => b - a);

  await deleteSheetRows(rowsToDelete);
  const after = rowsToDelete.length > 0 ? await findSheetDuplicates() : before;

  return {
    before,
    after,
    deletedRows: rowsToDelete,
  };
}

/**
 * Delete duplicate rows for one specific invoice key only.
 * Safe for invoice-specific cleanup: deletes nothing outside the matching group.
 *
 * @param invoiceKey — canonical key from findSheetDuplicates, e.g. "la:5555" or "inv:1001"
 */
export async function deleteSheetDuplicatesForKey(invoiceKey: string): Promise<SheetDuplicateCleanupResult> {
  const before = await findSheetDuplicates();
  const group = before.find((g) => g.key === invoiceKey);

  if (!group || group.deleteRows.length === 0) {
    return { before, after: before, deletedRows: [] };
  }

  await deleteSheetRows(group.deleteRows);
  const after = await findSheetDuplicates();

  return {
    before,
    after,
    deletedRows: group.deleteRows,
  };
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
  totalVoidedRows: number;
  totalUniqueKeys: number;
  activeDuplicateCount: number;
  /** Number of voided rows that still have a non-zero total — should always be 0. */
  voidedRowsWithMoneyCount: number;
  groups: SheetHealthGroup[];
  activeDuplicateGroups: SheetHealthGroup[];
  /** True when no active duplicates AND no void rows with money remaining. */
  isClean: boolean;
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

  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${QUOTED_SHEET_NAME}!A:T`,
  });

  const rows = readRes.data.values ?? [];
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
    totalUniqueKeys: groups.filter((g) => g.activeRows.length > 0).length,
    activeDuplicateCount: activeDuplicateGroups.length,
    voidedRowsWithMoneyCount,
    groups,
    activeDuplicateGroups,
    isClean: activeDuplicateGroups.length === 0 && voidedRowsWithMoneyCount === 0,
  };
}
