import "server-only";
import { createHash } from "node:crypto";
import { getSupabaseServerClient } from "./supabase";

export function webhookReceiptHash(signature: string, rawBody: string): string {
  // The signed JWT is the delivery identity. Hashing the body too prevents a
  // captured signature from being associated with any other payload. A later
  // legitimate cursor notification may have the same JSON shape but a fresh JWT.
  return createHash("sha256").update(signature).update("\0").update(rawBody).digest("hex");
}

export async function claimBankWebhookReceipt(
  signatureHash: string,
  itemId: string | null,
  webhookType: string | null,
  webhookCode: string | null,
): Promise<boolean> {
  const db = getSupabaseServerClient();
  const { data, error } = await db.rpc("claim_bank_provider_webhook", {
    p_signature_hash: signatureHash,
    p_provider_item_id: itemId,
    p_webhook_type: webhookType,
    p_webhook_code: webhookCode,
  });
  if (error) throw new Error(`[bank-provider] webhook receipt claim failed: ${error.message}`);
  return data === true;
}

export async function completeBankWebhookReceipt(signatureHash: string): Promise<void> {
  const db = getSupabaseServerClient();
  const { error } = await db.from("bank_provider_webhook_receipts").update({
    processing_status: "completed", completed_at: new Date().toISOString(), last_error: null,
  }).eq("signature_hash", signatureHash).eq("processing_status", "processing");
  if (error) throw new Error(`[bank-provider] webhook receipt completion failed: ${error.message}`);
}

export async function failBankWebhookReceipt(signatureHash: string, errorMessage: string): Promise<void> {
  const db = getSupabaseServerClient();
  const { error } = await db.from("bank_provider_webhook_receipts").update({
    processing_status: "failed", last_error: errorMessage.slice(0, 500),
  }).eq("signature_hash", signatureHash).eq("processing_status", "processing");
  if (error) throw new Error(`[bank-provider] webhook receipt failure failed: ${error.message}`);
}
