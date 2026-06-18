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
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { InvoicePacket } from "./invoice-types";

// ---------------------------------------------------------------------------
// Business info — centralised here; update as needed.
// ---------------------------------------------------------------------------

export const CONTRACTOR_INFO = {
  name:  "Jeff Ulsh",
  email: "jeffulsh@gmail.com",
  phone: "",      // Add if desired
  city:  "Dewey Beach, DE",
};

// ---------------------------------------------------------------------------
// Fonts — use built-in Helvetica so no external font fetch is required.
// ---------------------------------------------------------------------------

Font.registerHyphenationCallback((word) => [word]);

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const C = {
  black:    "#111111",
  dark:     "#333333",
  muted:    "#666666",
  light:    "#999999",
  border:   "#d0d0d0",
  accent:   "#1a56a0",
  rowAlt:   "#f5f7fa",
  white:    "#ffffff",
} as const;

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: C.dark,
    paddingTop: 44,
    paddingBottom: 48,
    paddingHorizontal: 48,
  },

  // ── Header ─────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 28,
    borderBottomWidth: 2,
    borderBottomColor: C.accent,
    paddingBottom: 14,
  },
  headerLeft: { flexDirection: "column" },
  contractorName: { fontSize: 20, fontFamily: "Helvetica-Bold", color: C.accent, marginBottom: 4 },
  contractorSub:  { fontSize: 9, color: C.muted },
  headerRight:    { alignItems: "flex-end" },
  invoiceTitle:   { fontSize: 24, fontFamily: "Helvetica-Bold", color: C.black, marginBottom: 4 },
  invoiceNumber:  { fontSize: 11, fontFamily: "Helvetica-Bold", color: C.accent },

  // ── Bill to / Meta two-column ───────────────────────────────────────────────
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  metaBlock:  { flexDirection: "column", width: "47%" },
  metaLabel:  { fontSize: 8, fontFamily: "Helvetica-Bold", color: C.muted, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 5 },
  metaValue:  { fontSize: 9, color: C.dark, marginBottom: 2 },
  metaValueBold: { fontSize: 10, fontFamily: "Helvetica-Bold", color: C.black, marginBottom: 2 },

  // ── Line-item table ─────────────────────────────────────────────────────────
  table:        { marginBottom: 16 },
  tableHeader:  { flexDirection: "row", backgroundColor: C.accent, paddingVertical: 6, paddingHorizontal: 6, borderRadius: 2 },
  thDesc:       { flex: 4, fontSize: 8, fontFamily: "Helvetica-Bold", color: C.white },
  thRight:      { flex: 1, fontSize: 8, fontFamily: "Helvetica-Bold", color: C.white, textAlign: "right" },
  tableRow:     { flexDirection: "row", paddingVertical: 5, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: C.border },
  tableRowAlt:  { backgroundColor: C.rowAlt },
  tdDesc:       { flex: 4, fontSize: 9, color: C.dark },
  tdSub:        { flex: 4, fontSize: 8, color: C.muted, fontStyle: "italic" },
  tdRight:      { flex: 1, fontSize: 9, color: C.dark, textAlign: "right" },
  tdRightMuted: { flex: 1, fontSize: 9, color: C.muted, textAlign: "right" },

  // ── Totals block ────────────────────────────────────────────────────────────
  totalsContainer: { alignItems: "flex-end", marginBottom: 24 },
  totalsBox:       { width: 220, borderTopWidth: 1, borderTopColor: C.border, paddingTop: 8 },
  totalsRow:       { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  totalsLabel:     { fontSize: 9, color: C.muted },
  totalsValue:     { fontSize: 9, color: C.dark },
  totalsDueRow:    { flexDirection: "row", justifyContent: "space-between", marginTop: 6, paddingTop: 6, borderTopWidth: 1.5, borderTopColor: C.accent },
  totalsDueLabel:  { fontSize: 11, fontFamily: "Helvetica-Bold", color: C.accent },
  totalsDueValue:  { fontSize: 11, fontFamily: "Helvetica-Bold", color: C.accent },

  // ── Footer notes ────────────────────────────────────────────────────────────
  notes:    { borderTopWidth: 1, borderTopColor: C.border, paddingTop: 10 },
  noteText: { fontSize: 9, color: C.muted, marginBottom: 3 },
  signoff:  { fontSize: 9, color: C.dark, marginTop: 8 },
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
  const first = sorted[0]!;
  const last  = sorted[sorted.length - 1]!;
  return `${fmtDate(first)} – ${fmtDate(last)}`;
}

// ---------------------------------------------------------------------------
// PDF Component
// ---------------------------------------------------------------------------

interface InvoicePDFProps {
  packet:        InvoicePacket;
  invoiceNumber: string;
  gigSummary:    string;
  issuedDate:    string; // YYYY-MM-DD
}

