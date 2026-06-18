"use client";

/**
 * QuickBooks setup page — /admin/quickbooks
 *
 * Jeff-only admin UI for the QuickBooks OAuth connection and item bootstrap.
 *
 * Steps:
 *  1. Set QUICKBOOKS_CLIENT_ID, CLIENT_SECRET, and REDIRECT_URI in env
 *  2. Click "Connect to QuickBooks" — completes OAuth flow
 *  3. Click "Run Bootstrap" — finds/creates QBO service items + customer
 *  4. Set QUICKBOOKS_ENABLED=true — enables draft invoice creation
 *
 * Auth: uses the la_editor_session cookie (set during normal app usage).
 * The status fetch and POST actions all use same-origin cookies automatically.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";

// ── Types ─────────────────────────────────────────────────────────────────────

interface QBStatus {
  enabled: boolean;
  readyToCreate: boolean;
  credentials: {
    clientId: boolean;
    clientSecret: boolean;
    redirectUri: boolean;
    customerName: string;
  };
  missingRequiredCredentials: string[] | null;
  connection: {
    stored: boolean;
    realmId: string | null;
    refreshTokenStored: boolean;
    refreshTokenExpiresAt: string | null;
    connectedAt: string | null;
    connectedBy: string | null;
  };
  tokenTest: { ok: boolean; error?: string } | null;
  bootstrap: {
    completed: boolean;
    bootstrappedAt: string | null;
    customer: { resolved: boolean; id: string | null; name: string };
    allItemsResolved: boolean;
    resolvedItemCount: number;
    totalItemCount: number;
    items: Record<string, { name: string; resolved: boolean; id: string | null }>;
  };
  nextSteps: string[] | null;
}

interface BootstrapResult {
  ok: boolean;
  cached: boolean;
  errors: string[];
  customer: { found: boolean; name: string };
  items: Record<string, { name: string; found: boolean; created: boolean; id: string | null; error?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`qb-badge ${ok ? "qb-badge--ok" : "qb-badge--warn"}`}>
      {ok ? "✓" : "✗"} {label}
    </span>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function QuickBooksSetupPage() {
  const searchParams = useSearchParams();
  const [status, setStatus]       = useState<QBStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading]     = useState(true);

  const [bootstrapResult, setBootstrapResult]     = useState<BootstrapResult | null>(null);
  const [bootstrapRunning, setBootstrapRunning]   = useState(false);
  const [bootstrapError, setBootstrapError]       = useState<string | null>(null);

  // OAuth result from redirect back
  const connected = searchParams.get("connected") === "true";
  const oauthError = searchParams.get("error");

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/quickbooks/status");
      if (res.status === 401 || res.status === 403) {
        setLoadError("Not authorized. Log in as Jeff first.");
        return;
      }
      if (!res.ok) {
        setLoadError(`Status fetch failed (${res.status})`);
        return;
      }
      setStatus(await res.json() as QBStatus);
    } catch {
      setLoadError("Could not reach /api/quickbooks/status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  async function runBootstrap() {
    setBootstrapRunning(true);
    setBootstrapError(null);
    setBootstrapResult(null);
    try {
      const res = await fetch("/api/quickbooks/bootstrap", { method: "POST" });
      const data = await res.json() as BootstrapResult;
      setBootstrapResult(data);
      // Refresh status after bootstrap
      await fetchStatus();
    } catch (err) {
      setBootstrapError(err instanceof Error ? err.message : "Bootstrap request failed");
    } finally {
      setBootstrapRunning(false);
    }
  }

  function connectToQuickBooks() {
    window.location.href = "/api/quickbooks/connect";
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="admin">
      <h1>QuickBooks Setup</h1>

      {/* Solopreneur limitation notice */}
      <div className="qb-banner qb-banner--warn" style={{ marginBottom: 16 }}>
        <strong>Note:</strong> QuickBooks draft invoice creation requires a supported QuickBooks Online
        plan, such as Simple Start or higher.{" "}
        <strong>QuickBooks Solopreneur is not supported for this API connection.</strong>{" "}
        Native PDF invoicing is available on the{" "}
        <a href="/admin/payments" style={{ color: "inherit", textDecoration: "underline" }}>Payments page</a>{" "}
        and does not require a QuickBooks subscription.
      </div>

      {/* OAuth result banners */}
      {connected && (
        <div className="qb-banner qb-banner--ok">
          QuickBooks connected successfully. Run Bootstrap below to set up service items.
        </div>
      )}
      {oauthError && (
        <div className="qb-banner qb-banner--error">
          OAuth error: <code>{oauthError}</code>
          {searchParams.get("detail") && (
            <> — {decodeURIComponent(searchParams.get("detail") ?? "")}</>
          )}
        </div>
      )}

      {/* Loading / auth error */}
      {loading && <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading status…</p>}
      {loadError && <p className="qb-banner qb-banner--error">{loadError}</p>}

      {status && (
        <>
          {/* Overall readiness */}
          <div className="qb-readiness">
            <Badge ok={status.readyToCreate} label={status.readyToCreate ? "Ready to create invoices" : "Setup incomplete"} />
            {status.enabled && <Badge ok={true} label="Enabled" />}
          </div>

          {/* Next steps */}
          {status.nextSteps && status.nextSteps.length > 0 && (
            <div className="qb-section">
              <h2>Next steps</h2>
              <ol className="qb-steps">
                {status.nextSteps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
            </div>
          )}

          {/* Step 1: Credentials */}
          <div className="qb-section">
            <h2>1. App credentials</h2>
            <dl className="kv">
              <dt>Client ID</dt>
              <dd><Badge ok={status.credentials.clientId} label={status.credentials.clientId ? "set" : "missing"} /></dd>

              <dt>Client Secret</dt>
              <dd><Badge ok={status.credentials.clientSecret} label={status.credentials.clientSecret ? "set" : "missing"} /></dd>

              <dt>Redirect URI</dt>
              <dd><Badge ok={status.credentials.redirectUri} label={status.credentials.redirectUri ? "set" : "missing"} /></dd>

              <dt>Customer name</dt>
              <dd>{status.credentials.customerName}</dd>
            </dl>
            {status.missingRequiredCredentials && (
              <p className="qb-hint">
                Missing: <code>{status.missingRequiredCredentials.join(", ")}</code> — add to .env.local / Netlify env vars.
              </p>
            )}
          </div>

          {/* Step 2: OAuth connection */}
          <div className="qb-section">
            <h2>2. QuickBooks connection</h2>
            <dl className="kv">
              <dt>Connected</dt>
              <dd><Badge ok={status.connection.stored} label={status.connection.stored ? "yes" : "no"} /></dd>

              {status.connection.stored && (
                <>
                  <dt>Realm ID</dt>
                  <dd>{status.connection.realmId ?? "—"}</dd>

                  <dt>Refresh token</dt>
                  <dd><Badge ok={status.connection.refreshTokenStored} label="stored in Supabase" /></dd>

                  <dt>Token expires</dt>
                  <dd>{fmtDate(status.connection.refreshTokenExpiresAt)}</dd>

                  <dt>Connected</dt>
                  <dd>{fmtDate(status.connection.connectedAt)}</dd>
                </>
              )}

              <dt>Token test</dt>
              <dd>
                {status.tokenTest === null
                  ? "—"
                  : <Badge ok={status.tokenTest.ok} label={status.tokenTest.ok ? "token valid" : `failed: ${status.tokenTest.error ?? "unknown"}`} />
                }
              </dd>
            </dl>

            <button
              className="qb-btn qb-btn--primary"
              onClick={connectToQuickBooks}
              disabled={!status.credentials.clientId || !status.credentials.clientSecret || !status.credentials.redirectUri}
            >
              {status.connection.stored ? "Reconnect to QuickBooks" : "Connect to QuickBooks"}
            </button>
          </div>

          {/* Step 3: Bootstrap */}
          <div className="qb-section">
            <h2>3. Service items &amp; customer</h2>
            <dl className="kv">
              <dt>Bootstrapped</dt>
              <dd>
                <Badge ok={status.bootstrap.completed} label={status.bootstrap.completed ? "yes" : "not yet"} />
              </dd>

              {status.bootstrap.completed && (
                <>
                  <dt>Items resolved</dt>
                  <dd>
                    <Badge
                      ok={status.bootstrap.allItemsResolved}
                      label={`${status.bootstrap.resolvedItemCount} / ${status.bootstrap.totalItemCount}`}
                    />
                  </dd>

                  <dt>Customer</dt>
                  <dd>
                    <Badge
                      ok={status.bootstrap.customer.resolved}
                      label={status.bootstrap.customer.resolved
                        ? `${status.bootstrap.customer.name} (found)`
                        : `${status.bootstrap.customer.name} (not found)`}
                    />
                  </dd>

                  <dt>Bootstrapped at</dt>
                  <dd>{fmtDate(status.bootstrap.bootstrappedAt)}</dd>
                </>
              )}
            </dl>

            <button
              className="qb-btn qb-btn--secondary"
              onClick={() => void runBootstrap()}
              disabled={bootstrapRunning || !status.connection.stored && !status.credentials.redirectUri}
            >
              {bootstrapRunning ? "Running…" : "Run Bootstrap"}
            </button>

            {bootstrapError && (
              <p className="qb-banner qb-banner--error" style={{ marginTop: 8 }}>{bootstrapError}</p>
            )}

            {bootstrapResult && (
              <div className="qb-bootstrap-result">
                <p>
                  {bootstrapResult.ok
                    ? <Badge ok={true} label="Bootstrap complete" />
                    : <Badge ok={false} label="Bootstrap had errors" />
                  }
                  {bootstrapResult.cached && " — IDs cached in Supabase."}
                </p>

                {bootstrapResult.errors.length > 0 && (
                  <ul className="qb-error-list">
                    {bootstrapResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                )}

                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-muted)" }}>
                    Item details
                  </summary>
                  <dl className="kv" style={{ marginTop: 8 }}>
                    {Object.entries(bootstrapResult.items).map(([key, item]) => (
                      <>
                        <dt key={`${key}-dt`} style={{ fontSize: 12 }}>{item.name}</dt>
                        <dd key={`${key}-dd`}>
                          {item.id
                            ? <Badge ok={true} label={item.found ? "found" : "created"} />
                            : <Badge ok={false} label={item.error ?? "not resolved"} />
                          }
                        </dd>
                      </>
                    ))}
                  </dl>
                </details>
              </div>
            )}

            {/* Item status (from stored bootstrap) */}
            {status.bootstrap.completed && !bootstrapResult && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-muted)" }}>
                  Item IDs ({status.bootstrap.resolvedItemCount}/{status.bootstrap.totalItemCount} resolved)
                </summary>
                <dl className="kv" style={{ marginTop: 8 }}>
                  {Object.entries(status.bootstrap.items).map(([key, item]) => (
                    <>
                      <dt key={`s-${key}-dt`} style={{ fontSize: 12 }}>{item.name}</dt>
                      <dd key={`s-${key}-dd`}>
                        <Badge ok={item.resolved} label={item.id ?? "not resolved"} />
                      </dd>
                    </>
                  ))}
                </dl>
              </details>
            )}
          </div>

          {/* Step 4: Enable */}
          <div className="qb-section">
            <h2>4. Enable</h2>
            <p className="qb-hint">
              Once all steps above are complete, set{" "}
              <code>QUICKBOOKS_ENABLED=true</code> in your env vars to allow
              draft invoice creation.
            </p>
            <Badge ok={status.enabled} label={status.enabled ? "Enabled" : "Not yet enabled"} />
          </div>

          <div style={{ marginTop: 24 }}>
            <button
              className="qb-btn qb-btn--ghost"
              onClick={() => void fetchStatus()}
              disabled={loading}
            >
              Refresh status
            </button>
          </div>
        </>
      )}
    </div>
  );
}
