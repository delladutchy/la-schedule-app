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
