import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { requirePlaidRuntimeConfig } from "@/lib/plaid-client";
import { verifyPlaidWebhook } from "@/lib/plaid-webhook";
import {
  markPlaidConnectionHealth,
  markPlaidWebhook,
  syncPlaidConnection,
} from "@/lib/plaid-bank-sync";

export const dynamic = "force-dynamic";

interface PlaidWebhookBody {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  error?: { error_code?: string; error_message?: string } | null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();
  if (rawBody.length === 0 || rawBody.length > 1_000_000) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const verification = request.headers.get("plaid-verification");
  if (!verification) return NextResponse.json({ error: "missing_signature" }, { status: 401 });

  let body: PlaidWebhookBody;
  try {
    const { env } = getConfig();
    const config = requirePlaidRuntimeConfig(env);
    await verifyPlaidWebhook(rawBody, verification, config);
    body = JSON.parse(rawBody) as PlaidWebhookBody;
  } catch {
    return NextResponse.json({ error: "invalid_webhook" }, { status: 401 });
  }
  if (!body.item_id) return NextResponse.json({ ok: true, ignored: "missing_item" });

  const connection = await markPlaidWebhook(body.item_id);
  if (!connection || connection.connection_status === "disconnected") {
    return NextResponse.json({ ok: true, ignored: "unknown_or_disconnected_item" });
  }
  try {
    if (body.webhook_type === "TRANSACTIONS" && body.webhook_code === "SYNC_UPDATES_AVAILABLE") {
      const sync = await syncPlaidConnection(connection.id);
      return NextResponse.json({ ok: true, sync });
    }
    if (body.webhook_type === "ITEM") {
      if (["PENDING_DISCONNECT", "PENDING_EXPIRATION", "USER_PERMISSION_REVOKED"].includes(body.webhook_code ?? "")) {
        await markPlaidConnectionHealth(connection.id, "relogin_required", body.webhook_code ?? null, "Bank authorization requires reconnection.");
      } else if (body.webhook_code === "ERROR") {
        const code = body.error?.error_code ?? "ITEM_ERROR";
        const relogin = ["ITEM_LOGIN_REQUIRED", "ITEM_LOCKED", "USER_PERMISSION_REVOKED"].includes(code);
        await markPlaidConnectionHealth(
          connection.id,
          relogin ? "relogin_required" : "degraded",
          code,
          body.error?.error_message ?? "Plaid Item error",
        );
      } else if (body.webhook_code === "LOGIN_REPAIRED") {
        await markPlaidConnectionHealth(connection.id, "healthy", null, null);
        await syncPlaidConnection(connection.id);
      }
    }
    return NextResponse.json({ ok: true });
  } catch {
    // A non-2xx response asks Plaid to retry. Cursor/idempotency guarantees make that safe.
    return NextResponse.json({ error: "webhook_processing_failed" }, { status: 500 });
  }
}
