import { describe, expect, it } from "vitest";
import {
  DEWEY_ORIGIN,
  DRIVE_THRESHOLD_ONE_WAY_MILES,
  PHL_ONE_WAY_MILES,
  classifyTravelBasis,
  isLightActionGig,
  phlMileage,
  selectMileageForBasis,
} from "@/lib/mileage-policy";
import { calculateWorkdayMileage } from "@/lib/invoice-calculations";

const env = {
  GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
  OVERTURE_CALENDAR_ID: "overture@group.calendar.google.com",
};

/** Real Dewey Beach one-way driving distances, used to pin the rule to reality. */
const REAL_ONE_WAY_MILES = {
  washingtonDC: 121,
  baltimore: 118,
  philadelphia: 119,
  chicago: 810,
  detroit: 638,
  milwaukee: 906,
  kansasCity: 1166,
};

describe("employer detection", () => {
  it("treats the Light Action calendar as Light Action", () => {
    expect(isLightActionGig({ calendarId: env.GOOGLE_CALENDAR_ID }, env)).toBe(true);
  });

  it("never treats the Overture calendar as Light Action", () => {
    expect(isLightActionGig({ calendarId: env.OVERTURE_CALENDAR_ID }, env)).toBe(false);
    expect(
      isLightActionGig(
        { calendarId: env.OVERTURE_CALENDAR_ID, gigSummary: "LA#72124 — UAE" },
        env,
      ),
    ).toBe(false);
  });

  it("does not treat another calendar as Light Action", () => {
    expect(isLightActionGig({ calendarId: "personal@group.calendar.google.com" }, env)).toBe(false);
  });

  it("falls back to the LA# summary convention when no calendar id is known", () => {
    expect(isLightActionGig({ gigSummary: "LA#71774 — Cole Swindell" }, env)).toBe(true);
    expect(isLightActionGig({ gigSummary: "Dentist appointment" }, env)).toBe(false);
  });

  it("is false when nothing identifies the job", () => {
    expect(isLightActionGig({}, env)).toBe(false);
  });
});

describe("drive/fly classification is distance-based, not state-based", () => {
  const driveCases: Array<[string, number]> = [
    ["Washington DC", REAL_ONE_WAY_MILES.washingtonDC],
    ["Baltimore", REAL_ONE_WAY_MILES.baltimore],
    ["Philadelphia", REAL_ONE_WAY_MILES.philadelphia],
  ];

  it.each(driveCases)(
    "%s is a DRIVE despite being outside Delaware (%i mi)",
    (_name, venueOneWayMiles) => {
      expect(classifyTravelBasis({ isLightAction: true, venueOneWayMiles })).toBe("venue");
    },
  );

  const flyCases: Array<[string, number]> = [
    ["Chicago", REAL_ONE_WAY_MILES.chicago],
    ["Detroit", REAL_ONE_WAY_MILES.detroit],
    ["Milwaukee", REAL_ONE_WAY_MILES.milwaukee],
    ["Kansas City", REAL_ONE_WAY_MILES.kansasCity],
  ];

  it.each(flyCases)("%s is a FLY (%i mi)", (_name, venueOneWayMiles) => {
    expect(classifyTravelBasis({ isLightAction: true, venueOneWayMiles })).toBe("phl_flight");
  });

  it("drives at exactly the threshold and flies just past it", () => {
    expect(DRIVE_THRESHOLD_ONE_WAY_MILES).toBe(200);
    expect(classifyTravelBasis({ isLightAction: true, venueOneWayMiles: 199 })).toBe("venue");
    expect(classifyTravelBasis({ isLightAction: true, venueOneWayMiles: 200 })).toBe("venue");
    expect(classifyTravelBasis({ isLightAction: true, venueOneWayMiles: 201 })).toBe("phl_flight");
  });

  it("never reclassifies a non-Light-Action job, however far", () => {
    for (const miles of [50, 201, REAL_ONE_WAY_MILES.chicago]) {
      expect(classifyTravelBasis({ isLightAction: false, venueOneWayMiles: miles })).toBe("venue");
    }
  });

  it("does not assume a flight when the venue distance is unknown", () => {
    expect(classifyTravelBasis({ isLightAction: true, venueOneWayMiles: null })).toBe("venue");
    expect(classifyTravelBasis({ isLightAction: true, venueOneWayMiles: Number.NaN })).toBe("venue");
  });
});

describe("manual basis selection", () => {
  const chicagoVenue = {
    oneWayMiles: REAL_ONE_WAY_MILES.chicago,
    roundTripMiles: REAL_ONE_WAY_MILES.chicago * 2,
  };
  const dcVenue = {
    oneWayMiles: REAL_ONE_WAY_MILES.washingtonDC,
    roundTripMiles: REAL_ONE_WAY_MILES.washingtonDC * 2,
  };

  it("Drive override on a long-haul job returns the real venue mileage", () => {
    expect(selectMileageForBasis("venue", chicagoVenue)).toEqual({
      oneWayMiles: 810,
      roundTripMiles: 1620,
    });
  });

  it("Fly override on a nearby job returns the fixed PHL mileage", () => {
    expect(selectMileageForBasis("phl_flight", dcVenue)).toEqual({
      oneWayMiles: 112,
      roundTripMiles: 224,
    });
  });

  it("PHL mileage does not depend on the venue being known", () => {
    expect(selectMileageForBasis("phl_flight", null)).toEqual({
      oneWayMiles: 112,
      roundTripMiles: 224,
    });
  });

  it("Drive with no resolvable venue yields nothing to auto-fill", () => {
    expect(selectMileageForBasis("venue", null)).toBeNull();
  });
});

describe("constants", () => {
  it("bills from the fixed Dewey origin", () => {
    expect(DEWEY_ORIGIN).toBe("Dewey Beach, DE 19971");
  });

  it("uses the measured Dewey -> PHL one-way distance", () => {
    expect(PHL_ONE_WAY_MILES).toBe(112);
    expect(phlMileage()).toEqual({ oneWayMiles: 112, roundTripMiles: 224 });
  });
});

describe("custom/manual mileage entry is unaffected", () => {
  it("uses explicitly entered miles verbatim in custom mode", () => {
    const calc = calculateWorkdayMileage({
      date: "2026-09-16",
      startTime: "8:00 AM",
      endTime: "6:00 PM",
      mileageMode: "custom",
      milesDriven: 1620,
      mileageDeduction: 60,
    });
    expect(calc?.milesDriven).toBe(1620);
    expect(calc?.billableMiles).toBe(1560);
  });

  it("never clamps an entered value back toward the PHL default", () => {
    const calc = calculateWorkdayMileage({
      date: "2026-09-16",
      startTime: "8:00 AM",
      endTime: "6:00 PM",
      mileageMode: "round_trip_dewey",
      milesDriven: 1620,
    });
    expect(calc?.milesDriven).toBe(1620);
    expect(calc?.milesDriven).not.toBe(PHL_ONE_WAY_MILES * 2);
  });
});
