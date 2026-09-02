import "server-only";
import { randomUUID } from "node:crypto";
import { CountryCode, type AccountBase, type Transaction } from "plaid";
import { getConfig } from "./config";
import { getSupabaseServerClient } from "./supabase";
import { decryptBankAccessToken, encryptBankAccessToken } from "./bank-token-crypto";
import { importBankTransactions, reconcileBankTransaction } from "./bank-transactions";
import type { BankTransactionImport } from "./bank-reconciliation";
import { normalizePlaidPostedTransaction } from "./plaid-normalization";
import {
  createPlaidClient,
  getPlaidError,
  requirePlaidRuntimeConfig,
  type PlaidRuntimeConfig,
} from "./plaid-client";

export interface BankProviderConnection {
  id: string;
  provider: "plaid";
  provider_item_id: string;
  access_token_encrypted: string | null;
  institution_id: string | null;
  institution_name: string;
  connection_status: "pending" | "healthy" | "syncing" | "degraded" | "relogin_required" | "disconnected";
  sync_cursor: string | null;
  consent_expiration_time: string | null;
  last_successful_sync_at: string | null;
  last_webhook_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  connected_at: string;
  disconnected_at: string | null;
}

export interface BankProviderAccount {
  id: string;
  connection_id: string;
  provider_account_id: string;
  account_name: string;
  official_name: string | null;
  mask: string | null;
  account_type: string | null;
  account_subtype: string | null;
  enabled: boolean;
}

export type PublicBankProviderAccount = Omit<BankProviderAccount, "provider_account_id" | "persistent_account_id">;

export interface PublicBankConnection extends Omit<BankProviderConnection, "provider_item_id" | "access_token_encrypted" | "sync_cursor"> {
  accounts: PublicBankProviderAccount[];
}

function coerceConnection(row: Record<string, unknown>): BankProviderConnection {
  return row as unknown as BankProviderConnection;
}

export async function listPublicBankConnections(): Promise<PublicBankConnection[]> {
  const db = getSupabaseServerClient();
  const { data, error } = await db.from("bank_provider_connections")
    .select("id, provider, institution_id, institution_name, connection_status, consent_expiration_time, last_successful_sync_at, last_webhook_at, last_error_code, last_error_message, connected_at, disconnected_at, bank_provider_accounts(id, connection_id, account_name, official_name, mask, account_type, account_subtype, enabled)")
    .order("connected_at", { ascending: false });
  if (error) throw new Error(`[bank-provider] list connections failed: ${error.message}`);
  return (data ?? []).map((row) => {
    const raw = row as Record<string, unknown>;
    const accounts = Array.isArray(raw.bank_provider_accounts)
      ? raw.bank_provider_accounts as unknown as PublicBankProviderAccount[]
      : [];
    const { bank_provider_accounts: _accounts, ...connection } = raw;
    return { ...(connection as unknown as Omit<PublicBankConnection, "accounts">), accounts };
  });
}

export async function listSyncableBankConnectionIds(): Promise<string[]> {
  const db = getSupabaseServerClient();
  const { data, error } = await db.from("bank_provider_connections").select("id")
    .in("connection_status", ["pending", "healthy", "syncing", "degraded"])
    .not("access_token_encrypted", "is", null);
  if (error) throw new Error(`[bank-provider] list syncable connections failed: ${error.message}`);
  return (data ?? []).map((row) => String(row.id));
}

export async function getBankProviderConnection(id: string): Promise<BankProviderConnection | null> {
  const db = getSupabaseServerClient();
  const { data, error } = await db.from("bank_provider_connections").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`[bank-provider] load connection failed: ${error.message}`);
  return data ? coerceConnection(data as Record<string, unknown>) : null;
}

export async function getBankProviderConnectionByItemId(itemId: string): Promise<BankProviderConnection | null> {
  const db = getSupabaseServerClient();
  const { data, error } = await db.from("bank_provider_connections").select("*")
    .eq("provider", "plaid").eq("provider_item_id", itemId).maybeSingle();
  if (error) throw new Error(`[bank-provider] load Item connection failed: ${error.message}`);
  return data ? coerceConnection(data as Record<string, unknown>) : null;
}

