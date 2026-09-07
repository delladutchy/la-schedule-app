/**
 * Helper for Netlify Scheduled Functions that drive the Next.js cron routes.
 *
 * Why this indirection exists:
 *
 * Netlify can only schedule *Netlify Functions* — a schedule cannot target an
 * arbitrary HTTP path such as a Next.js API route. (netlify.toml previously
 * carried top-level `[[crons]]` entries pointing at `/api/cron/*`; that key is
 * not part of Netlify's configuration schema, so it was silently ignored and
 * none of the scheduled work ran.)
 *
 * The sync/renew logic already lives in the Next.js routes and is exercised by
 * the existing tests, so rather than duplicating it into Lambda handlers these
 * scheduled functions stay deliberately thin and simply call the routes over
 * HTTP with the ADMIN_TOKEN the routes already accept. Keeping the handler
 * thin also means it does not import `getEnvConfig()`, so a scheduled run can
 * never fail closed on unrelated env validation.
 */

function resolveSiteOrigin(): string | null {
  // `URL` is set by Netlify to the site's primary address at runtime.
  const candidates = [process.env.URL, process.env.PUBLIC_SITE_URL];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed.replace(/\/+$/, "");
  }
  return null;
}

export interface CronInvocationResult {
  ok: boolean;
  status: number | null;
  body: string;
  durationMs: number;
}

/**
 * Calls one of the `/api/cron/*` routes with ADMIN_TOKEN bearer auth.
 * Never throws — scheduled runs report failure through the returned result so
 * a transient error is logged rather than crashing the invocation.
 */
export async function invokeCronRoute(
  path: string,
  logTag: string,
): Promise<CronInvocationResult> {
  const startedAt = Date.now();
  const origin = resolveSiteOrigin();
  const adminToken = process.env.ADMIN_TOKEN?.trim();

  if (!origin) {
    console.error(`[${logTag}] no site origin available (URL / PUBLIC_SITE_URL unset)`);
    return { ok: false, status: null, body: "missing_site_origin", durationMs: 0 };
  }
  if (!adminToken) {
    console.error(`[${logTag}] ADMIN_TOKEN is not configured`);
    return { ok: false, status: null, body: "missing_admin_token", durationMs: 0 };
  }

  try {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
    });
    const body = (await response.text().catch(() => "")).slice(0, 500);
    const durationMs = Date.now() - startedAt;

    if (response.ok) {
      console.info(`[${logTag}] ok status=${response.status} ms=${durationMs} body=${body}`);
    } else {
      console.error(`[${logTag}] failed status=${response.status} ms=${durationMs} body=${body}`);
    }
    return { ok: response.ok, status: response.status, body, durationMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;
    console.error(`[${logTag}] exception ms=${durationMs} message=${message}`);
    return { ok: false, status: null, body: message, durationMs };
  }
}
