import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getEnvConfig } from "@/lib/config";
import { getPlaidConfigurationStatus } from "@/lib/plaid-client";
import { listSyncableBankConnectionIds, markBankRecoveryPoll, syncPlaidConnection } from "@/lib/plaid-bank-sync";

export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest, adminToken: string): boolean {
  if (request.headers.get("x-netlify-event") === "scheduled") return true;
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return (match?.[1]?.trim() ?? "") === adminToken;
}

async function run(): Promise<NextResponse> {
  const env = getEnvConfig();
  if (!getPlaidConfigurationStatus(env).configured) {
    return NextResponse.json({ status: "skipped", reason: "plaid_not_configured" });
  }
  const connectionIds = await listSyncableBankConnectionIds();
  const results = [];
  for (const connectionId of connectionIds) {
    try {
      await markBankRecoveryPoll(connectionId);
      results.push({ connectionId, ...(await syncPlaidConnection(connectionId)) });
    } catch {
      results.push({ connectionId, error: "sync_failed" });
    }
  }
  return NextResponse.json({ status: "ok", results });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = getEnvConfig();
  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return run();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return GET(request);
}
