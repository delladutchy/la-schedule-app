import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const LA_CALENDAR = "la-jobs@group.calendar.google.com";
const OVERTURE_CALENDAR = "overture@group.calendar.google.com";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    env: {
      EDITOR_TOKEN: "jeff-token-abc123",
      EDITOR_TOKENS_JSON: JSON.stringify({ jeff: "jeff-token-abc123" }),
      GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
      OVERTURE_CALENDAR_ID: "overture@group.calendar.google.com",
    },
  }),
}));

// Jeff's token resolves to editorId "jeff"; match real isJeffEditorId behavior.
vi.mock("@/lib/job-time", () => ({
  isJeffEditorId: (id: string) => id === "jeff" || id === "legacy",
}));

const JEFF_TOKEN = "jeff-token-abc123";
const METERS_PER_MILE = 1609.344;

function metersForMiles(miles: number): number {
  return Math.round(miles * METERS_PER_MILE);
}

function makeDistanceResponse(meters: number) {
  return {
    rows: [{ elements: [{ status: "OK", distance: { value: meters } }] }],
  };
}

function makeRequest(location: string): Request {
  return new Request(
    `https://la-schedule-app.local/api/invoice/mileage?location=${encodeURIComponent(location)}`,
    { headers: { Authorization: `Bearer ${JEFF_TOKEN}` } },
  );
}

function makeJobRequest(
  location: string,
  opts: { calendarId?: string; gigSummary?: string } = {},
): Request {
  const q = new URLSearchParams({ location });
  if (opts.calendarId) q.set("calendarId", opts.calendarId);
  if (opts.gigSummary) q.set("gigSummary", opts.gigSummary);
  return new Request(
    `https://la-schedule-app.local/api/invoice/mileage?${q.toString()}`,
    { headers: { Authorization: `Bearer ${JEFF_TOKEN}` } },
  );
}

/** Places response carrying a structured administrative_area_level_1. */
function placesStateResponse(state: string | null) {
  return {
    ok: true,
    json: async () => ({
      places: [
        {
          addressComponents: state
            ? [{ shortText: state, longText: state, types: ["administrative_area_level_1"] }]
            : [{ shortText: "Somewhere", types: ["locality"] }],
        },
      ],
    }),
  };
}

