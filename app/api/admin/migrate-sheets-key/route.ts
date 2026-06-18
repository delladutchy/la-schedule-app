import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@netlify/blobs";
import { getEnvConfig } from "@/lib/config";
import { SHEETS_KEY_BLOB, SHEETS_KEY_STORE } from "@/lib/google-sheets";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/migrate-sheets-key
 *
 * One-time migration: copies GOOGLE_PRIVATE_KEY from env into Netlify Blobs so
 * the env var can be removed from Netlify. This shrinks Lambda function payloads
 * below AWS's 4KB limit without losing Google Sheets functionality.
 *
 * Auth: ADMIN_TOKEN bearer token.
 *
 * Usage:
 *   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
 *        https://your-site.netlify.app/api/admin/migrate-sheets-key
 *
 * After success, remove GOOGLE_PRIVATE_KEY from Netlify env vars and redeploy.
 * google-sheets.ts will then read the key from Blobs automatically.
 *
 * GET returns the current migration status (whether the key is stored in Blobs).
 */

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAdminAuthorized(request: NextRequest, adminToken: string): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const presented = match?.[1]?.trim() ?? "";
  return presented.length > 0 && constantTimeEquals(presented, adminToken);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = getEnvConfig();
  if (!isAdminAuthorized(request, env.ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!rawKey) {
    return NextResponse.json(
      { ok: false, error: "GOOGLE_PRIVATE_KEY is not set in env — nothing to migrate" },
      { status: 400 },
    );
  }

  const store = getStore(SHEETS_KEY_STORE);
  await store.set(SHEETS_KEY_BLOB, rawKey);

  return NextResponse.json({
    ok: true,
    message:
      "Private key stored in Netlify Blobs. " +
      "You can now remove GOOGLE_PRIVATE_KEY from Netlify env vars and redeploy.",
    store: SHEETS_KEY_STORE,
    blob: SHEETS_KEY_BLOB,
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = getEnvConfig();
  if (!isAdminAuthorized(request, env.ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let storedInBlobs = false;
  try {
    const store = getStore(SHEETS_KEY_STORE);
    const meta = await store.getMetadata(SHEETS_KEY_BLOB);
    storedInBlobs = meta !== null;
  } catch {
    // Blobs unavailable locally
  }

  return NextResponse.json({
    envVarSet: !!process.env.GOOGLE_PRIVATE_KEY,
    storedInBlobs,
    ready: !!process.env.GOOGLE_PRIVATE_KEY || storedInBlobs,
  });
}
