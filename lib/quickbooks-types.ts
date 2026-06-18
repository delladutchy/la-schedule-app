/**
 * QuickBooks Online API types and invoice line item mapping.
 *
 * This module is intentionally free of server-only imports so it can be
 * used in tests and, if needed, in shared UI code (e.g. to preview what
 * will be sent to QB before the user confirms).
 *
 * QB item IDs (QBItemConfig) are placeholders until the QuickBooks account
 * is set up. Configure them via QUICKBOOKS_ITEM_* env vars (see lib/quickbooks.ts).
 */

import type { InvoicePacket } from "./invoice-types";
import { round2 } from "./invoice-calculations";

// ── QB Online API types ───────────────────────────────────────────────────────

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
  Amount: number;            // total line amount; may be negative (e.g. mileage adjustment)
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

// ── QB item configuration ─────────────────────────────────────────────────────

/**
 * QB item IDs that map each line type to a service item in the QBO account.
 * All fields are nullable — null means the item has not been configured yet.
 * Lines with null item IDs are silently skipped by buildQBInvoiceLines().
 *
 * To configure: look up each item in QBO → Products & Services and note its ID,
 * then set QUICKBOOKS_ITEM_* env vars accordingly.
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

/** Human-readable names that appear on each QB invoice line. */
export const QB_LINE_NAMES: Record<keyof QBItemConfig, string> = {
  dayRate:       "Freelance Audio Engineer / Day Rate",
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

// ── Line builder ──────────────────────────────────────────────────────────────

function makeLine(
  itemId: string | null,
  name: string,
  amount: number,
  qty: number,
  unitPrice: number,
  description?: string,
): QBLine | null {
  if (!itemId) return null;   // item not yet configured in QB
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
 * - Lines with null item IDs (not yet configured) are omitted.
 * - Lines with zero amounts are omitted.
 * - The mileage adjustment is a negative line representing the non-reimbursable deduction.
 * - Expense notes (if present) are attached as the Description on the Other Expenses line.
 *
 * Returns an empty array when no items are configured — the caller should treat
 * this as a configuration error rather than creating an empty QB invoice.
 */
export function buildQBInvoiceLines(
  packet: InvoicePacket,
  items: QBItemConfig,
): QBLine[] {
  const m = packet.mileage;

  const candidates: (QBLine | null)[] = [
    // Labor
    makeLine(
      items.dayRate,
      QB_LINE_NAMES.dayRate,
      packet.dayRateTotal,
      packet.dayRateQty,
      packet.dayRate,
    ),
    packet.overtimeTotal > 0
      ? makeLine(
          items.overtime,
          QB_LINE_NAMES.overtime,
          packet.overtimeTotal,
          round2(packet.totalOvertimeHours),
          packet.overtimeRate,
        )
      : null,
    packet.perDiemTotal > 0
      ? makeLine(
          items.perDiem,
          QB_LINE_NAMES.perDiem,
          packet.perDiemTotal,
          packet.perDiemQty,
          packet.perDiemRate,
        )
      : null,

    // Mileage (billable miles × rate)
    m && m.mileageAmount > 0
      ? makeLine(
          items.mileage,
          QB_LINE_NAMES.mileage,
          m.mileageAmount,
          m.reimbursedMiles,
          m.mileageRate,
        )
      : null,
    // Mileage adjustment — negative line for the non-reimbursable deduction
    m && m.mileageAdjustmentAmount < 0
      ? makeLine(
          items.mileageAdj,
          QB_LINE_NAMES.mileageAdj,
          m.mileageAdjustmentAmount,          // already negative
          -m.deductionMiles,                   // negative qty × positive rate = negative amount
          m.mileageRate,
          `Non-reimbursable: ${m.deductionMiles} mi`,
        )
      : null,

    // Expenses
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
