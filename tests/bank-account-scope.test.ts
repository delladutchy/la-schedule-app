/**
 * Reconciliation is scoped to specific bank accounts.
 *
 * All four Wells Fargo accounts keep importing and retaining transactions for
 * future tax/accounting analysis, but only the checking account that receives
 * Light Action payroll may feed invoice reconciliation. Savings sweeps,
 * internal transfers, and card activity previously filled the review queue.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const mocks = vi.hoisted(() => ({ maybeSingle: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }) }),
  }),
}));

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

describe("isAccountInReconciliationScope", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("allows an account flagged for reconciliation", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { reconciliation_enabled: true }, error: null });
    const { isAccountInReconciliationScope } = await import("@/lib/bank-account-scope");
    expect(await isAccountInReconciliationScope("acct-8155")).toBe(true);
  });

  it("blocks an account excluded from reconciliation", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { reconciliation_enabled: false }, error: null });
    const { isAccountInReconciliationScope } = await import("@/lib/bank-account-scope");
    expect(await isAccountInReconciliationScope("acct-8655")).toBe(false);
  });

  it("fails open for a transaction with no provider attribution", async () => {
    const { isAccountInReconciliationScope } = await import("@/lib/bank-account-scope");
    expect(await isAccountInReconciliationScope(null)).toBe(true);
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });

  it("fails open for an unknown account", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    const { isAccountInReconciliationScope } = await import("@/lib/bank-account-scope");
    expect(await isAccountInReconciliationScope("acct-unknown")).toBe(true);
  });

  it("fails open when the lookup errors", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { isAccountInReconciliationScope } = await import("@/lib/bank-account-scope");
    expect(await isAccountInReconciliationScope("acct-8155")).toBe(true);
  });
});

describe("scope gate placement in the reconciliation flow", () => {
  const src = read("lib/bank-transactions.ts");

  it("runs before the deposit, counterparty, overlap and matcher checks", () => {
    const body = src.slice(src.indexOf("export async function reconcileBankTransaction"));
    const scopeAt = body.indexOf("isAccountInReconciliationScope");
    for (const later of ["amount <= 0", "light\\s*action", "await findCrossSourceOverlap(", "await listInvoicesForPayments("]) {
      const at = body.indexOf(later);
      expect(at).toBeGreaterThan(-1);
      expect(scopeAt).toBeLessThan(at);
    }
  });

  it("ignores rather than reviews, so out-of-scope accounts add no queue noise", () => {
    expect(src).toContain('reason: "account_not_reconciled"');
    const body = src.slice(src.indexOf("isAccountInReconciliationScope(transaction.provider_account_id)"));
    expect(body.slice(0, 400)).toContain('action: "ignore"');
  });

  it("still short-circuits already-applied and duplicate transactions first", () => {
    const body = src.slice(src.indexOf("export async function reconcileBankTransaction"));
    expect(body.indexOf('reconciliation_status === "applied"')).toBeLessThan(body.indexOf("isAccountInReconciliationScope"));
    expect(body.indexOf('reconciliation_status === "duplicate"')).toBeLessThan(body.indexOf("isAccountInReconciliationScope"));
  });

  it("leaves import unfiltered so every account is still retained", () => {
    const importBody = src.slice(src.indexOf("export async function importBankTransactions"), src.indexOf("export async function reconcileBankTransaction"));
    expect(importBody).not.toContain("isAccountInReconciliationScope");
  });

  it("migration is additive and defaults to reconciling", () => {
    const sql = read("supabase/migrations/20260904_account_reconciliation_scope.sql");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS reconciliation_enabled BOOLEAN NOT NULL DEFAULT true");
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b\s+(public\.)?(invoice_data|payment_batches|payment_batch_allocations|bank_transactions)/i);
  });
});

describe("Plaid OAuth return handling", () => {
  const page = read("app/admin/bank/page.tsx");

  it("never passes receivedRedirectUri without a token", () => {
    expect(page).toContain("receivedRedirectUri: linkToken && oauthRedirectUri ? oauthRedirectUri : undefined");
  });

  it("captures the OAuth return URL once instead of reading location each render", () => {
    expect(page).toContain("setOauthRedirectUri(window.location.href)");
    expect(page).not.toContain("? window.location.href\n      : undefined");
  });

  it("a saved connection can no longer surface as an error", () => {
    const onSuccess = page.slice(page.indexOf("const onSuccess"), page.indexOf("const plaidConfig"));
    const errAt = onSuccess.indexOf('setError(cause instanceof Error ? cause.message : "Could not save bank connection.")');
    const replaceAt = onSuccess.indexOf("history.replaceState");
    expect(errAt).toBeGreaterThan(-1);
    expect(replaceAt).toBeGreaterThan(errAt); // cleanup happens after the error path returns
    expect(onSuccess).toContain("return;");
  });

  it("guards storage and history access", () => {
    const onSuccess = page.slice(page.indexOf("const onSuccess"), page.indexOf("const plaidConfig"));
    expect(onSuccess).toMatch(/try\s*\{[\s\S]*sessionStorage\.removeItem[\s\S]*\}\s*catch/);
    expect(onSuccess).toMatch(/try\s*\{[\s\S]*history\.replaceState[\s\S]*\}\s*catch/);
  });
});