export async function exchangeAndStorePlaidConnection(publicToken: string, connectedBy: string): Promise<BankProviderConnection> {
  const { env } = getConfig();
  const config = requirePlaidRuntimeConfig(env);
  const plaid = createPlaidClient(config);
  const exchange = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = exchange.data.access_token;
  const [itemResponse, accountsResponse] = await Promise.all([
    plaid.itemGet({ access_token: accessToken }),
    plaid.accountsGet({ access_token: accessToken }),
  ]);
  const item = itemResponse.data.item;
  let institutionName = "Unknown institution";
  if (item.institution_id) {
    const institution = await plaid.institutionsGetById({
      institution_id: item.institution_id,
      country_codes: [CountryCode.Us],
    });
    institutionName = institution.data.institution.name;
  }

  const db = getSupabaseServerClient();
  let connection: BankProviderConnection | null = null;
  try {
    const { data, error } = await db.from("bank_provider_connections").insert({
      provider: "plaid",
      provider_item_id: exchange.data.item_id,
      access_token_encrypted: encryptBankAccessToken(accessToken, config.encryptionKey),
      institution_id: item.institution_id ?? null,
      institution_name: institutionName,
      connection_status: "pending",
      consent_expiration_time: item.consent_expiration_time ?? null,
      connected_by: connectedBy,
    }).select("*").single();
    if (error) throw new Error(`[bank-provider] store connection failed: ${error.message}`);
    connection = coerceConnection(data as Record<string, unknown>);
    await storeAccounts(connection.id, accountsResponse.data.accounts);
  } catch (error) {
    await plaid.itemRemove({ access_token: accessToken }).catch(() => undefined);
    if (connection) await db.from("bank_provider_connections").delete().eq("id", connection.id);
    throw error;
  }
  // A provider may still be preparing its initial transaction history. Keep the
  // valid connection and let the webhook/recovery poll retry if this first sync fails.
  await syncPlaidConnection(connection.id, { createdBy: connectedBy }).catch(() => undefined);
  return (await getBankProviderConnection(connection.id)) ?? connection;
}

async function storeAccounts(connectionId: string, accounts: AccountBase[]): Promise<void> {
  if (accounts.length === 0) return;
  const db = getSupabaseServerClient();
  const { error } = await db.from("bank_provider_accounts").upsert(accounts.map((account) => ({
    connection_id: connectionId,
    provider_account_id: account.account_id,
    persistent_account_id: account.persistent_account_id ?? null,
    account_name: account.name,
    official_name: account.official_name ?? null,
    mask: account.mask ?? null,
    account_type: String(account.type),
    account_subtype: account.subtype != null ? String(account.subtype) : null,
    enabled: true,
  })), { onConflict: "connection_id,provider_account_id" });
  if (error) throw new Error(`[bank-provider] store accounts failed: ${error.message}`);
}

async function listEnabledAccounts(connectionId: string): Promise<Map<string, BankProviderAccount>> {
  const db = getSupabaseServerClient();
  const { data, error } = await db.from("bank_provider_accounts").select("*")
    .eq("connection_id", connectionId).eq("enabled", true);
  if (error) throw new Error(`[bank-provider] load accounts failed: ${error.message}`);
  return new Map((data ?? []).map((row) => {
    const account = row as unknown as BankProviderAccount;
    return [account.provider_account_id, account];
  }));
}

async function importOrRefreshPostedTransaction(transaction: BankTransactionImport, createdBy: string): Promise<void> {
  const db = getSupabaseServerClient();
  const { data, error } = await db.from("bank_transactions").select("*")
    .eq("source", transaction.source).eq("external_transaction_id", transaction.externalTransactionId).maybeSingle();
  if (error) throw new Error(`[bank-provider] check transaction failed: ${error.message}`);
  if (!data) {
    await importBankTransactions([transaction], { autoReconcile: true, createdBy });
    return;
  }

  const changed = String(data.posted_date) !== transaction.postedDate
    || Number(data.amount) !== transaction.amount
    || String(data.description) !== transaction.description;
  if (!changed) return;
  if (data.reconciliation_status === "applied") {
    await queueProviderReview(String(data.id), "provider_modified_applied_transaction", {
      postedDate: transaction.postedDate,
      amount: transaction.amount,
      description: transaction.description,
    });
    return;
  }

  const { error: updateError } = await db.from("bank_transactions").update({
    posted_date: transaction.postedDate,
    amount: transaction.amount,
    description: transaction.description,
    source_account: transaction.sourceAccount,
    raw_metadata: transaction.rawMetadata,
    reconciliation_status: "pending",
    reconciliation_details: { reason: "provider_modified_transaction" },
  }).eq("id", data.id);
  if (updateError) throw new Error(`[bank-provider] refresh transaction failed: ${updateError.message}`);
  await reconcileBankTransaction(String(data.id), createdBy);
}

async function queueProviderReview(transactionId: string, reason: string, details: Record<string, unknown>): Promise<void> {
  const db = getSupabaseServerClient();
  const { error } = await db.from("bank_reconciliation_reviews").upsert({
    bank_transaction_id: transactionId,
    reason,
    candidate_matches: [],
    review_status: "open",
    resolved_at: null,
    resolution_notes: JSON.stringify(details),
  }, { onConflict: "bank_transaction_id" });
  if (error) throw new Error(`[bank-provider] provider review write failed: ${error.message}`);
}

