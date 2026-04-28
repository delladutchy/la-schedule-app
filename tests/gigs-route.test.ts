import { describe, expect, it } from "vitest";
import { DELETE, PATCH } from "@/app/api/gigs/[eventId]/route";

describe("/api/gigs/[eventId] auth", () => {
  it("rejects PATCH without bearer token", async () => {
    const req = new Request("http://localhost/api/gigs/g123", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#71411 — Wilmington Flower Market",
        date: "2026-05-06",
      }),
    });

    const res = await PATCH(req, { params: { eventId: "g123" } });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects DELETE without bearer token", async () => {
    const req = new Request("http://localhost/api/gigs/g123", {
      method: "DELETE",
    });

    const res = await DELETE(req, { params: { eventId: "g123" } });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });
});
