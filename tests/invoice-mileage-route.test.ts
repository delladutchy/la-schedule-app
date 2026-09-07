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
  // Out-of-state Light Action gigs are flown: the reimbursable drive is
  // Dewey <-> PHL, not Dewey <-> venue.
  // -------------------------------------------------------------------------

  it("Light Action + Delaware venue -> normal Dewey-to-venue mileage", async () => {
    const fetchMock = vi.fn()
      // 1st call: Places state lookup -> DE
      .mockResolvedValueOnce(placesStateResponse("DE"))
      // 2nd call: Distance Matrix to the actual venue
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "OK", ...makeDistanceResponse(metersForMiles(93)) }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadRoute();
    const res = await GET(makeJobRequest("Chase Center on the Riverfront, Wilmington, DE", {
      calendarId: LA_CALENDAR,
      gigSummary: "LA#72813 — Chase Center",
    }) as never);
    const json = await res.json() as { oneWayMiles: number; basis: string };

    expect(json.basis).toBe("venue");
    expect(json.oneWayMiles).toBe(93);
    // Distance Matrix was actually consulted for the venue.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("distancematrix");
  });

  it("Light Action + out-of-state venue -> default Dewey-to-PHL mileage", async () => {
    // Only the Places state lookup should happen; PHL is a known fixed route.
    const fetchMock = vi.fn().mockResolvedValueOnce(placesStateResponse("IL"));
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadRoute();
    const res = await GET(makeJobRequest("Rate Field, Chicago, IL", {
      calendarId: LA_CALENDAR,
      gigSummary: "LA#71774 — Cole Swindell After Game Concert",
    }) as never);
    const json = await res.json() as {
      oneWayMiles: number; roundTripMiles: number; plausible: boolean;
      basis: string; routeLabel: string; destinationState: string;
    };

    expect(json.basis).toBe("phl_flight");
    expect(json.oneWayMiles).toBe(112);
    expect(json.roundTripMiles).toBe(224);
    expect(json.plausible).toBe(true);
    expect(json.routeLabel).toContain("PHL");
    expect(json.destinationState).toBe("IL");
    // No Distance Matrix call at all — the PHL route is predetermined.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("places.googleapis.com");
  });

  it("non-Light-Action + out-of-state venue -> unchanged venue mileage", async () => {
    // Overture booking: no Places lookup, straight to Distance Matrix.
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "OK", ...makeDistanceResponse(metersForMiles(150)) }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadRoute();
    const res = await GET(makeJobRequest("Somewhere, Philadelphia, PA", {
      calendarId: OVERTURE_CALENDAR,
      gigSummary: "Overture",
    }) as never);
    const json = await res.json() as { oneWayMiles: number; basis: string };

    expect(json.basis).toBe("venue");
    expect(json.oneWayMiles).toBe(150);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("distancematrix");
  });

  it("does not assume PHL when the destination state cannot be determined", async () => {
    const fetchMock = vi.fn()
      // Places returns a place with no administrative_area_level_1.
      .mockResolvedValueOnce(placesStateResponse(null))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "OK", ...makeDistanceResponse(metersForMiles(322)) }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadRoute();
    const res = await GET(makeJobRequest("Fenwick Island", {
      calendarId: LA_CALENDAR,
      gigSummary: "LA#70001 — Ambiguous Venue",
    }) as never);
    const json = await res.json() as { oneWayMiles: number; basis: string; plausible: boolean };

    // Falls back to the venue rather than silently billing a flight.
    expect(json.basis).toBe("venue");
    expect(json.oneWayMiles).toBe(322);
    expect(json.plausible).toBe(false);
  });

  it("does not assume PHL when the Places lookup itself fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "OK", ...makeDistanceResponse(metersForMiles(40)) }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadRoute();
    const res = await GET(makeJobRequest("Rehoboth Beach, DE", {
      calendarId: LA_CALENDAR,
      gigSummary: "LA#70002 — Local",
    }) as never);
    const json = await res.json() as { oneWayMiles: number; basis: string };

    expect(json.basis).toBe("venue");
    expect(json.oneWayMiles).toBe(40);
  });

  it("applies the PHL rule via the LA# summary when no calendar id is passed", async () => {
    // InvoiceWorklist rows carry no calendarId; the LA# convention identifies them.
    const fetchMock = vi.fn().mockResolvedValueOnce(placesStateResponse("MO"));
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadRoute();
    const res = await GET(makeJobRequest("Kauffman Stadium, Kansas City, MO", {
      gigSummary: "LA#71770 — Toby Mac After Game Concert",
    }) as never);
    const json = await res.json() as { oneWayMiles: number; basis: string };

    expect(json.basis).toBe("phl_flight");
    expect(json.oneWayMiles).toBe(112);
  });

  it("leaves a job with no identity on the venue path", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "OK", ...makeDistanceResponse(metersForMiles(88)) }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadRoute();
    const res = await GET(makeRequest("Some Venue, Baltimore, MD") as never);
    const json = await res.json() as { oneWayMiles: number; basis: string };

    expect(json.basis).toBe("venue");
    expect(json.oneWayMiles).toBe(88);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
