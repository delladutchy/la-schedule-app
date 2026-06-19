/**
 * Native invoice PDF generation.
 *
 * Uses @react-pdf/renderer for server-side PDF creation.
 * Import "server-only" ensures this never leaks to the client bundle.
 *
 * Usage:
 *   const buffer = await renderInvoicePDF({ packet, invoiceNumber, gigSummary, issuedDate });
 */
import "server-only";

import React from "react";
import {
  Document,
  Font,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { InvoicePacket } from "./invoice-types";

// Logo hosted on Netlify CDN. Fetched at PDF render time and embedded as base64.
// Falls back to text branding when unavailable (file not yet deployed, network error, etc.).
const LOGO_PDF_URL = "https://la-schedule-app.netlify.app/brand/jeff-ulsh-logo.png";

// ---------------------------------------------------------------------------
// Business info
// ---------------------------------------------------------------------------

export const CONTRACTOR_INFO = {
  name:         "Jeff Ulsh",
  title:        "Freelance Audio Engineer",
  email:        "jeffulsh@gmail.com",
  phone:        "+1 (717) 460-1981",
  website:      "jeffulsh.carrd.co",
  addressLines: ["108 New Orleans St", "Dewey Beach, DE 19971-3205"],
};

const CLIENT_INFO_BY_NAME: Record<string, { addressLines: string[] }> = {
  "Light Action": {
    addressLines: ["1145 E Seventh St.", "Wilmington, DE 19801", "United States"],
  },
};

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

Font.registerHyphenationCallback((word) => [word]);

// ---------------------------------------------------------------------------
// Brand palette
// ---------------------------------------------------------------------------

const C = {
  teal:     "#429AA3",
  tealDark: "#357E86",
  infoBg:   "#EDF7F8",
  black:    "#2D3338",
  dark:     "#3E454B",
  body:     "#4F5961",
  muted:    "#6F7880",
  light:    "#A7B0B7",
  border:   "#E3E8EB",
  row:      "#FAFCFC",
  white:    "#FFFFFF",
} as const;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: C.body,
    paddingTop: 50,
    paddingBottom: 46,
    paddingHorizontal: 46,
    backgroundColor: C.white,
  },

  // ── Header ──────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 30,
  },
  headerIdentity: {
    flexDirection: "column",
    width: 230,
  },
  headerContact: {
    flexDirection: "column",
    width: 150,
    paddingTop: 25,
  },
  logo: {
    width: 120,
  },
  invoiceWordmark: {
    fontSize: 17,
    fontFamily: "Helvetica-Bold",
    color: C.teal,
    letterSpacing: 1.45,
    marginBottom: 7,
  },
  contractorName: {
    fontSize: 8.5,
    fontFamily: "Helvetica-Bold",
    color: C.black,
    marginBottom: 1.5,
  },
  contractorSub: {
    fontSize: 7.8,
    color: C.muted,
    marginBottom: 2,
  },
  headerRight: {
    alignItems: "flex-end",
    width: 122,
    marginTop: -10,
  },
  logoFallback: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: C.infoBg,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.teal,
  },
  logoFallbackText: {
    fontSize: 18,
    fontFamily: "Helvetica-Bold",
    color: C.tealDark,
    textAlign: "center",
  },

  // ── Bill To / Meta two-column ────────────────────────────────────────────────
  infoPanel: {
    backgroundColor: C.infoBg,
    marginHorizontal: -46,
    marginBottom: 26,
    paddingTop: 29,
    paddingBottom: 32,
    paddingHorizontal: 46,
    minHeight: 178,
  },
  infoTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  infoBlock: {
    flexDirection: "column",
    width: "46.8%",
  },
  infoLabel: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: C.dark,
    marginBottom: 9,
  },
  infoPrimary: {
    fontSize: 10,
    color: C.black,
    marginBottom: 4,
  },
  infoLine: {
    fontSize: 9.5,
    color: C.body,
    marginBottom: 4,
  },
  detailRow: {
    flexDirection: "row",
    marginBottom: 4.6,
  },
  detailLabel: {
    width: 78,
    fontSize: 9.1,
    color: C.body,
  },
  detailValue: {
    flex: 1,
    fontSize: 9.1,
    color: C.body,
  },

  // ── Line-item table ──────────────────────────────────────────────────────────
  table: {
    marginBottom: 20,
  },
  tableHeader: {
    flexDirection: "row",
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  thNumber: { width: "5%",  fontSize: 8.8, color: C.black },
  thService: { width: "29%", fontSize: 8.8, color: C.black },
  thDescription: { width: "31%", fontSize: 8.8, color: C.black },
  thQty: { width: "9%", fontSize: 8.8, color: C.black, textAlign: "right" },
  thRate: { width: "12%", fontSize: 8.8, color: C.black, textAlign: "right" },
  thAmount: { width: "14%", fontSize: 8.8, color: C.black, textAlign: "right" },
  tableRow: {
    flexDirection: "row",
    minHeight: 34,
    paddingVertical: 8.7,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  tableRowAlt: {
    backgroundColor: C.white,
  },
  tdNumber: { width: "5%", fontSize: 8.5, color: C.body },
  tdService: { width: "29%", fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.dark, paddingRight: 8 },
  tdDescription: { width: "31%", fontSize: 8.5, color: C.body, paddingRight: 8 },
  tdQty: { width: "9%", fontSize: 8.5, color: C.body, textAlign: "right" },
  tdRate: { width: "12%", fontSize: 8.5, color: C.body, textAlign: "right" },
  tdAmount: { width: "14%", fontSize: 8.5, color: C.body, textAlign: "right" },

  // ── Totals ───────────────────────────────────────────────────────────────────
  lowerSection: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginTop: 4,
  },
  noteBox: {
    width: "53%",
    paddingTop: 5,
    paddingLeft: 18,
  },
  noteTitle: {
    fontSize: 12,
    color: C.dark,
    marginBottom: 8,
  },
  noteText: {
    fontSize: 8.6,
    color: C.body,
    lineHeight: 1.35,
    marginBottom: 1,
  },
  signatureGroup: {
    marginTop: 0,
    marginBottom: 2,
  },
  signatureFallback: {
    fontSize: 9,
    color: C.body,
    marginTop: 1,
    marginBottom: 4,
  },
  expenseNoteText: {
    fontSize: 8.2,
    color: C.muted,
    marginTop: 7,
  },
  totalsBox: {
    width: "36%",
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 5.5,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  totalRowEmphasis: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8.5,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
  },
  totalLabel: {
    fontSize: 9,
    color: C.body,
  },
  totalValue: {
    fontSize: 9,
    color: C.black,
    fontFamily: "Helvetica-Bold",
  },
  paymentValue: {
    fontSize: 9,
    color: C.black,
  },
  balanceLabel: {
    fontSize: 9.5,
    fontFamily: "Helvetica-Bold",
    color: C.black,
  },
  balanceValue: {
    fontSize: 14,
    fontFamily: "Helvetica-Bold",
    color: C.black,
  },
  paidInFull: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: "#18A118",
    textAlign: "right",
    marginTop: 10,
  },

});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function fmtPayment(n: number): string {
  return `-${fmt(n)}`;
}

