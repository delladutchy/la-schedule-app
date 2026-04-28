import { beforeEach, describe, expect, it, vi } from "vitest";

const buildAndPersistSnapshot = vi.fn();

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    env: {
      GOOGLE_WEBHOOK_TOKEN: "google-webhook-token-0123456789",
    },
  }),
}));

vi.mock("@/lib/sync", () => ({
  buildAndPersistSnapshot: (...args: unknown[]) => buildAndPersistSnapshot(...args),
}));

async function loadPost() {
  const mod = await import("@/app/api/google/calendar/webhook/route");
  return mod.POST;
}

describe("/api/google/calendar/webhook", () => {
  beforeEach(() => {
    buildAndPersistSnapshot.mockReset();
  });

  it("returns 401 when token is missing", async () => {
    const POST = await loadPost();
    const req = new Request("http://localhost/api/google/calendar/webhook", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(buildAndPersistSnapshot).not.toHaveBeenCalled();
  });

  it("returns 401 for invalid token", async () => {
    const POST = await loadPost();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const req = new Request("http://localhost/api/google/calendar/webhook?token=wrong-token", { method: "POST" });
    try {
      const res = await POST(req);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
      expect(buildAndPersistSnapshot).not.toHaveBeenCalled();
      const logs = infoSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logs).toContain("[google:webhook] unauthorized");
      expect(logs).not.toContain("wrong-token");
      expect(logs).not.toContain("google-webhook-token-0123456789");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("accepts valid query token and syncs snapshot", async () => {
    buildAndPersistSnapshot.mockResolvedValue({
      status: "ok",
      snapshot: {
        busy: [],
      },
    });
    const POST = await loadPost();
    const req = new Request(
      "http://localhost/api/google/calendar/webhook?token=google-webhook-token-0123456789",
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; durationMs: number };
    expect(body.status).toBe("ok");
    expect(typeof body.durationMs).toBe("number");
    expect(buildAndPersistSnapshot).toHaveBeenCalledTimes(1);
  });

  it("accepts valid x-goog-channel-token header and syncs snapshot", async () => {
    buildAndPersistSnapshot.mockResolvedValue({
      status: "ok",
      snapshot: {
        busy: [],
      },
    });
    const POST = await loadPost();
    const req = new Request("http://localhost/api/google/calendar/webhook", {
      method: "POST",
      headers: {
        "x-goog-channel-token": "google-webhook-token-0123456789",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok" });
    expect(buildAndPersistSnapshot).toHaveBeenCalledTimes(1);
  });

  it("returns safe failure response when sync fails", async () => {
    buildAndPersistSnapshot.mockResolvedValue({
      status: "failed",
      error: "freebusy_error",
      erroredCalendarIds: ["calendar-1"],
    });
    const POST = await loadPost();
    const req = new Request(
      "http://localhost/api/google/calendar/webhook?token=google-webhook-token-0123456789",
      { method: "POST" },
    );
    const res = await POST(req);
    expect(res.status).toBe(502);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("failed");
    expect(body.error).toBe("freebusy_error");
    expect(Array.isArray(body.erroredCalendarIds)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("google-webhook-token-0123456789");
  });
});
