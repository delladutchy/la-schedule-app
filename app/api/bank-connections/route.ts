import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest, isSameOriginEditorMutation } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { exchangeAndStorePlaidConnection, listPublicBankConnections } from "@/lib/plaid-bank-sync";
import { getPlaidConfigurationStatus } from "@/lib/plaid-client";

export const dynamic = "force-dynamic";

function authorize(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return { ok: false as const, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!isJeffEditorId(auth.editorId)) return { ok: false as const, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { ok: true as const, auth, env };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const result = authorize(request);
  if (!result.ok) return result.response;
  const config = getPlaidConfigurationStatus(result.env);
  const connections = await listPublicBankConnections();
  const connected = connections.filter((connection) => connection.connection_status !== "disconnected");
  return NextResponse.json({
    provider: "plaid",
    environment: result.env.PLAID_ENV,
    configured: config.configured,
    missingConfig: config.missing,
    billing: {
      configuredPlan: result.env.PLAID_PLAN_NAME ?? null,
      connectedItemCount: connected.length,
      connectedAccountCount: connected.reduce((count, connection) => count + connection.accounts.filter((account) => account.enabled).length, 0),
      expectedMonthlyCost: result.env.PLAID_EXPECTED_MONTHLY_COST ?? null,
      expectedMonthlyCostLabel: "User-entered expected monthly cost",
      rateStatement: "Plaid pricing is managed in the Plaid Dashboard. LA Schedule cannot determine your contracted rate automatically.",
    },
    connections,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const result = authorize(request);
  if (!result.ok) return result.response;
  if (!isSameOriginEditorMutation(request)) return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  let body: { public_token?: string };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  if (!body.public_token || body.public_token.length > 2048) {
    return NextResponse.json({ error: "invalid_public_token" }, { status: 400 });
  }
  try {
    const connection = await exchangeAndStorePlaidConnection(body.public_token, result.auth.editorId);
    return NextResponse.json({ id: connection.id, status: connection.connection_status }, { status: 201 });
  } catch (error) {
    return NextResponse.json({
      error: "bank_connection_failed",
      detail: error instanceof Error ? error.message : "Connection failed",
    }, { status: 502 });
  }
}
