import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import type { PlaidRuntimeConfig } from "./plaid-client";
import { createPlaidClient } from "./plaid-client";

export async function verifyPlaidWebhook(
  rawBody: string,
  verificationToken: string,
  config: PlaidRuntimeConfig,
): Promise<void> {
  const header = decodeProtectedHeader(verificationToken);
  if (header.alg !== "ES256" || typeof header.kid !== "string") {
    throw new Error("Invalid Plaid webhook signing header");
  }
  const response = await createPlaidClient(config).webhookVerificationKeyGet({ key_id: header.kid });
  const key = response.data.key;
  if (key.alg !== "ES256" || key.kid !== header.kid) {
    throw new Error("Plaid webhook signing key mismatch");
  }
  await verifyPlaidWebhookWithJwk(rawBody, verificationToken, key as JWK);
}

export async function verifyPlaidWebhookWithJwk(
  rawBody: string,
  verificationToken: string,
  key: JWK,
): Promise<void> {
  const header = decodeProtectedHeader(verificationToken);
  if (header.alg !== "ES256" || typeof header.kid !== "string" || key.kid !== header.kid) {
    throw new Error("Invalid Plaid webhook signing header");
  }
  const publicKey = await importJWK(key, "ES256");
  const verified = await jwtVerify(verificationToken, publicKey, { algorithms: ["ES256"] });
  const issuedAt = verified.payload.iat;
  if (typeof issuedAt !== "number" || Math.abs(Math.floor(Date.now() / 1000) - issuedAt) > 300) {
    throw new Error("Plaid webhook signature is stale");
  }
  const expected = verified.payload.request_body_sha256;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error("Plaid webhook body hash is missing");
  }
  const actual = createHash("sha256").update(rawBody, "utf8").digest();
  const expectedBuffer = Buffer.from(expected, "hex");
  if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) {
    throw new Error("Plaid webhook body hash mismatch");
  }
}
