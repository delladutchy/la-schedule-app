/**
 * Which journey the default reimbursable mileage should describe.
 *
 * Light Action gigs within normal driving range bill the real Dewey Beach <->
 * venue distance. Genuinely long-haul gigs are flown, so what actually gets
 * reimbursed is the Dewey Beach <-> Philadelphia International (PHL) drive.
 *
 * The test is DISTANCE, not the state border: Washington DC, Baltimore,
 * Philadelphia and most of the Mid-Atlantic are drives even though they are
 * outside Delaware. Chicago, Detroit, Milwaukee and Kansas City are flights.
 *
 * This module owns the rule so the employer test and the drive/fly test are
 * not re-implemented per call site.
 */

import { parseLaJobSummary } from "./gigs";

/** Fixed billing origin. Never GPS, never dynamic. */
export const DEWEY_ORIGIN = "Dewey Beach, DE 19971";

/** Human-readable label for the flight-leg drive. */
export const PHL_LABEL = "Philadelphia International Airport (PHL)";

/**
 * Dewey Beach, DE 19971 -> Philadelphia International Airport.
 *
 * A fixed route has a fixed distance, so this is measured once and stored
 * rather than re-queried per invoice. Verified against Distance Matrix:
 * 180,312 m = 112 mi one-way (stable across "Philadelphia International
 * Airport", "PHL Airport", and the full Essington Ave address).
 */
export const PHL_ONE_WAY_MILES = 112;

/**
 * One-way driving miles at or below which a Light Action gig is assumed
 * driven. Anything farther is assumed flown out of PHL.
 *
 * Set to 250 rather than 200 so the routinely-driven Mid-Atlantic run stays a
 * drive: Newark NJ measures 201 mi, which a 200-mile cut-off would have
 * classified as a flight over a single mile — well inside the variation
 * between routes. The genuine fly jobs sit far above this (Detroit 638,
 * Chicago 810, Milwaukee 906, Kansas City 1166), so the wider band does not
 * blur the distinction.
 */
export const DRIVE_THRESHOLD_ONE_WAY_MILES = 250;

/** What a set of mileage numbers represents. */
export type TravelBasis = "venue" | "phl_flight";

export interface MileageLeg {
  oneWayMiles: number;
  roundTripMiles: number;
}

export interface MileageJobIdentity {
  /** Google Calendar id of the event, when the caller knows it. */
  calendarId?: string | null;
  /** Event summary, used only when no calendar id is available. */
  gigSummary?: string | null;
}

export interface MileageCalendarEnv {
  GOOGLE_CALENDAR_ID: string;
  OVERTURE_CALENDAR_ID?: string;
}

/**
 * Is this a Light Action gig?
 *
 * The calendar is authoritative when the caller has it — that is the same
 * signal the boards use to separate LA from Overture. Callers that have no
 * calendar id (the invoice worklist builds rows from sheet/Supabase data) fall
 * back to the existing "LA#<number>" summary convention via parseLaJobSummary,
 * rather than a bespoke regex.
 */
export function isLightActionGig(
  job: MileageJobIdentity,
  env: MileageCalendarEnv,
): boolean {
  const calendarId = job.calendarId?.trim();

  if (calendarId) {
    const overtureId = env.OVERTURE_CALENDAR_ID?.trim();
    if (overtureId && calendarId === overtureId) return false;
    return calendarId === env.GOOGLE_CALENDAR_ID.trim();
  }

  const summary = job.gigSummary?.trim();
  if (!summary) return false;
  return parseLaJobSummary(summary).jobNumber != null;
}

/** The fixed Dewey <-> PHL leg. */
export function phlMileage(): MileageLeg {
  return {
    oneWayMiles: PHL_ONE_WAY_MILES,
    roundTripMiles: PHL_ONE_WAY_MILES * 2,
  };
}

/**
 * Choose the journey the default mileage should describe.
 *
 * Only Light Action gigs are ever reclassified as flights. A venue distance
 * that could not be resolved never becomes a flight: without a real number we
 * cannot tell a long haul from a failed lookup, and quietly billing a flight
 * leg for a job that was driven would understate real miles. Callers surface
 * that uncertainty instead.
 */
export function classifyTravelBasis(opts: {
  isLightAction: boolean;
  venueOneWayMiles: number | null;
}): TravelBasis {
  if (!opts.isLightAction) return "venue";

  const miles = opts.venueOneWayMiles;
  if (miles == null || !Number.isFinite(miles)) return "venue";

  return miles > DRIVE_THRESHOLD_ONE_WAY_MILES ? "phl_flight" : "venue";
}

/**
 * Pick the mileage numbers for a basis.
 *
 * Used for both the automatic default and an explicit manual override, so
 * "Drive to Venue" on a long-haul job returns the real venue distance and
 * "Fly / PHL" on a nearby job returns the fixed 112/224.
 *
 * Returns null when the requested basis has no numbers available (venue
 * distance unresolved), which the caller must treat as "ask the user".
 */
export function selectMileageForBasis(
  basis: TravelBasis,
  venue: MileageLeg | null,
): MileageLeg | null {
  return basis === "phl_flight" ? phlMileage() : venue;
}
