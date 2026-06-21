"use client";

/**
 * /admin/invoices — Invoice Worklist
 *
 * Jeff-only. Shows all LA gig jobs from Google Calendar for the last 18 months
 * merged with Supabase invoice_data. Filters: Needs Invoice / Draft / Sent / Paid / All.
 * Search: LA#, gig name, date, invoice#.
 * Click a row → opens InvoiceSection slide panel for that job.
 *
 * Access: log in as Jeff (editorToken cookie), then navigate to /admin/invoices.
 * Does NOT automatically send emails, modify invoice math, PDFs, or payment records.
 */

import { InvoiceWorklist } from "@/components/InvoiceWorklist";

export default function InvoicesPage() {
  return (
    <>
      <a href="/" className="worklist-back-link">← Back to Schedule</a>
      <InvoiceWorklist />
    </>
  );
}