async function handleRemovedTransactions(transactionIds: string[]): Promise<void> {
  if (transactionIds.length === 0) return;
  const db = getSupabaseServerClient();
  const { data, error } = await db.from("bank_transactions").select("id, external_transaction_id, reconciliation_status")
    .eq("source", "plaid").in("external_transaction_id", transactionIds);
  if (error) throw new Error(`[bank-provider] load removed transactions failed: ${error.message}`);
  for (const row of data ?? []) {
    if (row.reconciliation_status === "applied") {
      await queueProviderReview(String(row.id), "provider_removed_applied_transaction", {
        externalTransactionId: row.external_transaction_id,
      });
    } else {
      const { error: updateError } = await db.from("bank_transactions").update({
        reconciliation_status: "ignored",
        reconciliation_details: { reason: "provider_removed_transaction" },
      }).eq("id", row.id);
      if (updateError) throw new Error(`[bank-provider] mark removed transaction failed: ${updateError.message}`);
      await db.from("bank_reconciliation_reviews").update({
        review_status: "dismissed",
        resolved_at: new Date().toISOString(),
        resolution_notes: "Provider removed this transaction before it was applied.",
      }).eq("bank_transaction_id", row.id).eq("review_status", "open");
    }
  }
}

export async function syncPlaidConnection(
  connectionId: string,
  options: { createdBy?: string } = {},
): Promise<{ acquired: boolean; imported: number; cursorAdvanced: boolean }> {
  const { env } = getConfig();
  const config = requirePlaidRuntimeConfig(env);
  const db = getSupabaseServerClient();
  const lockToken = randomUUID();
  const { data: claimed, error: claimError } = await db.rpc("claim_bank_provider_sync", {
    p_connection_id: connectionId,
    p_lock_token: lockToken,
    p_lease_seconds: 600,
  });
  if (claimError) throw new Error(`[bank-provider] claim sync failed: ${claimError.message}`);
  if (!claimed) return { acquired: false, imported: 0, cursorAdvanced: false };

  try {
    const connection = await getBankProviderConnection(connectionId);
    if (!connection?.access_token_encrypted) throw new Error("Bank connection is disconnected");
    const accessToken = decryptBankAccessToken(connection.access_token_encrypted, config.encryptionKey);
    const result = await fetchPlaidSync(config, accessToken, connection.sync_cursor);
    const accounts = await listEnabledAccounts(connection.id);
    let imported = 0;
    for (const plaidTransaction of [...result.added, ...result.modified]) {
      const account = accounts.get(plaidTransaction.account_id);
      if (!account) continue;
      const normalized = normalizePlaidPostedTransaction(plaidTransaction, {
        providerItemId: connection.provider_item_id,
        institutionId: connection.institution_id,
        institutionName: connection.institution_name,
        accountId: account.provider_account_id,
        accountName: account.account_name,
        accountMask: account.mask,
      });
      if (!normalized) continue;
      await importOrRefreshPostedTransaction(normalized, options.createdBy ?? "plaid-automatic-sync");
      imported += 1;
    }
    await handleRemovedTransactions(result.removed.map((entry) => entry.transaction_id));
    const { data: advanced, error: advanceError } = await db.rpc("advance_bank_provider_sync", {
      p_connection_id: connection.id,
      p_lock_token: lockToken,
      p_cursor: result.nextCursor,
    });
    if (advanceError || !advanced) throw new Error(`[bank-provider] advance cursor failed: ${advanceError?.message ?? "lease lost"}`);
    await finishSync(connection.id, lockToken, "healthy");
    return { acquired: true, imported, cursorAdvanced: true };
  } catch (error) {
    const plaidError = getPlaidError(error);
    const status = ["ITEM_LOGIN_REQUIRED", "ITEM_LOCKED", "USER_PERMISSION_REVOKED"].includes(plaidError.code)
      ? "relogin_required"
      : "degraded";
    await finishSync(connectionId, lockToken, status, plaidError.code, plaidError.message).catch(() => undefined);
    throw error;
  }
}

async function fetchPlaidSync(config: PlaidRuntimeConfig, accessToken: string, initialCursor: string | null) {
  const plaid = createPlaidClient(config);
  let cursor = initialCursor ?? undefined;
  const added: Transaction[] = [];
  const modified: Transaction[] = [];
  const removed: Array<{ transaction_id: string }> = [];
  do {
    const response = await plaid.transactionsSync({
      access_token: accessToken,
      cursor,
      count: 500,
      options: { include_original_description: true },
    });
    added.push(...response.data.added);
    modified.push(...response.data.modified);
    removed.push(...response.data.removed);
    cursor = response.data.next_cursor;
    if (!response.data.has_more) break;
  } while (true);
  return { added, modified, removed, nextCursor: cursor ?? initialCursor ?? "" };
}

