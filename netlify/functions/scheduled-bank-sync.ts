import type { Config } from "@netlify/functions";
import { invokeCronRoute } from "../../lib/cron-invoke";

/**
 * Cursor-based bank transaction poll. Plaid webhooks are the primary trigger;
 * this is the recovery path for delayed or missed provider events and is safe
 * to run repeatedly.
 */
export default async () => {
  await invokeCronRoute("/api/cron/bank-sync", "scheduled-bank-sync");
  return new Response(null, { status: 200 });
};

export const config: Config = {
  schedule: "7,22,37,52 * * * *",
};
