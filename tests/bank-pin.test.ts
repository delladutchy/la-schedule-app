/**
 * Bank PIN gate — an ADDITIONAL layer over the existing editor session.
 *
 * The PIN lives only in BANK_ADMIN_PIN server-side. It must never reach the
 * client bundle, rendered HTML, or an API response, and it must not replace or
 * weaken the editor authorization that already guards every bank route.
 */

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  BANK_UNLOCK_COOKIE_NAME,
  BANK_UNLOCK_MAX_AGE_SECONDS,
  buildBankUnlockCookieValue,
  isCorrectBankPin,
  isValidBankUnlockCookie,
  requestHasBankUnlock,
  bankPinLockoutRemainingMs,
  recordBankPinFailure,
  clearBankPinFailures,
  __resetBankPinThrottle,
} from "@/lib/bank-pin";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const PIN = "4731";          // test-only value, never a configured secret
const OTHER = "0000";

describe("PIN comparison", () => {
  it("accepts the configured PIN", () => {
    expect(isCorrectBankPin(PIN, PIN)).toBe(true);
  });
  it("3. rejects a wrong PIN", () => {
    expect(isCorrectBankPin(OTHER, PIN)).toBe(false);
    expect(isCorrectBankPin("473", PIN)).toBe(false);
    expect(isCorrectBankPin("47311", PIN)).toBe(false);
  });
  it("rejects non-numeric and empty input", () => {
    for (const bad of ["", "abcd", "47 1", "٤٧٣١"]) expect(isCorrectBankPin(bad, PIN)).toBe(false);
  });
  it("fails closed when no PIN is configured", () => {
    expect(isCorrectBankPin(PIN, undefined)).toBe(false);
    expect(isCorrectBankPin(PIN, "")).toBe(false);
  });
});

describe("4/5. unlock cookie", () => {
  it("a correct PIN produces a cookie that validates", () => {
    expect(isValidBankUnlockCookie(buildBankUnlockCookieValue(PIN), PIN)).toBe(true);
  });
  it("1. no cookie means locked", () => {
    expect(isValidBankUnlockCookie(null, PIN)).toBe(false);
    expect(isValidBankUnlockCookie("", PIN)).toBe(false);
  });
  it("a forged or tampered cookie is rejected", () => {
    const good = buildBankUnlockCookieValue(PIN);
    const [payload, sig] = good.split(".");
    expect(isValidBankUnlockCookie(`${payload}.deadbeef`, PIN)).toBe(false);
    expect(isValidBankUnlockCookie(`${Buffer.from('{"v":1,"exp":99999999999999,"iat":0}').toString("base64url")}.${sig}`, PIN)).toBe(false);
    expect(isValidBankUnlockCookie(payload!, PIN)).toBe(false);
  });
  it("a cookie signed under a different PIN is rejected (rotating the PIN revokes sessions)", () => {
    expect(isValidBankUnlockCookie(buildBankUnlockCookieValue(OTHER), PIN)).toBe(false);
  });
  it("expires after ~12 hours", () => {
    expect(BANK_UNLOCK_MAX_AGE_SECONDS).toBe(12 * 60 * 60);
    const now = Date.UTC(2026, 8, 2, 12, 0, 0);
    const cookie = buildBankUnlockCookieValue(PIN, now);
    expect(isValidBankUnlockCookie(cookie, PIN, now + 11 * 3600_000)).toBe(true);
    expect(isValidBankUnlockCookie(cookie, PIN, now + 13 * 3600_000)).toBe(false);
  });
  it("reads the cookie off a request", () => {
    const value = buildBankUnlockCookieValue(PIN);
    const req = new Request("https://app.local/api/bank-connections", {
      headers: { cookie: `theme=dark; ${BANK_UNLOCK_COOKIE_NAME}=${value}; other=1` },
    });
    expect(requestHasBankUnlock(req, PIN)).toBe(true);
    expect(requestHasBankUnlock(new Request("https://app.local/x"), PIN)).toBe(false);
  });
});

describe("4. guess throttling", () => {
  beforeEach(() => { __resetBankPinThrottle(); });
  it("locks out after repeated failures and clears on success", () => {
    const key = "jeff";
    expect(bankPinLockoutRemainingMs(key)).toBe(0);
    for (let i = 0; i < 5; i++) recordBankPinFailure(key);
    expect(bankPinLockoutRemainingMs(key)).toBeGreaterThan(0);
    clearBankPinFailures(key);
    expect(bankPinLockoutRemainingMs(key)).toBe(0);
  });
  it("a few failures alone do not lock out", () => {
    recordBankPinFailure("jeff");
    recordBankPinFailure("jeff");
    expect(bankPinLockoutRemainingMs("jeff")).toBe(0);
  });
});

describe("2/6. both layers required on bank routes", () => {
  const GUARDED = [
    "app/api/bank-connections/route.ts",
    "app/api/bank-connections/link-token/route.ts",
    "app/api/bank-connections/[connectionId]/route.ts",
    "app/api/bank-reconciliation/reviews/route.ts",
    "app/api/bank-reconciliation/health/route.ts",
    "app/api/bank-transactions/[transactionId]/review/route.ts",
    "app/api/bank-transactions/[transactionId]/reverse/route.ts",
  ];

  it("every sensitive bank route requires the Bank PIN", () => {
    for (const route of GUARDED) expect(read(route)).toContain("requireBankUnlock");
  });

  it("2. the existing editor authorization is still required everywhere", () => {
    for (const route of GUARDED) {
      const src = read(route);
      expect(src).toContain("authorizeEditorRequest");
      expect(src).toContain("isJeffEditorId");
    }
  });

  it("the editor check runs before the PIN check, so the PIN never replaces it", () => {
    for (const route of GUARDED) {
      const src = read(route);
      expect(src.indexOf("authorizeEditorRequest")).toBeLessThan(src.indexOf("requireBankUnlock"));
    }
  });

  it("the guard fails closed when no PIN is configured", () => {
    const guard = read("lib/bank-admin-guard.ts");
    expect(guard).toContain("bank_pin_not_configured");
    expect(guard).toContain("bank_locked");
  });

  it("10. the Plaid webhook and scheduled sync are NOT PIN-gated", () => {
    expect(read("app/api/plaid/webhook/route.ts")).not.toContain("requireBankUnlock");
    expect(read("app/api/cron/bank-sync/route.ts")).not.toContain("requireBankUnlock");
  });

  it("the ADMIN_TOKEN monitoring path still works without a PIN", () => {
    const health = read("app/api/bank-reconciliation/health/route.ts");
    expect(health).toContain("if (!isAdminToken)");
  });
});

