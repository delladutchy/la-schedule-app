#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { google } from "googleapis";
import http from "node:http";
import { URL } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

loadDotenv({ path: ".env.local" });

/**
 * One-time OAuth helper for the Gmail Draft invoice flow.
 *
 * Produces GOOGLE_GMAIL_REFRESH_TOKEN (gmail.compose scope). Uses the same
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET as Calendar auth, but its own
 * dedicated loopback port/path — deliberately different from
 * scripts/google-auth.ts's http://127.0.0.1:53682/oauth/callback. Sharing a
 * port with that script is a real failure mode: if a google:auth run is
 * still bound to 53682 in another terminal, IT (not this script) answers
 * the browser's redirect and silently consumes the one-time auth code —
 * this script then gets invalid_grant when it tries to exchange the same
 * code a second time.
 *
 * Flow:
 *   1. Start the local callback server FIRST (so it's listening before the
 *      browser can possibly redirect to it).
 *   2. Open the Google consent URL.
 *   3. Race two ways of getting the code: the automatic loopback callback,
 *      or pasting the code / full callback URL manually (useful if the
 *      browser can't reach 127.0.0.1, e.g. over SSH or in a sandboxed
 *      environment). Whichever resolves first wins; the other is cancelled.
 *   4. Exchange the code exactly once.
 *   5. On any failure, print the redirect_uri, a client_id hint (never the
 *      secret), and concrete next steps — never raw provider error dumps
 *      containing secrets.
 */

const REDIRECT_HOST = "127.0.0.1";
const REDIRECT_PORT = 53791;
const REDIRECT_PATH = "/oauth/gmail-callback";
const REDIRECT_URI = `http://${REDIRECT_HOST}:${REDIRECT_PORT}${REDIRECT_PATH}`;
const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** e.g. "123456-abc...xyz.apps.googleusercontent.com" -> "123456…leusercontent.com" */
function clientIdHint(clientId) {
  if (!clientId) return "(missing)";
  if (clientId.length <= 16) return clientId;
  return `${clientId.slice(0, 8)}…${clientId.slice(-10)}`;
}

function extractCode(rawInput) {
  const raw = rawInput.trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.searchParams.get("code") ?? raw;
  } catch {
    return raw;
  }
}

function printFailureDetails(clientId) {
  console.error("\n— Diagnostic details —");
  console.error(`redirect_uri used: ${REDIRECT_URI}`);
  console.error(`client_id: ${clientIdHint(clientId)}`);
  console.error("\nNext steps:");
  console.error("  1. Open https://console.cloud.google.com/apis/credentials and find the");
  console.error("     OAuth client matching the client_id hint above.");
  console.error('       - "Desktop app" client: no redirect URI registration needed —');
  console.error("         Google accepts any http://127.0.0.1:<port>/... loopback redirect.");
  console.error('       - "Web application" client: it must have this exact redirect URI');
  console.error(`         registered: ${REDIRECT_URI}`);
  console.error("  2. Confirm GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.local match");
  console.error("     that same client — not an older or different one.");
  console.error("  3. Authorization codes are single-use and expire within minutes. Rerun");
  console.error("     this script and complete consent promptly; don't reuse a code or URL");
  console.error("     from a previous run.");
  console.error("  4. Make sure no other instance of this script, or scripts/google-auth.ts,");
  console.error(`     is still running/listening in another terminal (this script uses port ${REDIRECT_PORT},`);
  console.error("     google-auth.ts uses 53682 — but stray processes on either can still");
  console.error("     intercept a redirect meant for the other if ports are reused by hand).\n");
}

