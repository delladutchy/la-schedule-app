import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getEnvConfig } from "@/lib/config";
import { backfillPlaid2026History, listSyncableBankConnectionIds } from "@/lib/plaid-bank-sync";

export const dynamic = "force-dynamic";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index++) result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return result === 0;
}

function authorized(request: NextRequest): boolean {
  const token = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  return constantTimeEqual(token, getEnvConfig().ADMIN_TOKEN);
}

async function run(apply: boolean): Promise<NextResponse> {
  const ids = await listSyncableBankConnectionIds();
  if (ids.length !== 1) {
    return NextResponse.json({ error: "expected_one_active_plaid_connection", count: ids.length }, { status: 409 });
  }
  try {
    const result = await backfillPlaid2026History(ids[0]!, {
      apply,
      fromDate: "2026-01-01",
      toDate: "2026-07-31",
      createdBy: "plaid-2026-history-backfill",
      maxImports: 25,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      error: "plaid_history_backfill_blocked",
      detail: error instanceof Error ? error.message : "Backfill failed",
    }, { status: 409 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return run(false);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return run(true);
}
