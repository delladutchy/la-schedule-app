#!/usr/bin/env tsx
import { config } from "dotenv";

config({ path: ".env.local" });

/**
 * Local sync helper.
 *
 * Usage:
 *   1. Link your local repo to the Netlify site: `netlify link`
 *   2. Run: `netlify env:import .env.local` (or set env vars directly)
 *   3. Run: `netlify dev:exec tsx scripts/sync-local.ts`
 *
 * This lets you prime the first snapshot before the scheduled function
 * runs for the first time, or verify setup end-to-end.
 */

import { buildAndPersistSnapshot } from "../lib/sync";

async function main() {
  console.log("Running sync...");
  const started = Date.now();
  const result = await buildAndPersistSnapshot();
  const dur = Date.now() - started;
  if (result.status === "ok") {
    console.log(`✓ sync ok in ${dur}ms`);
    console.log(`  busy blocks: ${result.snapshot?.busy.length ?? 0}`);
    console.log(`  generated:   ${result.snapshot?.generatedAtUtc}`);
  } else {
    console.error(`✗ sync failed in ${dur}ms`);
    console.error(`  error: ${result.error}`);
    if (result.erroredCalendarIds?.length) {
      console.error(`  errored calendars: ${result.erroredCalendarIds.join(", ")}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
