import { beforeEach, describe, expect, it, vi } from "vitest";

const createAllDayEvent = vi.fn();
const buildAndPersistSnapshot = vi.fn();
const readCurrentSnapshot = vi.fn();
const appendAuditEvent = vi.fn();
const authorizeEditorRequest = vi.fn();
const sendCreateJobNotification = vi.fn();

const snapshot = {
  version: 1 as const,
  generatedAtUtc: "2026-04-28T00:00:00.000Z",
  windowStartUtc: "2026-04-01T00:00:00.000Z",
  windowEndUtc: "2026-06-01T00:00:00.000Z",
  busy: [],
  sourceCalendarIds: ["la-jobs@group.calendar.google.com"],
  config: {
    timezone: "America/New_York",
    workdayStartHour: 9,
    workdayEndHour: 18,
    hideWeekends: false,
    showTentative: false,
    pageTitle: "LA Schedule",
  },
};

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    file: {
      timezone: "America/New_York",
    },
    env: {
      BLOBS_STORE_NAME: "availability-snapshots",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REFRESH_TOKEN: "refresh-token",
      GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
      EDITOR_TOKEN: "legacy-editor-token-0123456789",
      EDITOR_TOKENS_JSON: JSON.stringify({
        jeff: "jeff-editor-token-0123456789",
        dave: "dave-editor-token-0123456789",
        milos: "milos-editor-token-0123456789",
      }),
      RESEND_API_KEY: "resend-key",
      NOTIFY_EMAIL_TO: "jeff@example.com",
      NOTIFY_EMAIL_FROM: "la-schedule@example.com",
    },
  }),
}));

vi.mock("@/lib/google", () => ({
  CalendarEventAlreadyExistsError: class CalendarEventAlreadyExistsError extends Error {},
  createAllDayEvent: (...args: unknown[]) => createAllDayEvent(...args),
}));

vi.mock("@/lib/sync", () => ({
  buildAndPersistSnapshot: (...args: unknown[]) => buildAndPersistSnapshot(...args),
}));

vi.mock("@/lib/store", () => ({
  readCurrentSnapshot: (...args: unknown[]) => readCurrentSnapshot(...args),
}));

vi.mock("@/lib/audit-log", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit-log")>("@/lib/audit-log");
  return {
    ...actual,
    appendAuditEvent: (...args: unknown[]) => appendAuditEvent(...args),
  };
});

vi.mock("@/lib/editor-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/editor-auth")>("@/lib/editor-auth");
  return {
    ...actual,
    authorizeEditorRequest: (...args: unknown[]) => authorizeEditorRequest(...args),
  };
});

vi.mock("@/lib/notifications", () => ({
  sendCreateJobNotification: (...args: unknown[]) => sendCreateJobNotification(...args),
}));

async function loadRoute() {
  const mod = await import("@/app/api/gigs/create/route");
  return mod.POST;
}

describe("/api/gigs/create audit logging", () => {
  beforeEach(() => {
    createAllDayEvent.mockReset();
    buildAndPersistSnapshot.mockReset();
    readCurrentSnapshot.mockReset();
    appendAuditEvent.mockReset();
    authorizeEditorRequest.mockReset();
    sendCreateJobNotification.mockReset();
  });

  it("appends audit event after successful create", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });
    readCurrentSnapshot.mockResolvedValue(snapshot);
    createAllDayEvent.mockResolvedValue({ id: "evt-123", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });

    const POST = await loadRoute();
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12345 — Test Job",
        startDate: "2026-05-07",
        endDate: "2026-05-08",
        description: "Call Time: 8:00 AM",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    const [storeName, payload] = appendAuditEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(storeName).toBe("availability-snapshots");
    expect(payload.editorId).toBe("jeff");
    expect(payload.action).toBe("create");
    expect(payload.status).toBe("success");
    expect(sendCreateJobNotification).toHaveBeenCalledTimes(1);
  });

  it("does not append audit when unauthorized", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: false });
    const POST = await loadRoute();
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12345 — Test Job",
        date: "2026-05-07",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(appendAuditEvent).not.toHaveBeenCalled();
    expect(sendCreateJobNotification).not.toHaveBeenCalled();
  });

  it("does not send notification when audit append fails", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });
    readCurrentSnapshot.mockResolvedValue(snapshot);
    createAllDayEvent.mockResolvedValue({ id: "evt-123", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    appendAuditEvent.mockRejectedValue(new Error("audit write failed"));

    const POST = await loadRoute();
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12345 — Test Job",
        date: "2026-05-07",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    expect(sendCreateJobNotification).not.toHaveBeenCalled();
  });

  it("does not append audit or send notification when post-sync fails", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });
    readCurrentSnapshot.mockResolvedValue(snapshot);
    createAllDayEvent.mockResolvedValue({ id: "evt-123", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "failed", error: "sync failed" });

    const POST = await loadRoute();
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12345 — Test Job",
        date: "2026-05-07",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(appendAuditEvent).not.toHaveBeenCalled();
    expect(sendCreateJobNotification).not.toHaveBeenCalled();
  });

  it("still succeeds when notification sending fails", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "dave" });
    readCurrentSnapshot.mockResolvedValue(snapshot);
    createAllDayEvent.mockResolvedValue({ id: "evt-123", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    sendCreateJobNotification.mockRejectedValue(new Error("resend error"));

    const POST = await loadRoute();
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12345 — Test Job",
        date: "2026-05-07",
        description: "Call Time: 9:00 AM",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    expect(sendCreateJobNotification).toHaveBeenCalledTimes(1);
  });
});
