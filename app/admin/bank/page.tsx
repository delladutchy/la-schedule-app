"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link";

interface BankAccount {
  id: string;
  account_name: string;
  official_name: string | null;
  mask: string | null;
  account_type: string | null;
  account_subtype: string | null;
  enabled: boolean;
}

interface BankConnection {
  id: string;
  provider: "plaid";
  institution_id: string | null;
  institution_name: string;
  connection_status: "pending" | "healthy" | "syncing" | "degraded" | "relogin_required" | "disconnected";
  consent_expiration_time: string | null;
  last_successful_sync_at: string | null;
  last_webhook_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  connected_at: string;
  disconnected_at: string | null;
  accounts: BankAccount[];
}

interface ConnectionStatus {
  provider: "plaid";
  environment: "sandbox" | "production";
  configured: boolean;
  missingConfig: string[];
  connections: BankConnection[];
}

const LINK_TOKEN_KEY = "la_plaid_link_token";
const LINK_CONNECTION_KEY = "la_plaid_connection_id";

function fmtDate(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function healthLabel(connection: BankConnection): string {
  switch (connection.connection_status) {
    case "healthy": return "Connected";
    case "syncing": return "Syncing";
    case "relogin_required": return "Reconnect required";
    case "degraded": return "Needs attention";
    case "disconnected": return "Disconnected";
    default: return "Connecting";
  }
}

export default function BankConnectionPage() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [linkConnectionId, setLinkConnectionId] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/bank-connections", { credentials: "same-origin" });
      if (response.status === 401 || response.status === 403) throw new Error("Not authorized. Log in as Jeff first.");
      if (!response.ok) throw new Error("Could not load bank connection status.");
      setStatus(await response.json() as ConnectionStatus);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load bank connection status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  useEffect(() => {
    if (!window.location.search.includes("oauth_state_id")) return;
    const storedToken = window.sessionStorage.getItem(LINK_TOKEN_KEY);
    const storedConnectionId = window.sessionStorage.getItem(LINK_CONNECTION_KEY);
    if (storedToken) {
      setLinkToken(storedToken);
      setLinkConnectionId(storedConnectionId || null);
    }
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(async (publicToken) => {
    setError(null);
    try {
      const response = linkConnectionId
        ? await fetch(`/api/bank-connections/${linkConnectionId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ action: "reconnect_complete" }),
          })
        : await fetch("/api/bank-connections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ public_token: publicToken }),
          });
      const data = await response.json() as { detail?: string; error?: string };
      if (!response.ok) throw new Error(data.detail ?? data.error ?? "Could not save bank connection.");
      window.sessionStorage.removeItem(LINK_TOKEN_KEY);
      window.sessionStorage.removeItem(LINK_CONNECTION_KEY);
      setLinkToken(null);
      setLinkConnectionId(null);
      window.history.replaceState({}, "", "/admin/bank");
      await loadStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save bank connection.");
    }
  }, [linkConnectionId, loadStatus]);

  const plaidConfig = useMemo(() => ({
    token: linkToken,
    onSuccess,
    onExit: () => {
      if (!window.location.search.includes("oauth_state_id")) {
        window.sessionStorage.removeItem(LINK_TOKEN_KEY);
        window.sessionStorage.removeItem(LINK_CONNECTION_KEY);
        setLinkToken(null);
        setLinkConnectionId(null);
      }
    },
    receivedRedirectUri: typeof window !== "undefined" && window.location.search.includes("oauth_state_id")
      ? window.location.href
      : undefined,
  }), [linkToken, onSuccess]);
  const { open, ready } = usePlaidLink(plaidConfig);

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, open, ready]);

  async function beginLink(connectionId?: string) {
    setError(null);
    setBusyId(connectionId ?? "new");
    try {
      const response = await fetch("/api/bank-connections/link-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(connectionId ? { connection_id: connectionId } : {}),
      });
      const data = await response.json() as { link_token?: string; detail?: string; error?: string };
      if (!response.ok || !data.link_token) throw new Error(data.detail ?? data.error ?? "Could not start Plaid Link.");
      window.sessionStorage.setItem(LINK_TOKEN_KEY, data.link_token);
      if (connectionId) window.sessionStorage.setItem(LINK_CONNECTION_KEY, connectionId);
      else window.sessionStorage.removeItem(LINK_CONNECTION_KEY);
      setLinkConnectionId(connectionId ?? null);
      setLinkToken(data.link_token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start Plaid Link.");
    } finally {
      setBusyId(null);
    }
  }

  async function runAction(connectionId: string, action: "sync" | "disconnect") {
    if (action === "disconnect" && !window.confirm("Disconnect this bank account? Plaid access will be revoked. Existing payment provenance remains in the ledger.")) return;
    setBusyId(connectionId);
    setError(null);
    try {
      const response = await fetch(`/api/bank-connections/${connectionId}`, {
        method: action === "disconnect" ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: action === "sync" ? JSON.stringify({ action: "sync" }) : undefined,
      });
      const data = await response.json() as { detail?: string; error?: string };
      if (!response.ok) throw new Error(data.detail ?? data.error ?? `Could not ${action} connection.`);
      await loadStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${action} connection.`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="admin bank-admin">
      <div className="bank-admin-heading">
        <div>
          <h1>Bank Connection</h1>
          <p>Posted deposits flow through the existing safe reconciliation rules. Plaid Link handles bank authorization; this app never receives your Wells Fargo password.</p>
        </div>
        <a href="/admin/payments">Payment ledger</a>
      </div>

      {loading && <p className="bank-muted">Loading connection status…</p>}
      {error && <div className="qb-banner qb-banner--error" role="alert">{error}</div>}

      {status && !status.configured && (
        <section className="qb-section">
          <h2>Plaid configuration required</h2>
          <p className="bank-muted">Add these server-only environment values before connecting:</p>
          <code>{status.missingConfig.join(", ")}</code>
        </section>
      )}

      {status?.configured && (
        <div className="bank-toolbar">
          <button className="qb-btn qb-btn--primary" disabled={busyId !== null} onClick={() => void beginLink()}>
            {busyId === "new" ? "Opening Plaid…" : "Connect bank account"}
          </button>
          <span className="bank-muted">Plaid {status.environment}</span>
        </div>
      )}

      {status?.connections.map((connection) => (
        <section className="qb-section bank-connection-card" key={connection.id}>
          <div className="bank-connection-title">
            <div>
              <h2>{connection.institution_name}</h2>
              <span className={`bank-health bank-health--${connection.connection_status}`}>{healthLabel(connection)}</span>
            </div>
            <span className="bank-provider">via Plaid</span>
          </div>
          <dl className="kv">
            <dt>Account</dt>
            <dd>
              {connection.accounts.filter((account) => account.enabled).map((account) => (
                <div key={account.id}>
                  {account.official_name ?? account.account_name}{account.mask ? ` ••••${account.mask}` : ""}
                  {account.account_subtype ? ` (${account.account_subtype})` : ""}
                </div>
              ))}
              {connection.accounts.filter((account) => account.enabled).length === 0 ? "—" : null}
            </dd>
            <dt>Last successful sync</dt>
            <dd>{fmtDate(connection.last_successful_sync_at)}</dd>
            <dt>Last webhook</dt>
            <dd>{fmtDate(connection.last_webhook_at)}</dd>
            <dt>Consent expires</dt>
            <dd>{connection.consent_expiration_time ? fmtDate(connection.consent_expiration_time) : "No date reported"}</dd>
            {connection.last_error_code && <><dt>Connection issue</dt><dd>{connection.last_error_code}</dd></>}
          </dl>
          {connection.connection_status !== "disconnected" && (
            <div className="bank-actions">
              <button className="qb-btn qb-btn--secondary" disabled={busyId !== null} onClick={() => void runAction(connection.id, "sync")}>Sync now</button>
              <button className="qb-btn qb-btn--secondary" disabled={busyId !== null} onClick={() => void beginLink(connection.id)}>Reconnect</button>
              <button className="qb-btn bank-disconnect" disabled={busyId !== null} onClick={() => void runAction(connection.id, "disconnect")}>Disconnect</button>
            </div>
          )}
        </section>
      ))}

      {status && status.connections.length === 0 && status.configured && (
        <section className="qb-section"><p className="bank-muted">No bank account is connected yet.</p></section>
      )}

      <section className="qb-section">
        <h2>CSV fallback</h2>
        <p className="bank-muted">The existing Wells Fargo CSV importer remains available if provider sync is unavailable. Its duplicate protection and reconciliation rules are unchanged.</p>
      </section>
    </main>
  );
}
