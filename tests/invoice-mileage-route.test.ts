import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    env: {
      EDITOR_TOKEN: "jeff-token-abc123",
      EDITOR_TOKENS_JSON: JSON.stringify({ jeff: "jeff-token-abc123" }),
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
});
