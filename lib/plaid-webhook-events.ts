export type PlaidItemHealthAction =
  | { action: "reconnect"; code: string; message: string }
  | { action: "degraded"; code: string; message: string }
  | { action: "repaired" }
  | { action: "none" };

export function classifyPlaidItemWebhook(
  webhookCode: string | undefined,
  error?: { error_code?: string; error_message?: string } | null,
): PlaidItemHealthAction {
  const code = webhookCode ?? "";
  if (["PENDING_DISCONNECT", "PENDING_EXPIRATION", "USER_PERMISSION_REVOKED"].includes(code)) {
    return { action: "reconnect", code, message: "Bank authorization requires reconnection." };
  }
  if (code === "LOGIN_REPAIRED") return { action: "repaired" };
  if (code !== "ERROR") return { action: "none" };
  const errorCode = error?.error_code ?? "ITEM_ERROR";
  const message = error?.error_message ?? "Plaid Item error";
  return ["ITEM_LOGIN_REQUIRED", "ITEM_LOCKED", "USER_PERMISSION_REVOKED"].includes(errorCode)
    ? { action: "reconnect", code: errorCode, message }
    : { action: "degraded", code: errorCode, message };
}
