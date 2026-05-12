import { getStore } from "@netlify/blobs";
import type { Handler } from "@netlify/functions";
import { getEnvConfig } from "../../lib/config";
import { buildAndPersistSnapshot } from "../../lib/sync";

const LOCK_KEY = "internal/reconcile/lock";
const PENDING_KEY = "internal/reconcile/pending";
const LOCK_TTL_MS = 2 * 60 * 1000;

interface BackgroundRequestBody {
  reason?: string;
  editorId?: string;
  generatedAtUtc?: string;
  action?: "create" | "patch" | "delete";
  requestedAtUtc?: string;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorizedHeader(authorizationHeader: string | undefined, token: string): boolean {
  const header = authorizationHeader ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const presented = match[1]?.trim() ?? "";
  if (!presented || presented.length !== token.length) return false;
  return constantTimeEquals(presented, token);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseGeneratedAtMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBody(rawBody: string | null): BackgroundRequestBody {
  if (!rawBody) return {};
  try {
    const json = JSON.parse(rawBody) as Record<string, unknown>;
    return {
      reason: asNonEmptyString(json.reason),
      editorId: asNonEmptyString(json.editorId),
      generatedAtUtc: asNonEmptyString(json.generatedAtUtc),
      action: json.action === "create" || json.action === "patch" || json.action === "delete"
        ? json.action
        : undefined,
      requestedAtUtc: asNonEmptyString(json.requestedAtUtc),
    };
  } catch {
    return {};
  }
}

async function runFullReconciliation(tag: "primary" | "coalesced"): Promise<void> {
  const startedAt = Date.now();
  const result = await buildAndPersistSnapshot();
  const durationMs = Date.now() - startedAt;

  if (result.status === "ok") {
    console.info(
      `[reconcile:bg] ${tag} ok generatedAt=${result.snapshot?.generatedAtUtc ?? "unknown"} skipped=${result.skipped ? "true" : "false"} ms=${durationMs}`,
    );
    return;
  }

  const error = result.error ?? "sync_failed";
  console.error(`[reconcile:bg] ${tag} failed error=${error} ms=${durationMs}`);
}

export const handler: Handler = async (event) => {
  const startedAt = Date.now();
  const env = getEnvConfig();

  if (!isAuthorizedHeader(event.headers?.authorization, env.ADMIN_TOKEN)) {
    console.info("[reconcile:bg] unauthorized");
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "unauthorized" }),
    };
  }

  const body = parseBody(event.body ?? null);
  const requestedAtUtc = body.requestedAtUtc ?? new Date().toISOString();
  const requestedAtMs = parseGeneratedAtMs(requestedAtUtc) ?? Date.now();

  const store = getStore({ name: env.BLOBS_STORE_NAME });
  const existingLock = await store.get(LOCK_KEY, { type: "json", consistency: "strong" }) as
    | { lockedAtUtc?: string }
    | null;
  const existingLockMs = parseGeneratedAtMs(existingLock?.lockedAtUtc);

  const lockIsFresh = existingLockMs !== null && (Date.now() - existingLockMs) < LOCK_TTL_MS;
  if (lockIsFresh) {
    await store.setJSON(PENDING_KEY, {
      requestedAtUtc,
      reason: body.reason ?? null,
      editorId: body.editorId ?? null,
      action: body.action ?? null,
      generatedAtUtc: body.generatedAtUtc ?? null,
    });

    console.info(
      `[reconcile:bg] coalesced lock_busy action=${body.action ?? "unknown"} editor=${body.editorId ?? "unknown"}`,
    );

    return {
      statusCode: 202,
      body: JSON.stringify({ status: "coalesced" }),
    };
  }

  await store.setJSON(LOCK_KEY, {
    lockedAtUtc: new Date().toISOString(),
    requestedAtUtc,
    reason: body.reason ?? null,
    editorId: body.editorId ?? null,
    action: body.action ?? null,
    generatedAtUtc: body.generatedAtUtc ?? null,
  });

  try {
    await store.delete(PENDING_KEY);
    await runFullReconciliation("primary");

    const pending = await store.get(PENDING_KEY, { type: "json", consistency: "strong" }) as
      | { requestedAtUtc?: string }
      | null;
    const pendingRequestedAtMs = parseGeneratedAtMs(pending?.requestedAtUtc);

    if (pendingRequestedAtMs !== null && pendingRequestedAtMs > requestedAtMs) {
      await store.delete(PENDING_KEY);
      await runFullReconciliation("coalesced");
    }

    console.info(
      `[reconcile:bg] queued action=${body.action ?? "unknown"} editor=${body.editorId ?? "unknown"} ms=${Date.now() - startedAt}`,
    );

    return {
      statusCode: 202,
      body: JSON.stringify({ status: "queued" }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[reconcile:bg] failed message=${message}`);
    return {
      statusCode: 500,
      body: JSON.stringify({ status: "failed", error: "reconcile_background_failed" }),
    };
  } finally {
    await store.delete(LOCK_KEY).catch(() => undefined);
  }
};
