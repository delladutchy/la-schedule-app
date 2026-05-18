import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  EDITOR_SESSION_COOKIE_NAME,
  buildEditorSessionCookieValue,
} from "@/lib/editor-auth";

const editorEnv = {
  EDITOR_TOKEN: "legacy-editor-token-0123456789",
  EDITOR_TOKENS_JSON: JSON.stringify({
    jeff: "jeff-editor-token-0123456789",
    dave: "dave-editor-token-0123456789",
    milos: "milos-editor-token-0123456789",
    mike: "mike-editor-token-00123456789",
  }),
};

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ env: editorEnv, file: { timezone: "America/Los_Angeles" } }),
}));

vi.mock("@/lib/job-time", () => ({
  isJeffEditorId: (id: string) => id === "jeff" || id === "legacy",
  normalizeEditorProfile: (id: string) => (id === "legacy" ? "jeff" : id),
  getJobTimeEntry: vi.fn().mockResolvedValue(null),
  upsertClockIn: vi.fn().mockResolvedValue({ id: "uuid", google_event_id: "evt1", editor_profile: "jeff", clock_in_at: new Date().toISOString(), clock_out_at: null }),
  upsertClockOut: vi.fn().mockResolvedValue({ id: "uuid", google_event_id: "evt1", editor_profile: "jeff", clock_in_at: new Date().toISOString(), clock_out_at: new Date().toISOString() }),
}));

vi.mock("@/lib/supabase", () => ({
  SupabaseConfigError: class SupabaseConfigError extends Error {},
  getSupabaseServerClient: vi.fn(),
}));

async function loadGetRoute() {
  const mod = await import("@/app/api/job-time/route");
  return mod.GET;
}

async function loadClockInRoute() {
  const mod = await import("@/app/api/job-time/clock-in/route");
  return mod.POST;
}

async function loadClockOutRoute() {
  const mod = await import("@/app/api/job-time/clock-out/route");
  return mod.POST;
}

describe("GET /api/job-time — authorization", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const GET = await loadGetRoute();
    const req = new Request("http://localhost/api/job-time?eventId=evt1");
    const res = await GET(req);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("allows Jeff with bearer token", async () => {
    const GET = await loadGetRoute();
    const req = new Request("http://localhost/api/job-time?eventId=evt1", {
      headers: { Authorization: "Bearer jeff-editor-token-0123456789" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ entry: null });
  });

  it("allows legacy token (maps to jeff profile)", async () => {
    const GET = await loadGetRoute();
    const req = new Request("http://localhost/api/job-time?eventId=evt1", {
      headers: { Authorization: "Bearer legacy-editor-token-0123456789" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it("rejects Dave with 403", async () => {
    const GET = await loadGetRoute();
    const req = new Request("http://localhost/api/job-time?eventId=evt1", {
      headers: { Authorization: "Bearer dave-editor-token-0123456789" },
    });
    const res = await GET(req);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "forbidden" });
  });

  it("rejects Milos with 403", async () => {
    const GET = await loadGetRoute();
    const req = new Request("http://localhost/api/job-time?eventId=evt1", {
      headers: { Authorization: "Bearer milos-editor-token-0123456789" },
    });
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it("rejects Mike with 403", async () => {
    const GET = await loadGetRoute();
    const req = new Request("http://localhost/api/job-time?eventId=evt1", {
      headers: { Authorization: "Bearer mike-editor-token-00123456789" },
    });
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it("returns 400 when eventId is missing", async () => {
    const GET = await loadGetRoute();
    const req = new Request("http://localhost/api/job-time", {
      headers: { Authorization: "Bearer jeff-editor-token-0123456789" },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "missing_event_id" });
  });
});

describe("POST /api/job-time/clock-in — authorization", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const POST = await loadClockInRoute();
    const req = new Request("http://localhost/api/job-time/clock-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "evt1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("allows Jeff to clock in", async () => {
    const POST = await loadClockInRoute();
    const req = new Request("http://localhost/api/job-time/clock-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer jeff-editor-token-0123456789",
      },
      body: JSON.stringify({ eventId: "evt1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json() as { entry: { editor_profile: string } };
    expect(json.entry).toBeDefined();
  });

  it("rejects Dave from clock-in with 403", async () => {
    const POST = await loadClockInRoute();
    const req = new Request("http://localhost/api/job-time/clock-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer dave-editor-token-0123456789",
      },
      body: JSON.stringify({ eventId: "evt1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/job-time/clock-out — authorization", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const POST = await loadClockOutRoute();
    const req = new Request("http://localhost/api/job-time/clock-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "evt1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("allows Jeff to clock out", async () => {
    const POST = await loadClockOutRoute();
    const req = new Request("http://localhost/api/job-time/clock-out", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer jeff-editor-token-0123456789",
      },
      body: JSON.stringify({ eventId: "evt1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("rejects Milos from clock-out with 403", async () => {
    const POST = await loadClockOutRoute();
    const req = new Request("http://localhost/api/job-time/clock-out", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer milos-editor-token-0123456789",
      },
      body: JSON.stringify({ eventId: "evt1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});

describe("isJeffEditorId helper", () => {
  it("identifies jeff and legacy as Jeff-tier", async () => {
    const { isJeffEditorId } = await import("@/lib/job-time");
    expect(isJeffEditorId("jeff")).toBe(true);
    expect(isJeffEditorId("legacy")).toBe(true);
    expect(isJeffEditorId("dave")).toBe(false);
    expect(isJeffEditorId("milos")).toBe(false);
    expect(isJeffEditorId("mike")).toBe(false);
    expect(isJeffEditorId("")).toBe(false);
  });

  it("normalizes legacy to jeff in the DB profile", async () => {
    const { normalizeEditorProfile } = await import("@/lib/job-time");
    expect(normalizeEditorProfile("jeff")).toBe("jeff");
    expect(normalizeEditorProfile("legacy")).toBe("jeff");
    expect(normalizeEditorProfile("dave")).toBe("dave");
  });
});
