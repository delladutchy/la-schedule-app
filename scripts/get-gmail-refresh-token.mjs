#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { google } from "googleapis";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

loadDotenv({ path: ".env.local" });

const REDIRECT_URI = "http://127.0.0.1:53682/oauth/callback";
const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
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

  console.log("\nGoogle Gmail Draft OAuth URL:\n");
  console.log(authUrl);
  console.log("\nOpen that URL, approve Gmail compose access, then copy the returned code.");
  console.log(`If the browser lands on ${REDIRECT_URI} and says it cannot connect, copy the full address-bar URL and paste it here.\n`);

  const rl = readline.createInterface({ input, output });
  const answer = await rl.question("Paste the returned code or full callback URL: ");
  rl.close();

  const code = extractCode(answer);
  if (!code) fail("No authorization code provided.");

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    fail(
      "Google did not return a refresh token. Revoke this app at " +
      "https://myaccount.google.com/permissions, then rerun this script and approve consent again."
    );
  }

  console.log("\nGOOGLE_GMAIL_REFRESH_TOKEN=" + tokens.refresh_token + "\n");
  console.error("Keep this value secret. Add it to Netlify env vars, then close this terminal if you do not want it in scrollback.");
}

main().catch((error) => {
  console.error("\n✗ Failed to get Gmail refresh token:");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
