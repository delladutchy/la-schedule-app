/**
 * Types for the invoice/tracking system.
 * Stored in Supabase invoice_data table; visible to Jeff/admin only.
 */

import type { InvoiceLineItemOverrides } from "./invoice-line-item-overrides";

export type InvoiceStatus =
  | "none"
  | "ready"
  | "sheet_synced"   // PDF created + synced to Google Sheets
  | "draft_created"  // QuickBooks draft (QB-specific)
  | "sent"
  | "partially_paid"
  | "paid"
  | "void";

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  none:           "No Invoice",
  ready:          "Ready",
  sheet_synced:   "Draft / Synced",
  draft_created:  "QB Draft",
  sent:           "Sent",
  partially_paid: "Partially Paid",
  paid:           "Paid",
  void:           "Void",
};

/** Statuses that represent a finalized/completed payment — do not regress these. */
export const TERMINAL_STATUSES: ReadonlySet<InvoiceStatus> =
  new Set(["sent", "partially_paid", "paid", "void"]);

/** How mileage was driven for one workday. */
export type MileageMode =
  | "none"
  | "from_dewey"       // one-way Dewey Beach → job; deduct 30 mi
  | "to_dewey"         // one-way job → Dewey Beach; deduct 30 mi
  | "round_trip_dewey" // both ways; deduct 60 mi
  | "custom";          // user-entered miles + editable deduction

/** One worked day: manual start/end times entered by Jeff, optional per-day mileage. */
export interface WorkdayEntry {
  date: string;                        // YYYY-MM-DD
  startTime: string;                   // e.g. "8:00 AM"
  endTime: string;                     // e.g. "6:30 PM"
  mileageMode?: MileageMode;           // undefined = none
  milesDriven?: number | null;         // actual miles for this day
  mileageDeduction?: number | null;    // override; null = use mode default
}

/** Per-day mileage calculation result. */
export interface WorkdayMileageCalc {
  date: string;
  mode: MileageMode;
  milesDriven: number;
  deduction: number;
  billableMiles: number;
}

/** Calculated result for a single workday. */
export interface WorkdayCalculated extends WorkdayEntry {
  totalHours: number;
  overtimeHours: number;
}

/** Mileage calculation result. */
export interface MileageCalc {
  totalMiles: number;
  deductionMiles: number;       // 60
  reimbursedMiles: number;      // max(totalMiles - 60, 0)
  unreimbursedMiles: number;    // totalMiles - reimbursedMiles (sheet only)
  mileageAmount: number;        // reimbursedMiles * rate
  mileageAdjustmentAmount: number; // -deductionMiles * rate (when totalMiles > 0)
  mileageRate: number;
}

/** Full row stored in Supabase invoice_data. */
export interface InvoiceData {
  id: string;
  google_event_id: string;
  la_number: string | null;
  invoice_status: InvoiceStatus;
  workday_entries: WorkdayEntry[];

  client: string;
  day_rate: number;
  per_diem_rate: number;
  overtime_rate: number;

  bag_fees: number | null;
  hotel: number | null;
  parking: number | null;
  tolls: number | null;
  uber: number | null;
  other_expenses: number | null;
  expense_notes: string | null;

  job_address: string | null;
  total_miles: number | null;
  mileage_rate: number;
  mileage_deduction_miles: number;

  sheet_synced_at: string | null;
  sheet_sync_error: string | null;
  paid_date: string | null;

  // Native invoicing (added in 20260618_invoice_pdf_fields.sql)
  invoice_number: string | null;
  invoice_pdf_url: string | null;
  invoice_created_at: string | null;
  invoice_sent_at: string | null;
  invoice_sent_to: string | null;      // comma-separated recipients; see invoice-sent-to-migration.sql
  invoice_sent_subject: string | null; // email subject from last send; see invoice-sent-subject-migration.sql
  invoice_total: number | null;
  // Text overrides (see scripts/invoice-overrides-migration.sql)
  invoice_job_name_override: string | null;
  invoice_day_rate_description_override: string | null;
  invoice_ot_description_override: string | null;
  invoice_per_diem_description_override: string | null;
  invoice_bag_fees_description_override: string | null;
  invoice_parking_description_override: string | null;
  invoice_uber_description_override: string | null;
  invoice_tolls_description_override: string | null;
  invoice_hotel_description_override: string | null;
  invoice_other_description_override: string | null;
  invoice_note_override: string | null;
  invoice_line_item_overrides: InvoiceLineItemOverrides;
  amount_paid: number;
  remaining_balance: number | null;

  // QuickBooks (added in scripts/qb-migration.sql)
  quickbooks_invoice_id: string | null;
  quickbooks_invoice_link: string | null;
  quickbooks_synced_at: string | null;
  quickbooks_sync_error: string | null;

  created_at: string;
  updated_at: string;
}

/** Calculated invoice totals, derived from InvoiceData. */
export interface InvoicePacket {
  googleEventId: string;
  laNumber: string | null;
  invoiceStatus: InvoiceStatus;
  client: string;

  workdays: WorkdayCalculated[];
  dayRateQty: number;
  dayRate: number;
  dayRateTotal: number;

  totalOvertimeHours: number;
  overtimeRate: number;
  overtimeTotal: number;

  perDiemQty: number;
  perDiemRate: number;
  perDiemTotal: number;

  mileage: MileageCalc | null;

  bagFees: number;
  hotel: number;
  parking: number;
  tolls: number;
  uber: number;
  otherExpenses: number;
  expenseNotes: string | null;

  estimatedTotal: number;

  // Pulled through from InvoiceData for PDF/status UI
  invoiceNumber: string | null;
  invoicePdfUrl: string | null;
  invoiceCreatedAt: string | null;
  invoiceSentAt: string | null;
  invoiceTotal: number | null;
  amountPaid: number;
  remainingBalance: number | null;
}

/** One row exported to Google Sheets. */
export interface SheetRow {
  invoiceNumber: string;
  date: string;
  laJobNumber: string;
  gigEvent: string;
  totalPay: number;
  labor: number;
  ot: number;
  mileage: number;
  parking: number;
  perDiem: number;
  hotel: number;
  tolls: number;
  bagFees: number;
  uber: number;
  otherExpenses: number;
  totalBusinessMiles: number;
  laPaidMiles: number;
  unreimbursedMiles: number;
  mileagePaid: number;
  status: InvoiceStatus;
  paidDate: string;
  // Native invoicing columns (appended at end to preserve existing column positions)
  invoicePdfUrl: string;
  invoiceSentDate: string;
  amountPaid: number;
  remainingBalance: number;
  paymentMethod: string;
  paymentReceivedDate: string;
  paymentBatchRef: string;
  // Optional extended columns (AC–AG). Add matching headers in the Sheet to label them.
  // Omit or leave undefined to skip writing these columns.
  sentTo?: string;
  sentSubject?: string;
  jobNameOverride?: string;
  dayRateDescriptionOverride?: string;
  noteOverride?: string;
  // Tax column (AH) — unreimbursed business miles × IRS standard mileage rate.
  // Helps with Schedule C deduction without mixing miles (col R) and dollars.
  unreimbursedMileageValue?: number;
}
