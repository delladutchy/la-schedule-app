#!/usr/bin/env tsx
import { config } from 'dotenv';

config({ path: '.env.local' });

/**
 * One-time Google OAuth helper.
 *
 * Walks you through producing a long-lived refresh token for the
 * Calendar read-only scopes (FreeBusy + event titles). You run this ONCE on your own
 * machine; the resulting refresh token goes into Netlify env vars.
 *
 * Prerequisites:
 *   1. A Google Cloud project with the Google Calendar API enabled.
 *      - https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
 *   2. An OAuth 2.0 Client ID, type = "Desktop app".
 *      - https://console.cloud.google.com/apis/credentials
 *   3. Your Google account added as a test user while the OAuth consent
 *      screen is in "Testing" mode (Google Workspace users: set Internal
 *      and skip this).
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npx tsx scripts/google-auth.ts
 *
 * What it does:
 *   - starts a local webserver on http://127.0.0.1:53682
 *   - opens a Google consent URL in your browser
 *   - receives the auth code callback
 *   - exchanges it for a refresh token
 *   - writes the refresh token to a local ignored file
 *   - does NOT print the refresh token to stdout
 */

import http from "node:http";
import { URL } from "node:url";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { google } from "googleapis";

const REDIRECT_HOST = "127.0.0.1";
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://${REDIRECT_HOST}:${REDIRECT_PORT}/oauth/callback`;
const REFRESH_TOKEN_OUTPUT_FILE = ".google-refresh-token.local";

// Read scopes keep FreeBusy + title fetch behavior, and calendar.events
// enables token-gated write-through all-day gig creation.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId) fail("Missing GOOGLE_CLIENT_ID env var");
  if (!clientSecret) fail("Missing GOOGLE_CLIENT_SECRET env var");

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",   // <-- required for refresh token
    prompt: "consent",        // <-- forces Google to re-issue refresh token
    scope: SCOPES,
    include_granted_scopes: false,
  });

  console.log("\nOpening this URL in your browser:\n");
  console.log(authUrl);
  console.log("\nIf it does not open automatically, copy/paste it.\n");

  // Best-effort auto-open
  try {
    const { exec } = await import("node:child_process");
    const cmd =
      process.platform === "darwin" ? "open" :
      process.platform === "win32" ? "start" :
      "xdg-open";
    exec(`${cmd} "${authUrl}"`);
  } catch {
    // ignore; user can copy-paste
  }

  const code: string = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== "/oauth/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const err = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      if (err) {
        res.end(`Auth failed: ${err}. You can close this tab.`);
        server.close();
        reject(new Error(`Google returned error: ${err}`));
        return;
      }
      if (!got) {
        res.end("No code returned. You can close this tab.");
        server.close();
        reject(new Error("No auth code returned"));
        return;
      }
      res.end("Success! You can close this tab and return to the terminal.");
      server.close();
      resolve(got);
    });
    server.listen(REDIRECT_PORT, REDIRECT_HOST, () => {
      console.log(`Waiting for callback on ${REDIRECT_URI} …\n`);
    });
  });

  console.log("Exchanging code for tokens …");
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    fail(
      "No refresh_token was returned. Revoke this app's access at " +
      "https://myaccount.google.com/permissions and run this script again."
    );
  }

  const tokenFilePath = resolve(process.cwd(), REFRESH_TOKEN_OUTPUT_FILE);
  await writeFile(tokenFilePath, `${tokens.refresh_token}\n`, { mode: 0o600 });

  console.log("\n✓ Success. Paste these into your Netlify site environment:\n");
  console.log("  GOOGLE_CLIENT_ID      = <the client id you already have>");
  console.log("  GOOGLE_CLIENT_SECRET  = <the client secret you already have>");
  console.log(`  GOOGLE_REFRESH_TOKEN  = <saved to ${tokenFilePath}>\n`);
  console.log(
    "Refresh token generated. Raw token output is disabled for safety.\n" +
    `Read it locally from ${tokenFilePath} and remove the file when done.\n`
  );
  console.log(
    "Keep the refresh token secret. If it leaks, revoke it at " +
    "https://myaccount.google.com/permissions and rerun this script.\n"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