async function loadRoute() {
  const mod = await import("@/app/api/invoice/mileage/route");
  return mod.GET;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "fake-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/api/invoice/mileage", () => {
  it("returns plausible=true for a local trip (~15 mi one-way)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeDistanceResponse(metersForMiles(15)),
    }));
    const GET = await loadRoute();
    const res = await GET(makeRequest("Fenwick Island, DE 19944") as never);
    const json = await res.json() as { oneWayMiles: number; roundTripMiles: number; plausible: boolean };
    expect(json.oneWayMiles).toBe(15);
    expect(json.roundTripMiles).toBe(30);
    expect(json.plausible).toBe(true);
  });

  it("returns plausible=false for an implausibly far trip (322 mi one-way = 644 round trip)", async () => {
    // Simulates "Fenwick Island" (no state) resolving to Fenwick Island, SC instead of DE.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeDistanceResponse(metersForMiles(322)),
    }));
    const GET = await loadRoute();
    const res = await GET(makeRequest("Fenwick Island") as never);
    const json = await res.json() as { oneWayMiles: number; roundTripMiles: number; plausible: boolean };
    expect(json.oneWayMiles).toBe(322);
    expect(json.roundTripMiles).toBe(644);
    expect(json.plausible).toBe(false);
  });

  it("returns plausible=true at exactly the 200-mile boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeDistanceResponse(metersForMiles(200)),
    }));
    const GET = await loadRoute();
    const res = await GET(makeRequest("Edge Case Town, DE") as never);
    const json = await res.json() as { oneWayMiles: number; plausible: boolean };
    expect(json.oneWayMiles).toBe(200);
    expect(json.plausible).toBe(true);
  });

  it("returns plausible=false just over the 200-mile boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeDistanceResponse(metersForMiles(201)),
    }));
    const GET = await loadRoute();
    const res = await GET(makeRequest("Just Over, DE") as never);
    const json = await res.json() as { oneWayMiles: number; plausible: boolean };
    expect(json.oneWayMiles).toBe(201);
    expect(json.plausible).toBe(false);
  });

  it("returns 404 when Google cannot find a route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rows: [{ elements: [{ status: "NOT_FOUND" }] }],
      }),
    }));
    const GET = await loadRoute();
    const res = await GET(makeRequest("Nonexistent Place XYZ") as never);
    expect(res.status).toBe(404);
  });

  it("returns 400 when location param is missing", async () => {
    const GET = await loadRoute();
    const req = new Request("https://la-schedule-app.local/api/invoice/mileage", {
      headers: { Authorization: `Bearer ${JEFF_TOKEN}` },
    });
    const res = await GET(req as never);
    expect(res.status).toBe(400);
  });

  it("returns 401 when no token is provided", async () => {
    const GET = await loadRoute();
    const req = new Request(
      "https://la-schedule-app.local/api/invoice/mileage?location=somewhere",
    );
    const res = await GET(req as never);
    expect(res.status).toBe(401);
  });

  /**
   * Distance Matrix answers API-level failures with HTTP *200* plus an empty
   * `rows`, so `!res.ok` never fires and execution used to fall through to the
   * element check — turning a billing/quota problem into "no_route_found", i.e.
   * blaming the job's address.
   *
   * An HTTP 200 is also cacheable, so Next.js cached that denial per
   * destination URL. After Maps billing was restored, every venue queried
   * during the outage kept returning "no route" while venues first queried
   * afterwards worked — which is why "Rate Field, Chicago, IL" stayed broken
   * but "Rate Field, Chicago,IL" (different URL, different cache key) did not.
   */
  it("reports REQUEST_DENIED as an API failure, not a missing route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "REQUEST_DENIED",
        error_message: "You must enable Billing on the Google Cloud Project",
        origin_addresses: [],
        destination_addresses: [],
        rows: [],
      }),
    }));
    const GET = await loadRoute();
    const res = await GET(makeRequest("Rate Field, Chicago, IL") as never);
    const json = await res.json() as { error: string; reason: string };
    expect(res.status).toBe(502);
    expect(json.error).toBe("distance_api_unavailable");
    expect(json.reason).toBe("REQUEST_DENIED");
  });

  it("reports OVER_QUERY_LIMIT as an API failure too", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "OVER_QUERY_LIMIT", rows: [] }),
    }));
    const GET = await loadRoute();
    const res = await GET(makeRequest("Comerica Park, Detroit, MI") as never);
    expect(res.status).toBe(502);
    expect((await res.json() as { reason: string }).reason).toBe("OVER_QUERY_LIMIT");
  });

  it("does not let Next.js cache the upstream Distance Matrix call", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeDistanceResponse(metersForMiles(15)),
    });
    vi.stubGlobal("fetch", fetchMock);
    const GET = await loadRoute();
    await GET(makeRequest("Dewey Beach, DE") as never);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
  });

  it("still succeeds when the top-level status is OK", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "OK", ...makeDistanceResponse(metersForMiles(93)) }),
    }));
    const GET = await loadRoute();
    const json = await (await GET(
      makeRequest("Chase Center on the Riverfront, Wilmington, DE") as never,
    )).json() as { oneWayMiles: number; plausible: boolean };
    expect(json.oneWayMiles).toBe(93);
    expect(json.plausible).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Drive/fly is decided by the real Dewey -> venue distance, never by the
  // state border. DC/Baltimore/Philadelphia are drives; Chicago/Detroit/
  // Milwaukee/Kansas City are flights.
  // -------------------------------------------------------------------------

  function distanceOnly(miles: number) {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "OK", ...makeDistanceResponse(metersForMiles(miles)) }),
    });
  }

  const DRIVE_CASES: Array<[string, string, number]> = [
    ["Washington DC", "Capital One Arena, Washington, DC", 121],
    ["Baltimore", "Oriole Park at Camden Yards, Baltimore, MD", 118],
    ["Philadelphia", "Xfinity Mobile Arena, Philadelphia, PA", 119],
    ["Newark NJ", "Prudential Center, Newark, NJ", 201],
  ];

  it.each(DRIVE_CASES)(
    "Light Action + %s -> DRIVE / actual venue mileage",
    async (_name, location, miles) => {
      const fetchMock = distanceOnly(miles);
      vi.stubGlobal("fetch", fetchMock);
      const GET = await loadRoute();
      const res = await GET(makeJobRequest(location, {
        calendarId: LA_CALENDAR,
        gigSummary: "LA#70000 — Drive Job",
      }) as never);
      const json = await res.json() as { oneWayMiles: number; basis: string; venue: { oneWayMiles: number } };

      expect(json.basis).toBe("venue");
      expect(json.oneWayMiles).toBe(miles);
      expect(json.venue.oneWayMiles).toBe(miles);
      // One Distance Matrix call, no classification lookup.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("distancematrix");
    },
  );

  const FLY_CASES: Array<[string, string, number]> = [
    ["Chicago", "Rate Field, Chicago, IL", 810],
    ["Detroit", "Comerica Park, Detroit, MI", 638],
    ["Milwaukee", "American Family Field, Milwaukee, WI", 906],
    ["Kansas City", "Kauffman Stadium, Kansas City, MO", 1166],
  ];

  it.each(FLY_CASES)(
    "Light Action + %s -> FLY / PHL 112 & 224",
    async (_name, location, miles) => {
      vi.stubGlobal("fetch", distanceOnly(miles));
      const GET = await loadRoute();
      const res = await GET(makeJobRequest(location, {
        calendarId: LA_CALENDAR,
        gigSummary: "LA#70001 — Fly Job",
      }) as never);
      const json = await res.json() as {
        oneWayMiles: number; roundTripMiles: number; basis: string;
        venue: { oneWayMiles: number; roundTripMiles: number };
        phl: { oneWayMiles: number; roundTripMiles: number };
      };

      expect(json.basis).toBe("phl_flight");
      expect(json.oneWayMiles).toBe(112);
      expect(json.roundTripMiles).toBe(224);
      // The real venue leg is still returned so "Drive to Venue" is instant.
      expect(json.venue).toEqual({ oneWayMiles: miles, roundTripMiles: miles * 2 });
      expect(json.phl).toEqual({ oneWayMiles: 112, roundTripMiles: 224 });
    },
  );

  it("drives at exactly 250 mi and flies at 251 mi", async () => {
    const GET = await loadRoute();

    vi.stubGlobal("fetch", distanceOnly(250));
    const at = await (await GET(makeJobRequest("Right At Threshold", {
      calendarId: LA_CALENDAR, gigSummary: "LA#70002 — Edge",
    }) as never)).json() as { basis: string; oneWayMiles: number };
    expect(at.basis).toBe("venue");
    expect(at.oneWayMiles).toBe(250);

    vi.stubGlobal("fetch", distanceOnly(251));
    const over = await (await GET(makeJobRequest("Just Past Threshold", {
      calendarId: LA_CALENDAR, gigSummary: "LA#70003 — Edge",
    }) as never)).json() as { basis: string; oneWayMiles: number };
    expect(over.basis).toBe("phl_flight");
    expect(over.oneWayMiles).toBe(112);
  });

  it("non-Light-Action jobs are unchanged regardless of distance", async () => {
    const GET = await loadRoute();

    // Overture, far away — still the venue distance, and still flagged
    // implausible exactly as before.
    vi.stubGlobal("fetch", distanceOnly(638));
    const far = await (await GET(makeJobRequest("Comerica Park, Detroit, MI", {
      calendarId: OVERTURE_CALENDAR, gigSummary: "Overture",
    }) as never)).json() as { basis: string; oneWayMiles: number; plausible: boolean; phl?: unknown };
    expect(far.basis).toBe("venue");
    expect(far.oneWayMiles).toBe(638);
    expect(far.plausible).toBe(false);
    expect(far.phl).toBeUndefined();

    // Unknown employer, far away — same.
    vi.stubGlobal("fetch", distanceOnly(322));
    const unknown = await (await GET(makeRequest("Fenwick Island") as never)).json() as
      { basis: string; oneWayMiles: number; plausible: boolean };
    expect(unknown.basis).toBe("venue");
    expect(unknown.oneWayMiles).toBe(322);
    expect(unknown.plausible).toBe(false);
  });

  it("applies the rule via the LA# summary when no calendar id is passed", async () => {
    vi.stubGlobal("fetch", distanceOnly(1166));
    const GET = await loadRoute();
    const json = await (await GET(makeJobRequest("Kauffman Stadium, Kansas City, MO", {
      gigSummary: "LA#71770 — Toby Mac After Game Concert",
    }) as never)).json() as { basis: string; oneWayMiles: number };

    expect(json.basis).toBe("phl_flight");
    expect(json.oneWayMiles).toBe(112);
  });

  it("does not assume a flight when the venue distance cannot be resolved", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "OK", rows: [{ elements: [{ status: "NOT_FOUND" }] }] }),
    }));
    const GET = await loadRoute();
    const res = await GET(makeJobRequest("Somewhere Unresolvable", {
      calendarId: LA_CALENDAR, gigSummary: "LA#70004 — Unknown",
    }) as never);

    // 404 surfaces the uncertainty; the UI prompts manual entry rather than
    // silently billing a flight leg.
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("no_route_found");
  });

  it("does not assume a flight when Distance Matrix is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "REQUEST_DENIED", rows: [] }),
    }));
    const GET = await loadRoute();
    const res = await GET(makeJobRequest("Rate Field, Chicago, IL", {
      calendarId: LA_CALENDAR, gigSummary: "LA#71774 — Cole Swindell",
    }) as never);

    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toBe("distance_api_unavailable");
  });

  it("still returns 404 for a genuine ZERO_RESULTS route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "ZERO_RESULTS",
        rows: [{ elements: [{ status: "ZERO_RESULTS" }] }],
      }),
    }));
    const GET = await loadRoute();
    const res = await GET(makeRequest("Middle of the Atlantic Ocean") as never);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("no_route_found");
  });
});