describe("1. the page itself is server-gated", () => {
  const page = read("app/admin/bank/page.tsx");
  it("renders the PIN screen instead of the dashboard when locked", () => {
    expect(page).toContain("isValidBankUnlockCookie");
    expect(page).toContain("<BankPinGate />");
    expect(page).toContain("<BankDashboard />");
    expect(page).not.toContain('"use client"');
  });
  it("no bank data component is imported into the locked branch", () => {
    const gate = read("components/BankPinGate.tsx");
    for (const s of ["BankConnection", "reviews", "plaid", "transaction", "balance"]) {
      expect(gate.toLowerCase()).not.toContain(s.toLowerCase() + "[]");
    }
  });
});

describe("7/8. Lock Bank", () => {
  const route = read("app/api/bank-pin/route.ts");
  const dash = read("components/BankDashboard.tsx");
  it("7. clears the bank unlock cookie", () => {
    const del = route.slice(route.indexOf("export async function DELETE"));
    expect(del).toContain("BANK_UNLOCK_COOKIE_NAME");
    expect(del).toContain("maxAge: 0");
  });
  it("8. does NOT touch the editor session cookie", () => {
    expect(route).not.toContain("EDITOR_SESSION_COOKIE_NAME");
    expect(route).not.toContain("la_editor_session");
  });
  it("the dashboard exposes a Lock Bank control", () => {
    expect(dash).toContain("Lock Bank");
    expect(dash).toContain('method: "DELETE"');
  });
});

describe("9. the PIN never reaches the client", () => {
  it("is not referenced in any client component", () => {
    // page.tsx is deliberately excluded: it is a server component, so its env
    // access never ships to the browser. That property is asserted below.
    for (const f of ["components/BankPinGate.tsx", "components/BankDashboard.tsx"]) {
      const src = read(f);
      expect(src.startsWith('"use client"')).toBe(true);
      expect(src).not.toContain("BANK_ADMIN_PIN");
    }
  });

  it("only the server component reads the configured PIN", () => {
    const page = read("app/admin/bank/page.tsx");
    expect(page).not.toContain('"use client"');
    expect(page).toContain("BANK_ADMIN_PIN");
  });

  it("never appears in the built client bundle", () => {
    // Ground truth rather than a source-text proxy. Skipped when .next is absent.
    const staticDir = path.join(process.cwd(), ".next", "static");
    if (!fs.existsSync(staticDir)) return;
    const stack = [staticDir];
    const hits: string[] = [];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (!/\.(js|json|map)$/.test(entry.name)) continue;
        if (fs.readFileSync(full, "utf8").includes("BANK_ADMIN_PIN")) hits.push(full);
      }
    }
    expect(hits).toEqual([]);
  });
  it("is never exposed through NEXT_PUBLIC or committed to the example env", () => {
    const env = read(".env.example");
    expect(env).not.toContain("NEXT_PUBLIC_BANK_ADMIN_PIN");
    expect(env).toMatch(/#\s*BANK_ADMIN_PIN=\s*$/m); // commented, no value
  });
  it("is never echoed by the unlock API", () => {
    const route = read("app/api/bank-pin/route.ts");
    const responses = route.match(/NextResponse\.json\([^)]*\)/g) ?? [];
    for (const r of responses) expect(r).not.toContain("configuredPin");
    // Fixed log strings are fine; logging the entered value is not.
    expect(route).not.toMatch(/console\.\w+\([^)]*\$\{\s*pin\s*\}/);
    expect(route).not.toMatch(/console\.\w+\([^)]*,\s*pin\b/);
    expect(route).not.toMatch(/console\.\w+\(\s*pin\b/);
  });
  it("the server marks bank-pin lib as server-only", () => {
    expect(read("lib/bank-pin.ts").startsWith('import "server-only"')).toBe(true);
    expect(read("lib/bank-admin-guard.ts").startsWith('import "server-only"')).toBe(true);
  });
});

describe("10. reconciliation behavior unchanged", () => {
  it("overlap protection still precedes the matcher", () => {
    const src = read("lib/bank-transactions.ts");
    const body = src.slice(src.indexOf("export async function reconcileBankTransaction"));
    expect(body.indexOf("await findCrossSourceOverlap(")).toBeLessThan(body.indexOf("await listInvoicesForPayments("));
  });
  it("account scope gate is intact", () => {
    expect(read("lib/bank-transactions.ts")).toContain("isAccountInReconciliationScope");
  });
  it("no PIN logic leaked into reconciliation", () => {
    for (const f of ["lib/bank-transactions.ts", "lib/bank-reconciliation.ts", "lib/plaid-bank-sync.ts"]) {
      expect(read(f)).not.toContain("BANK_ADMIN_PIN");
      expect(read(f)).not.toContain("requireBankUnlock");
    }
  });
});
