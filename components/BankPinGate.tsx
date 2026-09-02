"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ensureEditorSession } from "@/lib/editor-session";

/**
 * 4-digit PIN screen for /admin/bank.
 *
 * Renders no bank data of any kind. The PIN is posted to /api/bank-pin and
 * compared server-side; the configured value never reaches the browser. On
 * success the server sets an httpOnly unlock cookie and we reload so the server
 * component renders the dashboard.
 */
export function BankPinGate() {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = useCallback(async () => {
    if (busy || pin.length !== 4) return;
    setBusy(true);
    setError(null);
    try {
      await ensureEditorSession();
      const response = await fetch("/api/bank-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ pin }),
      });
      if (response.ok) {
        window.location.replace("/admin/bank");
        return;
      }
      const data = await response.json().catch(() => ({})) as { error?: string; retryAfterSeconds?: number };
      if (response.status === 429) {
        setError(`Too many attempts. Try again in about ${Math.ceil((data.retryAfterSeconds ?? 900) / 60)} minutes.`);
      } else if (data.error === "bank_pin_not_configured") {
        setError("Bank PIN is not configured on the server yet.");
      } else if (response.status === 401 || response.status === 403) {
        setError("Incorrect PIN.");
      } else {
        setError("Could not unlock. Try again.");
      }
      setPin("");
      inputRef.current?.focus();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, pin]);

  return (
    <div className="bank-pin-screen">
      <h1 className="bank-pin-title">Bank</h1>
      <p className="bank-pin-subtitle">Enter 4-digit PIN</p>
      <form
        className="bank-pin-form"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <input
          ref={inputRef}
          className="bank-pin-input"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{4}"
          maxLength={4}
          value={pin}
          aria-label="4-digit bank PIN"
          onChange={(event) => {
            setPin(event.target.value.replace(/\D/g, "").slice(0, 4));
            setError(null);
          }}
          disabled={busy}
        />
        <button type="submit" className="bank-pin-submit" disabled={busy || pin.length !== 4}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </form>
      {error ? <p className="bank-pin-error" role="alert">{error}</p> : null}
      <a href="/" className="bank-pin-back">← Back to Schedule</a>
    </div>
  );
}
