import type { Handler } from "@netlify/functions";
import { getEnvConfig } from "../../lib/config";
import { WatchConfigError, ensureGoogleCalendarWatch } from "../../lib/google-watch";

function resolveRuntimeSiteUrl(): string | undefined {
  const value = process.env.URL ?? process.env.DEPLOY_URL ?? process.env.DEPLOY_PRIME_URL;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatExpiresInMs(expiresInMs: number | null): string {
  return expiresInMs === null ? "null" : String(Math.trunc(expiresInMs));
}

export const handler: Handler = async () => {
  const started = Date.now();
  try {
    const env = getEnvConfig();
    const result = await ensureGoogleCalendarWatch(env, {
      force: false,
      runtimeSiteUrl: resolveRuntimeSiteUrl(),
    });

    const durationMs = Date.now() - started;
    if (result.action === "skipped") {
      console.info(
        `[google:watch:auto-renew] skipped reason=${result.renewalReason} expiresInMs=${formatExpiresInMs(result.expiresInMs)} ms total=${durationMs}`,
      );
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "ok",
          action: "skipped",
          expiresInMs: result.expiresInMs,
          durationMs,
        }),
      };
    }

    console.info(
      `[google:watch:auto-renew] renewed expiresInMs=${formatExpiresInMs(result.expiresInMs)} ms total=${durationMs}`,
    );
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "ok",
        action: "registered",
        expiresInMs: result.expiresInMs,
        durationMs,
      }),
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const errCode =
      error instanceof WatchConfigError
        ? error.code
        : error instanceof Error
          ? error.name || "error"
          : "error";
    console.error(
      `[google:watch:auto-renew] failed error=${errCode} ms total=${durationMs}`,
    );
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: "failed",
        error: "watch_auto_renew_failed",
        durationMs,
      }),
    };
  }
};