function fmtDate(isoDate: string): string {
  const [y, mo, d] = isoDate.split("-").map(Number);
  return `${String(mo).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
}

function fmtCompactDate(isoDate: string): string {
  const [y, mo, d] = isoDate.split("-").map(Number);
  return `${mo}/${d}/${String(y).slice(2)}`;
}

function fmtShortDate(isoDate: string, includeYear = false): string {
  const [y, mo, d] = isoDate.split("-").map(Number);
  return includeYear ? `${mo}/${d}/${y}` : `${mo}/${d}`;
}

function addDaysIso(isoDate: string, days: number): string {
  const [y, mo, d] = isoDate.split("-").map(Number);
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fmtWorkDates(workdays: InvoicePacket["workdays"]): string {
  if (workdays.length === 0) return "";
  const dates = workdays.map((w) => w.date);
  if (dates.length === 1) return fmtShortDate(dates[0]!);
  const sorted = [...dates].sort();
  const start = sorted[0]!;
  const end = sorted[sorted.length - 1]!;
  const includeYear = start.slice(0, 4) !== end.slice(0, 4);
  return `${fmtShortDate(start, includeYear)} - ${fmtShortDate(end, includeYear)}`;
}

function fmtHours(n: number): string {
  return n % 1 === 0 ? `${n}` : n.toFixed(2);
}

function formatLaJobNumber(laNumber: string | null): string | null {
  if (!laNumber) return null;
  const clean = laNumber.replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "");
  return clean ? `LA #${clean}` : laNumber;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatJobTitle(gigSummary: string, laNumber: string | null): string {
  let title = gigSummary.trim();
  const cleanLa = laNumber?.replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "") ?? "";
  if (cleanLa) {
    title = title
      .replace(
        new RegExp(`^\\s*LA\\s*#?\\s*${escapeRegExp(cleanLa)}\\s*(?:[-–—:|]+\\s*)?`, "i"),
        "",
      )
      .trim();
  }
  return title.replace(/^[\s\-–—:|]+/, "").trim();
}

