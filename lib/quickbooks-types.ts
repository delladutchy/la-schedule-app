/**
 * QuickBooks Online API types and invoice line item mapping.
 *
 * Intentionally free of server-only imports — safe to use in tests and UI code.
 */

import type { InvoicePacket } from "./invoice-types";
import { round2 } from "./invoice-calculations";

// ── QB Online API request types ───────────────────────────────────────────────

export interface QBItemRef {
  value: string;   // QB internal item ID (integer string, e.g. "42")
  name?: string;   // display name — appears on the invoice line
}

export interface QBSalesItemLineDetail {
  ItemRef: QBItemRef;
  Qty?: number;
  UnitPrice?: number;
}

export interface QBLine {
  DetailType: "SalesItemLineDetail";
  Amount: number;            // may be negative (e.g. mileage adjustment)
  Description?: string;
  SalesItemLineDetail: QBSalesItemLineDetail;
}

export interface QBInvoiceBody {
  Line: QBLine[];
  CustomerRef: { value: string; name?: string };
  DocNumber?: string;   // maps to la_number
  PrivateNote?: string; // gig summary — not visible to client
  TxnDate?: string;     // YYYY-MM-DD
  DueDate?: string;
}

// ── QB Online API response types ──────────────────────────────────────────────

export interface QBInvoiceObject {
  Id: string;
  DocNumber: string;
  TotalAmt: number;
  Balance: number;
}

export interface QBCreateInvoiceResponse {
  Invoice: QBInvoiceObject;
  time: string;
}

export interface QBTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}

export interface QBItemRow {
  Id: string;
  Name: string;
  Type: string;
  Active: boolean;
  IncomeAccountRef?: { value: string; name?: string };
}

export interface QBItemQueryResponse {
  QueryResponse: { Item?: QBItemRow[]; maxResults?: number };
  time: string;
}

export interface QBItemCreateResponse {
  Item: QBItemRow;
  time: string;
}

export interface QBCustomerRow {
  Id: string;
  DisplayName: string;
  Active: boolean;
}

export interface QBCustomerQueryResponse {
  QueryResponse: { Customer?: QBCustomerRow[]; maxResults?: number };
  time: string;
}

export interface QBAccountRow {
  Id: string;
  Name: string;
  AccountType: string;
  AccountSubType?: string;
  Active: boolean;
}

export interface QBAccountQueryResponse {
  QueryResponse: { Account?: QBAccountRow[]; maxResults?: number };
  time: string;
}

// ── QB item configuration ─────────────────────────────────────────────────────

/**
 * QB item IDs keyed by invoice line type.
 * null = not yet resolved; populated after a successful bootstrap.
 */
export interface QBItemConfig {
  dayRate: string | null;
  overtime: string | null;
  perDiem: string | null;
  mileage: string | null;
  mileageAdj: string | null;
  bagFees: string | null;
  hotel: string | null;
  parking: string | null;
  tolls: string | null;
  uber: string | null;
  otherExpenses: string | null;
}

/**
 * Ordered list of all item keys — used by bootstrap to know which items to
 * find or create. Order matches QB invoice line order.
 */
export const QB_REQUIRED_ITEM_KEYS: ReadonlyArray<keyof QBItemConfig> = [
  "dayRate",
  "overtime",
  "perDiem",
  "mileage",
  "mileageAdj",
  "bagFees",
  "hotel",
  "parking",
  "tolls",
  "uber",
  "otherExpenses",
] as const;

/**
 * Exact names used for QBO Products & Services items.
 * These are looked up by name during bootstrap; if not found they are created.
 */
export const QB_LINE_NAMES: Record<keyof QBItemConfig, string> = {
  dayRate:       "Freelance Audio Engineer – Day Rate",
  overtime:      "Overtime",
  perDiem:       "Per Diem",
  mileage:       "Mileage",
  mileageAdj:    "Mileage Adjustment",
  bagFees:       "Bag Fees",
  hotel:         "Hotel",
  parking:       "Parking",
  tolls:         "Tolls",
  uber:          "Uber",
  otherExpenses: "Other Expenses",
};

// ── Bootstrap cache ───────────────────────────────────────────────────────────