function InvoicePDF({ packet, invoiceNumber, gigSummary, issuedDate }: InvoicePDFProps) {
  const m       = packet.mileage;
  const hasOT   = packet.overtimeTotal > 0;
  const hasMile = m !== null && m.totalMiles > 0;
  const hasPD   = packet.perDiemTotal > 0;

  // Expense line pairs
  const expenses: Array<{ label: string; amount: number }> = [
    { label: "Bag Fees",       amount: packet.bagFees },
    { label: "Hotel",          amount: packet.hotel },
    { label: "Parking",        amount: packet.parking },
    { label: "Tolls",          amount: packet.tolls },
    { label: "Uber / Rideshare", amount: packet.uber },
    { label: "Other Expenses", amount: packet.otherExpenses },
  ].filter((e) => e.amount > 0);

  const workDateStr = fmtWorkDates(packet.workdays);

  return (
    <Document title={`Invoice ${invoiceNumber}`} author={CONTRACTOR_INFO.name}>
      <Page size="LETTER" style={styles.page}>

        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.contractorName}>{CONTRACTOR_INFO.name}</Text>
            {CONTRACTOR_INFO.email ? <Text style={styles.contractorSub}>{CONTRACTOR_INFO.email}</Text> : null}
            {CONTRACTOR_INFO.city  ? <Text style={styles.contractorSub}>{CONTRACTOR_INFO.city}</Text>  : null}
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.invoiceTitle}>INVOICE</Text>
            <Text style={styles.invoiceNumber}># {invoiceNumber}</Text>
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
            {packet.laNumber ? <Text style={styles.metaValue}>LA Job #: {packet.laNumber}</Text> : null}
            {gigSummary ? <Text style={styles.metaValueBold}>{gigSummary}</Text> : null}
            <Text style={styles.metaValue}>Date Issued: {fmtDate(issuedDate)}</Text>
            {workDateStr ? <Text style={styles.metaValue}>Work Dates: {workDateStr}</Text> : null}
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

          {/* Day Rate */}
          {packet.dayRateQty > 0 && (
            <View style={styles.tableRow}>
              <Text style={styles.tdDesc}>Freelance Audio Engineer — Day Rate</Text>
              <Text style={styles.tdRight}>{packet.dayRateQty}</Text>
              <Text style={styles.tdRight}>{fmt(packet.dayRate)}</Text>
              <Text style={styles.tdRight}>{fmt(packet.dayRateTotal)}</Text>
            </View>
          )}

          {/* Overtime */}
          {hasOT && (
            <View style={[styles.tableRow, styles.tableRowAlt]}>
              <Text style={styles.tdDesc}>Overtime</Text>
              <Text style={styles.tdRight}>{packet.totalOvertimeHours.toFixed(2)} h</Text>
              <Text style={styles.tdRight}>{fmt(packet.overtimeRate)}</Text>
              <Text style={styles.tdRight}>{fmt(packet.overtimeTotal)}</Text>
            </View>
          )}

          {/* Per Diem */}
          {hasPD && (
            <View style={[styles.tableRow, ...(hasOT ? [] : [styles.tableRowAlt])]}>
              <Text style={styles.tdDesc}>Per Diem</Text>
              <Text style={styles.tdRight}>{packet.perDiemQty}</Text>
              <Text style={styles.tdRight}>{fmt(packet.perDiemRate)}</Text>
              <Text style={styles.tdRight}>{fmt(packet.perDiemTotal)}</Text>
            </View>
          )}

          {/* Mileage */}
          {hasMile && (
            <>
              <View style={styles.tableRow}>
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
              {m!.mileageAdjustmentAmount !== 0 && (
                <View style={[styles.tableRow, styles.tableRowAlt]}>
                  <Text style={styles.tdSub}>  Mileage deduction ({m!.deductionMiles} mi × ${m!.mileageRate.toFixed(2)})</Text>
                  <Text style={styles.tdRight}></Text>
                  <Text style={styles.tdRight}></Text>
                  <Text style={styles.tdRightMuted}>{fmt(m!.mileageAdjustmentAmount)}</Text>
                </View>
              )}
            </>
          )}

          {/* Expenses */}
          {expenses.map((exp, i) => (
            <View
              key={exp.label}
              style={[styles.tableRow, i % 2 === 0 ? styles.tableRowAlt : {}]}
            >
              <Text style={styles.tdDesc}>{exp.label}</Text>
              <Text style={styles.tdRight}></Text>
              <Text style={styles.tdRight}></Text>
              <Text style={styles.tdRight}>{fmt(exp.amount)}</Text>
            </View>
          ))}
        </View>

        {/* ── Expense Notes ── */}
        {packet.expenseNotes ? (
          <View style={{ marginBottom: 12 }}>
            <Text style={{ fontSize: 8, color: C.muted, fontStyle: "italic" }}>
              Notes: {packet.expenseNotes}
            </Text>
          </View>
        ) : null}

        {/* ── Total Due ── */}
        <View style={styles.totalsContainer}>
          <View style={styles.totalsBox}>
            <View style={styles.totalsDueRow}>
              <Text style={styles.totalsDueLabel}>TOTAL DUE</Text>
              <Text style={styles.totalsDueValue}>{fmt(packet.estimatedTotal)}</Text>
            </View>
          </View>
        </View>

        {/* ── Footer ── */}
        <View style={styles.notes}>
          <Text style={styles.noteText}>Payment method: Direct deposit</Text>
          {packet.expenseNotes ? null : null}
          <Text style={styles.signoff}>Thanks again,{"\n"}{CONTRACTOR_INFO.name}</Text>
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
  issuedDate:    string; // YYYY-MM-DD; defaults to today
}

export async function renderInvoicePDF(opts: RenderInvoicePDFOptions): Promise<Buffer> {
  const issuedDate = opts.issuedDate ?? new Date().toISOString().slice(0, 10);
  const element = React.createElement(InvoicePDF, {
    packet:        opts.packet,
    invoiceNumber: opts.invoiceNumber,
    gigSummary:    opts.gigSummary,
    issuedDate,
  });
  return renderToBuffer(element as React.ReactElement);
}
