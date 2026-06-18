/**
 * Types for the invoice/tracking system.
 * Stored in Supabase invoice_data table; visible to Jeff/admin only.
 */

export type InvoiceStatus =
  | "none"
  | "ready"
  | "sheet_synced"
  | "draft_created"
  | "sent"
  | "paid";

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
}
