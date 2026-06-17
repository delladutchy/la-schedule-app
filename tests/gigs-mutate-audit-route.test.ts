import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_DAILY_DETAILS_BLOCK_END,
  APP_DAILY_DETAILS_BLOCK_START,
  mergeGigDescriptionWithDailyDetailsBlock,
} from "@/lib/gigs";

const updateAllDayEvent = vi.fn();
const deleteCalendarEvent = vi.fn();
const buildAndPersistSnapshot = vi.fn();
const readCurrentSnapshot = vi.fn();
const appendAuditEvent = vi.fn();
const authorizeEditorRequest = vi.fn();
const refreshSnapshotAfterMutation = vi.fn();
const scheduleDeferredReconciliationSync = vi.fn();
const closeJobTimeEntriesForDeletedEvent = vi.fn();

const snapshot = {
  version: 1 as const,
  generatedAtUtc: "2026-04-28T00:00:00.000Z",
  windowStartUtc: "2026-04-01T00:00:00.000Z",
  windowEndUtc: "2026-06-01T00:00:00.000Z",
  busy: [],
  namedEvents: [{
    startUtc: "2026-05-09T00:00:00.000Z",
    endUtc: "2026-05-10T00:00:00.000Z",
    summary: "LA#12347 — Delete Me",
    eventId: "evt-delete",
    description: "Call Time: 10:00 AM",
    ownerEditor: "milos",
    calendarId: "la-jobs@group.calendar.google.com",
    displayMode: "details" as const,
  }],
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
  updateAllDayEvent: (...args: unknown[]) => updateAllDayEvent(...args),
  deleteCalendarEvent: (...args: unknown[]) => deleteCalendarEvent(...args),
  buildWarmedCalendarAuth: () => Promise.resolve({
    getAccessToken: () => Promise.resolve({ token: "mock-access-token" }),
  }),
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

vi.mock("@/lib/mutation-postsync", () => ({
  refreshSnapshotAfterMutation: (...args: unknown[]) => refreshSnapshotAfterMutation(...args),
  scheduleDeferredReconciliationSync: (...args: unknown[]) => scheduleDeferredReconciliationSync(...args),
}));

vi.mock("@/lib/job-time", () => ({
  closeJobTimeEntriesForDeletedEvent: (...args: unknown[]) => closeJobTimeEntriesForDeletedEvent(...args),
}));

async function loadRoutes() {
  const mod = await import("@/app/api/gigs/[eventId]/route");
  return { PATCH: mod.PATCH, DELETE: mod.DELETE };
}

describe("/api/gigs/[eventId] audit logging", () => {
  beforeEach(() => {
    updateAllDayEvent.mockReset();
    deleteCalendarEvent.mockReset();
    buildAndPersistSnapshot.mockReset();
    readCurrentSnapshot.mockReset();
    appendAuditEvent.mockReset();
    authorizeEditorRequest.mockReset();
    refreshSnapshotAfterMutation.mockReset();
    scheduleDeferredReconciliationSync.mockReset();
    closeJobTimeEntriesForDeletedEvent.mockReset();
    mockEnv.OVERTURE_CALENDAR_ID = "overture@group.calendar.google.com";
    refreshSnapshotAfterMutation.mockResolvedValue({ status: "ok", snapshot });
    scheduleDeferredReconciliationSync.mockResolvedValue({ queued: true, statusCode: 202 });
    closeJobTimeEntriesForDeletedEvent.mockResolvedValue(0);
  });

  it("appends audit event after successful edit", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "dave" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-edit",
        ownerEditor: "dave",
        calendarId: "la-jobs@group.calendar.google.com",
      }],
    });
    updateAllDayEvent.mockResolvedValue({ id: "evt-edit", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-edit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12346 — Updated Job",
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-edit" } });
    expect(res.status).toBe(200);
    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    const payload = appendAuditEvent.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.editorId).toBe("dave");
    expect(payload.action).toBe("edit");
  });

  it("PATCH forwards location to Google update and fast snapshot patch", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "dave" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-edit-location",
        ownerEditor: "dave",
        calendarId: "la-jobs@group.calendar.google.com",
      }],
    });
    updateAllDayEvent.mockResolvedValue({ id: "evt-edit-location", status: "confirmed" });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-edit-location", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12346 — Updated Job",
        startDate: "2026-05-08",
        endDate: "2026-05-08",
        location: "  100 Universal City Plaza, Universal City, CA  ",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-edit-location" } });
    expect(res.status).toBe(200);
    expect(updateAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt-edit-location",
        location: "100 Universal City Plaza, Universal City, CA",
      }),
    );
    expect(refreshSnapshotAfterMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: expect.objectContaining({
          action: "edit",
          event: expect.objectContaining({
            location: "100 Universal City Plaza, Universal City, CA",
          }),
        }),
      }),
    );
  });

  it("preserves existing owner metadata on PATCH updates", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "dave" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      busy: [{
        startUtc: "2026-05-08T00:00:00.000Z",
        endUtc: "2026-05-09T00:00:00.000Z",
      }],
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-edit-owner",
        startUtc: "2026-05-08T00:00:00.000Z",
        endUtc: "2026-05-09T00:00:00.000Z",
        ownerEditor: "milos",
      }],
    });
    updateAllDayEvent.mockResolvedValue({ id: "evt-edit-owner", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-edit-owner", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12346 — Updated Job",
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-edit-owner" } });
    expect(res.status).toBe(200);
    expect(updateAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt-edit-owner",
        ownerEditor: "milos",
      }),
    );
  });

  it("PATCH forwards merged description without changing human text outside the app block", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "dave" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      busy: [{
        startUtc: "2026-05-08T00:00:00.000Z",
        endUtc: "2026-05-09T00:00:00.000Z",
      }],
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-edit-desc",
        startUtc: "2026-05-08T00:00:00.000Z",
        endUtc: "2026-05-09T00:00:00.000Z",
        ownerEditor: "dave",
      }],
    });
    updateAllDayEvent.mockResolvedValue({ id: "evt-edit-desc", status: "confirmed" });

    const originalHuman = "Shoot notes line A\nShoot notes line B";
    const mergedDescription = mergeGigDescriptionWithDailyDetailsBlock(originalHuman, {
      callTime: "9:00 AM",
      dayDetails: [{ date: "2026-05-08", startTime: "9:00 AM" }],
    });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-edit-desc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12346 — Updated Job",
        description: mergedDescription,
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-edit-desc" } });
    expect(res.status).toBe(200);
    expect(updateAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        description: mergedDescription,
      }),
    );
    expect(mergedDescription).toContain(originalHuman);
    expect(mergedDescription).toContain(APP_DAILY_DETAILS_BLOCK_START);
    expect(mergedDescription).toContain(APP_DAILY_DETAILS_BLOCK_END);
  });

  it("PATCH keeps malformed existing block text and only appends new app-owned block", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "dave" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      busy: [{
        startUtc: "2026-05-08T00:00:00.000Z",
        endUtc: "2026-05-09T00:00:00.000Z",
      }],
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-edit-malformed-desc",
        startUtc: "2026-05-08T00:00:00.000Z",
        endUtc: "2026-05-09T00:00:00.000Z",
        ownerEditor: "dave",
      }],
    });
    updateAllDayEvent.mockResolvedValue({ id: "evt-edit-malformed-desc", status: "confirmed" });

    const malformedExistingDescription = [
      "Human notes stay as-is",
      APP_DAILY_DETAILS_BLOCK_START,
      "{ bad-json",
    ].join("\n");
    const mergedDescription = mergeGigDescriptionWithDailyDetailsBlock(malformedExistingDescription, {
      callTime: "10:30 AM",
      dayDetails: [{ date: "2026-05-08", startTime: "10:30 AM" }],
    });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-edit-malformed-desc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12346 — Updated Job",
        description: mergedDescription,
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-edit-malformed-desc" } });
    expect(res.status).toBe(200);
    expect(updateAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        description: mergedDescription,
      }),
    );
    expect(mergedDescription).toContain(malformedExistingDescription);
    expect((mergedDescription?.match(new RegExp(APP_DAILY_DETAILS_BLOCK_START, "g")) ?? []).length).toBe(2);
  });

  it("allows limited editor to edit own event", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "milos" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      busy: [{
        startUtc: "2026-05-08T00:00:00.000Z",
        endUtc: "2026-05-09T00:00:00.000Z",
      }],
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-own-edit",
        startUtc: "2026-05-08T00:00:00.000Z",
        endUtc: "2026-05-09T00:00:00.000Z",
        ownerEditor: "milos",
      }],
    });
    updateAllDayEvent.mockResolvedValue({ id: "evt-own-edit", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-own-edit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12346 — Updated Job",
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-own-edit" } });
    expect(res.status).toBe(200);
    expect(updateAllDayEvent).toHaveBeenCalled();
  });

  it("appends audit event after successful delete", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "milos" });
    readCurrentSnapshot.mockResolvedValue(snapshot);
    deleteCalendarEvent.mockResolvedValue({ id: "evt-delete" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    const { DELETE } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-delete" } });
    expect(res.status).toBe(200);
    expect(appendAuditEvent).toHaveBeenCalledTimes(1);
    const payload = appendAuditEvent.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.editorId).toBe("milos");
    expect(payload.action).toBe("delete");
  });

  it("allows full editor to delete non-owned event", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        ownerEditor: "milos",
      }],
    });
    deleteCalendarEvent.mockResolvedValue({ id: "evt-delete" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    const { DELETE } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-delete" } });
    expect(res.status).toBe(200);
    expect(deleteCalendarEvent).toHaveBeenCalledTimes(1);
  });

  it("blocks limited editor from editing non-owned event", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "milos" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-edit",
        ownerEditor: "dave",
      }],
    });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-edit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12346 — Updated Job",
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-edit" } });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "forbidden",
      message: "Only the creator can edit this booking.",
    });
    expect(updateAllDayEvent).not.toHaveBeenCalled();
    expect(appendAuditEvent).not.toHaveBeenCalled();
  });

  it("blocks limited editor from deleting unknown-owner event", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "milos" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        ownerEditor: undefined,
      }],
    });
    const { DELETE } = await loadRoutes();
    const req = new Request("http://localhost/api/gigs/evt-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-delete" } });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "forbidden",
      message: "Only the creator can edit this booking.",
    });
    expect(deleteCalendarEvent).not.toHaveBeenCalled();
    expect(appendAuditEvent).not.toHaveBeenCalled();
  });

  it("blocks Milos from deleting Dave-owned LA event", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "milos" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-dave-delete",
        ownerEditor: "dave",
        calendarId: "la-jobs@group.calendar.google.com",
      }],
    });
    const { DELETE } = await loadRoutes();
    const req = new Request("http://localhost/api/gigs/evt-dave-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-dave-delete" } });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "forbidden" });
    expect(deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("blocks Milos from editing event with no owner", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "milos" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-no-owner-edit",
        ownerEditor: undefined,
        calendarId: "la-jobs@group.calendar.google.com",
      }],
    });
    const { PATCH } = await loadRoutes();
    const req = new Request("http://localhost/api/gigs/evt-no-owner-edit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#99999 — Test",
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-no-owner-edit" } });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "forbidden" });
    expect(updateAllDayEvent).not.toHaveBeenCalled();
  });

  it("blocks Milos from editing Overture booking", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "milos" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-overture-milos-edit",
        ownerEditor: "milos",
        calendarId: "overture@group.calendar.google.com",
      }],
    });
    const { PATCH } = await loadRoutes();
    const req = new Request("http://localhost/api/gigs/evt-overture-milos-edit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Overture Job",
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-overture-milos-edit" } });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "forbidden" });
    expect(updateAllDayEvent).not.toHaveBeenCalled();
  });

  it("blocks Dave from editing Overture booking", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "dave" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-overture-edit",
        ownerEditor: "mike",
        calendarId: "overture@group.calendar.google.com",
      }],
    });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-overture-edit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Overture",
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-overture-edit" } });
    expect(res.status).toBe(403);
    expect(updateAllDayEvent).not.toHaveBeenCalled();
  });

  it("blocks Dave from deleting Overture booking", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "dave" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-overture-delete",
        ownerEditor: "mike",
        calendarId: "overture@group.calendar.google.com",
      }],
    });
    const { DELETE } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-overture-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-overture-delete" } });
    expect(res.status).toBe(403);
    expect(deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("blocks Milos from deleting Overture booking", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "milos" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-overture-delete",
        ownerEditor: "mike",
        calendarId: "overture@group.calendar.google.com",
      }],
    });
    const { DELETE } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-overture-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-overture-delete" } });
    expect(res.status).toBe(403);
    expect(deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("allows Jeff to delete Overture booking", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-overture-delete",
        ownerEditor: "mike",
        calendarId: "overture@group.calendar.google.com",
      }],
    });
    deleteCalendarEvent.mockResolvedValue({ id: "evt-overture-delete" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    const { DELETE } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-overture-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-overture-delete" } });
    expect(res.status).toBe(200);
    expect(deleteCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "overture@group.calendar.google.com",
      }),
    );
  });

  it("allows Mike to delete own Overture booking", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "mike" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-overture-own-delete",
        ownerEditor: "mike",
        calendarId: "overture@group.calendar.google.com",
      }],
    });
    deleteCalendarEvent.mockResolvedValue({ id: "evt-overture-own-delete" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    const { DELETE } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-overture-own-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-overture-own-delete" } });
    expect(res.status).toBe(200);
    expect(deleteCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "overture@group.calendar.google.com",
      }),
    );
  });

  it("allows Mike to delete Jeff-owned Overture booking", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "mike" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-overture-jeff-delete",
        ownerEditor: "jeff",
        calendarId: "overture@group.calendar.google.com",
      }],
    });
    deleteCalendarEvent.mockResolvedValue({ id: "evt-overture-jeff-delete" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    const { DELETE } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-overture-jeff-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-overture-jeff-delete" } });
    expect(res.status).toBe(200);
    expect(deleteCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "overture@group.calendar.google.com",
      }),
    );
  });

  it("allows Mike to delete unknown-owner Overture booking", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "mike" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-overture-unknown-delete",
        ownerEditor: undefined,
        calendarId: "overture@group.calendar.google.com",
      }],
    });
    deleteCalendarEvent.mockResolvedValue({ id: "evt-overture-unknown-delete" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    const { DELETE } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-overture-unknown-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-overture-unknown-delete" } });
    expect(res.status).toBe(200);
    expect(deleteCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "overture@group.calendar.google.com",
      }),
    );
  });

  it("allows Mike to edit own Overture booking", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "mike" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-overture-own-edit",
        ownerEditor: "mike",
        calendarId: "overture@group.calendar.google.com",
        startUtc: "2026-05-08T00:00:00.000Z",
        endUtc: "2026-05-09T00:00:00.000Z",
      }],
    });
    updateAllDayEvent.mockResolvedValue({ id: "evt-overture-own-edit", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-overture-own-edit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Overture",
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-overture-own-edit" } });
    expect(res.status).toBe(200);
    expect(updateAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "overture@group.calendar.google.com",
        ownerEditor: "mike",
      }),
    );
  });

  it("allows Mike to edit Jeff-owned Overture booking", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "mike" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-overture-jeff-edit",
        ownerEditor: "jeff",
        calendarId: "overture@group.calendar.google.com",
        startUtc: "2026-05-08T00:00:00.000Z",
        endUtc: "2026-05-09T00:00:00.000Z",
      }],
    });
    updateAllDayEvent.mockResolvedValue({ id: "evt-overture-jeff-edit", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-overture-jeff-edit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Overture",
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-overture-jeff-edit" } });
    expect(res.status).toBe(200);
    expect(updateAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "overture@group.calendar.google.com",
      }),
    );
  });

  it("allows Mike to edit unknown-owner Overture booking", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "mike" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-overture-unknown-edit",
        ownerEditor: undefined,
        calendarId: "overture@group.calendar.google.com",
        startUtc: "2026-05-08T00:00:00.000Z",
        endUtc: "2026-05-09T00:00:00.000Z",
      }],
    });
    updateAllDayEvent.mockResolvedValue({ id: "evt-overture-unknown-edit", status: "confirmed" });
    buildAndPersistSnapshot.mockResolvedValue({ status: "ok", snapshot });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-overture-unknown-edit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Overture",
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-overture-unknown-edit" } });
    expect(res.status).toBe(200);
    expect(updateAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "overture@group.calendar.google.com",
      }),
    );
  });

  it("blocks Mike from editing LA booking", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "mike" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-la-edit",
        ownerEditor: "mike",
        calendarId: "la-jobs@group.calendar.google.com",
      }],
    });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-la-edit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12346 — Updated Job",
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-la-edit" } });
    expect(res.status).toBe(403);
    expect(updateAllDayEvent).not.toHaveBeenCalled();
  });

  it("blocks Mike from deleting LA booking", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "mike" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-la-delete",
        ownerEditor: "mike",
        calendarId: "la-jobs@group.calendar.google.com",
      }],
    });
    const { DELETE } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-la-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-la-delete" } });
    expect(res.status).toBe(403);
    expect(deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("does not append audit on unauthorized delete", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: false });
    const { DELETE } = await loadRoutes();
    const req = new Request("http://localhost/api/gigs/evt-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-delete" } });
    expect(res.status).toBe(401);
    expect(appendAuditEvent).not.toHaveBeenCalled();
  });

  it("DELETE returns friendly rate-limit message when preflight sync is quota-exceeded", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "milos" });
    readCurrentSnapshot.mockResolvedValue(null); // triggers preflight
    buildAndPersistSnapshot.mockResolvedValue({
      status: "failed",
      isRateLimit: true,
      error: "FreeBusy transport error: Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'calendar-json.googleapis.com' for consumer 'project_number:123456789'.",
    });
    const { DELETE } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-delete" } });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, string>;
    expect(body.error).toBe("snapshot_unavailable");
    expect(body.message).toBe(
      "Google Calendar is rate-limiting sync right now. Wait about a minute and try again.",
    );
    expect(body.message).not.toMatch(/quota/i);
    expect(body.message).not.toMatch(/project_number/i);
    expect(deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("PATCH returns friendly rate-limit message when preflight sync is quota-exceeded", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });
    readCurrentSnapshot.mockResolvedValue(null); // triggers preflight
    buildAndPersistSnapshot.mockResolvedValue({
      status: "failed",
      isRateLimit: true,
      error: "FreeBusy transport error: Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'calendar-json.googleapis.com' for consumer 'project_number:123456789'.",
    });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-edit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#12346 — Updated Job",
        startDate: "2026-05-08",
        endDate: "2026-05-08",
      }),
    });
    const res = await PATCH(req, { params: { eventId: "evt-edit" } });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, string>;
    expect(body.error).toBe("snapshot_unavailable");
    expect(body.message).toBe(
      "Google Calendar is rate-limiting sync right now. Wait about a minute and try again.",
    );
    expect(body.message).not.toMatch(/quota/i);
    expect(body.message).not.toMatch(/project_number/i);
    expect(updateAllDayEvent).not.toHaveBeenCalled();
  });

  it("PATCH uses fast post-mutation refresh and queues deferred reconciliation", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "dave" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-fast-edit",
        ownerEditor: "dave",
      }],
    });
    updateAllDayEvent.mockResolvedValue({ id: "evt-fast-edit", status: "confirmed" });
    refreshSnapshotAfterMutation.mockResolvedValue({ status: "ok", snapshot });
    scheduleDeferredReconciliationSync.mockResolvedValue({ queued: true, statusCode: 202 });
    const { PATCH } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-fast-edit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "LA#90909 — Fast Edit",
        startDate: "2026-05-09",
        endDate: "2026-05-09",
      }),
    });

    const res = await PATCH(req, { params: { eventId: "evt-fast-edit" } });
    expect(res.status).toBe(200);
    expect(refreshSnapshotAfterMutation).toHaveBeenCalledTimes(1);
    expect(scheduleDeferredReconciliationSync).toHaveBeenCalledTimes(1);
    expect(buildAndPersistSnapshot).not.toHaveBeenCalled();
  });

  it("DELETE uses fast post-mutation refresh and queues deferred reconciliation", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "milos" });
    readCurrentSnapshot.mockResolvedValue(snapshot);
    deleteCalendarEvent.mockResolvedValue({ id: "evt-delete" });
    refreshSnapshotAfterMutation.mockResolvedValue({ status: "ok", snapshot });
    scheduleDeferredReconciliationSync.mockResolvedValue({ queued: true, statusCode: 202 });
    const { DELETE } = await loadRoutes();

    const req = new Request("http://localhost/api/gigs/evt-delete", { method: "DELETE" });
    const res = await DELETE(req, { params: { eventId: "evt-delete" } });
    expect(res.status).toBe(200);
    expect(refreshSnapshotAfterMutation).toHaveBeenCalledTimes(1);
    expect(scheduleDeferredReconciliationSync).toHaveBeenCalledTimes(1);
    expect(buildAndPersistSnapshot).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/gigs/[eventId] — job_time_entries cleanup on gig delete
