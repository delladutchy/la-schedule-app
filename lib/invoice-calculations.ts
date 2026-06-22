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
import { sanitizeInvoiceLineItemOverrides } from "./invoice-line-item-overrides";
import type { InvoiceLineItemKey } from "./invoice-line-item-overrides";
import { parseLaJobSummary } from "./gigs";

const TIME_12_RE = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i;
const TIME_24_RE = /^(\d{1,2}):(\d{2})$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** IRS standard business mileage deduction rate for 2026. */
export const IRS_MILEAGE_RATE_2026 = 0.725;

export interface MileageInvoicePresentationLine {
  service: "Mileage" | "Mileage Adjustment";
  description: string;
  qty: number;
  rate: number;
  amount: number;
}

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

function normalizeIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = ISO_DATE_RE.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function enumerateInvoiceDateRange(startDate: string, endDateInclusive: string): string[] {
  const start = normalizeIsoDate(startDate);
  const end = normalizeIsoDate(endDateInclusive);
  if (!start || !end || end < start) return [];

  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  const cursor = new Date(Date.UTC(startYear!, startMonth! - 1, startDay!));
  const last = Date.UTC(endYear!, endMonth! - 1, endDay!);
  const dates: string[] = [];

  while (cursor.getTime() <= last) {
    const year = cursor.getUTCFullYear();
    const month = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    const day = String(cursor.getUTCDate()).padStart(2, "0");
    dates.push(`${year}-${month}-${day}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

export function mergeInvoiceWorkDates(
  expectedDates: string[],
  existing: WorkdayEntry[] = [],
): string[] {
  const dates = new Set<string>();
  for (const date of expectedDates) {
    const normalized = normalizeIsoDate(date);
    if (normalized) dates.add(normalized);
  }
  for (const entry of existing) {
    const normalized = normalizeIsoDate(entry.date);
    if (normalized) dates.add(normalized);
  }
  return [...dates].sort();
}

export function buildInvoiceWorkDates(
  startDate: string | null | undefined,
  endDateInclusive: string | null | undefined,
  existing: WorkdayEntry[] = [],
): string[] {
  const rangeDates = startDate
    ? enumerateInvoiceDateRange(startDate, endDateInclusive ?? startDate)
    : [];
  return mergeInvoiceWorkDates(rangeDates, existing);
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
  const grossMileageAmount = round2(totalMiles * rate);
  const mileageAmount = round2(reimbursedMiles * rate);
  const mileageAdjustmentAmount = unreimbursedMiles > 0 ? round2(-unreimbursedMiles * rate) : 0;
  return {
    totalMiles,
    deductionMiles,
    reimbursedMiles,
    unreimbursedMiles,
    grossMileageAmount,
    mileageAmount,
    mileageAdjustmentAmount,
    mileageRate: rate,
  };
}

export function buildMileageInvoicePresentationLines(
  mileage: MileageCalc | null,
): MileageInvoicePresentationLine[] {
  if (!mileage || mileage.totalMiles <= 0) return [];

  const lines: MileageInvoicePresentationLine[] = [{
    service: "Mileage",
    description: `${mileage.totalMiles} miles × ${mileage.mileageRate.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 })}`,
    qty: mileage.totalMiles,
    rate: mileage.mileageRate,
    amount: mileage.grossMileageAmount,
  }];

  if (mileage.unreimbursedMiles > 0 && mileage.mileageAdjustmentAmount < 0) {
    lines.push({
      service: "Mileage Adjustment",
      description: `Per company policy: ${mileage.unreimbursedMiles} miles excluded`,
      qty: -mileage.unreimbursedMiles,
      rate: mileage.mileageRate,
      amount: mileage.mileageAdjustmentAmount,
    });
  }

  return lines;
}

/**
 * Merge saved workday entries with the expected work dates for a job.
 *
 * Rules (in priority order):
 *  1. If a saved entry exists for a date, return it unchanged — never overwrite
 *     with scheduled defaults, even if the calendar event later changes.
 *  2. If no saved entry exists for a date (brand-new job), create one seeded
 *     with the scheduled event start/end times as defaults.
 *  3. Preserve saved rows even when the caller's expected dates are clipped to
 *     a current/visible day slice. Invoice editing is after-the-fact and must
 *     not drop past workdays.
 *  4. If no defaults are provided, create an empty entry.
 *
 * This function is pure — it never mutates existing entries.
 */
export function initWorkdayEntries(
  existing: WorkdayEntry[],
  dates: string[],
  defaultStart?: string,
  defaultEnd?: string,
): WorkdayEntry[] {
  const savedByDate = new Map(existing.map((e) => [e.date, e]));
  return mergeInvoiceWorkDates(dates, existing).map((date) => {
    const saved = savedByDate.get(date);
    if (saved) {
      // An empty saved time ("") means the user cleared it → fall back to the
      // calendar-scheduled default, just as if no time had been saved yet.
      // A non-empty saved time (e.g. "7:30 AM") always wins over the default.
      const startTime = saved.startTime !== "" ? saved.startTime : (defaultStart ?? "");
      const endTime   = saved.endTime   !== "" ? saved.endTime   : (defaultEnd   ?? "");
      if (startTime === saved.startTime && endTime === saved.endTime) return saved;
      return { ...saved, startTime, endTime };
    }
    return { date, startTime: defaultStart ?? "", endTime: defaultEnd ?? "" };
  });
}

/** Convert stored workday entries into calculated rows. */
export function calculateWorkdays(entries: WorkdayEntry[]): WorkdayCalculated[] {
  return entries.map((entry) => {
    const { totalHours, overtimeHours } = calculateHours(entry.startTime, entry.endTime);
    return { ...entry, totalHours, overtimeHours };
  });
}

/** Derive a complete InvoicePacket from stored InvoiceData. */
export function calculateInvoicePacket(data: InvoiceData): InvoicePacket {
  const workdays = calculateWorkdays(data.workday_entries);
  const lineItemOverrides = sanitizeInvoiceLineItemOverrides(data.invoice_line_item_overrides);
  const resolveQtyRateLine = (
    key: InvoiceLineItemKey,
    autoQty: number,
    autoRate: number,
  ): { qty: number; rate: number; total: number } => {
    const override = lineItemOverrides[key];
    const qty = override?.qty ?? autoQty;
    const rate = override?.rate ?? autoRate;
    return { qty, rate, total: round2(qty * rate) };
  };
  const resolveAmountLine = (key: InvoiceLineItemKey, autoAmount: number): number => {
    return round2(lineItemOverrides[key]?.amount ?? autoAmount);
  };

  const dayRateLine = resolveQtyRateLine("day_rate", workdays.length, data.day_rate);
  const dayRateQty = dayRateLine.qty;
  const dayRate = dayRateLine.rate;
  const dayRateTotal = dayRateLine.total;

  const totalOvertimeHours = round2(workdays.reduce((sum, w) => sum + w.overtimeHours, 0));
  const overtimeLine = resolveQtyRateLine("ot", totalOvertimeHours, data.overtime_rate);
  const adjustedOvertimeHours = overtimeLine.qty;
  const overtimeRate = overtimeLine.rate;
  const overtimeTotal = overtimeLine.total;

  const perDiemLine = resolveQtyRateLine("per_diem", workdays.length, data.per_diem_rate);
  const perDiemQty = perDiemLine.qty;
  const perDiemRate = perDiemLine.rate;
  const perDiemTotal = perDiemLine.total;

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
      grossMileageAmount: round2(totalMiles * rate),
      mileageAmount: round2(reimbursedMiles * rate),
      mileageAdjustmentAmount: unreimbursedMiles > 0 ? round2(-unreimbursedMiles * rate) : 0,
      mileageRate: rate,
    };
  } else if (data.total_miles != null && data.total_miles > 0) {
    mileage = calculateMileage(data.total_miles, data.mileage_deduction_miles, data.mileage_rate);
  }

  const bagFees = resolveAmountLine("bag_fees", data.bag_fees ?? 0);
  const hotel = resolveAmountLine("hotel", data.hotel ?? 0);
  const parking = resolveAmountLine("parking", data.parking ?? 0);
  const tolls = resolveAmountLine("tolls", data.tolls ?? 0);
  const uber = resolveAmountLine("uber", data.uber ?? 0);
  const otherExpenses = resolveAmountLine("other", data.other_expenses ?? 0);

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
    totalOvertimeHours: adjustedOvertimeHours,
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
    // Native invoicing fields passed through from storage
    invoiceNumber:     data.invoice_number    ?? null,
    invoicePdfUrl:     data.invoice_pdf_url   ?? null,
    invoiceCreatedAt:  data.invoice_created_at ?? null,
    invoiceSentAt:     data.invoice_sent_at   ?? null,
    invoiceTotal:      data.invoice_total     ?? null,
    amountPaid:        data.amount_paid       ?? 0,
    remainingBalance:  data.remaining_balance ?? null,
  };
}

/** Generate a Google Sheet row from a calculated InvoicePacket. */
export interface GenerateSheetRowExtras {
  sentTo?: string | null;
  sentSubject?: string | null;
  jobNameOverride?: string | null;
}

export function generateSheetRow(
  packet: InvoicePacket,
  gigSummary: string,
  invoiceNumber?: string,
  paymentMeta?: {
    paymentMethod?: string;
    paymentReceivedDate?: string;
    paymentBatchRef?: string;
  },
  extras?: GenerateSheetRowExtras,
): SheetRow {
  const m = packet.mileage;
  const pm = paymentMeta ?? {};
  const finalGigEvent = resolveSheetGigEvent(gigSummary, extras?.jobNameOverride);
  return {
    invoiceNumber: invoiceNumber ?? packet.invoiceNumber ?? packet.laNumber ?? "",
    date: new Date().toISOString().slice(0, 10),
    laJobNumber: packet.laNumber ?? "",
    gigEvent: finalGigEvent,
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
    // Native invoicing columns (appended to preserve existing positions)
    invoicePdfUrl:        packet.invoicePdfUrl       ?? "",
    invoiceSentDate:      packet.invoiceSentAt        ? packet.invoiceSentAt.slice(0, 10)  : "",
    amountPaid:           packet.amountPaid           ?? 0,
    remainingBalance:     Math.max(0, Number((packet.estimatedTotal - (packet.amountPaid ?? 0)).toFixed(2))),
    paymentMethod:        pm.paymentMethod            ?? "",
    paymentReceivedDate:  pm.paymentReceivedDate      ?? "",
    paymentBatchRef:      pm.paymentBatchRef          ?? "",
    // Optional visible email metadata columns (AC–AD)
    sentTo:      extras?.sentTo      ?? "",
    sentSubject: extras?.sentSubject ?? "",
    // Hidden internal spacer columns (AE–AG). Overrides stay in Supabase invoice_data.
    internalReservedAe: "",
    internalReservedAf: "",
    internalReservedAg: "",
    // Tax column AH: unreimbursed miles × IRS rate = Schedule C deduction value
    unreimbursedMileageValue: Math.round((m?.unreimbursedMiles ?? 0) * IRS_MILEAGE_RATE_2026 * 100) / 100,
  };
}

export function resolveSheetGigEvent(gigSummary: string, jobNameOverride?: string | null): string {
  const override = jobNameOverride?.trim();
  if (override) return override;

  const parsed = parseLaJobSummary(gigSummary);
  return parsed.jobName.trim() || gigSummary.trim();
}
