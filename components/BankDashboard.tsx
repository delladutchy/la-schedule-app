"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link";
import { ensureEditorSession } from "@/lib/editor-session";

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
  last_recovery_poll_at: string | null;
  last_cursor_advanced_at: string | null;
  cursor_initialized: boolean;
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
  billing: {
    configuredPlan: string | null;
    connectedItemCount: number;
    connectedAccountCount: number;
    expectedMonthlyCost: number | null;
    expectedMonthlyCostLabel: string;
    rateStatement: string;
  };
}

interface ReviewAllocation { googleEventId: string; invoiceNumber: string | null; amount: number }
interface BankReview {
  id: string;
  bank_transaction_id: string;
  reason: string;
  candidate_matches: ReviewAllocation[][] | Record<string, unknown>[];
  created_at: string;
  bank_transactions: { posted_date: string; amount: number; description: string; source_account: string | null; reconciliation_status: string } | null;
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

export function BankDashboard() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [linkConnectionId, setLinkConnectionId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<BankReview[]>([]);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      // No sign-in step: refresh the existing editor session from the token this
      // device already stored, then request. If the cookie had lapsed, retry once
      // after the refresh rather than reporting an authorization failure.
      await ensureEditorSession();
      let response = await fetch("/api/bank-connections", { credentials: "same-origin" });
      if (response.status === 401 || response.status === 403) {
        await ensureEditorSession();
        response = await fetch("/api/bank-connections", { credentials: "same-origin" });
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          "This device isn't linked to LA Schedule yet. Open the LA Schedule home screen once, then reload this page.",
        );
      }
      if (!response.ok) throw new Error("Could not load bank connection status.");
      setStatus(await response.json() as ConnectionStatus);
      const reviewResponse = await fetch("/api/bank-reconciliation/reviews", { credentials: "same-origin" });
      if (reviewResponse.ok) setReviews((await reviewResponse.json() as { reviews: BankReview[] }).reviews);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load bank connection status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  // Capture the OAuth return URL once, before anything rewrites the address bar.
  // Reading window.location on every render made receivedRedirectUri flip to
  // undefined mid-flight once history.replaceState stripped oauth_state_id.
  const [oauthRedirectUri, setOauthRedirectUri] = useState<string | null>(null);

