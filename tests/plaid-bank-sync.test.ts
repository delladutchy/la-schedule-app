import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Transaction } from "plaid";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { decryptBankAccessToken, encryptBankAccessToken } from "@/lib/bank-token-crypto";
import { normalizePlaidPostedTransaction } from "@/lib/plaid-normalization";
import { verifyPlaidWebhookWithJwk } from "@/lib/plaid-webhook";
import { createHash } from "node:crypto";

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    account_id: "acct-checking",
    amount: -10336.22,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date: "2026-08-26",
    location: {} as Transaction["location"],
    name: "LIGHT ACTION PAYROLL",
    original_description: "LIGHT ACTION PAYROLL DEPOSIT",
    payment_meta: {} as Transaction["payment_meta"],
    pending: false,
    pending_transaction_id: null,
    account_owner: null,
    transaction_id: "plaid-2026-08-26",
    payment_channel: "other",
    authorized_date: "2026-08-25",
    authorized_datetime: null,
    datetime: null,
    personal_finance_category: null,
    personal_finance_category_icon_url: null,
    transaction_code: null,
    counterparties: [],
    website: null,
    logo_url: null,
    merchant_entity_id: null,
    ...overrides,
  };
}

const context = {
  providerItemId: "item-safe-provenance",
  institutionId: "ins-wells-fargo",
  institutionName: "Wells Fargo",
  accountId: "acct-checking",
  accountName: "Checking",
  accountMask: "6789",
};

describe("Plaid posted transaction normalization", () => {
  it("converts Plaid's negative deposit sign into the positive normalized ledger amount", () => {
    expect(normalizePlaidPostedTransaction(transaction(), context)).toMatchObject({
      source: "plaid",
      externalTransactionId: "plaid-2026-08-26",
      postedDate: "2026-08-26",
      amount: 10336.22,
      description: "LIGHT ACTION PAYROLL DEPOSIT",
      sourceAccount: "Wells Fargo — Checking ••••6789",
      rawMetadata: {
        item_id: "item-safe-provenance",
        account_id: "acct-checking",
      },
    });
  });

  it("keeps withdrawals negative so the existing reconciliation engine ignores them", () => {
    expect(normalizePlaidPostedTransaction(transaction({ amount: 42.17 }), context)?.amount).toBe(-42.17);
  });

  it("does not ingest pending, non-USD, zero, or non-selected-account activity", () => {
    expect(normalizePlaidPostedTransaction(transaction({ pending: true }), context)).toBeNull();
    expect(normalizePlaidPostedTransaction(transaction({ iso_currency_code: "EUR" }), context)).toBeNull();
    expect(normalizePlaidPostedTransaction(transaction({ amount: 0 }), context)).toBeNull();
    expect(normalizePlaidPostedTransaction(transaction({ account_id: "other-account" }), context)).toBeNull();
  });
});

describe("bank provider access-token encryption", () => {
  it("round-trips an access token without storing plaintext", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptBankAccessToken("access-production-secret", key);
    expect(encrypted).not.toContain("access-production-secret");
    expect(decryptBankAccessToken(encrypted, key)).toBe("access-production-secret");
  });

  it("rejects tampering and the wrong encryption key", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptBankAccessToken("access-production-secret", key);
    expect(() => decryptBankAccessToken(encrypted, randomBytes(32).toString("base64"))).toThrow();
    expect(() => decryptBankAccessToken(`${encrypted.slice(0, -2)}AA`, key)).toThrow();
  });
});

describe("Plaid webhook verification", () => {
  it("accepts a fresh ES256 signature and rejects a changed body", async () => {
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE" });
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.alg = "ES256";
    publicJwk.kid = "test-key";
    const token = await new SignJWT({
      request_body_sha256: createHash("sha256").update(body).digest("hex"),
    }).setProtectedHeader({ alg: "ES256", kid: "test-key" }).setIssuedAt().sign(privateKey);

    await expect(verifyPlaidWebhookWithJwk(body, token, publicJwk)).resolves.toBeUndefined();
    await expect(verifyPlaidWebhookWithJwk(`${body} `, token, publicJwk)).rejects.toThrow("body hash mismatch");
  });

  it("rejects webhook signatures older than five minutes", async () => {
    const body = "{}";
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.alg = "ES256";
    publicJwk.kid = "stale-key";
    const token = await new SignJWT({
      request_body_sha256: createHash("sha256").update(body).digest("hex"),
    }).setProtectedHeader({ alg: "ES256", kid: "stale-key" }).setIssuedAt(Math.floor(Date.now() / 1000) - 301).sign(privateKey);
    await expect(verifyPlaidWebhookWithJwk(body, token, publicJwk)).rejects.toThrow("signature is stale");
  });
});
