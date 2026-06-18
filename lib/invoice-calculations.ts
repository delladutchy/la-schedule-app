/**
 * Pure utility functions for invoice calculations.
 * No side effects; safe to import anywhere including tests.
 *
 * Validation cases (see tests/invoice-calculations.test.ts):
 *   8:00 AM → 6:00 PM  = 10 h total, 0 OT
 *   8:00 AM → 8:30 PM  = 12.5 h total, 2.5 OT
 *   420 miles → 360 reimbursed, 60 unreimbursed, $187.20 mileage paid
 */

import type {
  InvoiceData,
  InvoicePacket,
  MileageCalc,
  MileageMode,
  SheetRow,
  WorkdayCalculated,
  WorkdayEntry,
  WorkdayMileageCalc,
} from "./invoice-types";

const TIME_12_RE = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i;
const TIME_24_RE = /^(\d{1,2}):(\d{2})$/;

/** Convert a human time string to minutes-since-midnight. Returns null on parse failure. */
export function parseTimeToMinutes(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;

  const m12 = TIME_12_RE.exec(s);
  if (m12) {
    const h = Number(m12[1] ?? 0);
    const min = Number(m12[2] ?? 0);
    const meridiem = (m12[3] ?? "").toUpperCase();
    if (h < 1 || h > 12 || min < 0 || min > 59) return null;
    let h24 = h % 12;
    if (meridiem === "PM") h24 += 12;
    return h24 * 60 + min;
  }

  const m24 = TIME_24_RE.exec(s);
  if (m24) {
    const h = Number(m24[1] ?? 0);
    const min = Number(m24[2] ?? 0);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  }

  return null;
}

/** Calculate total hours (decimal) and overtime hours from start/end time strings. */
export function calculateHours(startTime: string, endTime: string): {
  totalHours: number;
  overtimeHours: number;
} {
  const startMin = parseTimeToMinutes(startTime);
  const endMin = parseTimeToMinutes(endTime);
  if (startMin == null || endMin == null) return { totalHours: 0, overtimeHours: 0 };
  let diffMin = endMin - startMin;
  if (diffMin < 0) diffMin += 24 * 60; // overnight shift: end is next calendar day
  if (diffMin === 0) return { totalHours: 0, overtimeHours: 0 };
  const totalHours = diffMin / 60;
  const overtimeHours = Math.max(0, totalHours - 10);
  return { totalHours, overtimeHours };
}

/** Round to 2 decimal places (for display/sheet). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Deduction miles that apply per mode under the Light Action agreement. */
export function getDefaultDeductionForMode(mode: MileageMode): number {
  switch (mode) {
    case "from_dewey":       return 30;
    case "to_dewey":         return 30;
    case "round_trip_dewey": return 60;
    case "custom":           return 60; // user-editable; defaults to round-trip amount
    default:                 return 0;
  }
}

/** Calculate mileage for one workday. Returns null when no mileage is set or miles ≤ 0. */
export function calculateWorkdayMileage(entry: WorkdayEntry): WorkdayMileageCalc | null {
  const mode = entry.mileageMode;
  if (!mode || mode === "none") return null;
  const miles = entry.milesDriven;
  if (!miles || miles <= 0) return null;
  const deduction = entry.mileageDeduction ?? getDefaultDeductionForMode(mode);
  const billableMiles = Math.max(0, miles - deduction);
  return { date: entry.date, mode, milesDriven: miles, deduction, billableMiles };
}

/** Calculate mileage reimbursement. */
export function calculateMileage(
  totalMiles: number,
  deductionMiles: number,
  rate: number,
): MileageCalc {
  const reimbursedMiles = Math.max(0, totalMiles - deductionMiles);
  const unreimbursedMiles = totalMiles - reimbursedMiles;
  const mileageAmount = round2(reimbursedMiles * rate);
  const mileageAdjustmentAmount = totalMiles > 0 ? round2(-deductionMiles * rate) : 0;
  return {
    totalMiles,
    deductionMiles,
    reimbursedMiles,
    unreimbursedMiles,
    mileageAmount,
    mileageAdjustmentAmount,
    mileageRate: rate,
  };
}

/** Convert stored workday entries into calculated rows. */
export function calculateWorkdays(entries: WorkdayEntry[]): WorkdayCalculated[] {
  return entries.map((entry) => {
    const { totalHours, overtimeHours } = calculateHours(entry.startTime, entry.endTime);
    return { ...entry, totalHours, overtimeHours };
  });
}