/** Resolved QB entity IDs, stored in Supabase after a successful bootstrap. */
export interface QBSetupCache {
  realmId: string;
  customerId: string;
  customerName: string;
  itemIds: Record<string, string>;             // all keys present after successful bootstrap
  incomeAccountRef: { value: string; name: string };
  bootstrappedAt: string;                       // ISO timestamp
}

// ── Bootstrap helper (pure — testable without HTTP) ──────────────────────────

/**
 * Given a list of existing item names (from QBO), return the QB_LINE_NAMES
 * values that are NOT yet present. These are the items that bootstrap will create.
 *
 * Comparison is case-insensitive.
 */
export function findMissingItemNames(
  existingNames: string[],
): string[] {
  const lower = new Set(existingNames.map((n) => n.toLowerCase()));
  return QB_REQUIRED_ITEM_KEYS
    .filter((key) => !lower.has(QB_LINE_NAMES[key].toLowerCase()))
    .map((key) => QB_LINE_NAMES[key]);
}

// ── Line builder ──────────────────────────────────────────────────────────────

function makeLine(
  itemId: string | null,
  name: string,
  amount: number,
  qty: number,
  unitPrice: number,
  description?: string,
): QBLine | null {
  if (!itemId) return null;
  if (amount === 0) return null;
  return {
    DetailType: "SalesItemLineDetail",
    Amount: round2(amount),
    ...(description ? { Description: description } : {}),
    SalesItemLineDetail: {
      ItemRef: { value: itemId, name },
      Qty: qty,
      UnitPrice: round2(unitPrice),
    },
  };
}

/**
 * Convert a calculated InvoicePacket into QB invoice line items.
 *
 * - Lines with null item IDs are omitted (items not yet bootstrapped).
 * - Lines with zero amounts are omitted.
 * - The mileage adjustment is a negative line for the non-reimbursable deduction.
 * - Expense notes are attached as the Description on the Other Expenses line.
 */
export function buildQBInvoiceLines(
  packet: InvoicePacket,
  items: QBItemConfig,
): QBLine[] {
  const m = packet.mileage;

  const candidates: (QBLine | null)[] = [
    makeLine(items.dayRate, QB_LINE_NAMES.dayRate, packet.dayRateTotal, packet.dayRateQty, packet.dayRate),

    packet.overtimeTotal > 0
      ? makeLine(items.overtime, QB_LINE_NAMES.overtime, packet.overtimeTotal, round2(packet.totalOvertimeHours), packet.overtimeRate)
      : null,

    packet.perDiemTotal > 0
      ? makeLine(items.perDiem, QB_LINE_NAMES.perDiem, packet.perDiemTotal, packet.perDiemQty, packet.perDiemRate)
      : null,

    m && m.mileageAmount > 0
      ? makeLine(items.mileage, QB_LINE_NAMES.mileage, m.mileageAmount, m.reimbursedMiles, m.mileageRate)
      : null,

    m && m.mileageAdjustmentAmount < 0
      ? makeLine(
          items.mileageAdj,
          QB_LINE_NAMES.mileageAdj,
          m.mileageAdjustmentAmount,
          -m.deductionMiles,
          m.mileageRate,
          `Non-reimbursable: ${m.deductionMiles} mi`,
        )
      : null,

    packet.bagFees > 0
      ? makeLine(items.bagFees, QB_LINE_NAMES.bagFees, packet.bagFees, 1, packet.bagFees)
      : null,
    packet.hotel > 0
      ? makeLine(items.hotel, QB_LINE_NAMES.hotel, packet.hotel, 1, packet.hotel)
      : null,
    packet.parking > 0
      ? makeLine(items.parking, QB_LINE_NAMES.parking, packet.parking, 1, packet.parking)
      : null,
    packet.tolls > 0
      ? makeLine(items.tolls, QB_LINE_NAMES.tolls, packet.tolls, 1, packet.tolls)
      : null,
    packet.uber > 0
      ? makeLine(items.uber, QB_LINE_NAMES.uber, packet.uber, 1, packet.uber)
      : null,
    packet.otherExpenses > 0
      ? makeLine(
          items.otherExpenses,
          QB_LINE_NAMES.otherExpenses,
          packet.otherExpenses,
          1,
          packet.otherExpenses,
          packet.expenseNotes ?? undefined,
        )
      : null,
  ];

  return candidates.filter((l): l is QBLine => l !== null);
}
