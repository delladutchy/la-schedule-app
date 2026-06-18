/**
 * QuickBooks Online API service — server-only.
 *
 * Bootstrap flow (one-time):
 *   POST /api/quickbooks/bootstrap
 *     → finds or creates all required QBO service items by name
 *     → looks up the customer by QUICKBOOKS_CUSTOMER_NAME
 *     → caches resolved IDs in Supabase `quickbooks_setup` table
 *
 * After bootstrap, creating invoices requires no additional env vars:
 *   POST /api/quickbooks/draft/:eventId
 *     → loads cached IDs from Supabase
 *     → builds line items from InvoicePacket
 *     → POSTs draft invoice to QBO (not sent to client)
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
  findMissingItemNames,
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
import { getSupabaseServerClient } from "./supabase";

const QB_BASE_URL = "https://quickbooks.api.intuit.com/v3/company";
const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QB_API_VERSION = "65";

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

// ── OAuth token refresh ───────────────────────────────────────────────────────

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
  return { accessToken: data.access_token, newRefreshToken: data.refresh_token };
}

// ── Setup cache (Supabase quickbooks_setup table) ─────────────────────────────

/**
 * Load the bootstrapped QB setup from Supabase. Returns null if not yet
 * bootstrapped or if the table doesn't exist (migration not yet applied).
 */
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
      realmId: String(data.realm_id),
      customerId: String(data.customer_id),
      customerName: String(data.customer_name),
      itemIds: (data.item_ids ?? {}) as Record<string, string>,
      incomeAccountRef: (data.income_account_ref ?? {}) as { value: string; name: string },
      bootstrappedAt: String(data.bootstrapped_at),
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

/**
 * Get the bootstrapped setup — throws with a clear message if not yet run.
 * Called by createQBDraftInvoice before creating any invoices.
 */
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
  // Prefer an account whose name contains "Service"; otherwise take the first income account
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

/**
 * One-time setup: find or create all required QBO service items, look up
 * the customer, then cache the resolved IDs in Supabase.
 *
 * Safe to re-run — existing items are found by name, not re-created.
 * Customer is NEVER auto-created — must already exist in QBO.
 */
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

  const missingCreds = [
    !env.QUICKBOOKS_CLIENT_ID && "QUICKBOOKS_CLIENT_ID",
    !env.QUICKBOOKS_CLIENT_SECRET && "QUICKBOOKS_CLIENT_SECRET",
    !env.QUICKBOOKS_REALM_ID && "QUICKBOOKS_REALM_ID",
    !env.QUICKBOOKS_REFRESH_TOKEN && "QUICKBOOKS_REFRESH_TOKEN",
  ].filter(Boolean) as string[];

  if (missingCreds.length > 0) {
    const emptyItems = Object.fromEntries(
      QB_REQUIRED_ITEM_KEYS.map((k) => [k, { name: QB_LINE_NAMES[k], found: false, created: false, id: null }]),
    );
    return {
      ok: false,
      customer: { found: false, id: null, name: customerName },
      items: emptyItems,
      incomeAccount: { found: false, id: null, name: null },
      cached: false,
      errors: [`Missing required env vars: ${missingCreds.join(", ")}`],
    };
  }

  const realmId = env.QUICKBOOKS_REALM_ID!;

  // 1. OAuth token
  const { accessToken } = await getQBAccessToken(
    env.QUICKBOOKS_CLIENT_ID!,
    env.QUICKBOOKS_CLIENT_SECRET!,
    env.QUICKBOOKS_REFRESH_TOKEN!,
  );

  // 2. Income account (needed if any items must be created)
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

  // 3. Fetch all existing active Service items
  const existingItems = await queryQBActiveItems(accessToken, realmId).catch((err) => {
    errors.push(`Item query failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });

  const existingByName = new Map(existingItems.map((i) => [i.Name.toLowerCase(), i]));

  // 4. Find or create each required item
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

  // 5. Look up customer (never auto-create)
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

  // 6. Cache if fully resolved
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
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Cache save failed: ${msg}`);
    }
  }

  return {
    ok: errors.length === 0,
    customer: { found: !!customer, id: customer?.id ?? null, name: customerName },
    items: itemResults,
    incomeAccount: {
      found: !!incomeAccountRef,
      id: incomeAccountRef?.value ?? null,
      name: incomeAccountRef?.name ?? null,
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
 * Requires a successful bootstrap (POST /api/quickbooks/bootstrap) first.
 * Does NOT send the invoice or notify the client.
 * Caller is responsible for persisting the QB invoice ID via markQBDraftCreated().
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

  // Load bootstrapped IDs — throws if bootstrap hasn't been run
  const setup = await getQBSetup(env.QUICKBOOKS_REALM_ID);

  const { accessToken } = await getQBAccessToken(
    env.QUICKBOOKS_CLIENT_ID,
    env.QUICKBOOKS_CLIENT_SECRET,
    env.QUICKBOOKS_REFRESH_TOKEN,
  );

  // Convert cached itemIds (all strings) to QBItemConfig (string | null)
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

  const url = `${QB_BASE_URL}/${env.QUICKBOOKS_REALM_ID}/invoice?minorversion=${QB_API_VERSION}`;
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
