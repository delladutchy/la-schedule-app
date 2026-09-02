/**
 * /admin/bank — server-gated by the Bank PIN.
 *
 * This is a server component on purpose: when the device is locked it renders
 * only the PIN screen, so no bank data, Plaid detail, or review item is ever
 * present in the HTML. The dashboard's API calls are independently PIN-gated
 * server-side, so this is defence in depth rather than client-side hiding.
 *
 * The Bank PIN is an additional layer — the existing editor session still
 * applies to every bank route exactly as before.
 */

import { cookies } from "next/headers";
import { getEnvConfig } from "@/lib/config";
import { BANK_UNLOCK_COOKIE_NAME, isValidBankUnlockCookie } from "@/lib/bank-pin";
import { BankPinGate } from "@/components/BankPinGate";
import { BankDashboard } from "@/components/BankDashboard";

export const dynamic = "force-dynamic";

export default function BankPage() {
  const env = getEnvConfig();
  const rawCookie = cookies().get(BANK_UNLOCK_COOKIE_NAME)?.value ?? null;
  const unlocked = isValidBankUnlockCookie(rawCookie, env.BANK_ADMIN_PIN);
  if (!unlocked) return <BankPinGate />;
  return <BankDashboard />;
}
