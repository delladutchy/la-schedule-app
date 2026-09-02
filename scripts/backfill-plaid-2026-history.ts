#!/usr/bin/env tsx
import { config } from "dotenv";
config({ path: ".env.local" });

import { createRequire } from "node:module";
const req = createRequire(__filename);
const serverOnlyPath = req.resolve("server-only");
req.cache[serverOnlyPath] = { id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {}, children: [], paths: [] } as never;

async function main() {
  const apply = process.argv.includes("--apply");
  const { listSyncableBankConnectionIds, backfillPlaid2026History } = req("../lib/plaid-bank-sync") as typeof import("../lib/plaid-bank-sync");
  const ids = await listSyncableBankConnectionIds();
  if (ids.length !== 1) throw new Error(`Expected exactly one active Plaid connection; found ${ids.length}`);
  const result = await backfillPlaid2026History(ids[0]!, {
    apply,
    fromDate: "2026-01-01",
    toDate: "2026-07-31",
    createdBy: "plaid-2026-history-backfill",
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!apply) process.stdout.write("Preview only. Re-run with --apply after verifying every Light Action deposit is an unambiguous duplicate.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