  useEffect(() => {
    if (!window.location.search.includes("oauth_state_id")) return;
    setOauthRedirectUri(window.location.href);
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save bank connection.");
      return;
    }
    // Past this point the connection is saved on the server. Nothing here may
    // surface as an error — a cosmetic cleanup failure must never make a
    // successful bank connection look like it failed.
    try {
      window.sessionStorage.removeItem(LINK_TOKEN_KEY);
      window.sessionStorage.removeItem(LINK_CONNECTION_KEY);
    } catch { /* storage unavailable — nothing to clean up */ }
    setLinkToken(null);
    setLinkConnectionId(null);
    setOauthRedirectUri(null);
    try {
      window.history.replaceState({}, "", "/admin/bank");
    } catch { /* address-bar tidy-up only */ }
    await loadStatus();
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
    // Only pass receivedRedirectUri alongside a token. react-plaid-link creates
    // the handler when `token || publicKey || receivedRedirectUri` is set, so a
    // redirect URI on its own made it call Plaid.create({ token: null, ... }),
    // which throws in Safari as "The string did not match the expected pattern."
    // even though the OAuth exchange itself had already succeeded.
    receivedRedirectUri: linkToken && oauthRedirectUri ? oauthRedirectUri : undefined,
  }), [linkToken, oauthRedirectUri, onSuccess]);
  const { open, ready } = usePlaidLink(plaidConfig);

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, open, ready]);

  /**
   * Clears ONLY the bank unlock cookie. The LA Schedule editor session is left
   * untouched, so this locks the bank without signing you out of the app.
   */
  async function lockBank() {
    try {
      await fetch("/api/bank-pin", { method: "DELETE", credentials: "same-origin" });
    } catch { /* fall through to the reload; the gate re-checks server-side */ }
    window.location.replace("/admin/bank");
  }

  async function beginLink(connectionId?: string) {
    setError(null);
    setBusyId(connectionId ?? "new");
    try {
      await ensureEditorSession();
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

  async function reviewAction(review: BankReview, action: "retry" | "dismiss" | "apply" | "reverse", allocations?: ReviewAllocation[]) {
    if ((action === "dismiss" || action === "reverse") && !window.confirm(`${action === "reverse" ? "Reverse the existing payment allocation" : "Dismiss this review"}? This is an explicit ledger action.`)) return;
    setBusyId(review.bank_transaction_id);
    setError(null);
    try {
      const endpoint = action === "reverse"
        ? `/api/bank-transactions/${review.bank_transaction_id}/reverse`
        : `/api/bank-transactions/${review.bank_transaction_id}/review`;
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: action === "reverse" ? undefined : JSON.stringify({ action, allocations }),
      });
      const data = await response.json() as { detail?: string; error?: string };
      if (!response.ok) throw new Error(data.detail ?? data.error ?? "Review action failed.");
      await loadStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review action failed.");
    } finally { setBusyId(null); }
  }

  return (
    <main className="admin bank-admin">
      <div className="bank-admin-heading">
        <div>
          <h1>Bank Connection</h1>
          <p>Posted deposits flow through the existing safe reconciliation rules. Plaid Link handles bank authorization; this app never receives your Wells Fargo password.</p>
        </div>
        <div className="bank-admin-heading-actions">
          <a href="/admin/payments">Payment ledger</a>
          <button
            type="button"
            className="bank-lock-button"
            onClick={() => { void lockBank(); }}
          >
            Lock Bank
          </button>
        </div>
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
            <dt>Last recovery poll</dt>
            <dd>{fmtDate(connection.last_recovery_poll_at)}</dd>
            <dt>Cursor state</dt>
            <dd>{connection.cursor_initialized ? `Initialized${connection.last_cursor_advanced_at ? ` — advanced ${fmtDate(connection.last_cursor_advanced_at)}` : ""}` : "Awaiting first sync"}</dd>
            <dt>Consent expires</dt>
            <dd>{connection.consent_expiration_time ? fmtDate(connection.consent_expiration_time) : "No date reported"}</dd>
            {connection.last_error_code && <><dt>Connection issue</dt><dd>{connection.last_error_code}{connection.last_error_message ? ` — ${connection.last_error_message}` : ""}</dd></>}
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

      {status && (
        <section className="qb-section">
          <h2>Plaid billing</h2>
          <dl className="kv">
            <dt>Environment</dt><dd>{status.environment}</dd>
            <dt>Configured plan</dt><dd>{status.billing.configuredPlan ?? "Not configured"}</dd>
            <dt>Connected Items / accounts</dt><dd>{status.billing.connectedItemCount} / {status.billing.connectedAccountCount}</dd>
            {status.billing.expectedMonthlyCost != null && <><dt>{status.billing.expectedMonthlyCostLabel}</dt><dd>${status.billing.expectedMonthlyCost.toFixed(2)}</dd></>}
          </dl>
          <p className="bank-muted">{status.billing.rateStatement}</p>
          <p className="bank-muted">To verify the exact rate, open Plaid Dashboard → Team Settings → Billing → Contracts &amp; Rates.</p>
          <a href="https://dashboard.plaid.com" target="_blank" rel="noreferrer">Open Plaid Dashboard</a>
        </section>
      )}

      <section className="qb-section">
        <h2>Reconciliation review queue</h2>
        {reviews.length === 0 && <p className="bank-muted">No deposits currently require review.</p>}
        {reviews.map((review) => {
          const transaction = Array.isArray(review.bank_transactions) ? review.bank_transactions[0] : review.bank_transactions;
          const candidates = Array.isArray(review.candidate_matches) ? review.candidate_matches : [];
          const applyCandidates = candidates.filter((candidate): candidate is ReviewAllocation[] => Array.isArray(candidate) && candidate.length > 0 && candidate.every((entry) => typeof entry?.googleEventId === "string"));
          const providerChange = ["provider_modified_applied_transaction", "provider_removed_applied_transaction"].includes(review.reason);
          return (
            <div className="bank-review" key={review.id}>
              <p><strong>{review.reason.replaceAll("_", " ")}</strong></p>
              {transaction && <p className="bank-muted">{transaction.posted_date} · ${Number(transaction.amount).toFixed(2)} · {transaction.description}</p>}
              {applyCandidates.map((candidate, index) => (
                <button key={index} className="qb-btn qb-btn--secondary" disabled={busyId !== null} onClick={() => void reviewAction(review, "apply", candidate)}>
                  Apply {candidate.map((entry) => `#${entry.invoiceNumber ?? "?"} $${entry.amount.toFixed(2)}`).join(" + ")}
                </button>
              ))}
              <div className="bank-actions">
                <button className="qb-btn qb-btn--secondary" disabled={busyId !== null} onClick={() => void reviewAction(review, "retry")}>Re-run matching</button>
                {providerChange && <button className="qb-btn bank-disconnect" disabled={busyId !== null} onClick={() => void reviewAction(review, "reverse")}>Reverse applied payment</button>}
                <button className="qb-btn qb-btn--secondary" disabled={busyId !== null} onClick={() => void reviewAction(review, "dismiss")}>Dismiss</button>
              </div>
            </div>
          );
        })}
      </section>

      <section className="qb-section">
        <h2>CSV fallback</h2>
        <p className="bank-muted">The existing Wells Fargo CSV importer remains available if provider sync is unavailable. Its duplicate protection and reconciliation rules are unchanged.</p>
      </section>
    </main>
  );
}