function fmtCompactTime(raw: string): string {
  const trimmed = raw.trim();
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(trimmed);
  if (!match) return trimmed.replace(/\s+/g, "").toLowerCase();
  const hour = Number(match[1]);
  const minute = match[2] ?? "00";
  const meridiem = (match[3] ?? "").toLowerCase();
  return `${hour}:${minute}${meridiem}`;
}

function fmtWorkedDateTimes(workdays: InvoicePacket["workdays"]): string {
  return workdays
    .map((workday) => {
      const date = fmtShortDate(workday.date);
      const start = fmtCompactTime(workday.startTime);
      const end = fmtCompactTime(workday.endTime);
      if (!start || !end) return date;
      return `${date} - ${start}-${end}`;
    })
    .join("\n");
}

interface PdfLineItem {
  service: string;
  description: string;
  qty: string;
  rate: string;
  amount: number;
}

// ---------------------------------------------------------------------------
// PDF Component
// ---------------------------------------------------------------------------

interface InvoicePDFProps {
  packet:        InvoicePacket;
  invoiceNumber: string;
  gigSummary:    string;
  issuedDate:    string; // YYYY-MM-DD
  logoSrc:       string | null;
}

function InvoicePDF({ packet, invoiceNumber, gigSummary, issuedDate, logoSrc }: InvoicePDFProps) {
  const m       = packet.mileage;
  const hasOT   = packet.overtimeTotal > 0;
  const hasMile = m !== null && m.totalMiles > 0;
  const hasPD   = packet.perDiemTotal > 0;
  const workDateStr = fmtWorkDates(packet.workdays);
  const workedDateTimes = fmtWorkedDateTimes(packet.workdays);
  const formattedLaJob = formatLaJobNumber(packet.laNumber);
  const clientInvoiceNumber = formattedLaJob
    ? `${invoiceNumber} - ${formattedLaJob}`
    : invoiceNumber;
  const jobTitle = formatJobTitle(gigSummary, packet.laNumber);
  const billToAddress = CLIENT_INFO_BY_NAME[packet.client]?.addressLines ?? [];
  const dueDate = addDaysIso(issuedDate, 15);
  const invoiceTotal = packet.estimatedTotal;
  const paidAmount = packet.invoiceStatus === "paid"
    ? invoiceTotal
    : packet.amountPaid > 0
      ? packet.amountPaid
      : 0;
  const balanceDue = packet.invoiceStatus === "paid"
    ? 0
    : Math.max(Number((invoiceTotal - paidAmount).toFixed(2)), 0);
  const showPaymentRow = paidAmount > 0;
  const showPaidInFull = balanceDue <= 0;

  const expenses: Array<{ label: string; amount: number }> = [
    { label: "Bag Fees",           amount: packet.bagFees },
    { label: "Parking",            amount: packet.parking },
    { label: "Hotel",              amount: packet.hotel },
    { label: "Tolls",              amount: packet.tolls },
    { label: "Uber",               amount: packet.uber },
    { label: "Other",              amount: packet.otherExpenses },
  ].filter((e) => e.amount > 0);

  const lineItems: PdfLineItem[] = [];
  if (packet.dayRateQty > 0) {
    lineItems.push({
      service: "Freelance Audio Engineer",
      description: workedDateTimes,
      qty: String(packet.dayRateQty),
      rate: fmt(packet.dayRate),
      amount: packet.dayRateTotal,
    });
  }
  if (hasOT) {
    lineItems.push({
      service: "Overtime",
      description: "Over 10hrs",
      qty: fmtHours(packet.totalOvertimeHours),
      rate: fmt(packet.overtimeRate),
      amount: packet.overtimeTotal,
    });
  }
  if (hasPD) {
    lineItems.push({
      service: "Per Diem",
      description: "",
      qty: String(packet.perDiemQty),
      rate: fmt(packet.perDiemRate),
      amount: packet.perDiemTotal,
    });
  }
  if (hasMile) {
    lineItems.push({
      service: "Mileage",
      description: "Billable mileage after deduction",
      qty: `${m!.reimbursedMiles}`,
      rate: fmt(m!.mileageRate),
      amount: m!.mileageAmount,
    });
  }
  for (const exp of expenses) {
    lineItems.push({
      service: exp.label,
      description: "",
      qty: "1",
      rate: fmt(exp.amount),
      amount: exp.amount,
    });
  }
  return (
    <Document title={`Invoice ${clientInvoiceNumber}`} author={CONTRACTOR_INFO.name}>
      <Page size="LETTER" style={styles.page}>

        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.headerIdentity}>
            <Text style={styles.invoiceWordmark}>INVOICE</Text>
            <Text style={styles.contractorName}>{CONTRACTOR_INFO.name}</Text>
            {CONTRACTOR_INFO.addressLines.map((line) => (
              <Text key={line} style={styles.contractorSub}>{line}</Text>
            ))}
          </View>
          <View style={styles.headerContact}>
            <Text style={styles.contractorSub}>{CONTRACTOR_INFO.email}</Text>
            <Text style={styles.contractorSub}>{CONTRACTOR_INFO.phone}</Text>
            <Text style={styles.contractorSub}>{CONTRACTOR_INFO.website}</Text>
          </View>
          <View style={styles.headerRight}>
            {logoSrc
              ? <Image src={logoSrc} style={styles.logo} />
              : (
                <View style={styles.logoFallback}>
                  <Text style={styles.logoFallbackText}>Jeff{"\n"}Ulsh</Text>
                </View>
              )
            }
          </View>
        </View>

        {/* ── Bill To / Job Details ── */}
        <View style={styles.infoPanel}>
          <View style={styles.infoTopRow}>
            <View style={styles.infoBlock}>
              <Text style={styles.infoLabel}>Bill to</Text>
              <Text style={styles.infoPrimary}>{packet.client}</Text>
              {billToAddress.map((line) => (
                <Text key={line} style={styles.infoLine}>{line}</Text>
              ))}
            </View>
            <View style={styles.infoBlock}>
              <Text style={styles.infoLabel}>Invoice details</Text>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Invoice no.:</Text>
                <Text style={styles.detailValue}>{clientInvoiceNumber}</Text>
              </View>
              {jobTitle ? (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Job:</Text>
                  <Text style={styles.detailValue}>{jobTitle}</Text>
                </View>
              ) : null}
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Invoice date:</Text>
                <Text style={styles.detailValue}>{fmtCompactDate(issuedDate)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Due date:</Text>
                <Text style={styles.detailValue}>{fmtCompactDate(dueDate)}</Text>
              </View>
              {workDateStr ? (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Work dates:</Text>
                  <Text style={styles.detailValue}>{workDateStr}</Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>

        {/* ── Line Items ── */}
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={styles.thNumber}>#</Text>
            <Text style={styles.thService}>Product or service</Text>
            <Text style={styles.thDescription}>Description</Text>
            <Text style={styles.thQty}>Qty</Text>
            <Text style={styles.thRate}>Rate</Text>
            <Text style={styles.thAmount}>Amount</Text>
          </View>

          {lineItems.map((item, index) => (
            <View key={`${item.service}-${index}`} style={[styles.tableRow, index % 2 === 1 ? styles.tableRowAlt : {}]}>
              <Text style={styles.tdNumber}>{index + 1}.</Text>
              <Text style={styles.tdService}>{item.service}</Text>
              <Text style={styles.tdDescription}>{item.description}</Text>
              <Text style={styles.tdQty}>{item.qty}</Text>
              <Text style={styles.tdRate}>{item.rate}</Text>
              <Text style={styles.tdAmount}>{fmt(item.amount)}</Text>
            </View>
          ))}
        </View>

        {/* ── Notes / Totals ── */}
        <View style={styles.lowerSection} wrap={false}>
          <View style={styles.noteBox}>
            <Text style={styles.noteTitle}>Note to customer</Text>
            <View style={styles.signatureGroup} wrap={false}>
              <Text style={styles.noteText}>Thanks again,</Text>
              <Text style={styles.signatureFallback}>Jeff</Text>
            </View>
            {packet.expenseNotes ? (
              <Text style={styles.expenseNoteText}>Expense notes: {packet.expenseNotes}</Text>
            ) : null}
          </View>

          <View style={styles.totalsBox}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.totalValue}>{fmt(invoiceTotal)}</Text>
            </View>
            {showPaymentRow ? (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Payment</Text>
                <Text style={styles.paymentValue}>{fmtPayment(paidAmount)}</Text>
              </View>
            ) : null}
            <View style={styles.totalRowEmphasis}>
              <Text style={styles.balanceLabel}>Balance due</Text>
              <Text style={styles.balanceValue}>{fmt(balanceDue)}</Text>
            </View>
            {showPaidInFull ? (
              <Text style={styles.paidInFull}>Paid in Full</Text>
            ) : null}
          </View>
        </View>

      </Page>
    </Document>
  );
}

// ---------------------------------------------------------------------------
// Public render function
// ---------------------------------------------------------------------------

export interface RenderInvoicePDFOptions {
  packet:        InvoicePacket;
  invoiceNumber: string;
  gigSummary:    string;
  issuedDate:    string;
}

export async function renderInvoicePDF(opts: RenderInvoicePDFOptions): Promise<Buffer> {
  const issuedDate = opts.issuedDate ?? new Date().toISOString().slice(0, 10);

  // Fetch the logo from the CDN and embed as base64 so react-pdf renders it without
  // a second network round-trip. Falls back to text branding on any error or 404.
  let logoSrc: string | null = null;
  try {
    console.log(`[invoice/pdf] fetching logo from ${LOGO_PDF_URL}`);
    const res = await fetch(LOGO_PDF_URL);
    console.log(`[invoice/pdf] logo fetch status=${res.status} ok=${res.ok}`);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      logoSrc = `data:image/png;base64,${buf.toString("base64")}`;
      console.log(`[invoice/pdf] logo embedded (${buf.byteLength} bytes)`);
    }
  } catch (e) {
    console.warn(`[invoice/pdf] logo fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const element = React.createElement(InvoicePDF, {
    packet:        opts.packet,
    invoiceNumber: opts.invoiceNumber,
    gigSummary:    opts.gigSummary,
    issuedDate,
    logoSrc,
  });
  return renderToBuffer(element as React.ReactElement);
}
