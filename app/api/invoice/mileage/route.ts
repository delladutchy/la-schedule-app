import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import {
  DEWEY_ORIGIN,
  PHL_LABEL,
  classifyTravelBasis,
  isLightActionGig,
  phlMileage,
  selectMileageForBasis,
} from "@/lib/mileage-policy";

export const dynamic = "force-dynamic";

// Full address with zip makes Google geocode the correct Dewey Beach, DE.
// Never use browser GPS or any dynamic location.
const ORIGIN = DEWEY_ORIGIN;
const METERS_PER_MILE = 1609.344;
// Non-Light-Action jobs are local to the Delmarva peninsula. Flag anything
// farther as suspicious so the UI prompts manual entry instead of auto-filling.
// Light Action jobs use the drive/fly threshold instead — a long distance there
// is a flight, not a bad geocode.
const MAX_PLAUSIBLE_ONE_WAY_MILES = 200;

export async function GET(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const params = new URL(request.url).searchParams;
  const location = params.get("location")?.trim();
  if (!location) return NextResponse.json({ error: "location required" }, { status: 400 });

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const isLightAction = isLightActionGig(
    { calendarId: params.get("calendarId"), gigSummary: params.get("gigSummary") },
    env,
  );

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
    url.searchParams.set("origins", ORIGIN);
    url.searchParams.set("destinations", location);
    url.searchParams.set("units", "imperial");
    url.searchParams.set("key", apiKey);

    // `no-store` is essential here, not merely an optimization. Distance
    // Matrix reports API-level failures (REQUEST_DENIED when billing is off,
    // quota errors) with HTTP *200* and an empty `rows`, which makes such a
    // response perfectly cacheable — Next.js would then replay that failure
    // for this exact destination indefinitely, long after the underlying
    // problem was fixed. That is what happened while Maps billing was
    // disabled: every venue queried during the outage kept returning "no
    // route", while venues first queried afterwards worked fine.
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) return NextResponse.json({ error: "distance_api_failed" }, { status: 502 });

    const data = await res.json() as {
      status?: string;
      error_message?: string;
      rows?: Array<{ elements?: Array<{ status: string; distance?: { value: number } }> }>;
    };

    // The top-level status describes the API call, not the journey. Reporting
    // REQUEST_DENIED or OVER_QUERY_LIMIT as "no_route_found" would blame the
    // job's address for what is really a configuration or quota problem.
    if (data.status && data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error(
        `[mileage] distance matrix unavailable status=${data.status} message=${data.error_message ?? "(none)"}`,
      );
      return NextResponse.json(
        { error: "distance_api_unavailable", reason: data.status },
        { status: 502 },
      );
    }

    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK" || element.distance == null) {
      return NextResponse.json({ error: "no_route_found" }, { status: 404 });
    }

    const venueOneWayMiles = Math.round(element.distance.value / METERS_PER_MILE);
    const venue = { oneWayMiles: venueOneWayMiles, roundTripMiles: venueOneWayMiles * 2 };

    // Classify from the venue distance we just fetched — no second API call,
    // and no state-border heuristic. DC/Baltimore/Philadelphia stay drives.
    const basis = classifyTravelBasis({ isLightAction, venueOneWayMiles });
    const active = selectMileageForBasis(basis, venue) ?? venue;

    // For a Light Action gig the drive/fly threshold has already accounted for
    // distance, so a far venue is a flight rather than a suspect geocode. Other
    // employers keep the original plausibility guard unchanged.
    const plausible = isLightAction
      ? true
      : venueOneWayMiles <= MAX_PLAUSIBLE_ONE_WAY_MILES;

    // Both legs are returned so the UI's Drive/Fly toggle can switch instantly
    // without another round trip.
    return NextResponse.json({
      oneWayMiles: active.oneWayMiles,
      roundTripMiles: active.roundTripMiles,
      plausible,
      basis,
      isLightAction,
      venue,
      ...(isLightAction ? { phl: phlMileage(), routeLabel: PHL_LABEL } : {}),
    });
  } catch {
    return NextResponse.json({ error: "calculation_failed" }, { status: 500 });
  }
}
