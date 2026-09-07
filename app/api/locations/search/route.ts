import { NextRequest, NextResponse } from "next/server";
import {
  PLACES_ENDPOINT,
  extractCityState,
  type PlacesAddressComponent,
} from "@/lib/places";

export const dynamic = "force-dynamic";

// Google Places API (New) — Text Search.
// Single call returns venue name, formatted address, AND coordinates.
// Field mask is deliberately minimal to reduce billing cost.
const FIELD_MASK =
  "places.displayName,places.formattedAddress,places.location,places.addressComponents";

// Soft geographic bias: center on Rehoboth/Dewey Beach area.
// 50,000 m is the Places API (New) maximum for circle.radius.
// This is a *bias*, not a restriction — results outside this radius still appear
// when the query strongly matches them (e.g. Wilmington, Philadelphia, etc.).
const BIAS_CENTER = { latitude: 38.7, longitude: -75.1 };
const BIAS_RADIUS_M = 50000;

type PlacesItem = {
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  addressComponents?: PlacesAddressComponent[];
};

type PlacesResponse = {
  places?: PlacesItem[];
};

export async function GET(req: NextRequest) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Places search unavailable" },
      { status: 503 },
    );
  }

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 3) {
    return NextResponse.json({ error: "Query too short" }, { status: 400 });
  }

  try {
    const resp = await fetch(PLACES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Key in header keeps it out of server access logs.
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: q,
        maxResultCount: 5,
        regionCode: "us",
        locationBias: {
          circle: { center: BIAS_CENTER, radius: BIAS_RADIUS_M },
        },
      }),
    });

    if (!resp.ok) {
      // Upstream refused the call (billing disabled, API not enabled, key
      // restriction, quota). That is NOT the same as "this place does not
      // exist", and callers must be able to tell the two apart — otherwise a
      // perfectly valid calendar location gets reported to the user as
      // missing. Keep the 200 + empty `suggestions` shape so the autocomplete
      // keeps degrading quietly, but say explicitly that we never looked.
      console.error(
        `[locations] upstream search failed status=${resp.status} — reporting unavailable, not empty`,
      );
      return NextResponse.json({
        suggestions: [],
        status: "unavailable",
        reason: "upstream_error",
      });
    }

    const data = (await resp.json()) as PlacesResponse;
    const places = data.places ?? [];

    const suggestions = places
      .map((p) => {
        const lat = p.location?.latitude;
        const lon = p.location?.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

        const shortName = p.displayName?.text ?? "";
        const address = p.formattedAddress ?? "";
        const { city, state } = extractCityState(p.addressComponents ?? []);

        // Input fill: "Venue Name, City, ST" when we have all parts;
        // falls back to full formatted address.
        const displayName =
          shortName && city && state
            ? `${shortName}, ${city}, ${state}`
            : address || shortName;

        const subtext = address;

        return {
          displayName,
          shortName: shortName || address,
          subtext,
          lat: lat as number,
          lon: lon as number,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    // A successful lookup that genuinely matched nothing still reports
    // status "ok" — only then may a caller say the place could not be found.
    return NextResponse.json({ suggestions, status: "ok" });
  } catch (err) {
    // Network or parse error — return empty rather than 500 so the UI degrades
    // gracefully and the user can still type freely, but flag that the lookup
    // never completed so callers do not misreport this as "no such place".
    console.error(
      `[locations] search threw — reporting unavailable, not empty: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({
      suggestions: [],
      status: "unavailable",
      reason: "request_failed",
    });
  }
}
