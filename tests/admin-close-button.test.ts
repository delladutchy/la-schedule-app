/**
 * Top-right × close on the admin pages.
 *
 * Replaces the old "← Back to Schedule" links, which sat awkwardly under the
 * iPhone status bar. Presentation only: the × is a plain link to "/", so it
 * cannot clear the Bank PIN unlock — Lock Bank remains the only action that does.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const close = read("components/CloseToSchedule.tsx");
const invoices = read("app/admin/invoices/page.tsx");
const gate = read("components/BankPinGate.tsx");
const dash = read("components/BankDashboard.tsx");
const css = read("app/globals.css");

describe("4. the close control navigates to /", () => {
  it("is an anchor to the main schedule", () => {
    expect(close).toContain('href="/"');
    expect(close).toContain('className="admin-close"');
  });
  it("renders an × glyph", () => {
    expect(close).toContain("×");
  });
  it("is accessible", () => {
    expect(close).toMatch(/aria-label="(Close|Back to Schedule)"/);
    expect(close).toContain('aria-hidden="true"');
  });
});

describe("1/2/3. it appears on every admin surface", () => {
  it("1. on /admin/invoices", () => {
    expect(invoices).toContain("<CloseToSchedule />");
  });
  it("2. on the locked Bank PIN screen", () => {
    expect(gate).toContain("<CloseToSchedule />");
  });
  it("3. on the unlocked Bank dashboard", () => {
    expect(dash).toContain("<CloseToSchedule />");
  });
  it("uses one shared component for consistent placement", () => {
    for (const src of [invoices, gate, dash]) {
      expect(src).toContain('from "@/components/CloseToSchedule"');
    }
  });
});

describe("5/6. the old Back to Schedule links are gone", () => {
  it("5. removed from invoices", () => {
    expect(invoices).not.toContain("Back to Schedule");
    expect(invoices).not.toContain("worklist-back-link");
  });
  it("6. removed from the Bank PIN screen", () => {
    expect(gate).not.toContain("Back to Schedule");
    expect(gate).not.toContain("bank-pin-back");
  });
  it("their styles are retired from the stylesheet", () => {
    expect(css).not.toContain(".worklist-back-link");
    expect(css).not.toContain(".bank-pin-back");
  });
});

describe("7/8. the × does not affect Bank PIN authorization", () => {
  it("7. it performs no fetch and touches no cookie", () => {
    // Strip comments so the doc block explaining "no cookie" is not itself matched.
    const code = close.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("fetch(");
    expect(code).not.toContain("DELETE");
    expect(code).not.toContain("bank-pin");
    expect(code).not.toContain("document.cookie");
    expect(code).not.toContain("onClick");
    expect(code).not.toContain('"use client"'); // static server-rendered link
  });
  it("8. Lock Bank still clears the unlock", () => {
    expect(dash).toContain("Lock Bank");
    const lock = dash.slice(dash.indexOf("async function lockBank"));
    expect(lock.slice(0, 400)).toContain('"/api/bank-pin"');
    expect(lock.slice(0, 400)).toContain('method: "DELETE"');
  });
  it("the DELETE endpoint still clears only the bank cookie", () => {
    const route = read("app/api/bank-pin/route.ts");
    expect(route).not.toContain("la_editor_session");
  });
});

describe("9. authentication is unchanged", () => {
  it("bank routes still require both editor and PIN", () => {
    for (const route of [
      "app/api/bank-connections/route.ts",
      "app/api/bank-reconciliation/reviews/route.ts",
    ]) {
      const src = read(route);
      expect(src).toContain("authorizeEditorRequest");
      expect(src).toContain("requireBankUnlock");
    }
  });
  it("the page is still server-gated by the unlock cookie", () => {
    const page = read("app/admin/bank/page.tsx");
    expect(page).toContain("isValidBankUnlockCookie");
    expect(page).toContain("<BankPinGate />");
    expect(page).toContain("<BankDashboard />");
  });
});

describe("10. mobile / PWA safe-area spacing", () => {
  it("the × offsets respect the safe-area insets", () => {
    const rule = css.slice(css.indexOf(".admin-close {"), css.indexOf(".admin-close:hover"));
    expect(rule).toContain("env(safe-area-inset-top, 0px)");
    expect(rule).toContain("env(safe-area-inset-right, 0px)");
    expect(rule).toContain("position: fixed");
  });
  it("gives a ~44x44 touch target", () => {
    const rule = css.slice(css.indexOf(".admin-close {"), css.indexOf(".admin-close:hover"));
    expect(rule).toContain("width: 44px");
    expect(rule).toContain("height: 44px");
  });
  it("adds no fixed desktop gap — env() resolves to 0 there", () => {
    const rule = css.slice(css.indexOf(".admin-close {"), css.indexOf(".admin-close:hover"));
    expect(rule).toMatch(/top:\s*calc\(8px \+ env\(safe-area-inset-top, 0px\)\)/);
  });
  it("keeps headings clear of the status bar and the × itself", () => {
    expect(css).toMatch(/\.worklist-header\s*\{[^}]*env\(safe-area-inset-top, 0px\)/);
    expect(css).toContain(".worklist-title { padding-right: 44px; }");
    expect(css).toContain(".bank-admin-heading { padding-right: 52px; }");
  });
});

describe("presentation only", () => {
  it("no financial, Plaid, or reconciliation logic is referenced", () => {
    for (const s of ["invoice_status", "payment_batch", "reconciliation", "plaid", "PLAID_", "BANK_ADMIN_PIN"]) {
      expect(close.toLowerCase()).not.toContain(s.toLowerCase());
    }
  });
  it("the worklist component itself is untouched by this change", () => {
    // Filters/search/range live in InvoiceWorklist and must not gain close logic.
    expect(read("components/InvoiceWorklist.tsx")).not.toContain("CloseToSchedule");
  });
});
