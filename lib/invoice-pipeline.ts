/**
 * Pure helper functions for the invoice verified pipeline.
 * Separated for testability — no side effects, no React deps.
 */

export const VERIFY_FAIL_MESSAGE =
  "Invoice not verified — do not rely on Sheet totals yet.";

export const VERIFY_SUCCESS_MESSAGES = {
  clean: "Verified updated",
  cleaned: "Verified updated and cleaned",
  clutterOnly:
    "Verified updated. Old cleanup items remain; run Health Check when convenient.",
  cleanedClutter:
    "Verified updated and cleaned. Old cleanup items remain; run Health Check when convenient.",
} as const;

export type VerifySuccessMessage =
  (typeof VERIFY_SUCCESS_MESSAGES)[keyof typeof VERIFY_SUCCESS_MESSAGES];

/**
 * Build the user-facing verified message from pipeline outcome flags.
 * Used by InvoiceSection after a successful pipeline run.
 */
export function buildVerifiedMessage(
  autoRepaired: boolean,
  hasUnrelatedClutter: boolean,
): string {
  if (autoRepaired && hasUnrelatedClutter)
    return VERIFY_SUCCESS_MESSAGES.cleanedClutter;
  if (autoRepaired) return VERIFY_SUCCESS_MESSAGES.cleaned;
  if (hasUnrelatedClutter) return VERIFY_SUCCESS_MESSAGES.clutterOnly;
  return VERIFY_SUCCESS_MESSAGES.clean;
}

/**
 * Returns true when the message indicates a successful verified pipeline run.
 * Used to decide whether to gate the email send.
 */
export function isVerifySuccessMessage(message: string): boolean {
  return (
    Object.values(VERIFY_SUCCESS_MESSAGES) as string[]
  ).includes(message);
}

/**
 * Returns true when verification should block email send.
 * The pipeline status "verified" also allows send; this helper covers the
 * message-string path used in tests.
 */
export function isVerifyBlockingEmail(
  verifyStatus: "idle" | "verifying" | "verified" | "failed",
): boolean {
  return verifyStatus !== "verified";
}
