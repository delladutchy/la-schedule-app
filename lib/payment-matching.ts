/**
 * Smart payment matching for lump-sum direct deposits.
 *
 * Pure functions — no I/O, no server-only imports. Safe to import on both
 * server and client (e.g. for in-browser matching without an extra API call).
 *
 * Light Action pays by direct deposit, often covering 1–3 invoices at once.
 * This module does bounded subset-sum against invoice remaining balances to
 * suggest which invoices a given payment covers.
 */

export interface InvoiceForMatching {
  google_event_id:  string;
  client?:           string | null;
  invoice_number:   string | null;
  la_number:        string | null;
  invoice_total:    number | null;
  amount_paid:      number;
  remaining_balance: number | null;
  invoice_status:   string;
  invoice_sent_at?: string | null;
}

export type MatchType = "exact" | "close" | "partial" | "none";

export interface MatchSuggestion {
  invoices:     InvoiceForMatching[];
  totalBalance: number;
  /** paymentAmount − totalBalance; 0.00 = exact. Positive = over-payment. */
  difference:   number;
  isExact:      boolean;
  matchType:    MatchType;
}

export interface MatchOptions {
  /** Max invoices in a single combination. Default: 5. */
  maxCombinationSize?: number;
  /** Dollar tolerance for a "close" match. Default: $0.01. */
  toleranceDollars?:   number;
  /** Max suggestions to return. Default: 3. */
  maxSuggestions?:     number;
}

export interface OldestFirstAllocationLine {
  invoice: InvoiceForMatching;
  balance: number;
  allocatedAmount: number;
  resultingStatus: "paid" | "partially_paid";
}

