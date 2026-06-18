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
  orange:   "#E87722",
  teal:     "#459BA3",
  tealDark: "#32757C",
  infoBg:   "#EAF5F6",
  black:    "#1F2933",
  dark:     "#343A40",
  body:     "#4B5563",
  muted:    "#6B7280",
  light:    "#9CA3AF",
  border:   "#DFE5E8",
  row:      "#F7FAFB",
  white:    "#FFFFFF",
} as const;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9.5,
    color: C.body,
    paddingTop: 42,
    paddingBottom: 44,
    paddingHorizontal: 46,
    backgroundColor: C.white,
  },

  // ── Header ──────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 22,
  },
  headerLeft: {
    flexDirection: "column",
    width: "70%",
  },
  logo: {
    width: 92,
    height: 92,
  },
  invoiceWordmark: {
    fontSize: 17,
    fontFamily: "Helvetica-Bold",
    color: C.teal,
    letterSpacing: 1.4,
    marginBottom: 5,
  },
  contractorName: {
    fontSize: 9.5,
    fontFamily: "Helvetica-Bold",
    color: C.orange,
    marginBottom: 2,
  },
  contractorTitle: {
    fontSize: 8.5,
    color: C.body,
    marginBottom: 1,
  },
  contractorSub: {
    fontSize: 8.5,
    color: C.muted,
    marginBottom: 1,
  },
  contractorColumns: {
    flexDirection: "row",
    marginTop: 2,
  },
  contractorColumn: {
    width: 142,
  },
  headerRight: {
    alignItems: "flex-end",
  },
  logoFallback: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: C.infoBg,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.teal,
  },
  logoFallbackText: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    color: C.tealDark,
    textAlign: "center",
  },

  // ── Bill To / Meta two-column ────────────────────────────────────────────────
  infoPanel: {
    backgroundColor: C.infoBg,
    marginHorizontal: -46,
    marginBottom: 28,
    paddingVertical: 20,
    paddingHorizontal: 46,
  },
  infoTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  infoBlock: {
    flexDirection: "column",
    width: "47.5%",
  },
  infoLabel: {
    fontSize: 8.5,
    fontFamily: "Helvetica-Bold",
    color: C.dark,
    marginBottom: 6,
  },
  infoPrimary: {
    fontSize: 10,
    color: C.black,
    marginBottom: 3,
  },
  infoLine: {
    fontSize: 9.5,
    color: C.body,
    marginBottom: 3,
  },
  detailRow: {
    flexDirection: "row",
    marginBottom: 3,
  },
  detailLabel: {
    width: 82,
    fontSize: 9.5,
    color: C.body,
  },
  detailValue: {
    flex: 1,
    fontSize: 9.5,
    fontFamily: "Helvetica-Bold",
    color: C.black,
  },

  // ── Line-item table ──────────────────────────────────────────────────────────
  table: {
    marginBottom: 18,
  },
  tableHeader: {
    flexDirection: "row",
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  thNumber: { width: "5%",  fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.black },
  thService: { width: "28%", fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.black },
  thDescription: { width: "32%", fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.black },
  thQty: { width: "9%", fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.black, textAlign: "right" },
  thRate: { width: "12%", fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.black, textAlign: "right" },
  thAmount: { width: "14%", fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.black, textAlign: "right" },
  tableRow: {
    flexDirection: "row",
    minHeight: 32,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  tableRowAlt: {
    backgroundColor: C.row,
  },
  tdNumber: { width: "5%", fontSize: 9, color: C.body },
  tdService: { width: "28%", fontSize: 9, fontFamily: "Helvetica-Bold", color: C.black, paddingRight: 8 },
  tdDescription: { width: "32%", fontSize: 9, color: C.body, paddingRight: 8 },
  tdQty: { width: "9%", fontSize: 9, color: C.body, textAlign: "right" },
  tdRate: { width: "12%", fontSize: 9, color: C.body, textAlign: "right" },
  tdAmount: { width: "14%", fontSize: 9, color: C.body, textAlign: "right" },

  // ── Totals ───────────────────────────────────────────────────────────────────
  lowerSection: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginTop: 4,
  },
  noteBox: {
    width: "54%",
    paddingTop: 4,
  },
  noteTitle: {
    fontSize: 13,
    color: C.dark,
    marginBottom: 10,
  },
  noteText: {
    fontSize: 9,
    color: C.body,
    lineHeight: 1.35,
    marginBottom: 11,
  },
  paymentNote: {
    fontSize: 8.8,
    color: C.body,
    marginBottom: 3,
  },
  paymentNoteBold: {
    fontSize: 8.8,
    fontFamily: "Helvetica-Bold",
    color: C.black,
    marginBottom: 3,
  },
  expenseNoteText: {
    fontSize: 8.5,
    color: C.muted,
    marginTop: 7,
  },
  totalsBox: {
    width: "36%",
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  totalRowEmphasis: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
  },
  totalLabel: {
    fontSize: 9.5,
    color: C.body,
  },
  totalValue: {
    fontSize: 9.5,
    color: C.black,
    fontFamily: "Helvetica-Bold",
  },
  balanceLabel: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: C.black,
  },
  balanceValue: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    color: C.black,
  },

  // ── Footer ───────────────────────────────────────────────────────────────────
  footer: {
    position: "absolute",
    bottom: 28,
    left: 46,
    right: 46,
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 8,
  },
  footerText: {
    fontSize: 8,
    color: C.light,
    textAlign: "right",
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function fmtDate(isoDate: string): string {
  const [y, mo, d] = isoDate.split("-").map(Number);
  return new Date(Number(y), Number(mo) - 1, Number(d)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function fmtWorkDates(workdays: InvoicePacket["workdays"]): string {
  if (workdays.length === 0) return "";
  const dates = workdays.map((w) => w.date);
  if (dates.length === 1) return fmtDate(dates[0]!);
  const sorted = [...dates].sort();
  return `${fmtDate(sorted[0]!)} – ${fmtDate(sorted[sorted.length - 1]!)}`;
}

function fmtHours(n: number): string {
  return n % 1 === 0 ? `${n}` : n.toFixed(2);
}

function formatLaJobNumber(laNumber: string | null): string | null {
  if (!laNumber) return null;
  const clean = laNumber.replace(/^LA#?/i, "").replace(/[^a-zA-Z0-9-]/g, "");
  return clean ? `LA${clean}` : laNumber;
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
  const formattedLaJob = formatLaJobNumber(packet.laNumber);
  const billToAddress = CLIENT_INFO_BY_NAME[packet.client]?.addressLines ?? [];
  const invoiceTotal = packet.estimatedTotal;
  const paidAmount = packet.invoiceStatus === "paid"
    ? invoiceTotal
    : packet.amountPaid > 0
      ? packet.amountPaid
      : 0;
  const balanceDue = packet.invoiceStatus === "paid"
    ? 0
    : packet.remainingBalance != null
      ? packet.remainingBalance
      : Math.max(Number((invoiceTotal - paidAmount).toFixed(2)), 0);
  const showPaidRow = paidAmount > 0 || packet.invoiceStatus === "paid" || packet.invoiceStatus === "partially_paid";

  const expenses: Array<{ label: string; amount: number }> = [
    { label: "Bag Fees",           amount: packet.bagFees },
    { label: "Hotel",              amount: packet.hotel },
    { label: "Parking",            amount: packet.parking },
    { label: "Tolls",              amount: packet.tolls },
    { label: "Uber / Rideshare",   amount: packet.uber },
    { label: "Other Expenses",     amount: packet.otherExpenses },
  ].filter((e) => e.amount > 0);

  const lineItems: PdfLineItem[] = [];
  if (packet.dayRateQty > 0) {
    lineItems.push({
      service: "Freelance Audio Engineer",
      description: workDateStr ? `Day rate for ${workDateStr}` : "Day rate",
      qty: String(packet.dayRateQty),
      rate: fmt(packet.dayRate),
      amount: packet.dayRateTotal,
    });
  }
  if (hasOT) {
    lineItems.push({
      service: "Overtime",
      description: "Audio engineering overtime",
      qty: `${fmtHours(packet.totalOvertimeHours)} h`,
      rate: fmt(packet.overtimeRate),
      amount: packet.overtimeTotal,
    });
  }
  if (hasPD) {
    lineItems.push({
      service: "Per Diem",
      description: "Daily per diem",
      qty: String(packet.perDiemQty),
      rate: fmt(packet.perDiemRate),
      amount: packet.perDiemTotal,
    });
  }
  if (hasMile) {
    lineItems.push({
      service: "Mileage",
      description: `${m!.reimbursedMiles} billable mi (${m!.totalMiles} total mi, ${m!.deductionMiles} mi deducted)`,
      qty: `${m!.reimbursedMiles} mi`,
      rate: fmt(m!.mileageRate),
      amount: m!.mileageAmount,
    });
  }
  for (const exp of expenses) {
    lineItems.push({
      service: exp.label,
      description: "Reimbursable expense",
      qty: "1",
      rate: fmt(exp.amount),
      amount: exp.amount,
    });
  }

  return (
    <Document title={`Invoice ${invoiceNumber}`} author={CONTRACTOR_INFO.name}>
      <Page size="LETTER" style={styles.page}>

        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.invoiceWordmark}>INVOICE</Text>
            <Text style={styles.contractorName}>{CONTRACTOR_INFO.name}</Text>
            <Text style={styles.contractorTitle}>{CONTRACTOR_INFO.title}</Text>
            <View style={styles.contractorColumns}>
              <View style={styles.contractorColumn}>
                {CONTRACTOR_INFO.addressLines.map((line) => (
                  <Text key={line} style={styles.contractorSub}>{line}</Text>
                ))}
              </View>
              <View style={styles.contractorColumn}>
                <Text style={styles.contractorSub}>{CONTRACTOR_INFO.email}</Text>
                <Text style={styles.contractorSub}>{CONTRACTOR_INFO.phone}</Text>
                <Text style={styles.contractorSub}>{CONTRACTOR_INFO.website}</Text>
              </View>
            </View>
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
            <Text style={styles.infoLabel}>Bill To</Text>
            <Text style={styles.infoPrimary}>{packet.client}</Text>
            {billToAddress.map((line) => (
              <Text key={line} style={styles.infoLine}>{line}</Text>
            ))}
          </View>
          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>Job / Invoice Details</Text>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Invoice #:</Text>
              <Text style={styles.detailValue}>{invoiceNumber}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>LA Job #:</Text>
              <Text style={styles.detailValue}>{formattedLaJob ?? "—"}</Text>
            </View>
            {gigSummary ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Job:</Text>
                <Text style={styles.detailValue}>{gigSummary}</Text>
              </View>
            ) : null}
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Invoice Date:</Text>
              <Text style={styles.detailValue}>{fmtDate(issuedDate)}</Text>
            </View>
            {workDateStr ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Work Dates:</Text>
                <Text style={styles.detailValue}>{workDateStr}</Text>
              </View>
            ) : null}
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Payment:</Text>
              <Text style={styles.detailValue}>Direct Deposit</Text>
            </View>
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
        <View style={styles.lowerSection}>
          <View style={styles.noteBox}>
            <Text style={styles.noteTitle}>Note to customer</Text>
            <Text style={styles.noteText}>Thanks again,{"\n"}Jeff</Text>
            <Text style={styles.paymentNoteBold}>Payment method: Direct Deposit</Text>
            <Text style={styles.paymentNote}>Please reference {formattedLaJob ?? "the LA Job #"} when depositing.</Text>
            {packet.expenseNotes ? (
              <Text style={styles.expenseNoteText}>Expense notes: {packet.expenseNotes}</Text>
            ) : null}
          </View>

          <View style={styles.totalsBox}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.totalValue}>{fmt(invoiceTotal)}</Text>
            </View>
            {showPaidRow ? (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>{packet.invoiceStatus === "paid" ? "Paid" : "Amount Paid"}</Text>
                <Text style={styles.totalValue}>{fmt(paidAmount)}</Text>
              </View>
            ) : null}
            <View style={styles.totalRowEmphasis}>
              <Text style={styles.balanceLabel}>Balance Due</Text>
              <Text style={styles.balanceValue}>{fmt(balanceDue)}</Text>
            </View>
          </View>
        </View>

        {/* ── Footer ── */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Jeff Ulsh · Freelance Audio Engineer</Text>
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

  // Fetch logo from Netlify CDN; embed as base64 so react-pdf renders it without
  // a second network round-trip. Falls back to text branding on any error or 404.
  // Note: public/ files are NOT on the serverless function's filesystem — URL fetch is required.
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
