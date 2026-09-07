import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Regression: a valid Google Calendar location must never be reported as
 * missing just because the geocoder could not answer.
 *
 * Production had Google Maps billing disabled, so every Places call returned
 * 403. `/api/locations/search` collapsed that into `{ suggestions: [] }` with
 * HTTP 200 — indistinguishable from "we searched and this place does not
 * exist" — and LocationMapPreview rendered "Location not found" over real
 * addresses like "Rate Field, Chicago, IL" on 100% of jobs.
 *
 * The contract these tests pin down:
 *   - the route reports `status: "unavailable"` when the lookup never ran, and
 *     `status: "ok"` only when it really ran (even if it matched nothing);
 *   - geocodeQuery maps those to distinct outcomes, and only ever says
 *     'not-found' for a lookup that actually completed.
 */

const REAL_LOCATION = "Rate Field, Chicago, IL";

async function loadRoute() {
  const mod = await import("@/app/api/locations/search/route");
  return mod.GET;
}

function req(q: string) {
  return new NextRequest(
    `http://localhost/api/locations/search?q=${encodeURIComponent(q)}`,
  );
}

describe("/api/locations/search — outage vs genuine miss", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_PLACES_API_KEY;
  });

  it('reports "unavailable" when Places denies the call (billing disabled)', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 403, status: "PERMISSION_DENIED" },
          }),
          { status: 403 },
        ),
      ),
    );

    const GET = await loadRoute();
    const body = await (await GET(req(REAL_LOCATION))).json();

    expect(body.suggestions).toEqual([]);
    // The critical bit: not silently an empty result set.
    expect(body.status).toBe("unavailable");
  });

  it('reports "unavailable" when the request throws', async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

    const GET = await loadRoute();
    const body = await (await GET(req(REAL_LOCATION))).json();

    expect(body.suggestions).toEqual([]);
    expect(body.status).toBe("unavailable");
  });

  it('reports "ok" when the lookup ran and genuinely matched nothing', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ places: [] }), { status: 200 }),
      ),
    );

    const GET = await loadRoute();
    const body = await (await GET(req("qqqqzzzz not a real place"))).json();

    expect(body.suggestions).toEqual([]);
    expect(body.status).toBe("ok");
  });

  it("still returns coordinates on a successful match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            places: [
              {
                displayName: { text: "Rate Field" },
                formattedAddress: "333 W 35th St, Chicago, IL 60616, USA",
                location: { latitude: 41.83, longitude: -87.634 },
                addressComponents: [
                  { longText: "Chicago", types: ["locality"] },
                  { shortText: "IL", types: ["administrative_area_level_1"] },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const GET = await loadRoute();
    const body = await (await GET(req(REAL_LOCATION))).json();

    expect(body.status).toBe("ok");
    expect(body.suggestions[0]).toMatchObject({
      displayName: "Rate Field, Chicago, IL",
      lat: 41.83,
      lon: -87.634,
    });
  });
});

describe("geocodeQuery — never calls a real location 'not found' on an outage", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function loadGeocode() {
    const mod = await import("@/components/LocationMapPreview");
    return mod.geocodeQuery;
  }

  it("returns 'unavailable' (not 'not-found') when the route flags an outage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ suggestions: [], status: "unavailable" }),
          { status: 200 },
        ),
      ),
    );

    const geocodeQuery = await loadGeocode();
    const outcome = await geocodeQuery(REAL_LOCATION, new AbortController().signal);

    expect(outcome.status).toBe("unavailable");
    expect(outcome.status).not.toBe("not-found");
  });

  it("returns 'unavailable' for any non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 503 })),
    );

    const geocodeQuery = await loadGeocode();
    const outcome = await geocodeQuery(REAL_LOCATION, new AbortController().signal);

    expect(outcome.status).toBe("unavailable");
  });

  it("returns 'not-found' only when the lookup ran and matched nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ suggestions: [], status: "ok" }), {
          status: 200,
        }),
      ),
    );

    const geocodeQuery = await loadGeocode();
    const outcome = await geocodeQuery("qqqqzzzz", new AbortController().signal);

    expect(outcome.status).toBe("not-found");
  });

  it("returns coordinates on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            suggestions: [{ lat: 41.83, lon: -87.634 }],
            status: "ok",
          }),
          { status: 200 },
        ),
      ),
    );

    const geocodeQuery = await loadGeocode();
    const outcome = await geocodeQuery(
      "Rate Field unique-cache-key",
      new AbortController().signal,
    );

    expect(outcome).toEqual({ status: "ok", coords: { lat: 41.83, lon: -87.634 } });
  });

  it("does not cache an outage onto a valid location", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ suggestions: [], status: "unavailable" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ suggestions: [{ lat: 41.83, lon: -87.634 }], status: "ok" }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const geocodeQuery = await loadGeocode();
    const signal = new AbortController().signal;
    const query = "Kauffman Stadium, Kansas City, MO";

    expect((await geocodeQuery(query, signal)).status).toBe("unavailable");
    // Once billing is restored the same location must resolve — a cached
    // failure would have made the outage permanent for the session.
    expect(await geocodeQuery(query, signal)).toEqual({
      status: "ok",
      coords: { lat: 41.83, lon: -87.634 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