export interface OldestFirstPaymentPlan {
  paymentAmount: number;
  allocatedTotal: number;
  unappliedAmount: number;
  lines: OldestFirstAllocationLine[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Remaining balance for an invoice.
 * Uses `remaining_balance` when stored; falls back to invoice_total − amount_paid.
 */
export function getInvoiceRemainingBalance(inv: InvoiceForMatching): number {
  if (inv.remaining_balance != null) return inv.remaining_balance;
  if (inv.invoice_total   != null) return r2(Math.max(0, inv.invoice_total - inv.amount_paid));
  return 0;
}

/**
 * Sort invoices by matching priority:
 *   1. "sent" status before partially_paid / others
 *   2. Older invoice_sent_at first (oldest bill paid first)
 *   3. Invoice number ascending as tiebreaker
 */
export function sortByMatchPriority(invoices: InvoiceForMatching[]): InvoiceForMatching[] {
  return [...invoices].sort((a, b) => {
    const aSent = a.invoice_status === "sent" ? 0 : 1;
    const bSent = b.invoice_status === "sent" ? 0 : 1;
    if (aSent !== bSent) return aSent - bSent;

    const aDate = a.invoice_sent_at ?? "9999-99-99";
    const bDate = b.invoice_sent_at ?? "9999-99-99";
    if (aDate < bDate) return -1;
    if (aDate > bDate) return  1;

    // Invoice number tiebreaker (numeric sort when both are numeric strings)
    const aNum = Number(a.invoice_number ?? "NaN");
    const bNum = Number(b.invoice_number ?? "NaN");
    if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
    return (a.invoice_number ?? "").localeCompare(b.invoice_number ?? "");
  });
}

/**
 * Sort open invoices for actual payment application:
 *   1. Oldest sent date first when available
 *   2. Lowest invoice number first
 *   3. Stable event id as a final tiebreaker
 *
 * Unlike smart matching, this does not prioritize "sent" over partially paid;
 * a partially-paid older invoice should still be settled before newer invoices.
 */
export function sortByOldestOpenInvoice(invoices: InvoiceForMatching[]): InvoiceForMatching[] {
  return [...invoices].sort((a, b) => {
    const aDate = a.invoice_sent_at ?? "9999-99-99";
    const bDate = b.invoice_sent_at ?? "9999-99-99";
    if (aDate < bDate) return -1;
    if (aDate > bDate) return 1;

    const aNum = Number(a.invoice_number ?? "NaN");
    const bNum = Number(b.invoice_number ?? "NaN");
    if (!isNaN(aNum) && !isNaN(bNum) && aNum !== bNum) return aNum - bNum;
    const invCompare = (a.invoice_number ?? "").localeCompare(b.invoice_number ?? "");
    if (invCompare !== 0) return invCompare;

    return a.google_event_id.localeCompare(b.google_event_id);
  });
}

/**
 * Build a deterministic payment allocation preview: oldest open invoice first,
 * allocating up to each invoice's current remaining balance.
 *
 * Pure function only. It does not write payment records, mark invoices paid, or
 * sync Sheets. The caller must explicitly save the returned allocations.
 */
export function buildOldestFirstPaymentPlan(
  paymentAmount: number,
  invoices: InvoiceForMatching[],
): OldestFirstPaymentPlan {
  const amount = r2(Math.max(0, paymentAmount));
  let remaining = amount;
  const lines: OldestFirstAllocationLine[] = [];

  const eligible = sortByOldestOpenInvoice(
    invoices.filter(
      (inv) =>
        !["paid", "void"].includes(inv.invoice_status) &&
        getInvoiceRemainingBalance(inv) > 0,
    ),
  );

  for (const invoice of eligible) {
    if (remaining <= 0.005) break;
    const balance = r2(getInvoiceRemainingBalance(invoice));
    const allocatedAmount = r2(Math.min(balance, remaining));
    if (allocatedAmount <= 0) continue;
    lines.push({
      invoice,
      balance,
      allocatedAmount,
      resultingStatus: allocatedAmount + 0.005 >= balance ? "paid" : "partially_paid",
    });
    remaining = r2(remaining - allocatedAmount);
  }

  const allocatedTotal = r2(lines.reduce((sum, line) => sum + line.allocatedAmount, 0));
  return {
    paymentAmount: amount,
    allocatedTotal,
    unappliedAmount: r2(Math.max(0, amount - allocatedTotal)),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Combination generator
// ---------------------------------------------------------------------------

/** Return all combinations of `size` items from `items[]`. */
function getCombinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const result: T[][] = [];
  for (let i = 0; i <= items.length - size; i++) {
    const head = items[i]!;
    for (const rest of getCombinations(items.slice(i + 1), size - 1)) {
      result.push([head, ...rest]);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main matcher
// ---------------------------------------------------------------------------

/**
 * Find invoice combinations whose remaining balances sum to paymentAmount.
 *
 * Priority order:
 *   1. Exact matches (|diff| < $0.001) before close matches (|diff| ≤ tolerance)
 *   2. Fewer invoices before more invoices
 *   3. Sent invoices before partially-paid; older invoices before newer
 *
 * When no exact/close match exists, returns the closest partial suggestions
 * so the UI can still show context.
 *
 * @param paymentAmount  The deposit amount to match against.
 * @param invoices       All candidate invoices (including already-paid ones —
 *                       this function filters them out automatically).
 * @param opts           Tuning options.
 */
export function findPaymentMatches(
  paymentAmount: number,
  invoices:      InvoiceForMatching[],
  opts?:         MatchOptions,
): MatchSuggestion[] {
  const maxSize    = opts?.maxCombinationSize ?? 5;
  const tolerance  = opts?.toleranceDollars  ?? 0.01;
  const maxResults = opts?.maxSuggestions    ?? 3;

  // Only consider invoices with a positive remaining balance that aren't fully settled.
  const eligible = sortByMatchPriority(
    invoices.filter(
      (inv) =>
        !["paid", "void"].includes(inv.invoice_status) &&
        getInvoiceRemainingBalance(inv) > 0,
    ),
  );

  if (eligible.length === 0 || paymentAmount <= 0) {
    return [{ invoices: [], totalBalance: 0, difference: paymentAmount, isExact: false, matchType: "none" }];
  }

  const exactHits:  MatchSuggestion[] = [];
  const closeHits:  MatchSuggestion[] = [];

  // Try smallest sizes first — prefer fewest invoices per combination.
  outer:
  for (let size = 1; size <= Math.min(maxSize, eligible.length); size++) {
    for (const combo of getCombinations(eligible, size)) {
      const totalBalance = r2(combo.reduce((s, inv) => s + getInvoiceRemainingBalance(inv), 0));
      const diff         = r2(paymentAmount - totalBalance);
      const absDiff      = Math.abs(diff);

      if (absDiff < 0.001) {
        exactHits.push({ invoices: combo, totalBalance, difference: diff, isExact: true, matchType: "exact" });
      } else if (absDiff <= tolerance) {
        closeHits.push({ invoices: combo, totalBalance, difference: diff, isExact: true, matchType: "close" });
      }
    }

    // Once exact matches exist at this size, don't search larger combos.
    // Fewer invoices is always better (requirement 5).
    if (exactHits.length >= maxResults) break outer;
    if (exactHits.length > 0) break outer;       // found some — stop growing
    if (closeHits.length >= maxResults) break outer;
  }

  const matched = [
    ...exactHits.slice(0, maxResults),
    ...closeHits.slice(0, Math.max(0, maxResults - exactHits.length)),
  ];

  if (matched.length > 0) {
    matched.sort((a, b) => {
      // Exact before close
      if (a.matchType !== b.matchType) return a.matchType === "exact" ? -1 : 1;
      // Fewer invoices first
      return a.invoices.length - b.invoices.length;
    });
    return matched.slice(0, maxResults);
  }

  // No exact/close match — return closest partial suggestions for user context.
  const partials: MatchSuggestion[] = [];

  // Single-invoice partials (most actionable)
  for (const inv of eligible) {
    const balance = getInvoiceRemainingBalance(inv);
    const diff    = r2(paymentAmount - balance);
    partials.push({
      invoices:     [inv],
      totalBalance: balance,
      difference:   diff,
      isExact:      false,
      matchType:    "partial",
    });
  }

  // If payment could cover multiple invoices, also add the full-eligible combo
  if (eligible.length > 1) {
    const allBalance = r2(eligible.reduce((s, inv) => s + getInvoiceRemainingBalance(inv), 0));
    partials.push({
      invoices:     eligible,
      totalBalance: allBalance,
      difference:   r2(paymentAmount - allBalance),
      isExact:      false,
      matchType:    "partial",
    });
  }

  partials.sort((a, b) => Math.abs(a.difference) - Math.abs(b.difference));
  return partials.slice(0, maxResults);
}
