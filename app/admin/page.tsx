/**
 * Admin status page.
 *
 * Minimal, token-gated diagnostic. Shows:
 *   - snapshot freshness
 *   - config in use
 *   - calendar ids being used (ids only, never names/details)
 *   - last generation time
 *
 * Access: /admin?token=<ADMIN_TOKEN>
 *
 * We deliberately don't build a "real" admin UI — config lives in git
 * (rollback, audit) and in env vars (secrets, rotation).
 */

import { DateTime } from "luxon";
import { readCurrentSnapshot } from "@/lib/store";
import { classifySnapshot } from "@/lib/view";
import { humanizeAge } from "@/lib/time";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const { file, env } = getConfig();
  const presented = searchParams.token ?? "";

  if (!constantTimeEquals(presented, env.ADMIN_TOKEN)) {
    return (
      <div className="admin">
        <h1>Admin</h1>
        <p>Not authorized.</p>
      </div>
    );
  }

  const snapshot = await readCurrentSnapshot(env.BLOBS_STORE_NAME);
  const state = classifySnapshot(snapshot, Date.now(), {
    freshTtlMinutes: file.freshTtlMinutes,
    hardTtlMinutes: file.hardTtlMinutes,
  });

  const generatedLocal = snapshot
    ? DateTime.fromISO(snapshot.generatedAtUtc, { zone: "utc" })
        .setZone(file.timezone).toFormat("LLL d yyyy, h:mm:ss a ZZZZ")
    : "—";

  return (
    <div className="admin">
      <h1>Availability — Admin</h1>
      <dl className="kv">
        <dt>Snapshot status</dt>
        <dd>{state.status}</dd>

        <dt>Snapshot generated</dt>
        <dd>{generatedLocal}</dd>

        <dt>Snapshot age</dt>
        <dd>{state.ageMinutes === null ? "—" : humanizeAge(state.ageMinutes)}</dd>

        <dt>Busy blocks</dt>
        <dd>{snapshot?.busy.length ?? 0}</dd>

        <dt>Source calendars</dt>
        <dd>{snapshot?.sourceCalendarIds.join(", ") ?? "—"}</dd>

        <dt>Window</dt>
        <dd>
          {snapshot ? (
            <>
              {DateTime.fromISO(snapshot.windowStartUtc, { zone: "utc" })
                .setZone(file.timezone).toFormat("LLL d")} —{" "}
              {DateTime.fromISO(snapshot.windowEndUtc, { zone: "utc" })
                .setZone(file.timezone).toFormat("LLL d")}
            </>
          ) : "—"}
        </dd>

        <dt>Timezone</dt>
        <dd>{file.timezone}</dd>

        <dt>Fresh TTL</dt>
        <dd>{file.freshTtlMinutes} min</dd>

        <dt>Hard TTL</dt>
        <dd>{file.hardTtlMinutes} min</dd>

        <dt>Workday</dt>
        <dd>{file.workdayStartHour}:00 – {file.workdayEndHour}:00</dd>

        <dt>Horizon</dt>
        <dd>{file.horizonDays} days</dd>

        <dt>Buffers</dt>
        <dd>pre {file.preBufferMinutes}m / post {file.postBufferMinutes}m</dd>
      </dl>

      <p style={{ marginTop: 16, fontSize: 13, color: "var(--text-muted)" }}>
        To force a sync now:
        {" "}<code>curl -X POST -H &quot;Authorization: Bearer $ADMIN_TOKEN&quot; https://your-site/api/sync</code>
      </p>
    </div>
  );
}
