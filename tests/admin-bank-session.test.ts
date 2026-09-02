/**
 * /admin/bank must open without a sign-in step, while every sensitive Plaid
 * operation stays behind the existing server-side editor authorization.
 *
 * The page used to report "Not authorized. Log in as Jeff first." because
 * EditorTokenBridge — which exchanges the stored one-time token for the
 * httpOnly la_editor_session cookie — was mounted only on the main schedule
 * page. Opening /admin/bank directly never refreshed the session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("admin pages bootstrap the existing session (no login UI)", () => {
  it("an /admin layout mounts EditorTokenBridge for every admin page", () => {
    const layout = read("app/admin/layout.tsx");
    expect(layout).toContain("EditorTokenBridge");
  });

  it("the bank page ensures the session before requesting status", () => {
    const page = read("app/admin/bank/page.tsx");
    expect(page).toContain("ensureEditorSession");
    const ensureAt = page.indexOf("await ensureEditorSession()");
    const fetchAt = page.indexOf('fetch("/api/bank-connections"');
    expect(ensureAt).toBeGreaterThan(-1);
    expect(ensureAt).toBeLessThan(fetchAt);
  });

  it("the bank page ensures the session before starting Plaid Link", () => {
    const page = read("app/admin/bank/page.tsx");
    const linkIdx = page.indexOf('fetch("/api/bank-connections/link-token"');
    expect(page.slice(0, linkIdx)).toContain("await ensureEditorSession()");
  });

  it("introduces no login page, password prompt, or second auth system", () => {
    const page = read("app/admin/bank/page.tsx") + read("app/admin/layout.tsx") + read("lib/editor-session.ts");
    expect(page).not.toMatch(/type=["']password["']/i);
    expect(page).not.toMatch(/\bsignIn\(|\boauth\b|magic.?link/i);
    expect(page).not.toContain("Log in as Jeff first");
  });
});

describe("server-side secret protection", () => {
  const SECRETS = [
    "PLAID_SECRET",
    "BANK_TOKEN_ENCRYPTION_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "access_token_encrypted",
  ];

  it("no secret is exposed through a NEXT_PUBLIC_ variable", () => {
    const env = read(".env.example");
    for (const s of SECRETS) expect(env).not.toContain(`NEXT_PUBLIC_${s}`);
  });

  it("the client bank page never references server secrets", () => {
    const page = read("app/admin/bank/page.tsx");
    expect(page.startsWith('"use client"')).toBe(true);
    for (const s of SECRETS) expect(page).not.toContain(s);
    expect(page).not.toContain("SUPABASE_SERVICE_ROLE");
  });

  it("the bank connection API still authorizes every request server-side", () => {
    for (const route of [
      "app/api/bank-connections/route.ts",
      "app/api/bank-connections/link-token/route.ts",
      "app/api/bank-reconciliation/reviews/route.ts",
    ]) {
      const src = read(route);
      expect(src).toContain("authorizeEditorRequest");
      expect(src).toContain("isJeffEditorId");
    }
  });

  it("mutating bank routes keep same-origin enforcement", () => {
    for (const route of [
      "app/api/bank-connections/route.ts",
      "app/api/bank-connections/link-token/route.ts",
    ]) {
      expect(read(route)).toContain("isSameOriginEditorMutation");
    }
  });

  it("the status payload exposes no access token", () => {
    const src = read("app/api/bank-connections/route.ts");
    expect(src).not.toContain("access_token_encrypted");
  });
});

describe("reconciliation safeguards remain intact", () => {
  it("overlap protection still runs before the invoice matcher", () => {
    // Compare call sites, not the import block at the top of the file.
    const src = read("lib/bank-transactions.ts");
    const body = src.slice(src.indexOf("export async function reconcileBankTransaction"));
    const overlapAt = body.indexOf("await findCrossSourceOverlap(");
    const matcherAt = body.indexOf("await listInvoicesForPayments(");
    expect(overlapAt).toBeGreaterThan(-1);
    expect(matcherAt).toBeGreaterThan(-1);
    expect(overlapAt).toBeLessThan(matcherAt);
  });

  it("a cross-source duplicate returns before any payment is applied", () => {
    const src = read("lib/bank-transactions.ts");
    const dupAt = src.indexOf('overlap.action === "duplicate"');
    const applyAt = src.indexOf("apply_bank_transaction_reconciliation");
    expect(dupAt).toBeGreaterThan(-1);
    expect(dupAt).toBeLessThan(applyAt);
  });

  it("webhook signature verification is still required", () => {
    const src = read("app/api/plaid/webhook/route.ts");
    expect(src).toMatch(/verif|signature|jwt/i);
  });

  it("the database still refuses to pay a duplicate transaction", () => {
    const sql = read("supabase/migrations/20260903_bank_reconciliation_reliability.sql");
    expect(sql).toContain("Duplicate transaction % cannot create a payment");
  });
});

describe("ensureEditorSession", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("returns false and posts nothing when no token is stored", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem: () => null } });
    vi.stubGlobal("fetch", fetchSpy);
    const { ensureEditorSession } = await import("@/lib/editor-session");
    expect(await ensureEditorSession()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exchanges a stored token for the session cookie exactly once", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("window", { localStorage: { getItem: () => "jeff-token-abc" } });
    vi.stubGlobal("fetch", fetchSpy);
    const { ensureEditorSession } = await import("@/lib/editor-session");
    expect(await ensureEditorSession()).toBe(true);
    expect(await ensureEditorSession()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/editor/session");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
  });

  it("survives storage access throwing (private mode)", async () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("denied"); } } });
    vi.stubGlobal("fetch", vi.fn());
    const { ensureEditorSession } = await import("@/lib/editor-session");
    expect(await ensureEditorSession()).toBe(false);
  });
});
