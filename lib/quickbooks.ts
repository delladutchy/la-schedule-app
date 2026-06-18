/**
 * QuickBooks Online API service — server-only.
 *
 * Credential resolution order:
 *   1. QUICKBOOKS_REALM_ID / QUICKBOOKS_REFRESH_TOKEN env vars (manual override)
 *   2. Supabase quickbooks_connection table (populated by OAuth flow)
 *
 * Bootstrap flow (one-time, after OAuth connect):
 *   POST /api/quickbooks/bootstrap
 *     → finds or creates all required QBO service items by name
 *     → looks up the customer by QUICKBOOKS_CUSTOMER_NAME
 *     → caches resolved IDs in Supabase `quickbooks_setup` table
 *
 * OAuth reference:
 *   https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
 * Invoice API reference:
 *   https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice
 */

import "server-only";
import type { EnvConfig } from "./config";
import type { InvoicePacket } from "./invoice-types";
import {
  buildQBInvoiceLines,
  QB_LINE_NAMES,
  QB_REQUIRED_ITEM_KEYS,
  type QBAccountQueryResponse,
  type QBCreateInvoiceResponse,
  type QBCustomerQueryResponse,
  type QBInvoiceBody,
  type QBItemConfig,
  type QBItemCreateResponse,
  type QBItemQueryResponse,
  type QBSetupCache,
  type QBTokenResponse,
} from "./quickbooks-types";
import { getQBConnection, saveQBConnection } from "./quickbooks-connection";
import { getSupabaseServerClient } from "./supabase";

const QB_BASE_URL = "https://quickbooks.api.intuit.com/v3/company";
const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QB_AUTH_URL  = "https://appcenter.intuit.com/connect/oauth2";
const QB_API_VERSION = "65";

/** Scopes required to create invoices. Space-separated. */
export const QB_SCOPES = "com.intuit.quickbooks.accounting";

export type { QBSetupCache };

export interface QBDraftResult {
  invoiceId: string;
  docNumber: string;
  totalAmount: number;
  link: string;
}

export interface QBItemBootstrapStatus {
  name: string;
  found: boolean;
  created: boolean;
  id: string | null;
  error?: string;
}

export interface QBBootstrapResult {
  ok: boolean;
  customer: { found: boolean; id: string | null; name: string };
  items: Record<string, QBItemBootstrapStatus>;
  incomeAccount: { found: boolean; id: string | null; name: string | null };
  cached: boolean;
  errors: string[];
}

// ── OAuth helpers ─────────────────────────────────────────────────────────────

function qbBasicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

/**
 * Exchange an OAuth authorization code for access + refresh tokens.
 * Called once from the /api/quickbooks/callback route.
 */
