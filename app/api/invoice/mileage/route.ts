import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";

export const dynamic = "force-dynamic";

// Full address with zip makes Google geocode the correct Dewey Beach, DE.
// Never use browser GPS or any dynamic location.
const ORIGIN = "Dewey Beach, DE 19971";
const METERS_PER_MILE = 1609.344;
// Gigs are local to the Delmarva peninsula. Flag anything farther as suspicious
// so the UI can prompt the user to enter miles manually instead of auto-filling.
const MAX_PLAUSIBLE_ONE_WAY_MILES = 200;

export async function GET(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const location = new URL(request.url).searchParams.get("location")?.trim();
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

    const oneWayMiles = Math.round(element.distance.value / METERS_PER_MILE);
    const roundTripMiles = oneWayMiles * 2;
    // If the result is implausibly far the job location is likely ambiguous
    // (e.g. "Fenwick Island" resolving to SC instead of DE). Return the raw
    // numbers but flag it so the UI prompts manual entry instead of auto-fill.
    const plausible = oneWayMiles <= MAX_PLAUSIBLE_ONE_WAY_MILES;
    return NextResponse.json({ oneWayMiles, roundTripMiles, plausible });
  } catch {
    return NextResponse.json({ error: "calculation_failed" }, { status: 500 });
  }
}
