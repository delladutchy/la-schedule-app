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

const mockEnv = {
  BLOBS_STORE_NAME: "availability-snapshots",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_REFRESH_TOKEN: "refresh-token",
  GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
  OVERTURE_CALENDAR_ID: "overture@group.calendar.google.com",
  EDITOR_TOKEN: "legacy-editor-token-0123456789",
  EDITOR_TOKENS_JSON: JSON.stringify({
    jeff: "jeff-editor-token-0123456789",
    dave: "dave-editor-token-0123456789",
    milos: "milos-editor-token-0123456789",
    mike: "mike-editor-token-0123456789",
  }),
  RESEND_API_KEY: "resend-key",
  NOTIFY_EMAIL_TO: "jeff@example.com",
  NOTIFY_EMAIL_FROM: "la-schedule@example.com",
};

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    file: {
      timezone: "America/New_York",
    },
    env: mockEnv,
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
    mockEnv.OVERTURE_CALENDAR_ID = "overture@group.calendar.google.com";
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
    expect(createAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerEditor: "jeff",
      }),
    );
    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    const [storeName, payload] = appendAuditEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(storeName).toBe("availability-snapshots");
    expect(payload.editorId).toBe("jeff");
    expect(payload.action).toBe("create");
    expect(payload.status).toBe("success");
    expect(sendCreateJobNotification).toHaveBeenCalledTimes(1);
  });

  it("stores owner metadata for limited editor create", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "milos" });
    readCurrentSnapshot.mockResolvedValue(snapshot);
    createAllDayEvent.mockResolvedValue({ id: "evt-limited", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });

    const POST = await loadRoute();
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12355 — Milos Test",
        startDate: "2026-05-11",
        endDate: "2026-05-11",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(createAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerEditor: "milos",
      }),
    );
  });

  it("routes Mike create to Overture calendar with neutral summary", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "mike" });
    readCurrentSnapshot.mockResolvedValue(snapshot);
    createAllDayEvent.mockResolvedValue({ id: "evt-mike", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });

    const POST = await loadRoute();
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Ignored by server",
        startDate: "2026-05-12",
        endDate: "2026-05-12",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(createAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "overture@group.calendar.google.com",
        ownerEditor: "mike",
        summary: "Overture",
      }),
    );
  });

  it("routes Jeff create to Overture when bookingMode=overture", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });
    readCurrentSnapshot.mockResolvedValue(snapshot);
    createAllDayEvent.mockResolvedValue({ id: "evt-jeff-overture", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });

    const POST = await loadRoute();
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#77777 — Should Be Ignored",
        bookingMode: "overture",
        startDate: "2026-05-13",
        endDate: "2026-05-13",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(createAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "overture@group.calendar.google.com",
        ownerEditor: "jeff",
        summary: "Overture",
      }),
    );
  });

  it("keeps Jeff default create on LA calendar when no bookingMode override is provided", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });
    readCurrentSnapshot.mockResolvedValue(snapshot);
    createAllDayEvent.mockResolvedValue({ id: "evt-jeff-la", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });

    const POST = await loadRoute();
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#77888 — Jeff LA Job",
        startDate: "2026-05-14",
        endDate: "2026-05-14",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(createAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "la-jobs@group.calendar.google.com",
        ownerEditor: "jeff",
        summary: "LA#77888 — Jeff LA Job",
      }),
    );
  });

  it("ignores Dave bookingMode=overture spoof and keeps LA calendar", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "dave" });
    readCurrentSnapshot.mockResolvedValue(snapshot);
    createAllDayEvent.mockResolvedValue({ id: "evt-dave-la", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });

    const POST = await loadRoute();
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#70001 — Dave LA Job",
        bookingMode: "overture",
        startDate: "2026-05-15",
        endDate: "2026-05-15",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(createAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "la-jobs@group.calendar.google.com",
        ownerEditor: "dave",
        summary: "LA#70001 — Dave LA Job",
      }),
    );
  });

  it("ignores Milos bookingMode=overture spoof and keeps LA calendar", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "milos" });
    readCurrentSnapshot.mockResolvedValue(snapshot);
    createAllDayEvent.mockResolvedValue({ id: "evt-milos-la", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });

    const POST = await loadRoute();
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#70002 — Milos LA Job",
        bookingMode: "overture",
        startDate: "2026-05-16",
        endDate: "2026-05-16",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(createAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "la-jobs@group.calendar.google.com",
        ownerEditor: "milos",
        summary: "LA#70002 — Milos LA Job",
      }),
    );
  });

  it("fails Mike create safely when Overture calendar is not configured", async () => {
    mockEnv.OVERTURE_CALENDAR_ID = "";
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "mike" });

    const POST = await loadRoute();
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Ignored by server",
        date: "2026-05-12",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "overture_calendar_not_configured",
      message: "Overture calendar is not configured.",
    });
    expect(createAllDayEvent).not.toHaveBeenCalled();
  });

  it("fails Jeff overture create safely when Overture calendar is not configured", async () => {
    mockEnv.OVERTURE_CALENDAR_ID = "";
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });

    const POST = await loadRoute();
    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#70003 — Ignored for Overture mode",
        bookingMode: "overture",
        date: "2026-05-17",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "overture_calendar_not_configured",
      message: "Overture calendar is not configured.",
    });
    expect(createAllDayEvent).not.toHaveBeenCalled();
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
