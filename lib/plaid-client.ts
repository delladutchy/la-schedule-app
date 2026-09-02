import "server-only";
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type LinkTokenCreateRequest,
} from "plaid";
import type { EnvConfig } from "./config";

export interface PlaidRuntimeConfig {
  environment: "sandbox" | "production";
  clientId: string;
  secret: string;
  webhookUrl: string;
  redirectUri: string;
  encryptionKey: string;
}

export function getPlaidConfigurationStatus(env: EnvConfig) {
  const webhookUrl = env.PLAID_WEBHOOK_URL ?? (env.PUBLIC_SITE_URL
    ? `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/api/plaid/webhook`
    : undefined);
  const redirectUri = env.PLAID_REDIRECT_URI ?? (env.PUBLIC_SITE_URL
    ? `${env.PUBLIC_SITE_URL.replace(/\/$/, "")}/admin/bank`
    : undefined);
  const missing = [
    !env.PLAID_CLIENT_ID && "PLAID_CLIENT_ID",
    !env.PLAID_SECRET && "PLAID_SECRET",
    !webhookUrl && "PLAID_WEBHOOK_URL (or PUBLIC_SITE_URL)",
    !redirectUri && "PLAID_REDIRECT_URI (or PUBLIC_SITE_URL)",
    !env.BANK_TOKEN_ENCRYPTION_KEY && "BANK_TOKEN_ENCRYPTION_KEY",
  ].filter(Boolean) as string[];
  return { configured: missing.length === 0, missing, webhookUrl, redirectUri };
}

export function requirePlaidRuntimeConfig(env: EnvConfig): PlaidRuntimeConfig {
  const status = getPlaidConfigurationStatus(env);
  if (!status.configured || !status.webhookUrl || !status.redirectUri) {
    throw new Error(`Plaid is not configured: ${status.missing.join(", ")}`);
  }
  return {
    environment: env.PLAID_ENV,
    clientId: env.PLAID_CLIENT_ID!,
    secret: env.PLAID_SECRET!,
    webhookUrl: status.webhookUrl,
    redirectUri: status.redirectUri,
    encryptionKey: env.BANK_TOKEN_ENCRYPTION_KEY!,
  };
}

export function createPlaidClient(config: PlaidRuntimeConfig): PlaidApi {
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[config.environment],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": config.clientId,
        "PLAID-SECRET": config.secret,
        "Plaid-Version": "2020-09-14",
      },
    },
  }));
}

export async function createPlaidLinkToken(
  config: PlaidRuntimeConfig,
  clientUserId: string,
  accessToken?: string,
): Promise<string> {
  const request: LinkTokenCreateRequest = {
    client_name: "LA Schedule",
    language: "en",
    country_codes: [CountryCode.Us],
    user: { client_user_id: clientUserId },
    webhook: config.webhookUrl,
    redirect_uri: config.redirectUri,
    ...(accessToken
      ? { access_token: accessToken }
      : { products: [Products.Transactions] }),
  };
  const response = await createPlaidClient(config).linkTokenCreate(request);
  return response.data.link_token;
}

export function getPlaidError(error: unknown): { code: string; message: string } {
  const response = typeof error === "object" && error !== null && "response" in error
    ? (error as { response?: { data?: Record<string, unknown> } }).response
    : undefined;
  const data = response?.data;
  const code = typeof data?.error_code === "string" ? data.error_code : "PLAID_REQUEST_FAILED";
  const message = typeof data?.error_message === "string" ? data.error_message : "Plaid request failed";
  return { code, message: message.slice(0, 500) };
}
