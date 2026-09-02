import type { Transaction } from "plaid";
import type { BankTransactionImport } from "./bank-reconciliation";

export interface PlaidNormalizationContext {
  providerItemId: string;
  institutionId: string | null;
  institutionName: string;
  accountId: string;
  accountName: string;
  accountMask: string | null;
}

export function normalizePlaidPostedTransaction(
  transaction: Transaction,
  context: PlaidNormalizationContext,
): BankTransactionImport | null {
  if (transaction.pending || transaction.account_id !== context.accountId) return null;
  if (transaction.iso_currency_code && transaction.iso_currency_code !== "USD") return null;
  const amount = Math.round((-transaction.amount + Number.EPSILON) * 100) / 100;
  if (amount === 0) return null;
  const description = transaction.original_description?.trim()
    || transaction.merchant_name?.trim()
    || transaction.name.trim();
  return {
    source: "plaid",
    externalTransactionId: transaction.transaction_id,
    postedDate: transaction.date,
    amount,
    description,
    sourceAccount: `${context.institutionName} — ${context.accountName}${context.accountMask ? ` ••••${context.accountMask}` : ""}`,
    providerAccountId: transaction.account_id,
    rawMetadata: {
      provider: "plaid",
      item_id: context.providerItemId,
      institution_id: context.institutionId,
      account_id: transaction.account_id,
      pending_transaction_id: transaction.pending_transaction_id,
      authorized_date: transaction.authorized_date ?? null,
      merchant_name: transaction.merchant_name ?? null,
      original_description: transaction.original_description ?? null,
      payment_channel: transaction.payment_channel,
      transaction_code: transaction.transaction_code ?? null,
      personal_finance_category: transaction.personal_finance_category ?? null,
      iso_currency_code: transaction.iso_currency_code,
    },
  };
}
