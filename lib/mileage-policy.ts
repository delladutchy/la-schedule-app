/**
 * Which journey the default reimbursable mileage should describe.
 *
 * Light Action gigs outside Delaware are flown, so the drive that actually
 * gets reimbursed is Dewey Beach <-> Philadelphia International (PHL), not
 * Dewey Beach <-> the venue. In-state Light Action gigs, and anything that is
 * not a Light Action gig, keep billing the real venue distance.
 *
 * This module owns that rule so the employer test and the state test are not
 * re-implemented per call site.
 */

import { parseLaJobSummary } from "./gigs";

/** Fixed billing origin. Never GPS, never dynamic. */
export const DEWEY_ORIGIN = "Dewey Beach, DE 19971";

/** Gigs in this state bill the actual venue distance. */
export const HOME_STATE = "DE";

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

/** What the returned mileage represents. */
export type MileageBasis = "venue" | "phl_flight";

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

/**
 * Choose the journey the default mileage should describe.
 *
 * An unknown or ambiguous destination state never assumes PHL: without a
 * confident out-of-state answer we bill the venue, because quietly swapping in
 * a flight leg for a job that was actually driven would understate real miles.
 */
export function resolveMileageBasis(opts: {
  isLightAction: boolean;
  destinationState: string | null;
}): MileageBasis {
  if (!opts.isLightAction) return "venue";

  const state = opts.destinationState?.trim().toUpperCase();
  if (!state) return "venue";

  return state === HOME_STATE ? "venue" : "phl_flight";
}
