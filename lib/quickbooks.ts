/**
 * QuickBooks Online API service — server-only.
 *
 * Handles token refresh and draft invoice creation against the QBO v3 REST API.
 * All writes are gated behind QUICKBOOKS_ENABLED; callers should check the status
 * route (/api/quickbooks/status) to confirm configuration before enabling.
 *
 * Auth flow (already completed, stored as refresh token):
 *   https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
 *
 * Invoice API reference:
 *   https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice
 */

import "server-only";
import type { EnvConfig } from "./config";
import type { InvoicePacket } from "./invoice-types";
import {
  buildQBInvoiceLines,
  QB_LINE_NAMES,
  type QBCreateInvoiceResponse,
  type QBInvoiceBody,
  type QBItemConfig,
  type QBTokenResponse,
} from "./quickbooks-types";

const QB_BASE_URL = "https://quickbooks.api.intuit.com/v3/company";
const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export interface QBDraftResult {
  invoiceId: string;
  docNumber: string;
  totalAmount: number;
  link: string;
}

// ── Item ID config ────────────────────────────────────────────────────────────

/**
 * Read QB item IDs from env vars. All default to null (not configured).
 * Configure each item in QBO → Products & Services, note the item's ID,
 * then set the corresponding QUICKBOOKS_ITEM_* env var.
 */
export function getQBItemConfig(): QBItemConfig {
  return {
    dayRate:       process.env.QUICKBOOKS_ITEM_DAY_RATE    ?? null,
    overtime:      process.env.QUICKBOOKS_ITEM_OVERTIME    ?? null,
    perDiem:       process.env.QUICKBOOKS_ITEM_PER_DIEM    ?? null,
    mileage:       process.env.QUICKBOOKS_ITEM_MILEAGE     ?? null,
    mileageAdj:    process.env.QUICKBOOKS_ITEM_MILEAGE_ADJ ?? null,
    bagFees:       process.env.QUICKBOOKS_ITEM_BAG_FEES    ?? null,
    hotel:         process.env.QUICKBOOKS_ITEM_HOTEL       ?? null,
    parking:       process.env.QUICKBOOKS_ITEM_PARKING     ?? null,
    tolls:         process.env.QUICKBOOKS_ITEM_TOLLS       ?? null,
    uber:          process.env.QUICKBOOKS_ITEM_UBER        ?? null,
    otherExpenses: process.env.QUICKBOOKS_ITEM_OTHER       ?? null,
  };
}

// ── OAuth token refresh ───────────────────────────────────────────────────────

/**
 * Exchange a stored refresh token for a short-lived access token (1 hour).
 * QB refresh tokens are valid for 100 days; a new one is returned each time
 * and should eventually be persisted (not yet implemented — Phase 5 scaffold).
 */
async function getQBAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; newRefreshToken: string }> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QB token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as QBTokenResponse;
  return {
    accessToken: data.access_token,
    newRefreshToken: data.refresh_token,
  };
}

// ── Connection test ───────────────────────────────────────────────────────────

/** Attempt a token refresh to verify credentials are valid. */
export async function checkQBConnection(
  env: Pick<EnvConfig,
    | "QUICKBOOKS_CLIENT_ID"
    | "QUICKBOOKS_CLIENT_SECRET"
    | "QUICKBOOKS_REFRESH_TOKEN"
  >,
): Promise<{ ok: boolean; error?: string }> {
  if (!env.QUICKBOOKS_CLIENT_ID || !env.QUICKBOOKS_CLIENT_SECRET || !env.QUICKBOOKS_REFRESH_TOKEN) {
    return { ok: false, error: "missing_credentials" };
  }
  try {
    await getQBAccessToken(
      env.QUICKBOOKS_CLIENT_ID,
      env.QUICKBOOKS_CLIENT_SECRET,
      env.QUICKBOOKS_REFRESH_TOKEN,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Draft invoice creation ────────────────────────────────────────────────────

/**
 * Create a draft invoice in QuickBooks Online.
 *
 * Guards:
 *   - QUICKBOOKS_ENABLED must be true
 *   - All OAuth credentials must be present
 *   - At least one QB item ID must be configured (otherwise lines = [])
 *
 * Does NOT send the invoice or notify the client.
 * Does NOT persist the QB invoice ID — the caller (route handler) should call
 * markQBDraftCreated() after this succeeds.
 */
export async function createQBDraftInvoice(
  packet: InvoicePacket,
  gigSummary: string,
  env: Pick<EnvConfig,
    | "QUICKBOOKS_ENABLED"
    | "QUICKBOOKS_CLIENT_ID"
    | "QUICKBOOKS_CLIENT_SECRET"
    | "QUICKBOOKS_REALM_ID"
    | "QUICKBOOKS_REFRESH_TOKEN"
    | "QUICKBOOKS_CUSTOMER_ID"
  >,
): Promise<QBDraftResult> {
  if (!env.QUICKBOOKS_ENABLED) {
    throw new Error("QuickBooks is not enabled (QUICKBOOKS_ENABLED=false)");
  }
  if (!env.QUICKBOOKS_CLIENT_ID || !env.QUICKBOOKS_CLIENT_SECRET) {
    throw new Error("Missing QUICKBOOKS_CLIENT_ID or QUICKBOOKS_CLIENT_SECRET");
  }
  if (!env.QUICKBOOKS_REALM_ID) {
    throw new Error("Missing QUICKBOOKS_REALM_ID");
  }
  if (!env.QUICKBOOKS_REFRESH_TOKEN) {
    throw new Error("Missing QUICKBOOKS_REFRESH_TOKEN — complete OAuth setup first");
  }

  const { accessToken } = await getQBAccessToken(
    env.QUICKBOOKS_CLIENT_ID,
    env.QUICKBOOKS_CLIENT_SECRET,
    env.QUICKBOOKS_REFRESH_TOKEN,
  );

  const itemConfig = getQBItemConfig();
  const lines = buildQBInvoiceLines(packet, itemConfig);

  if (lines.length === 0) {
    throw new Error(
      "No QB invoice lines could be built — ensure QUICKBOOKS_ITEM_* env vars are set " +
      `(${Object.values(QB_LINE_NAMES).join(", ")})`,
    );
  }

  const customerId = env.QUICKBOOKS_CUSTOMER_ID ?? "1";
  const body: QBInvoiceBody = {
    Line: lines,
    CustomerRef: { value: customerId, name: packet.client },
    DocNumber: packet.laNumber ?? undefined,
    PrivateNote: gigSummary || undefined,
  };

  const url = `${QB_BASE_URL}/${env.QUICKBOOKS_REALM_ID}/invoice`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ Invoice: body }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`QB create invoice failed (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as QBCreateInvoiceResponse;
  const inv = data.Invoice;

  return {
    invoiceId: inv.Id,
    docNumber: inv.DocNumber,
    totalAmount: inv.TotalAmt,
    link: `https://app.qbo.intuit.com/app/invoice?txnId=${inv.Id}`,
  };
}
