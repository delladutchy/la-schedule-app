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
 * True if a sheet row (identified by its col-A and col-C values) looks like
 * an invoice data row rather than a totals/summary row.
 *
 * Invoice rows have a LA job number in col C, OR an invoice-number-like value
 * (starts with a digit or "JU-") in col A.  Totals/summary rows have empty
 * col C and a label such as "TOTAL" in col A — they do not pass this check.
 */
export function isInvoiceDataRow(cellA: string, cellC: string): boolean {
  if (cellC.trim()) return true;               // col C (LA#) present → invoice row
  const a = cellA.trim();
  if (!a) return false;
  return /^\d/.test(a) || /^JU-/i.test(a);    // numeric or JU-format invoice number
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

/**
 * Upsert one invoice row in the Google Sheet.
 *
 * Stable key: normalised LA job # (col C) first; invoice number (col A) as
 * fallback for rows written before a LA # was recorded.  Both keys are
 * normalised to prevent format-mismatch duplicates ("5555" vs "LA#5555").
 *
 * New rows are inserted with insertDimension immediately after the last
 * detected invoice-data row, so they are never placed inside totals/summary
 * sections (which the spreadsheets.values.append API can land in when those
 * sections contain formulas that count as "last row with data").
 *
 * Throws on auth/API failure so the caller can surface/log the error.
 */
export async function upsertSheetRow(row: SheetRow): Promise<void> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("[google-sheets] GOOGLE_SHEET_ID must be set");

  const auth = await getSheetAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Normalise the incoming keys once.
  const incomingLa  = normalizeLA(row.laJobNumber);
  const incomingInv = String(row.invoiceNumber ?? "").trim();

  if (!incomingLa && !incomingInv) {
    // Without a stable key we cannot prevent duplicates — refuse to write.
    throw new Error(
      "[google-sheets] upsertSheetRow: both laJobNumber and invoiceNumber are empty. " +
      "Cannot safely upsert without a stable row key.",
    );
  }

  // Parallel reads: spreadsheet metadata (needed for insertDimension's numeric
  // sheet ID) + column-A/C data (for duplicate detection and placement).
  const [spreadsheetRes, readRes] = await Promise.all([
    sheets.spreadsheets.get({ spreadsheetId: sheetId }),
    sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${QUOTED_SHEET_NAME}!A:C`,
    }),
  ]);

  // Resolve the numeric tab ID required by batchUpdate / insertDimension.
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
  let matchRowIndex  = -1;  // 1-indexed Sheets row of an existing match
  let lastDataRow    = 1;   // 1-indexed last row that looks like invoice data

  // i = 0 is the header row — scan from i = 1.
  for (let i = 1; i < existingRows.length; i++) {
    const cellA = String(existingRows[i]?.[0] ?? "").trim(); // col A: INV#
    const cellC = String(existingRows[i]?.[2] ?? "").trim(); // col C: LA Job #
    const sheetsRow = i + 1; // convert to 1-indexed Sheets row number

    // Track the last row that is recognisable as invoice data.
    // Totals/summary rows (empty col C, label in col A) will NOT advance this counter.
    if (isInvoiceDataRow(cellA, cellC)) {
      lastDataRow = sheetsRow;
    }

    // Match: primary key = normalised LA# in col C; fallback = invoice# in col A.
    if (matchRowIndex < 0) {
      if (incomingLa && normalizeLA(cellC) === incomingLa) {
        matchRowIndex = sheetsRow;
      } else if (incomingInv && cellA && cellA === incomingInv) {
        matchRowIndex = sheetsRow;
      }
    }
  }

  const values = [rowToValues(row)];

  if (matchRowIndex > 0) {
    // ── UPDATE existing row in-place ─────────────────────────────────────────
    // Never creates a duplicate — always targets the same physical row.
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${QUOTED_SHEET_NAME}!A${matchRowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });
    return;
  }

  // ── INSERT new row after the last invoice data row ────────────────────────
  //
  // We use insertDimension (not values.append) so the new row is placed at an
  // exact position we control.  values.append detects "last row with data" by
  // scanning the full column — formula-containing totals rows count as data, so
  // append can land new rows inside or below the totals section.
  //
  // insertDimension uses 0-indexed row positions:
  //   startIndex = lastDataRow inserts BEFORE the current row at 0-index lastDataRow,
  //   which is AFTER 1-indexed Sheets row lastDataRow (the last data row).
  //
  // Example: lastDataRow = 10 (Sheets row 10 is the last invoice row)
  //   startIndex = 10  →  new row inserted at 0-index 10  →  Sheets row 11
  //   old Sheets row 11 (first totals row) shifts down to Sheets row 12  ✓
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId: numericTabId,
              dimension: "ROWS",
              startIndex: lastDataRow,       // 0-indexed: insert after lastDataRow
              endIndex: lastDataRow + 1,
            },
            inheritFromBefore: lastDataRow > 1, // inherit data-row formatting (not header)
          },
        },
      ],
    },
  });

  // The newly inserted blank row is now at 1-indexed position (lastDataRow + 1).
  const newRowNumber = lastDataRow + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${QUOTED_SHEET_NAME}!A${newRowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
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
    range: `${QUOTED_SHEET_NAME}!A:C`,
  });

  const rows = readRes.data.values ?? [];
  let matchRowIndex = -1;

  for (let i = 1; i < rows.length; i++) {
    const cellA = String(rows[i]?.[0] ?? "").trim();
    const cellC = String(rows[i]?.[2] ?? "").trim();
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
    range: `${QUOTED_SHEET_NAME}!A:E`, // INV#, DATE, LA#, GIG, TOTAL
  });

  const rows = readRes.data.values ?? [];

  // Group rows by (normalised LA# OR invoice#).
  const groups = new Map<string, Array<{ rowNumber: number; invNumber: string; laNumber: string; date: string; total: string }>>();

  for (let i = 1; i < rows.length; i++) {
    const cellA = String(rows[i]?.[0] ?? "").trim();
    const cellB = String(rows[i]?.[1] ?? "").trim();
    const cellC = String(rows[i]?.[2] ?? "").trim();
    const cellE = String(rows[i]?.[4] ?? "").trim();

    if (!isInvoiceDataRow(cellA, cellC)) continue; // skip totals/summary rows

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
