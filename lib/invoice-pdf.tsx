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
  name:  "Jeff Ulsh",
  title: "Freelance Audio Engineer",
  email: "jeffulsh@gmail.com",
  city:  "Dewey Beach, DE",
};

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

Font.registerHyphenationCallback((word) => [word]);

// ---------------------------------------------------------------------------
// Brand palette
// ---------------------------------------------------------------------------

const C = {
  // Orange brand — matches the Jeff Ulsh logo.
  // Once the logo file is added, this accent will coordinate with it.
  orange:     "#E87722",
  orangeDark: "#C05A10",
  orangeTint: "#FFF7ED",

  // Neutrals
  black:  "#111111",
  dark:   "#333333",
  body:   "#444444",
  muted:  "#777777",
  light:  "#AAAAAA",
  border: "#E0E0E0",
  row:    "#F8F9FA",
  white:  "#FFFFFF",
} as const;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: C.body,
    paddingTop: 44,
    paddingBottom: 48,
    paddingHorizontal: 48,
    backgroundColor: C.white,
  },

  // ── Header ──────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 24,
    paddingBottom: 16,
    borderBottomWidth: 2,
    borderBottomColor: C.orange,
  },
  headerLeft: {
    flexDirection: "column",
  },
  logo: {
    width: 72,
    height: 72,
    marginBottom: 6,
  },
  contractorName: {
    fontSize: 22,
    fontFamily: "Helvetica-Bold",
    color: C.orange,
    marginBottom: 3,
    letterSpacing: 0.3,
  },
  contractorTitle: {
    fontSize: 9,
    color: C.muted,
    marginBottom: 1,
  },
  contractorSub: {
    fontSize: 9,
    color: C.muted,
  },
  headerRight: {
    alignItems: "flex-end",
  },
  invoiceWordmark: {
    fontSize: 26,
    fontFamily: "Helvetica-Bold",
    color: C.black,
    letterSpacing: 1,
    marginBottom: 4,
  },
  invoiceNumberBadge: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: C.orange,
    backgroundColor: C.orangeTint,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 3,
  },

  // ── Bill To / Meta two-column ────────────────────────────────────────────────
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 22,
  },
  metaBlock: {
    flexDirection: "column",
    width: "47%",
  },
  metaLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    paddingBottom: 3,
  },
  metaValue: {
    fontSize: 9,
    color: C.body,
    marginBottom: 3,
  },
  metaValueBold: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: C.black,
    marginBottom: 3,
  },
  metaValueSmall: {
    fontSize: 8,
    color: C.muted,
    marginBottom: 2,
  },

  // ── Line-item table ──────────────────────────────────────────────────────────
  table: {
    marginBottom: 0,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: C.dark,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  thDesc:  { flex: 4, fontSize: 7.5, fontFamily: "Helvetica-Bold", color: C.white, textTransform: "uppercase", letterSpacing: 0.5 },
  thRight: { flex: 1, fontSize: 7.5, fontFamily: "Helvetica-Bold", color: C.white, textAlign: "right", textTransform: "uppercase", letterSpacing: 0.5 },

  tableRow: {
    flexDirection: "row",
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  tableRowAlt: {
    backgroundColor: C.row,
  },
  tdDesc:       { flex: 4, fontSize: 9, color: C.dark },
  tdSub:        { flex: 4, fontSize: 8, color: C.muted, fontStyle: "italic" },
  tdRight:      { flex: 1, fontSize: 9, color: C.dark, textAlign: "right" },
  tdRightMuted: { flex: 1, fontSize: 9, color: C.muted, textAlign: "right" },

  // ── Totals ───────────────────────────────────────────────────────────────────
  totalsSection: {
    marginTop: 16,
    marginBottom: 20,
  },
  subtotalArea: {
    alignItems: "flex-end",
    marginBottom: 8,
    paddingRight: 0,
  },
  subtotalBox: {
    width: 240,
  },
  subtotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  subtotalLabel: { fontSize: 9, color: C.muted },
  subtotalValue: { fontSize: 9, color: C.dark },

  // Full-width orange band — the visual anchor of the invoice.
  totalDueBand: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: C.orange,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 3,
    marginTop: 2,
  },
  totalDueLabel: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    color: C.white,
    letterSpacing: 0.5,
  },
  totalDueValue: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    color: C.white,
  },

  // ── Expense notes ─────────────────────────────────────────────────────────────
  expenseNotes: {
    marginTop: 8,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  expenseNotesText: {
    fontSize: 8,
    color: C.muted,
    fontStyle: "italic",
  },

  // ── Footer ───────────────────────────────────────────────────────────────────
  footer: {
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  footerLeft: {
    flexDirection: "column",
  },
  footerNote: {
    fontSize: 8.5,
    color: C.muted,
    marginBottom: 2,
  },
  footerSignoff: {
    fontSize: 9,
    color: C.dark,
    marginTop: 6,
  },
  footerRight: {
    alignItems: "flex-end",
  },
  footerPageNote: {
    fontSize: 8,
    color: C.light,
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

  const expenses: Array<{ label: string; amount: number }> = [
    { label: "Bag Fees",           amount: packet.bagFees },
    { label: "Hotel",              amount: packet.hotel },
    { label: "Parking",            amount: packet.parking },
    { label: "Tolls",              amount: packet.tolls },
    { label: "Uber / Rideshare",   amount: packet.uber },
    { label: "Other Expenses",     amount: packet.otherExpenses },
  ].filter((e) => e.amount > 0);

  const workDateStr = fmtWorkDates(packet.workdays);

  // Alternating row counter for visual rhythm
  let rowIdx = 0;
  function nextRow(): boolean {
    return rowIdx++ % 2 === 1;
  }

  return (
    <Document title={`Invoice ${invoiceNumber}`} author={CONTRACTOR_INFO.name}>
      <Page size="LETTER" style={styles.page}>

        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            {logoSrc
              ? <Image src={logoSrc} style={styles.logo} />
              : <Text style={styles.contractorName}>{CONTRACTOR_INFO.name}</Text>
            }
            <Text style={styles.contractorTitle}>{CONTRACTOR_INFO.title}</Text>
            {CONTRACTOR_INFO.email ? <Text style={styles.contractorSub}>{CONTRACTOR_INFO.email}</Text> : null}
            {CONTRACTOR_INFO.city  ? <Text style={styles.contractorSub}>{CONTRACTOR_INFO.city}</Text>  : null}
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.invoiceWordmark}>INVOICE</Text>
            <Text style={styles.invoiceNumberBadge}>#{invoiceNumber}</Text>
          </View>
        </View>

        {/* ── Bill To / Job Details ── */}
        <View style={styles.metaRow}>
          <View style={styles.metaBlock}>
            <Text style={styles.metaLabel}>Bill To</Text>
            <Text style={styles.metaValueBold}>{packet.client}</Text>
          </View>
          <View style={styles.metaBlock}>
            <Text style={styles.metaLabel}>Job Details</Text>
            {packet.laNumber ? (
              <Text style={styles.metaValue}>LA Job #: {packet.laNumber}</Text>
            ) : null}
            {gigSummary ? (
              <Text style={styles.metaValueBold}>{gigSummary}</Text>
            ) : null}
            <Text style={styles.metaValue}>Invoice Date: {fmtDate(issuedDate)}</Text>
            {workDateStr ? (
              <Text style={styles.metaValue}>Work Dates: {workDateStr}</Text>
            ) : null}
            <Text style={styles.metaValue}>Payment: Direct Deposit</Text>
          </View>
        </View>

        {/* ── Line Items ── */}
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={styles.thDesc}>Description</Text>
            <Text style={styles.thRight}>Qty</Text>
            <Text style={styles.thRight}>Rate</Text>
            <Text style={styles.thRight}>Amount</Text>
          </View>

          {packet.dayRateQty > 0 ? (
            <View style={[styles.tableRow, nextRow() ? styles.tableRowAlt : {}]}>
              <Text style={styles.tdDesc}>Freelance Audio Engineer — Day Rate</Text>
              <Text style={styles.tdRight}>{packet.dayRateQty}</Text>
              <Text style={styles.tdRight}>{fmt(packet.dayRate)}</Text>
              <Text style={styles.tdRight}>{fmt(packet.dayRateTotal)}</Text>
            </View>
          ) : null}

          {hasOT ? (
            <View style={[styles.tableRow, nextRow() ? styles.tableRowAlt : {}]}>
              <Text style={styles.tdDesc}>Overtime</Text>
              <Text style={styles.tdRight}>{packet.totalOvertimeHours.toFixed(2)} h</Text>
              <Text style={styles.tdRight}>{fmt(packet.overtimeRate)}</Text>
              <Text style={styles.tdRight}>{fmt(packet.overtimeTotal)}</Text>
            </View>
          ) : null}

          {hasPD ? (
            <View style={[styles.tableRow, nextRow() ? styles.tableRowAlt : {}]}>
              <Text style={styles.tdDesc}>Per Diem</Text>
              <Text style={styles.tdRight}>{packet.perDiemQty}</Text>
              <Text style={styles.tdRight}>{fmt(packet.perDiemRate)}</Text>
              <Text style={styles.tdRight}>{fmt(packet.perDiemTotal)}</Text>
            </View>
          ) : null}

          {hasMile ? (
            <>
              <View style={[styles.tableRow, nextRow() ? styles.tableRowAlt : {}]}>
                <View style={styles.tdDesc}>
                  <Text>Mileage ({m!.totalMiles} mi total, {m!.deductionMiles} mi deducted)</Text>
                  <Text style={{ fontSize: 8, color: C.muted }}>
                    {m!.reimbursedMiles} mi × ${m!.mileageRate.toFixed(2)}/mi
                  </Text>
                </View>
                <Text style={styles.tdRight}>{m!.reimbursedMiles} mi</Text>
                <Text style={styles.tdRight}>${m!.mileageRate.toFixed(2)}</Text>
                <Text style={styles.tdRight}>{fmt(m!.mileageAmount)}</Text>
              </View>
              {m!.mileageAdjustmentAmount !== 0 ? (
                <View style={[styles.tableRow, nextRow() ? styles.tableRowAlt : {}]}>
                  <Text style={styles.tdSub}>  Mileage deduction ({m!.deductionMiles} mi × ${m!.mileageRate.toFixed(2)})</Text>
                  <Text style={styles.tdRight}></Text>
                  <Text style={styles.tdRight}></Text>
                  <Text style={styles.tdRightMuted}>{fmt(m!.mileageAdjustmentAmount)}</Text>
                </View>
              ) : null}
            </>
          ) : null}

          {expenses.map((exp) => (
            <View key={exp.label} style={[styles.tableRow, nextRow() ? styles.tableRowAlt : {}]}>
              <Text style={styles.tdDesc}>{exp.label}</Text>
              <Text style={styles.tdRight}></Text>
              <Text style={styles.tdRight}></Text>
              <Text style={styles.tdRight}>{fmt(exp.amount)}</Text>
            </View>
          ))}
        </View>

        {/* ── Expense Notes ── */}
        {packet.expenseNotes ? (
          <View style={styles.expenseNotes}>
            <Text style={styles.expenseNotesText}>Notes: {packet.expenseNotes}</Text>
          </View>
        ) : null}

        {/* ── Totals ── */}
        <View style={styles.totalsSection}>
          {/* Subtotal (shown when more than one line item for clarity) */}
          {rowIdx > 1 ? (
            <View style={styles.subtotalArea}>
              <View style={styles.subtotalBox}>
                <View style={styles.subtotalRow}>
                  <Text style={styles.subtotalLabel}>Subtotal</Text>
                  <Text style={styles.subtotalValue}>{fmt(packet.estimatedTotal)}</Text>
                </View>
              </View>
            </View>
          ) : null}

          {/* Total Due — full-width orange band */}
          <View style={styles.totalDueBand}>
            <Text style={styles.totalDueLabel}>TOTAL DUE</Text>
            <Text style={styles.totalDueValue}>{fmt(packet.estimatedTotal)}</Text>
          </View>
        </View>

        {/* ── Footer ── */}
        <View style={styles.footer}>
          <View style={styles.footerLeft}>
            <Text style={styles.footerNote}>Payment method: Direct deposit</Text>
            <Text style={styles.footerNote}>Please reference LA Job #{packet.laNumber ?? "—"} when depositing.</Text>
            <Text style={styles.footerSignoff}>Thanks again,{"\n"}{CONTRACTOR_INFO.name}</Text>
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
