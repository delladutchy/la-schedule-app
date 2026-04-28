import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/editor/sync/route";

describe("/api/editor/sync auth", () => {
  it("rejects POST without bearer token", async () => {
    const req = new Request("http://localhost/api/editor/sync", {
      method: "POST",
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });
});