// ---------------------------------------------------------------------------

describe("/api/gigs/[eventId] DELETE — job-time cleanup", () => {
  beforeEach(() => {
    updateAllDayEvent.mockReset();
    deleteCalendarEvent.mockReset();
    buildAndPersistSnapshot.mockReset();
    readCurrentSnapshot.mockReset();
    appendAuditEvent.mockReset();
    authorizeEditorRequest.mockReset();
    refreshSnapshotAfterMutation.mockReset();
    scheduleDeferredReconciliationSync.mockReset();
    closeJobTimeEntriesForDeletedEvent.mockReset();
    mockEnv.OVERTURE_CALENDAR_ID = "overture@group.calendar.google.com";
    refreshSnapshotAfterMutation.mockResolvedValue({ status: "ok", snapshot });
    scheduleDeferredReconciliationSync.mockResolvedValue({ queued: true, statusCode: 202 });
    closeJobTimeEntriesForDeletedEvent.mockResolvedValue(0);
  });

  async function deleteJeffGig(eventId: string) {
    const { DELETE } = await loadRoutes();
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId,
        ownerEditor: "jeff",
        calendarId: "la-jobs@group.calendar.google.com",
      }],
    });
    deleteCalendarEvent.mockResolvedValue({ id: eventId });
    return DELETE(
      new Request(`http://localhost/api/gigs/${eventId}`, { method: "DELETE" }),
      { params: { eventId } },
    );
  }

  it("closes active job_time_entries for the deleted event on successful delete", async () => {
    closeJobTimeEntriesForDeletedEvent.mockResolvedValue(1);
    const res = await deleteJeffGig("evt-clocked-in");
    expect(res.status).toBe(200);
    expect(closeJobTimeEntriesForDeletedEvent).toHaveBeenCalledWith("evt-clocked-in", "jeff");
  });

  it("passes delete even when there is no active job_time_entry (returns 0 rows closed)", async () => {
    closeJobTimeEntriesForDeletedEvent.mockResolvedValue(0);
    const res = await deleteJeffGig("evt-no-clock");
    expect(res.status).toBe(200);
    expect(closeJobTimeEntriesForDeletedEvent).toHaveBeenCalledWith("evt-no-clock", "jeff");
  });

  it("does not call job-time cleanup when Google delete fails", async () => {
    const { DELETE } = await loadRoutes();
    authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });
    readCurrentSnapshot.mockResolvedValue({
      ...snapshot,
      namedEvents: [{
        ...snapshot.namedEvents[0],
        eventId: "evt-google-fail",
        ownerEditor: "jeff",
        calendarId: "la-jobs@group.calendar.google.com",
      }],
    });
    deleteCalendarEvent.mockRejectedValue(Object.assign(new Error("Google error"), { status: 500 }));

    const res = await DELETE(
      new Request("http://localhost/api/gigs/evt-google-fail", { method: "DELETE" }),
      { params: { eventId: "evt-google-fail" } },
    );
    expect(res.status).toBe(502);
    expect(closeJobTimeEntriesForDeletedEvent).not.toHaveBeenCalled();
  });

  it("does not touch job_time_entries for a different event when deleting one gig", async () => {
    closeJobTimeEntriesForDeletedEvent.mockResolvedValue(1);
    const res = await deleteJeffGig("evt-alpha");
    expect(res.status).toBe(200);
    expect(closeJobTimeEntriesForDeletedEvent).toHaveBeenCalledWith("evt-alpha", "jeff");
    expect(closeJobTimeEntriesForDeletedEvent).not.toHaveBeenCalledWith("evt-beta", expect.anything());
  });

  it("still returns 200 and does not surface error when job-time cleanup throws", async () => {
    closeJobTimeEntriesForDeletedEvent.mockRejectedValue(new Error("supabase down"));
    const res = await deleteJeffGig("evt-supabase-fail");
    expect(res.status).toBe(200);
    const json = await res.json() as { status: string };
    expect(json.status).toBe("ok");
  });

  it("does not call job-time cleanup when DELETE is unauthorized", async () => {
    authorizeEditorRequest.mockReturnValue({ ok: false });
    const { DELETE } = await loadRoutes();
    const res = await DELETE(
      new Request("http://localhost/api/gigs/evt-unauth", { method: "DELETE" }),
      { params: { eventId: "evt-unauth" } },
    );
    expect(res.status).toBe(401);
    expect(closeJobTimeEntriesForDeletedEvent).not.toHaveBeenCalled();
    expect(deleteCalendarEvent).not.toHaveBeenCalled();
  });
});
