import "server-only";

/**
 * Shared Google Places (New) helpers.
 *
 * Both /api/locations/search and /api/invoice/mileage need structured address
 * data, so the component extraction lives here rather than being duplicated
 * (and drifting) between the two routes.
 */

export const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

export interface PlacesAddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

/**
 * Pull city/state out of Places `addressComponents`.
 *
 * This is deliberately structured — reading the typed components rather than
 * substring-matching a formatted address, which breaks on international
 * addresses, venue names containing state abbreviations, and so on.
 */
export function extractCityState(
  components: PlacesAddressComponent[],
): { city: string; state: string } {
  const city =
    components.find((c) => c.types?.includes("locality"))?.longText ??
    components.find((c) => c.types?.includes("sublocality"))?.longText ??
    "";
  const state =
    components.find((c) => c.types?.includes("administrative_area_level_1"))
      ?.shortText ?? "";
  return { city, state };
}

/**
 * Resolve the US state code (e.g. "DE", "IL") for a free-text location.
 *
 * Returns null whenever the state cannot be determined — an unreachable API,
 * no match, or a result carrying no administrative area. Callers MUST treat
 * null as "unknown" and never infer a particular state from it.
 */
export async function lookupPlaceState(
  query: string,
  apiKey: string,
): Promise<string | null> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return null;

  try {
    const resp = await fetch(PLACES_ENDPOINT, {
      method: "POST",
      // Never cache: a denial or outage must not pin a wrong answer onto a
      // location for the life of the deployment.
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.addressComponents",
      },
      body: JSON.stringify({
        textQuery: trimmed,
        maxResultCount: 1,
        regionCode: "us",
      }),
    });
    if (!resp.ok) {
      console.error(`[places] state lookup failed status=${resp.status}`);
      return null;
    }

    const data = (await resp.json()) as {
      places?: Array<{ addressComponents?: PlacesAddressComponent[] }>;
    };
    const first = data.places?.[0];
    if (!first) return null;

    const { state } = extractCityState(first.addressComponents ?? []);
    const normalized = state.trim().toUpperCase();
    return normalized.length > 0 ? normalized : null;
  } catch (err) {
    console.error(
      `[places] state lookup threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
