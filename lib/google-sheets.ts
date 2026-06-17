import "server-only";
import { google } from "googleapis";
import type { SheetRow } from "./invoice-types";

/**
 * Google Sheets sync for invoice rows.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  — service account email with Sheets Editor access
 *   GOOGLE_PRIVATE_KEY            — service account private key (newlines as \n)
 *   GOOGLE_SHEET_ID               — spreadsheet ID from the URL
 *   GOOGLE_SHEET_NAME             — tab name (default: "LA PAY (2026)")
 */

const SHEET_NAME = process.env.GOOGLE_SHEET_NAME ?? "LA PAY (2026)";

// Sheet names with spaces or parens must be single-quoted in A1 notation.
const QUOTED_SHEET_NAME = `'${SHEET_NAME}'`;

// INV#, DATE, LA#, GIG, TOTAL, LABOR, OT, PER DIEM, MILEAGE, PARKING,
// HOTEL, TOLLS, BAG FEES, UBER, OTHER, TOTAL MILES, LA PAID MILES,
// UNREIMBURSED MILES, MILEAGE PAID, STATUS, PAID DATE
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
];

function getSheetAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error(
      "[google-sheets] GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY must be set",
    );
  }
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

/**
 * Upsert one invoice row in the Google Sheet.
 * Matches by LA Job # in column C (index 2). Appends if not found.
 * Throws on auth/API failure so the caller can handle retry.
 */
export async function upsertSheetRow(row: SheetRow): Promise<void> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("[google-sheets] GOOGLE_SHEET_ID must be set");

  const auth = getSheetAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Read existing rows to find a match by LA Job #
  const readRange = `${QUOTED_SHEET_NAME}!A:C`;
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: readRange,
  });

  const existingRows = readRes.data.values ?? [];
  const laJobNumber = row.laJobNumber.trim();
  let matchRowIndex = -1;

  if (laJobNumber) {
    for (let i = 1; i < existingRows.length; i++) {
      const cellVal = String(existingRows[i]?.[2] ?? "").trim();
      if (cellVal === laJobNumber) {
        matchRowIndex = i + 1; // Sheets rows are 1-indexed; header is row 1
        break;
      }
    }
  }

  const values = [rowToValues(row)];

  if (matchRowIndex > 0) {
    // Update existing row
    const updateRange = `${QUOTED_SHEET_NAME}!A${matchRowIndex}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: updateRange,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });
  } else {
    // Append new row
    const appendRange = `${QUOTED_SHEET_NAME}!A:A`;
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: appendRange,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
  }
}