async function finishSync(
  connectionId: string,
  lockToken: string,
  status: "healthy" | "degraded" | "relogin_required",
  errorCode: string | null = null,
  errorMessage: string | null = null,
): Promise<void> {
  const db = getSupabaseServerClient();
  const { error } = await db.rpc("finish_bank_provider_sync", {
    p_connection_id: connectionId,
    p_lock_token: lockToken,
    p_status: status,
    p_error_code: errorCode,
    p_error_message: errorMessage,
  });
  if (error) throw new Error(`[bank-provider] finish sync failed: ${error.message}`);
}

export async function markPlaidWebhook(itemId: string): Promise<BankProviderConnection | null> {
  const connection = await getBankProviderConnectionByItemId(itemId);
  if (!connection) return null;
  const db = getSupabaseServerClient();
  const { error } = await db.from("bank_provider_connections")
    .update({ last_webhook_at: new Date().toISOString() }).eq("id", connection.id);
  if (error) throw new Error(`[bank-provider] mark webhook failed: ${error.message}`);
  return connection;
}

export async function markPlaidConnectionHealth(
  connectionId: string,
  status: "healthy" | "degraded" | "relogin_required",
  code: string | null,
  message: string | null,
): Promise<void> {
  const db = getSupabaseServerClient();
  const { error } = await db.from("bank_provider_connections").update({
    connection_status: status,
    last_error_code: code,
    last_error_message: message?.slice(0, 500) ?? null,
  }).eq("id", connectionId).neq("connection_status", "disconnected");
  if (error) throw new Error(`[bank-provider] update health failed: ${error.message}`);
}

export async function completePlaidReconnect(connectionId: string, connectedBy: string): Promise<void> {
  const { env } = getConfig();
  const config = requirePlaidRuntimeConfig(env);
  const accessToken = await getDecryptedPlaidAccessToken(connectionId);
  const plaid = createPlaidClient(config);
  const [itemResponse, accountsResponse] = await Promise.all([
    plaid.itemGet({ access_token: accessToken }),
    plaid.accountsGet({ access_token: accessToken }),
  ]);
  const db = getSupabaseServerClient();
  const activeAccountIds = accountsResponse.data.accounts.map((account) => account.account_id);
  const { error: disableError } = await db.from("bank_provider_accounts").update({ enabled: false }).eq("connection_id", connectionId);
  if (disableError) throw new Error(`[bank-provider] refresh account authorization failed: ${disableError.message}`);
  await storeAccounts(connectionId, accountsResponse.data.accounts);
  const { error } = await db.from("bank_provider_connections").update({
    connection_status: "healthy",
    consent_expiration_time: itemResponse.data.item.consent_expiration_time ?? null,
    last_error_code: null,
    last_error_message: null,
    connected_by: connectedBy,
    disconnected_at: null,
  }).eq("id", connectionId);
  if (error) throw new Error(`[bank-provider] finish reconnect failed: ${error.message}`);
  if (activeAccountIds.length === 0) {
    await markPlaidConnectionHealth(connectionId, "degraded", "NO_ACTIVE_ACCOUNTS", "No accounts remain authorized.");
    return;
  }
  await syncPlaidConnection(connectionId, { createdBy: connectedBy });
}

export async function disconnectPlaidConnection(connectionId: string): Promise<void> {
  const { env } = getConfig();
  const config = requirePlaidRuntimeConfig(env);
  const connection = await getBankProviderConnection(connectionId);
  if (!connection || connection.connection_status === "disconnected") return;
  if (!connection.access_token_encrypted) throw new Error("Connection has no stored access token");
  const accessToken = decryptBankAccessToken(connection.access_token_encrypted, config.encryptionKey);
  await createPlaidClient(config).itemRemove({ access_token: accessToken });
  const db = getSupabaseServerClient();
  const { error } = await db.from("bank_provider_connections").update({
    access_token_encrypted: null,
    connection_status: "disconnected",
    sync_lock_token: null,
    sync_lock_until: null,
    last_error_code: null,
    last_error_message: null,
    disconnected_at: new Date().toISOString(),
  }).eq("id", connectionId);
  if (error) throw new Error(`[bank-provider] disconnect failed: ${error.message}`);
  await db.from("bank_provider_accounts").update({ enabled: false }).eq("connection_id", connectionId);
}

export async function getDecryptedPlaidAccessToken(connectionId: string): Promise<string> {
  const { env } = getConfig();
  const config = requirePlaidRuntimeConfig(env);
  const connection = await getBankProviderConnection(connectionId);
  if (!connection?.access_token_encrypted || connection.connection_status === "disconnected") {
    throw new Error("Bank connection is not active");
  }
  return decryptBankAccessToken(connection.access_token_encrypted, config.encryptionKey);
}
