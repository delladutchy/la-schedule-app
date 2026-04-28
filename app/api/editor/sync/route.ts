import { NextResponse } from "next/server";
import { buildAndPersistSnapshot } from "@/lib/sync";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorized(req: Request): boolean {
  try {
    const { env } = getConfig();
    const header = req.headers.get("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const presented = match[1]?.trim() ?? "";
    return constantTimeEquals(presented, env.EDITOR_TOKEN);
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const result = await buildAndPersistSnapshot();
  const durationMs = Date.now() - started;

  if (result.status === "ok") {
    return NextResponse.json({
      status: "ok",
      durationMs,
      busyBlocks: result.snapshot?.busy.length ?? 0,
      generatedAtUtc: result.snapshot?.generatedAtUtc,
    });
  }

  return NextResponse.json(
    {
      status: "failed",
      durationMs,
      error: result.error,
      erroredCalendarIds: result.erroredCalendarIds ?? [],
    },
    { status: 502 },
  );
}
