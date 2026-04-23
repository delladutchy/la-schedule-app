/**
 * Netlify Scheduled Function: runs every 10 minutes (see netlify.toml).
 *
 * Calls the snapshot builder. If it fails, we log and return 500 — but
 * we never overwrite a good snapshot with bad data, so the public page
 * keeps serving the previous one.
 */

import type { Handler } from "@netlify/functions";
import { buildAndPersistSnapshot } from "../../lib/sync";

export const handler: Handler = async () => {
  const started = Date.now();
  try {
    const result = await buildAndPersistSnapshot();
    const durMs = Date.now() - started;
    if (result.status === "ok") {
      console.log(`[scheduled-sync] ok in ${durMs}ms, ${result.snapshot?.busy.length ?? 0} busy blocks`);
      return { statusCode: 200, body: JSON.stringify({ status: "ok", durationMs: durMs }) };
    }
    console.error(`[scheduled-sync] failed in ${durMs}ms: ${result.error}`);
    return {
      statusCode: 500,
      body: JSON.stringify({ status: "failed", error: result.error, durationMs: durMs }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduled-sync] exception: ${msg}`);
    return { statusCode: 500, body: JSON.stringify({ status: "error", error: msg }) };
  }
};
