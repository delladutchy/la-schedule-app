import type { Config } from "@netlify/functions";
import { invokeCronRoute } from "../../lib/cron-invoke";

/**
 * Re-registers the Google Calendar push-notification watches daily.
 *
 * Calendar watch channels expire after at most 7 days. When renewal stops, the
 * webhook path goes quiet and the app silently falls back to whatever the last
 * snapshot held.
 */
export default async () => {
  await invokeCronRoute("/api/cron/google-watch-renew", "scheduled-google-watch-renew");
  return new Response(null, { status: 200 });
};

export const config: Config = {
  schedule: "17 4 * * *",
};
