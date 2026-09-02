export interface ExistingBankPaymentEvidence {
  bankTransactionId: string;
  source: string;
  postedDate: string;
  amount: number;
  description: string;
  sourceAccount: string | null;
  paymentBatchId: string | null;
  paymentReference: string | null;
  allocationIds: string[];
  invoiceEventIds: string[];
}

export interface ExistingPaymentBatchEvidence {
  paymentBatchId: string;
  receivedDate: string;
  amount: number;
  bankAccount: string | null;
  reference: string | null;
  bankTransactionId: string | null;
  allocationIds: string[];
  invoiceEventIds: string[];
}

export interface PaidInvoiceEvidence {
  googleEventId: string;
  invoiceNumber: string | null;
  paidDate: string;
  amountPaid: number;
}

export interface CrossSourceOverlapInput {
  source: string;
  postedDate: string;
  amount: number;
  description: string;
  sourceAccount: string | null;
}

export type CrossSourceOverlapCandidate = {
  kind: "bank_transaction" | "payment_batch" | "legacy_paid_invoices";
  date: string;
  amount: number;
  bankTransactionId: string | null;
  paymentBatchId: string | null;
  paymentReference: string | null;
  allocationIds: string[];
  invoiceEventIds: string[];
  invoiceNumbers: Array<string | null>;
};

export type CrossSourceOverlapDecision =
  | { action: "none"; candidates: [] }
  | { action: "duplicate"; candidate: CrossSourceOverlapCandidate; candidates: CrossSourceOverlapCandidate[] }
  | { action: "review"; reason: "ambiguous_cross_source_overlap"; candidates: CrossSourceOverlapCandidate[] };

const DATE_TOLERANCE_DAYS = 2;

export function isLightActionCounterparty(value: string): boolean {
  return /\blight\s*action\b/i.test(value.replace(/[^a-z0-9]+/gi, " "));
}

function cents(value: number): number {
  return Math.round(value * 100);
}

function dateDistanceDays(a: string, b: string): number {
  const aMs = Date.parse(`${a}T00:00:00Z`);
  const bMs = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((aMs - bMs) / 86_400_000));
}

