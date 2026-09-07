import type { Config } from "@netlify/functions";
import { invokeCronRoute } from "../../lib/cron-invoke";

/**
 * Rebuilds the calendar snapshot every 10 minutes.
 *
 * This is the app's only unattended refresh path: the Google Calendar webhook
 * covers live edits while a watch is registered, but watches expire (7 days
 * max) and are re-registered by scheduled-google-watch-renew. Without this
 * function the snapshot only changes when someone saves a gig through the UI,
 * so calendar edits made directly in Google Calendar never reach the app.
 */
export default async () => {
  await invokeCronRoute("/api/cron/sync", "scheduled-sync");
  // Always 200 — a failed sync is logged above and retried on the next tick;
  // surfacing an error here only marks the scheduled invocation as failed.
  return new Response(null, { status: 200 });
};

export const config: Config = {
  schedule: "*/10 * * * *",
};
