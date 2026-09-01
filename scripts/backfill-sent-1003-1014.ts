#!/usr/bin/env tsx
/**
 * One-time backfill: invoices #1003–#1014 were genuinely sent from Gmail, but
 * the app had no "mark sent" step at the time, so they are stuck at
 * invoice_status = "draft_created" with invoice_sent_at = null.
 *
 * Applies the same data semantics as lib/invoice-data.ts markInvoiceSent():
 *   invoice_status  = "sent"
 *   invoice_sent_at = <timestamp>
 *   updated_at      = <same timestamp>
 *   invoice_sent_to = left untouched (never fabricated — see below)
 *
 * Timestamp: invoice_created_at — the moment the PDF was generated and the
 * Gmail draft was created. The real Gmail send happened moments later in the
 * same session, and it is the only stored timestamp tied to that event.
 * Falls back to updated_at if invoice_created_at is null.
 *
 * Recipients: not stored for these rows (invoice_sent_to is null), and the real
 * addresses only exist in Gmail. Left null rather than guessed.
 *
 * Sheet: updates only the STATUS (T) and SENT DATE (W) cells of the matching
 * row via updateSheetPaymentColumns — a full upsertSheetRow would rewrite the
 * historical DATE column to today.
 *
 * Usage: npx tsx scripts/backfill-sent-1003-1014.ts [--apply]
 * Without --apply it prints the preview and exits.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createRequire } from "node:module";
const req = createRequire(__filename);
// lib/* modules are marked "server-only"; this script is the server.
const serverOnlyPath = req.resolve("server-only");
req.cache[serverOnlyPath] = {
  id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {}, children: [], paths: [],
} as never;

const FIRST_INVOICE = 1003;
const LAST_INVOICE = 1014;

interface Row {
  google_event_id: string;
  la_number: string | null;
  invoice_number: string | null;
  invoice_status: string;
  invoice_total: number | null;
  invoice_pdf_url: string | null;
  invoice_created_at: string | null;
  invoice_sent_at: string | null;
  invoice_sent_to: string | null;
  paid_date: string | null;
  amount_paid: number | null;
  remaining_balance: number | null;
  updated_at: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { getSupabaseServerClient } = req("../lib/supabase") as typeof import("../lib/supabase");
  const { updateSheetPaymentColumns } = req("../lib/google-sheets") as typeof import("../lib/google-sheets");

  const client = getSupabaseServerClient();
  const { data, error } = await client
    .from("invoice_data")
    .select(
      "google_event_id,la_number,invoice_number,invoice_status,invoice_total,invoice_pdf_url," +
      "invoice_created_at,invoice_sent_at,invoice_sent_to,paid_date,amount_paid,remaining_balance,updated_at",
    )
    .gte("invoice_number", String(FIRST_INVOICE))
    .lte("invoice_number", String(LAST_INVOICE))
    .order("invoice_number", { ascending: true });

  if (error) throw new Error(`select failed: ${error.message}`);

  const rows = (data ?? []) as unknown as Row[];
  const targets = rows.filter((r) => {
    const n = Number(r.invoice_number);
    return Number.isFinite(n) && n >= FIRST_INVOICE && n <= LAST_INVOICE;
  });

  // ── Preview ───────────────────────────────────────────────────────────────
  console.log(`\nBackfill preview — invoices #${FIRST_INVOICE}–#${LAST_INVOICE} (${targets.length} rows)\n`);
  console.log(
    "INV#".padEnd(6) + "LA#".padEnd(8) + "STATUS".padEnd(16) +
    "PROPOSED SENT AT".padEnd(26) + "RECIPIENT".padEnd(22) + "EVENT ID",
  );
  console.log("-".repeat(120));

  const plan: Array<{ row: Row; sentAt: string; source: string }> = [];
  for (const r of targets) {
    const sentAt = r.invoice_created_at ?? r.updated_at;
    if (!sentAt) {
      console.log(`${String(r.invoice_number).padEnd(6)}SKIPPED — no invoice_created_at or updated_at to use`);
      continue;
    }
    const source = r.invoice_created_at ? "invoice_created_at" : "updated_at";
    console.log(
      String(r.invoice_number ?? "?").padEnd(6) +
      String(r.la_number ?? "—").padEnd(8) +
      String(r.invoice_status).padEnd(16) +
      sentAt.padEnd(26) +
      String(r.invoice_sent_to ?? "(none stored — left null)").padEnd(22) +
      String(r.google_event_id).slice(0, 24),
    );
    plan.push({ row: r, sentAt, source });
  }
  console.log("-".repeat(120));
  console.log(`Timestamp source: ${[...new Set(plan.map((p) => p.source))].join(", ")}`);
  console.log(`Recipients stored: ${plan.filter((p) => p.row.invoice_sent_to).length} of ${plan.length}\n`);

  if (!apply) {
    console.log("Preview only. Re-run with --apply to write.\n");
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  let supabaseOk = 0;
  let sheetOk = 0;
  const sheetFailures: string[] = [];

  for (const { row, sentAt } of plan) {
    const patch: Record<string, unknown> = {
      invoice_status: "sent",
      invoice_sent_at: sentAt,
      updated_at: sentAt,
    };
    // invoice_sent_to / invoice_sent_subject intentionally untouched.

    const { error: updateError } = await client
      .from("invoice_data")
      .update(patch)
      .eq("google_event_id", row.google_event_id);

    if (updateError) {
      console.error(`  #${row.invoice_number} supabase FAILED: ${updateError.message}`);
      continue;
    }
    supabaseOk++;
    console.log(`  #${row.invoice_number} → sent (${sentAt})`);

    // Sheet: only STATUS (T) and SENT DATE (W) change; every other column is
    // passed through from the existing record so nothing else is rewritten.
    try {
      await updateSheetPaymentColumns({
        laJobNumber:         row.la_number ?? "",
        invoiceNumber:       row.invoice_number ?? "",
        status:              "sent",
        paidDate:            row.paid_date ?? "",
        invoicePdfUrl:       row.invoice_pdf_url ?? "",
        invoiceSentDate:     sentAt.slice(0, 10),
        amountPaid:          Number(row.amount_paid ?? 0),
        remainingBalance:    Number(row.remaining_balance ?? row.invoice_total ?? 0),
        paymentMethod:       "",
        paymentReceivedDate: "",
        paymentBatchRef:     "",
      });
      sheetOk++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sheetFailures.push(`#${row.invoice_number}: ${msg}`);
    }
  }

  console.log(`\nSupabase rows updated: ${supabaseOk}/${plan.length}`);
  console.log(`Sheet rows updated:    ${sheetOk}/${plan.length}`);
  if (sheetFailures.length > 0) {
    console.log("Sheet failures:");
    for (const f of sheetFailures) console.log(`  ${f}`);
  }
  console.log();
}

main().catch((err) => { console.error("BACKFILL FAILED:", err); process.exit(1); });