function accountEvidence(value: string | null): { institution: string | null; mask: string | null } {
  const normalized = (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const institution = /wells\s*fargo|\bwf\b/.test(normalized)
    ? "wells_fargo"
    : normalized.split(" ").filter(Boolean).slice(0, 2).join("_") || null;
  const maskMatch = normalized.match(/(?:^|\s)(\d{4})(?:$|\s)/);
  return { institution, mask: maskMatch?.[1] ?? null };
}

export function isCompatibleBankAccount(a: string | null, b: string | null): boolean {
  const left = accountEvidence(a);
  const right = accountEvidence(b);
  if (!left.institution || !right.institution || left.institution !== right.institution) return false;
  if (left.mask && right.mask && left.mask !== right.mask) return false;
  return true;
}

function exactPaidInvoiceCombinations(
  targetAmount: number,
  invoices: PaidInvoiceEvidence[],
  maxSize = 6,
): PaidInvoiceEvidence[][] {
  const target = cents(targetAmount);
  const candidates = invoices
    .map((invoice) => ({ invoice, value: cents(invoice.amountPaid) }))
    .filter((entry) => entry.value > 0 && entry.value <= target)
    .sort((a, b) => a.value - b.value || a.invoice.googleEventId.localeCompare(b.invoice.googleEventId));
  const matches: PaidInvoiceEvidence[][] = [];
  const search = (start: number, remaining: number, current: PaidInvoiceEvidence[]): void => {
    if (matches.length >= 2) return;
    if (remaining === 0) { matches.push([...current]); return; }
    if (current.length >= maxSize) return;
    for (let index = start; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      if (candidate.value > remaining) break;
      current.push(candidate.invoice);
      search(index + 1, remaining - candidate.value, current);
      current.pop();
      if (matches.length >= 2) return;
    }
  };
  search(0, target, []);
  return matches;
}

function chooseByDateCertainty(
  inputDate: string,
  candidates: CrossSourceOverlapCandidate[],
): CrossSourceOverlapDecision {
  const exactDate = candidates.filter((candidate) => candidate.date === inputDate);
  const pool = exactDate.length > 0 ? exactDate : candidates;
  if (pool.length === 0) return { action: "none", candidates: [] };
  if (pool.length === 1) return { action: "duplicate", candidate: pool[0]!, candidates: pool };
  return { action: "review", reason: "ambiguous_cross_source_overlap", candidates: pool };
}

/**
 * Detect an already-recorded payment before matching against unpaid invoices.
 * Direct bank/payment provenance takes precedence over legacy paid-date evidence.
 */
export function decideCrossSourceOverlap(
  input: CrossSourceOverlapInput,
  evidence: {
    bankTransactions: ExistingBankPaymentEvidence[];
    paymentBatches: ExistingPaymentBatchEvidence[];
    paidInvoices: PaidInvoiceEvidence[];
  },
): CrossSourceOverlapDecision {
  if (input.amount <= 0 || !isLightActionCounterparty(input.description)) {
    return { action: "none", candidates: [] };
  }

  const directBank = evidence.bankTransactions.filter((candidate) => (
    candidate.source !== input.source
    && cents(candidate.amount) === cents(input.amount)
    && dateDistanceDays(candidate.postedDate, input.postedDate) <= DATE_TOLERANCE_DAYS
    && isLightActionCounterparty(candidate.description)
    && isCompatibleBankAccount(candidate.sourceAccount, input.sourceAccount)
  )).map((candidate): CrossSourceOverlapCandidate => ({
    kind: "bank_transaction",
    date: candidate.postedDate,
    amount: candidate.amount,
    bankTransactionId: candidate.bankTransactionId,
    paymentBatchId: candidate.paymentBatchId,
    paymentReference: candidate.paymentReference,
    allocationIds: candidate.allocationIds,
    invoiceEventIds: candidate.invoiceEventIds,
    invoiceNumbers: [],
  }));
  const directDecision = chooseByDateCertainty(input.postedDate, directBank);
  if (directDecision.action !== "none") return directDecision;

  const batches = evidence.paymentBatches.filter((candidate) => (
    cents(candidate.amount) === cents(input.amount)
    && dateDistanceDays(candidate.receivedDate, input.postedDate) <= DATE_TOLERANCE_DAYS
    && isCompatibleBankAccount(candidate.bankAccount, input.sourceAccount)
  )).map((candidate): CrossSourceOverlapCandidate => ({
    kind: "payment_batch",
    date: candidate.receivedDate,
    amount: candidate.amount,
    bankTransactionId: candidate.bankTransactionId,
    paymentBatchId: candidate.paymentBatchId,
    paymentReference: candidate.reference,
    allocationIds: candidate.allocationIds,
    invoiceEventIds: candidate.invoiceEventIds,
    invoiceNumbers: [],
  }));
  const batchDecision = chooseByDateCertainty(input.postedDate, batches);
  if (batchDecision.action !== "none") return batchDecision;

  const dates = [...new Set(evidence.paidInvoices
    .filter((invoice) => dateDistanceDays(invoice.paidDate, input.postedDate) <= DATE_TOLERANCE_DAYS)
    .map((invoice) => invoice.paidDate))];
  const legacyCandidates: CrossSourceOverlapCandidate[] = [];
  for (const date of dates) {
    const matches = exactPaidInvoiceCombinations(
      input.amount,
      evidence.paidInvoices.filter((invoice) => invoice.paidDate === date),
    );
    for (const match of matches) {
      legacyCandidates.push({
        kind: "legacy_paid_invoices",
        date,
        amount: input.amount,
        bankTransactionId: null,
        paymentBatchId: null,
        paymentReference: null,
        allocationIds: [],
        invoiceEventIds: match.map((invoice) => invoice.googleEventId),
        invoiceNumbers: match.map((invoice) => invoice.invoiceNumber),
      });
      if (legacyCandidates.length >= 2) break;
    }
    if (legacyCandidates.length >= 2) break;
  }
  return chooseByDateCertainty(input.postedDate, legacyCandidates);
}