/** Repeatedly prompts until a non-empty code is pasted, or `signal` aborts. */
async function waitForManualPaste(rl, signal) {
  while (!signal.aborted) {
    let answer;
    try {
      answer = await rl.question(
        "Paste the returned code or full callback URL (or leave blank to keep waiting for the browser): ",
        { signal },
      );
    } catch (err) {
      if (err?.name === "AbortError") return null;
      throw err;
    }
    const code = extractCode(answer);
    if (code) return code;
  }
  return null;
}

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId) fail("Missing GOOGLE_CLIENT_ID. Put it in .env.local or export it before running this script.");
  if (!clientSecret) fail("Missing GOOGLE_CLIENT_SECRET. Put it in .env.local or export it before running this script.");

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [GMAIL_COMPOSE_SCOPE],
    include_granted_scopes: false,
  });

  // ---- Start the callback server FIRST, before opening the browser ----
  const abortController = new AbortController();
  let serverSettled = false;
  let server;

  const callbackResult = new Promise((resolvePromise) => {
    server = http.createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== REDIRECT_PATH) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const err = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      if (serverSettled) {
        // Already resolved once (e.g. browser retried the request) — ack
        // without ever exchanging the code a second time.
        res.end("Already handled. You can close this tab.");
        return;
      }
      if (err) {
        res.end(`Auth failed: ${err}. You can close this tab.`);
        serverSettled = true;
        resolvePromise({ error: err });
        return;
      }
      if (!got) {
        res.end("No code returned. You can close this tab.");
        return;
      }
      res.end("Success! You can close this tab and return to the terminal.");
      serverSettled = true;
      resolvePromise({ code: got });
    });
    server.listen(REDIRECT_PORT, REDIRECT_HOST, () => {
      console.log(`Waiting for the browser redirect on ${REDIRECT_URI} …`);
    });
  });

  console.log("\nGoogle Gmail Draft OAuth URL:\n");
  console.log(authUrl);
  console.log(`\nredirect_uri in use: ${REDIRECT_URI}`);
  console.log('If your OAuth client is type "Web application", that exact redirect URI');
  console.log('must be registered in Google Cloud Console. "Desktop app" clients accept');
  console.log("any loopback redirect automatically — no registration needed.");
  console.log("\nOpen the URL above and approve Gmail compose access.");
  console.log("If the browser can't reach the redirect, paste the full callback URL below.\n");

  // Best-effort auto-open — AFTER the server is already listening.
  try {
    const { exec } = await import("node:child_process");
    const cmd =
      process.platform === "darwin" ? "open" :
      process.platform === "win32" ? "start" :
      "xdg-open";
    exec(`${cmd} "${authUrl}"`);
  } catch {
    // ignore; user can copy-paste the URL above
  }

  const rl = readline.createInterface({ input, output });
  const manualResult = waitForManualPaste(rl, abortController.signal)
    .then((code) => (code ? { code } : null));

  const raceResult = await Promise.race([
    callbackResult.then((r) => {
      abortController.abort();
      return r;
    }),
    manualResult,
  ]);

  rl.close();
  if (server?.listening) server.close();

  if (!raceResult) fail("No authorization code provided.");
  if (raceResult.error) fail(`Google returned error: ${raceResult.error}`);
  if (!raceResult.code) fail("No authorization code provided.");

  // Exchange the code exactly once — this is the single call site.
  console.log("Exchanging code for tokens …");
  let tokens;
  try {
    ({ tokens } = await oauth2.getToken(raceResult.code));
  } catch (error) {
    console.error("\n✗ Token exchange failed.");
    console.error(error instanceof Error ? error.message : String(error));
    printFailureDetails(clientId);
    process.exit(1);
  }

  if (!tokens.refresh_token) {
    printFailureDetails(clientId);
    fail(
      "No refresh_token was returned. Revoke this app at " +
      "https://myaccount.google.com/permissions, then rerun this script and approve consent again."
    );
  }

  console.log("\nGOOGLE_GMAIL_REFRESH_TOKEN=" + tokens.refresh_token + "\n");
  console.error("Keep this value secret. Add it to Netlify env vars, then close this terminal if you do not want it in scrollback.");
}

main().catch((error) => {
  console.error("\n✗ Failed to get Gmail refresh token:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
