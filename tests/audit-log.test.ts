import { describe, expect, it } from "vitest";
import { AUDIT_EVENT_LIMIT, appendAuditEvent, readAuditEvents } from "@/lib/audit-log";

describe("audit log store", () => {
  it("caps stored audit events to latest configured limit", async () => {
    const storeName = `audit-log-cap-${Date.now()}`;
    for (let i = 0; i < AUDIT_EVENT_LIMIT + 5; i += 1) {
      await appendAuditEvent(storeName, {
        editorId: "jeff",
        action: "sync",
        status: "success",
      });
    }

    const events = await readAuditEvents(storeName, 500);
    expect(events).toHaveLength(AUDIT_EVENT_LIMIT);
  });

  it("does not store raw token fields", async () => {
    const storeName = `audit-log-safety-${Date.now()}`;
    await appendAuditEvent(storeName, {
      editorId: "dave",
      action: "create",
      status: "success",
      summary: "LA#12345 — Test",
      startDate: "2026-05-07",
      endDate: "2026-05-07",
    });

    const events = await readAuditEvents(storeName);
    expect(events.length).toBeGreaterThan(0);
    const latest = events[0] as Record<string, unknown>;
    expect(latest.editorId).toBe("dave");
    expect(latest).not.toHaveProperty("token");
    expect(latest).not.toHaveProperty("authorization");
  });
});
