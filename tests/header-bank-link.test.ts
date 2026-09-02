/**
 * The main header exposes a Bank entry next to Invoices.
 *
 * /admin/bank already existed but had no navigation entry, so it could only be
 * reached by typing the URL. This is presentation only — no auth, no Plaid, and
 * no reconciliation behavior is involved.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const page = read("app/page.tsx");
const css = read("app/globals.css");

describe("Bank header link", () => {
  it("links to the existing bank page", () => {
    expect(page).toContain('href="/admin/bank"');
  });

  it("appears in both the desktop and mobile header groups", () => {
    const matches = page.match(/href="\/admin\/bank"/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  it("sits next to Invoices in each group", () => {
    for (const group of ["header-editor-tools", "mobile-header-editor-tools"]) {
      const start = page.indexOf(`className="${group}"`);
      expect(start).toBeGreaterThan(-1);
      const block = page.slice(start, start + 600);
      const inv = block.indexOf('href="/admin/invoices"');
      const bank = block.indexOf('href="/admin/bank"');
      expect(inv).toBeGreaterThan(-1);
      expect(bank).toBeGreaterThan(inv);
    }
  });

  it("reuses the existing header pill styling", () => {
    const bankAt = page.indexOf('href="/admin/bank"');
    expect(page.slice(bankAt, bankAt + 120)).toContain('className="header-invoices-link"');
  });

  it("is gated by the same editor check as Invoices, adding no new auth", () => {
    // Both links live inside the same isJeffEditor branch.
    const branch = page.slice(page.indexOf("isJeffEditor ?"), page.indexOf("<ThemeToggle"));
    expect(branch).toContain('href="/admin/invoices"');
    expect(branch).toContain('href="/admin/bank"');
    expect(page).not.toMatch(/type=["']password["']|signIn\(|next-auth/i);
  });

  it("keeps Sync and History in the header", () => {
    expect(page).toContain("<EditorSyncButton");
    expect(page).toContain("<EditorHistoryButton");
  });

  it("spaces the pills on mobile without changing the container gap", () => {
    expect(css).toContain(".mobile-header-editor-tools .header-invoices-link");
    const rule = css.slice(css.indexOf(".mobile-header-editor-tools .header-invoices-link"));
    expect(rule.slice(0, 160)).toMatch(/margin-left:\s*6px/);
  });

  it("leaks no Plaid or bank data into the main page", () => {
    for (const s of ["PLAID_SECRET", "PLAID_CLIENT_ID", "BANK_TOKEN_ENCRYPTION_KEY", "access_token", "plaid-bank-sync", "bank-transactions"]) {
      expect(page).not.toContain(s);
    }
  });
});
