import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { requirePlaidRuntimeConfig } from "@/lib/plaid-client";
import { verifyPlaidWebhook } from "@/lib/plaid-webhook";
import {
  markPlaidConnectionHealth,
  markPlaidWebhook,
  syncPlaidConnection,
} from "@/lib/plaid-bank-sync";
import { claimBankWebhookReceipt, completeBankWebhookReceipt, failBankWebhookReceipt, webhookReceiptHash } from "@/lib/bank-webhook-receipts";
import { classifyPlaidItemWebhook } from "@/lib/plaid-webhook-events";

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

  const receiptHash = webhookReceiptHash(verification, rawBody);
  const claimed = await claimBankWebhookReceipt(
    receiptHash, body.item_id, body.webhook_type ?? null, body.webhook_code ?? null,
  );
  if (!claimed) return NextResponse.json({ ok: true, duplicate: true });

  try {
    const connection = await markPlaidWebhook(body.item_id);
    if (!connection || connection.connection_status === "disconnected") {
      await completeBankWebhookReceipt(receiptHash);
      return NextResponse.json({ ok: true, ignored: "unknown_or_disconnected_item" });
    }
    if (body.webhook_type === "TRANSACTIONS" && body.webhook_code === "SYNC_UPDATES_AVAILABLE") {
      const sync = await syncPlaidConnection(connection.id);
      await completeBankWebhookReceipt(receiptHash);
      return NextResponse.json({ ok: true, sync });
    }
    if (body.webhook_type === "ITEM") {
      const health = classifyPlaidItemWebhook(body.webhook_code, body.error);
      if (health.action === "reconnect") {
        await markPlaidConnectionHealth(connection.id, "relogin_required", health.code, health.message);
      } else if (health.action === "degraded") {
        await markPlaidConnectionHealth(connection.id, "degraded", health.code, health.message);
      } else if (health.action === "repaired") {
        await markPlaidConnectionHealth(connection.id, "healthy", null, null);
        await syncPlaidConnection(connection.id);
      }
    }
    await completeBankWebhookReceipt(receiptHash);
    return NextResponse.json({ ok: true });
  } catch (error) {
    await failBankWebhookReceipt(receiptHash, error instanceof Error ? error.message : "Webhook processing failed").catch(() => undefined);
    // A non-2xx response asks Plaid to retry. Cursor/idempotency guarantees make that safe.
    return NextResponse.json({ error: "webhook_processing_failed" }, { status: 500 });
  }
}
