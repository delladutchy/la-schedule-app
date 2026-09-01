import { getInvoiceRemainingBalance, type InvoiceForMatching } from "./payment-matching";

export interface BankTransactionImport {
  source: string;
  externalTransactionId: string;
  postedDate: string;
  amount: number;
  description: string;
  sourceAccount: string | null;
  rawMetadata: Record<string, unknown>;
}

export interface AutomaticAllocation {
  googleEventId: string;
  invoiceNumber: string | null;
  amount: number;
}

export type ReconciliationDecision =
  | {
      action: "auto_apply";
      reason: "unique_exact_match";
      allocations: AutomaticAllocation[];
      candidateMatches: AutomaticAllocation[][];
    }
  | {
      action: "review";
      reason: "no_exact_match" | "ambiguous_exact_match" | "unrecognized_counterparty";
      allocations: [];
      candidateMatches: AutomaticAllocation[][];
    }
  | {
      action: "ignore";
      reason: "not_a_deposit";
      allocations: [];
      candidateMatches: [];
    };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isTestInvoice(invoice: InvoiceForMatching): boolean {
  return /^test(?:[-_:]|$)/i.test(invoice.google_event_id)
    || /\btest\b/i.test(invoice.la_number ?? "");
}

export function eligibleInvoicesForAutoReconciliation(
  invoices: InvoiceForMatching[],
): InvoiceForMatching[] {
  return invoices.filter((invoice) => (
    !["paid", "void"].includes(invoice.invoice_status)
    && (invoice.client == null || invoice.client === "Light Action")
    && !isTestInvoice(invoice)
    && getInvoiceRemainingBalance(invoice) > 0
  ));
}

function toAllocations(invoices: InvoiceForMatching[]): AutomaticAllocation[] {
  return invoices.map((invoice) => ({
    googleEventId: invoice.google_event_id,
    invoiceNumber: invoice.invoice_number,
    amount: round2(getInvoiceRemainingBalance(invoice)),
  }));
}

function findExactCombinationsToCent(
  amount: number,
  invoices: InvoiceForMatching[],
  maxCombinationSize: number,
): InvoiceForMatching[][] {
  const targetCents = Math.round(amount * 100);
  const candidates = invoices
    .map((invoice) => ({ invoice, cents: Math.round(getInvoiceRemainingBalance(invoice) * 100) }))
    .filter((candidate) => candidate.cents > 0 && candidate.cents <= targetCents)
    .sort((a, b) => a.cents - b.cents || a.invoice.google_event_id.localeCompare(b.invoice.google_event_id));
  const matches: InvoiceForMatching[][] = [];

  const search = (start: number, remaining: number, current: InvoiceForMatching[]): void => {
    if (matches.length >= 2) return; // two is enough to prove ambiguity
    if (remaining === 0) { matches.push([...current]); return; }
    if (current.length >= maxCombinationSize) return;
    for (let index = start; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      if (candidate.cents > remaining) break;
      current.push(candidate.invoice);
      search(index + 1, remaining - candidate.cents, current);
      current.pop();
      if (matches.length >= 2) return;
    }
  };

  search(0, targetCents, []);
  return matches;
}

/**
 * Auto-apply only one unique, exact-to-the-cent result. Close, partial,
 * ambiguous, and non-credit transactions always require review.
 */
export function decideAutomaticReconciliation(
  transactionAmount: number,
  invoices: InvoiceForMatching[],
  maxCombinationSize = 6,
): ReconciliationDecision {
  const amount = round2(transactionAmount);
  if (amount <= 0) {
    return { action: "ignore", reason: "not_a_deposit", allocations: [], candidateMatches: [] };
  }

  const eligible = eligibleInvoicesForAutoReconciliation(invoices);
  const exact = findExactCombinationsToCent(amount, eligible, maxCombinationSize);
  const candidateMatches = exact.map(toAllocations);

  if (exact.length === 1) {
    return {
      action: "auto_apply",
      reason: "unique_exact_match",
      allocations: candidateMatches[0]!,
      candidateMatches,
    };
  }
  return {
    action: "review",
    reason: exact.length > 1 ? "ambiguous_exact_match" : "no_exact_match",
    allocations: [],
    candidateMatches,
  };
}

export function resolveLaPaySheetName(
  workdayDates: string[],
  configuredName = "LA PAY (2026)",
): string {
  const serviceDate = workdayDates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort()[0];
  if (!serviceDate) return configuredName;
  const year = serviceDate.slice(0, 4);
  return /\(\d{4}\)/.test(configuredName)
    ? configuredName.replace(/\(\d{4}\)/, `(${year})`)
    : configuredName;
}

export function dedupeBankTransactionImports(
  transactions: BankTransactionImport[],
): BankTransactionImport[] {
  const seen = new Set<string>();
  return transactions.filter((transaction) => {
    const key = `${transaction.source}\u0000${transaction.externalTransactionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