export async function exchangeQBAuthCode(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}> {
  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${qbBasicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type:   "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QB code exchange failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as QBTokenResponse;
  const now = Date.now();
  return {
    accessToken:           data.access_token,
    refreshToken:          data.refresh_token,
    accessTokenExpiresAt:  new Date(now + data.expires_in * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(now + data.x_refresh_token_expires_in * 1000).toISOString(),
  };
}

/**
 * Build the Intuit authorization URL to redirect the user to.
 */
export function buildQBAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(QB_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QB_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Exchange a refresh token for a new access token. */
async function getQBAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; newRefreshToken: string }> {
  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${qbBasicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QB token refresh failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as QBTokenResponse;
  return { accessToken: data.access_token, newRefreshToken: data.refresh_token };
}

// ── Runtime credential resolver ───────────────────────────────────────────────

interface QBRuntimeCredentials {
  clientId: string;
  clientSecret: string;
  realmId: string;
  refreshToken: string;
  /** true when realm/refreshToken came from DB rather than env vars */
  fromDatabase: boolean;
}

/**
 * Resolve the full set of QB credentials needed to make API calls.
 *
 * client_id / client_secret must be in env vars.
 * realm_id / refresh_token are read from env vars first; if absent, fall back
 * to the Supabase quickbooks_connection row (populated by the OAuth flow).
 */
async function resolveQBRuntimeCredentials(
  env: Pick<EnvConfig,
    | "QUICKBOOKS_CLIENT_ID"
    | "QUICKBOOKS_CLIENT_SECRET"
    | "QUICKBOOKS_REALM_ID"
    | "QUICKBOOKS_REFRESH_TOKEN"
  >,
): Promise<QBRuntimeCredentials> {
  if (!env.QUICKBOOKS_CLIENT_ID) throw new Error("Missing QUICKBOOKS_CLIENT_ID");
  if (!env.QUICKBOOKS_CLIENT_SECRET) throw new Error("Missing QUICKBOOKS_CLIENT_SECRET");

  // Prefer env vars (manual override)
  if (env.QUICKBOOKS_REALM_ID && env.QUICKBOOKS_REFRESH_TOKEN) {
    return {
      clientId:      env.QUICKBOOKS_CLIENT_ID,
      clientSecret:  env.QUICKBOOKS_CLIENT_SECRET,
      realmId:       env.QUICKBOOKS_REALM_ID,
      refreshToken:  env.QUICKBOOKS_REFRESH_TOKEN,
      fromDatabase:  false,
    };
  }

  // Fall back to Supabase connection
  const conn = await getQBConnection();
  if (!conn) {
    throw new Error(
      "QuickBooks is not connected. " +
      "Visit /admin/quickbooks and click 'Connect to QuickBooks' to complete OAuth setup.",
    );
  }

  return {
    clientId:      env.QUICKBOOKS_CLIENT_ID,
    clientSecret:  env.QUICKBOOKS_CLIENT_SECRET,
    realmId:       conn.realmId,
    refreshToken:  conn.refreshToken,
    fromDatabase:  true,
  };
}

// ── Setup cache (Supabase quickbooks_setup table) ─────────────────────────────

export async function readQBSetupCache(realmId: string): Promise<QBSetupCache | null> {
  try {
    const client = getSupabaseServerClient();
    const { data } = await client
      .from("quickbooks_setup")
      .select("*")
      .eq("realm_id", realmId)
      .maybeSingle();
    if (!data) return null;
    return {
      realmId:          String(data.realm_id),
      customerId:       String(data.customer_id),
      customerName:     String(data.customer_name),
      itemIds:          (data.item_ids ?? {}) as Record<string, string>,
      incomeAccountRef: (data.income_account_ref ?? {}) as { value: string; name: string },
      bootstrappedAt:   String(data.bootstrapped_at),
    };
  } catch {
    return null; // table not yet migrated, or connection error
  }
}

async function saveQBSetupCache(setup: QBSetupCache): Promise<void> {
  const client = getSupabaseServerClient();
  const { error } = await client
    .from("quickbooks_setup")
    .upsert(
      {
        realm_id:           setup.realmId,
        customer_id:        setup.customerId,
        customer_name:      setup.customerName,
        item_ids:           setup.itemIds,
        income_account_ref: setup.incomeAccountRef,
        bootstrapped_at:    setup.bootstrappedAt,
        bootstrap_error:    null,
      },
      { onConflict: "realm_id" },
    );
  if (error) throw new Error(`[quickbooks] setup cache save failed: ${error.message}`);
}

export async function getQBSetup(realmId: string): Promise<QBSetupCache> {
  const cache = await readQBSetupCache(realmId);
  if (!cache) {
    throw new Error(
      "QuickBooks setup not complete. POST to /api/quickbooks/bootstrap to initialize items and customer.",
    );
  }
  return cache;
}

// ── QBO CDN query helper ──────────────────────────────────────────────────────

async function qbQuery<T>(
  accessToken: string,
  realmId: string,
  sql: string,
): Promise<T> {
  const url = new URL(`${QB_BASE_URL}/${realmId}/query`);
  url.searchParams.set("query", sql);
  url.searchParams.set("minorversion", QB_API_VERSION);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QB query failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<T>;
}

// ── QBO entity lookups ────────────────────────────────────────────────────────

async function queryQBActiveItems(accessToken: string, realmId: string) {
  const data = await qbQuery<QBItemQueryResponse>(
    accessToken,
    realmId,
    "SELECT * FROM Item WHERE Type='Service' AND Active=true MAXRESULTS 100",
  );
  return data.QueryResponse.Item ?? [];
}

async function queryQBIncomeAccount(
  accessToken: string,
  realmId: string,
): Promise<{ value: string; name: string } | null> {
  const data = await qbQuery<QBAccountQueryResponse>(
    accessToken,
    realmId,
    "SELECT * FROM Account WHERE AccountType='Income' AND Active=true MAXRESULTS 20",
  );
  const accounts = data.QueryResponse.Account ?? [];
  const preferred = accounts.find((a) => /service/i.test(a.Name)) ?? accounts[0];
  if (!preferred) return null;
  return { value: preferred.Id, name: preferred.Name };
}

async function queryQBCustomer(
  accessToken: string,
  realmId: string,
  customerName: string,
): Promise<{ id: string; name: string } | null> {
  const safe = customerName.replace(/'/g, "\\'");
  const data = await qbQuery<QBCustomerQueryResponse>(
    accessToken,
    realmId,
    `SELECT * FROM Customer WHERE DisplayName='${safe}' AND Active=true MAXRESULTS 5`,
  );
  const c = (data.QueryResponse.Customer ?? [])[0];
  return c ? { id: c.Id, name: c.DisplayName } : null;
}

async function createQBItem(
  accessToken: string,
  realmId: string,
  name: string,
  incomeAccountRef: { value: string; name: string },
): Promise<{ id: string }> {
  const url = `${QB_BASE_URL}/${realmId}/item?minorversion=${QB_API_VERSION}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      Item: {
        Name: name,
        Type: "Service",
        IncomeAccountRef: { value: incomeAccountRef.value },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QB create item "${name}" failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as QBItemCreateResponse;
  return { id: data.Item.Id };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export async function runQBBootstrap(
  env: Pick<EnvConfig,
    | "QUICKBOOKS_CLIENT_ID"
    | "QUICKBOOKS_CLIENT_SECRET"
    | "QUICKBOOKS_REALM_ID"
    | "QUICKBOOKS_REFRESH_TOKEN"
    | "QUICKBOOKS_CUSTOMER_NAME"
  >,
): Promise<QBBootstrapResult> {
  const errors: string[] = [];
  const customerName = env.QUICKBOOKS_CUSTOMER_NAME ?? "Light Action";

  // Resolve credentials (env → DB)
  let creds: QBRuntimeCredentials;
  try {
    creds = await resolveQBRuntimeCredentials(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const emptyItems = Object.fromEntries(
      QB_REQUIRED_ITEM_KEYS.map((k) => [k, { name: QB_LINE_NAMES[k], found: false, created: false, id: null }]),
    );
    return {
      ok: false,
      customer: { found: false, id: null, name: customerName },
      items: emptyItems,
      incomeAccount: { found: false, id: null, name: null },
      cached: false,
      errors: [msg],
    };
  }

  const { accessToken, newRefreshToken } = await getQBAccessToken(
    creds.clientId,
    creds.clientSecret,
    creds.refreshToken,
  );

  // Persist refreshed token back to DB so it doesn't expire
  if (creds.fromDatabase) {
    const conn = await getQBConnection();
    if (conn) {
      await saveQBConnection({ ...conn, refreshToken: newRefreshToken }).catch(() => undefined);
    }
  }

  const realmId = creds.realmId;

  // Income account (needed if any items must be created)
  let incomeAccountRef: { value: string; name: string } | null = null;
  try {
    incomeAccountRef = await queryQBIncomeAccount(accessToken, realmId);
    if (!incomeAccountRef) {
      errors.push(
        "No Income account found in QBO Chart of Accounts. " +
        "Add at least one Income account before bootstrapping.",
      );
    }
  } catch (err) {
    errors.push(`Income account lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fetch all existing active Service items
  const existingItems = await queryQBActiveItems(accessToken, realmId).catch((err) => {
    errors.push(`Item query failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });

  const existingByName = new Map(existingItems.map((i) => [i.Name.toLowerCase(), i]));

  // Find or create each required item
  const itemResults: QBBootstrapResult["items"] = {};
  const resolvedIds: Record<string, string> = {};

  for (const key of QB_REQUIRED_ITEM_KEYS) {
    const requiredName = QB_LINE_NAMES[key];
    const existing = existingByName.get(requiredName.toLowerCase());

    if (existing) {
      itemResults[key] = { name: requiredName, found: true, created: false, id: existing.Id };
      resolvedIds[key] = existing.Id;
    } else if (!incomeAccountRef) {
      itemResults[key] = {
        name: requiredName, found: false, created: false, id: null,
        error: "Cannot create — no income account available",
      };
    } else {
      try {
        const created = await createQBItem(accessToken, realmId, requiredName, incomeAccountRef);
        itemResults[key] = { name: requiredName, found: false, created: true, id: created.id };
        resolvedIds[key] = created.id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        itemResults[key] = { name: requiredName, found: false, created: false, id: null, error: msg };
        errors.push(`Item "${requiredName}": ${msg}`);
      }
    }
  }

  // Look up customer (never auto-create)
  let customer: { id: string; name: string } | null = null;
  try {
    customer = await queryQBCustomer(accessToken, realmId, customerName);
  } catch (err) {
    errors.push(`Customer lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!customer) {
    errors.push(
      `Customer "${customerName}" not found in QuickBooks. ` +
      `Please create this customer in QBO → Customers → New Customer.`,
    );
  }

  // Cache if fully resolved
  const allItemsResolved = QB_REQUIRED_ITEM_KEYS.every((k) => k in resolvedIds);
  let cached = false;

  if (allItemsResolved && customer && incomeAccountRef) {
    try {
      await saveQBSetupCache({
        realmId,
        customerId: customer.id,
        customerName,
        itemIds: resolvedIds,
        incomeAccountRef,
        bootstrappedAt: new Date().toISOString(),
      });
      cached = true;
    } catch (err) {
      errors.push(`Cache save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ok: errors.length === 0,
    customer: { found: !!customer, id: customer?.id ?? null, name: customerName },
    items: itemResults,
    incomeAccount: {
      found:  !!incomeAccountRef,
      id:     incomeAccountRef?.value ?? null,
      name:   incomeAccountRef?.name ?? null,
    },
    cached,
    errors,
  };
}

// ── Connection test ───────────────────────────────────────────────────────────

export async function checkQBConnection(
  env: Pick<EnvConfig,
    | "QUICKBOOKS_CLIENT_ID"
    | "QUICKBOOKS_CLIENT_SECRET"
    | "QUICKBOOKS_REALM_ID"
    | "QUICKBOOKS_REFRESH_TOKEN"
  >,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const creds = await resolveQBRuntimeCredentials(env);
    await getQBAccessToken(creds.clientId, creds.clientSecret, creds.refreshToken);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Draft invoice creation ────────────────────────────────────────────────────

export async function createQBDraftInvoice(
  packet: InvoicePacket,
  gigSummary: string,
  env: Pick<EnvConfig,
    | "QUICKBOOKS_ENABLED"
    | "QUICKBOOKS_CLIENT_ID"
    | "QUICKBOOKS_CLIENT_SECRET"
    | "QUICKBOOKS_REALM_ID"
    | "QUICKBOOKS_REFRESH_TOKEN"
  >,
): Promise<QBDraftResult> {
  if (!env.QUICKBOOKS_ENABLED) {
    throw new Error("QuickBooks is not enabled (QUICKBOOKS_ENABLED=false)");
  }

  const creds = await resolveQBRuntimeCredentials(env);
  const { accessToken, newRefreshToken } = await getQBAccessToken(
    creds.clientId,
    creds.clientSecret,
    creds.refreshToken,
  );

  // Persist refreshed token back to DB
  if (creds.fromDatabase) {
    const conn = await getQBConnection();
    if (conn) {
      await saveQBConnection({ ...conn, refreshToken: newRefreshToken }).catch(() => undefined);
    }
  }

  const setup = await getQBSetup(creds.realmId);

  const itemConfig: QBItemConfig = {
    dayRate:       setup.itemIds["dayRate"] ?? null,
    overtime:      setup.itemIds["overtime"] ?? null,
    perDiem:       setup.itemIds["perDiem"] ?? null,
    mileage:       setup.itemIds["mileage"] ?? null,
    mileageAdj:    setup.itemIds["mileageAdj"] ?? null,
    bagFees:       setup.itemIds["bagFees"] ?? null,
    hotel:         setup.itemIds["hotel"] ?? null,
    parking:       setup.itemIds["parking"] ?? null,
    tolls:         setup.itemIds["tolls"] ?? null,
    uber:          setup.itemIds["uber"] ?? null,
    otherExpenses: setup.itemIds["otherExpenses"] ?? null,
  };

  const lines = buildQBInvoiceLines(packet, itemConfig);
  if (lines.length === 0) {
    throw new Error(
      "No QB invoice lines could be built — re-run bootstrap to ensure all items are resolved.",
    );
  }

  const body: QBInvoiceBody = {
    Line: lines,
    CustomerRef: { value: setup.customerId, name: setup.customerName },
    DocNumber: packet.laNumber ?? undefined,
    PrivateNote: gigSummary || undefined,
  };

  const url = `${QB_BASE_URL}/${creds.realmId}/invoice?minorversion=${QB_API_VERSION}`;
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
    invoiceId:   inv.Id,
    docNumber:   inv.DocNumber,
    totalAmount: inv.TotalAmt,
    link:        `https://app.qbo.intuit.com/app/invoice?txnId=${inv.Id}`,
  };
}
