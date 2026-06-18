import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";

export const dynamic = "force-dynamic";

const ORIGIN = "Dewey Beach, DE";
const METERS_PER_MILE = 1609.344;

export async function GET(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const location = request.nextUrl.searchParams.get("location")?.trim();
  if (!location) return NextResponse.json({ error: "location required" }, { status: 400 });

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
    url.searchParams.set("origins", ORIGIN);
    url.searchParams.set("destinations", location);
    url.searchParams.set("units", "imperial");
    url.searchParams.set("key", apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) return NextResponse.json({ error: "distance_api_failed" }, { status: 502 });

    const data = await res.json() as {
      rows?: Array<{ elements?: Array<{ status: string; distance?: { value: number } }> }>;
    };

    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK" || element.distance == null) {
      return NextResponse.json({ error: "no_route_found" }, { status: 404 });
    }

    const roundTripMiles = Math.round((element.distance.value / METERS_PER_MILE) * 2);
    return NextResponse.json({ miles: roundTripMiles });
  } catch {
    return NextResponse.json({ error: "calculation_failed" }, { status: 500 });
  }
}
