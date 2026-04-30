import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import {
  EDITOR_SESSION_COOKIE_NAME,
  EDITOR_SESSION_MAX_AGE_SECONDS,
  authorizeEditorRequest,
  buildEditorSessionCookieValue,
} from "@/lib/editor-auth";

export const dynamic = "force-dynamic";

function shouldUseSecureCookies() {
  return process.env.NODE_ENV === "production";
}

export async function POST(req: Request) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(req, env);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const cookieValue = buildEditorSessionCookieValue(auth.editorId, env);
  const response = NextResponse.json({
    status: "ok",
    editorId: auth.editorId,
  });
  response.cookies.set({
    name: EDITOR_SESSION_COOKIE_NAME,
    value: cookieValue,
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: EDITOR_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
