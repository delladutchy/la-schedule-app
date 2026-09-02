import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

function decodeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey.trim(), "base64");
  if (key.length !== 32) {
    throw new Error("BANK_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function encryptBankAccessToken(token: string, encodedKey: string): string {
  if (!token) throw new Error("Cannot encrypt an empty bank access token");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(encodedKey), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptBankAccessToken(value: string, encodedKey: string): string {
  const [version, ivRaw, tagRaw, ciphertextRaw] = value.split(":");
  if (version !== VERSION || !ivRaw || !tagRaw || !ciphertextRaw) {
    throw new Error("Unsupported encrypted bank token format");
  }
  const decipher = createDecipheriv("aes-256-gcm", decodeKey(encodedKey), Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
