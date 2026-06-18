/**
 * QuickBooks OAuth connection storage — server-only.
 *
 * Stores the realm ID and refresh token in Supabase so they don't need to
 * be copied into env vars. One connection row per app (id = 1 singleton).
 *
 * Tables (from scripts/qb-migration.sql):
 *   quickbooks_connection — stores live credentials
 *   quickbooks_oauth_state — short-lived CSRF state tokens
 */

import "server-only";
import { randomBytes } from "node:crypto";
import { getSupabaseServerClient } from "./supabase";

export interface QBConnection {
  realmId: string;
  refreshToken: string;
  refreshTokenExpiresAt: string | null;  // ISO timestamp
  connectedAt: string;                   // ISO timestamp
  connectedBy: string | null;            // editor ID (audit trail)
}

const CONNECTION_ID = 1; // singleton row
const STATE_TTL_MINUTES = 10;

// ── Connection CRUD ───────────────────────────────────────────────────────────

export async function getQBConnection(): Promise<QBConnection | null> {
  try {
    const client = getSupabaseServerClient();
    const { data } = await client
      .from("quickbooks_connection")
      .select("realm_id, refresh_token, refresh_token_expires_at, connected_at, connected_by")
      .eq("id", CONNECTION_ID)
      .maybeSingle();
    if (!data) return null;
    return {
      realmId:                 String(data.realm_id),
      refreshToken:            String(data.refresh_token),
      refreshTokenExpiresAt:   data.refresh_token_expires_at ? String(data.refresh_token_expires_at) : null,
      connectedAt:             String(data.connected_at),
      connectedBy:             data.connected_by ? String(data.connected_by) : null,
    };
  } catch {
    return null; // table not yet migrated or connection error
  }
}

export async function saveQBConnection(conn: QBConnection): Promise<void> {
  const client = getSupabaseServerClient();
  const { error } = await client
    .from("quickbooks_connection")
    .upsert(
      {
        id:                       CONNECTION_ID,
        realm_id:                 conn.realmId,
        refresh_token:            conn.refreshToken,
        refresh_token_expires_at: conn.refreshTokenExpiresAt ?? null,
        connected_at:             conn.connectedAt,
        connected_by:             conn.connectedBy ?? null,
      },
      { onConflict: "id" },
    );
  if (error) throw new Error(`[qb-connection] save failed: ${error.message}`);
}

export async function clearQBConnection(): Promise<void> {
  const client = getSupabaseServerClient();
  await client.from("quickbooks_connection").delete().eq("id", CONNECTION_ID);
}

// ── OAuth CSRF state ──────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random state string and store it in Supabase
 * with a 10-minute expiry. Returns the state value to embed in the auth URL.
 */
export async function createOAuthState(editorId: string): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60 * 1000).toISOString();

  const client = getSupabaseServerClient();
  const { error } = await client
    .from("quickbooks_oauth_state")
    .insert({ state, editor_id: editorId, expires_at: expiresAt });

  if (error) throw new Error(`[qb-connection] state insert failed: ${error.message}`);
  return state;
}

/**
 * Verify a returned state value. Deletes the row (one-time use) and returns
 * the editor ID that started the flow, or null if state is invalid/expired.
 */
export async function verifyAndConsumeOAuthState(state: string): Promise<string | null> {
  if (!state) return null;
  const client = getSupabaseServerClient();

  // Fetch the state row
  const { data } = await client
    .from("quickbooks_oauth_state")
    .select("editor_id, expires_at")
    .eq("state", state)
    .maybeSingle();

  if (!data) return null;

  // Delete immediately (one-time use) regardless of expiry
  await client.from("quickbooks_oauth_state").delete().eq("state", state);

  // Check expiry
  if (new Date(String(data.expires_at)) < new Date()) return null;

  return String(data.editor_id);
}

/**
 * Clean up expired state rows older than 1 hour. Call opportunistically —
 * safe to call on every request, just a best-effort maintenance query.
 */
export async function pruneExpiredOAuthStates(): Promise<void> {
  try {
    const client = getSupabaseServerClient();
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await client.from("quickbooks_oauth_state").delete().lt("expires_at", cutoff);
  } catch {
    // non-critical
  }
}
