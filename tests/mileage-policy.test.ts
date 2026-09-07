import { describe, expect, it } from "vitest";
import {
  DEWEY_ORIGIN,
  HOME_STATE,
  PHL_ONE_WAY_MILES,
  isLightActionGig,
  resolveMileageBasis,
} from "@/lib/mileage-policy";
import { calculateWorkdayMileage } from "@/lib/invoice-calculations";

const env = {
  GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
  OVERTURE_CALENDAR_ID: "overture@group.calendar.google.com",
};

describe("mileage policy — employer detection", () => {
  it("treats the Light Action calendar as Light Action", () => {
    expect(isLightActionGig({ calendarId: env.GOOGLE_CALENDAR_ID }, env)).toBe(true);
  });

  it("never treats the Overture calendar as Light Action", () => {
    expect(isLightActionGig({ calendarId: env.OVERTURE_CALENDAR_ID }, env)).toBe(false);
    // Even when the summary happens to look like an LA job number.
    expect(
      isLightActionGig(
        { calendarId: env.OVERTURE_CALENDAR_ID, gigSummary: "LA#72124 — UAE" },
        env,
      ),
    ).toBe(false);
  });

  it("does not treat some other calendar as Light Action", () => {
    expect(isLightActionGig({ calendarId: "personal@group.calendar.google.com" }, env)).toBe(false);
  });

  it("falls back to the LA# summary convention when no calendar id is known", () => {
    expect(isLightActionGig({ gigSummary: "LA#71774 — Cole Swindell" }, env)).toBe(true);
    expect(isLightActionGig({ gigSummary: "LA #71774 Cole Swindell" }, env)).toBe(true);
    expect(isLightActionGig({ gigSummary: "Dentist appointment" }, env)).toBe(false);
    expect(isLightActionGig({ gigSummary: "Overture" }, env)).toBe(false);
  });

  it("is false when nothing identifies the job", () => {
    expect(isLightActionGig({}, env)).toBe(false);
    expect(isLightActionGig({ calendarId: null, gigSummary: null }, env)).toBe(false);
  });
});

describe("mileage policy — basis selection", () => {
  it("bills the venue for an in-state Light Action gig", () => {
    expect(resolveMileageBasis({ isLightAction: true, destinationState: HOME_STATE }))
      .toBe("venue");
    expect(resolveMileageBasis({ isLightAction: true, destinationState: "de" }))
      .toBe("venue");
  });

  it("bills the PHL drive for an out-of-state Light Action gig", () => {
    for (const state of ["IL", "MI", "WI", "MO", "PA", "FL"]) {
      expect(resolveMileageBasis({ isLightAction: true, destinationState: state }))
        .toBe("phl_flight");
    }
  });

  it("never applies the PHL rule to a non-Light-Action job", () => {
    expect(resolveMileageBasis({ isLightAction: false, destinationState: "IL" }))
      .toBe("venue");
  });

  it("does not assume PHL when the state is unknown or ambiguous", () => {
    expect(resolveMileageBasis({ isLightAction: true, destinationState: null }))
      .toBe("venue");
    expect(resolveMileageBasis({ isLightAction: true, destinationState: "" }))
      .toBe("venue");
    expect(resolveMileageBasis({ isLightAction: true, destinationState: "   " }))
      .toBe("venue");
  });
});

describe("mileage policy — constants", () => {
  it("bills from the fixed Dewey origin", () => {
    expect(DEWEY_ORIGIN).toBe("Dewey Beach, DE 19971");
  });

  it("uses the measured Dewey -> PHL one-way distance", () => {
    expect(PHL_ONE_WAY_MILES).toBe(112);
  });
});

describe("manual override is unaffected by the PHL default", () => {
  it("uses explicitly entered miles verbatim in custom mode", () => {
    const calc = calculateWorkdayMileage({
      date: "2026-09-16",
      startTime: "8:00 AM",
      endTime: "6:00 PM",
      mileageMode: "custom",
      milesDriven: 1620, // Jeff actually drove to Chicago and back
      mileageDeduction: 60,
    });
    expect(calc).not.toBeNull();
    expect(calc?.milesDriven).toBe(1620);
    expect(calc?.billableMiles).toBe(1560);
  });

  it("honours a round-trip entry that overrides the PHL default", () => {
    const calc = calculateWorkdayMileage({
      date: "2026-09-16",
      startTime: "8:00 AM",
      endTime: "6:00 PM",
      mileageMode: "round_trip_dewey",
      milesDriven: 1620,
    });
    // Nothing clamps the entered value back to 2 x PHL_ONE_WAY_MILES.
    expect(calc?.milesDriven).toBe(1620);
    expect(calc?.milesDriven).not.toBe(PHL_ONE_WAY_MILES * 2);
  });
});