/** Derive a complete InvoicePacket from stored InvoiceData. */
export function calculateInvoicePacket(data: InvoiceData, gigSummary?: string): InvoicePacket {
  const workdays = calculateWorkdays(data.workday_entries);
  const dayRateQty = workdays.length;
  const dayRate = data.day_rate;
  const dayRateTotal = round2(dayRateQty * dayRate);

  const totalOvertimeHours = round2(workdays.reduce((sum, w) => sum + w.overtimeHours, 0));
  const overtimeRate = data.overtime_rate;
  const overtimeTotal = round2(totalOvertimeHours * overtimeRate);

  const perDiemQty = dayRateQty;
  const perDiemRate = data.per_diem_rate;
  const perDiemTotal = round2(perDiemQty * perDiemRate);

  // Per-day mileage takes precedence; fall back to legacy job-level total_miles.
  const perDayMileage = data.workday_entries
    .map(calculateWorkdayMileage)
    .filter((m): m is WorkdayMileageCalc => m !== null);

  let mileage: MileageCalc | null = null;
  if (perDayMileage.length > 0) {
    const totalMiles = perDayMileage.reduce((s, m) => s + m.milesDriven, 0);
    const totalDeduction = perDayMileage.reduce((s, m) => s + m.deduction, 0);
    const reimbursedMiles = perDayMileage.reduce((s, m) => s + m.billableMiles, 0);
    const unreimbursedMiles = totalMiles - reimbursedMiles;
    const rate = data.mileage_rate;
    mileage = {
      totalMiles,
      deductionMiles: totalDeduction,
      reimbursedMiles,
      unreimbursedMiles,
      mileageAmount: round2(reimbursedMiles * rate),
      mileageAdjustmentAmount: totalDeduction > 0 ? round2(-totalDeduction * rate) : 0,
      mileageRate: rate,
    };
  } else if (data.total_miles != null && data.total_miles > 0) {
    mileage = calculateMileage(data.total_miles, data.mileage_deduction_miles, data.mileage_rate);
  }

  const bagFees = data.bag_fees ?? 0;
  const hotel = data.hotel ?? 0;
  const parking = data.parking ?? 0;
  const tolls = data.tolls ?? 0;
  const uber = data.uber ?? 0;
  const otherExpenses = data.other_expenses ?? 0;

  const estimatedTotal = round2(
    dayRateTotal
    + overtimeTotal
    + perDiemTotal
    + (mileage?.mileageAmount ?? 0)
    + bagFees
    + hotel
    + parking
    + tolls
    + uber
    + otherExpenses,
  );

  return {
    googleEventId: data.google_event_id,
    laNumber: data.la_number,
    invoiceStatus: data.invoice_status,
    client: data.client,
    workdays,
    dayRateQty,
    dayRate,
    dayRateTotal,
    totalOvertimeHours,
    overtimeRate,
    overtimeTotal,
    perDiemQty,
    perDiemRate,
    perDiemTotal,
    mileage,
    bagFees,
    hotel,
    parking,
    tolls,
    uber,
    otherExpenses,
    expenseNotes: data.expense_notes ?? null,
    estimatedTotal,
  };
}

/** Generate a Google Sheet row from a calculated InvoicePacket. */
export function generateSheetRow(
  packet: InvoicePacket,
  gigSummary: string,
  invoiceNumber?: string,
): SheetRow {
  const m = packet.mileage;
  return {
    invoiceNumber: invoiceNumber ?? packet.laNumber ?? "",
    date: new Date().toISOString().slice(0, 10),
    laJobNumber: packet.laNumber ?? "",
    gigEvent: gigSummary,
    totalPay: packet.estimatedTotal,
    labor: packet.dayRateTotal,
    ot: packet.overtimeTotal,
    mileage: m?.mileageAmount ?? 0,
    parking: packet.parking,
    perDiem: packet.perDiemTotal,
    hotel: packet.hotel,
    tolls: packet.tolls,
    bagFees: packet.bagFees,
    uber: packet.uber,
    otherExpenses: packet.otherExpenses,
    totalBusinessMiles: m?.totalMiles ?? 0,
    laPaidMiles: m?.reimbursedMiles ?? 0,
    unreimbursedMiles: m?.unreimbursedMiles ?? 0,
    mileagePaid: m?.mileageAmount ?? 0,
    status: packet.invoiceStatus,
    paidDate: "",
  };
}
