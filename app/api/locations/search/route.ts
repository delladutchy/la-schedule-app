import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Google Places API (New) — Text Search.
// Single call returns venue name, formatted address, AND coordinates.
// Field mask is deliberately minimal to reduce billing cost.
const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK =
  "places.displayName,places.formattedAddress,places.location,places.addressComponents";

// Soft geographic bias: center on Rehoboth/Dewey Beach area.
// 50,000 m is the Places API (New) maximum for circle.radius.
// This is a *bias*, not a restriction — results outside this radius still appear
// when the query strongly matches them (e.g. Wilmington, Philadelphia, etc.).
const BIAS_CENTER = { latitude: 38.7, longitude: -75.1 };
const BIAS_RADIUS_M = 50000;

type AddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
};

type PlacesItem = {
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  addressComponents?: AddressComponent[];
};

type PlacesResponse = {
  places?: PlacesItem[];
};

function extractCityState(components: AddressComponent[]): { city: string; state: string } {
  const city =
    components.find((c) => c.types?.includes("locality"))?.longText ??
    components.find((c) => c.types?.includes("sublocality"))?.longText ??
    "";
  const state =
    components.find((c) => c.types?.includes("administrative_area_level_1"))
      ?.shortText ?? "";
  return { city, state };
}

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
      return NextResponse.json({ suggestions: [] });
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

    return NextResponse.json({ suggestions });
  } catch {
    // Network or parse error — return empty rather than 500 so the UI degrades
    // gracefully and the user can still type freely.
    return NextResponse.json({ suggestions: [] });
  }
}
