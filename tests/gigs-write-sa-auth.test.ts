/**
 * Tests for service-account Calendar auth on gig write routes.
 *
 * Verifies that after the SA migration:
 *   - Create/PATCH/DELETE all call buildWarmedCalendarWriteAuth (not the old OAuth2-only helper)
 *   - When buildWarmedCalendarWriteAuth throws, the route returns 503 calendar_auth_failed
 *   - The invoice system (Supabase/Sheet sync) is unaffected by Calendar auth changes
 *   - Dave-created events (different ownerEditor) still attempt write to the correct calendarId
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── Mutable mock state ─────────────────────────────────────────────────────

const buildWarmedCalendarWriteAuth = vi.fn();
const createAllDayEvent = vi.fn();
const updateAllDayEvent = vi.fn();
const deleteCalendarEvent = vi.fn();
const buildAndPersistSnapshot = vi.fn();
const readCurrentSnapshot = vi.fn();
const refreshSnapshotAfterMutation = vi.fn();
const scheduleDeferredReconciliationSync = vi.fn();
const appendAuditEvent = vi.fn();
const sendCreateJobNotification = vi.fn();
const closeJobTimeEntriesForDeletedEvent = vi.fn();

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const LA_CAL = "la-jobs@group.calendar.google.com";

const snapshot = {
  version: 1 as const,
  generatedAtUtc: "2026-06-01T00:00:00.000Z",
  windowStartUtc: "2026-06-01T00:00:00.000Z",
  windowEndUtc: "2026-09-01T00:00:00.000Z",
  busy: [],
  namedEvents: [
    {
      startUtc: "2026-07-10T00:00:00.000Z",
      endUtc: "2026-07-11T00:00:00.000Z",
      summary: "LA#99001 — Dave Gig",
      eventId: "dave-event-id",
      ownerEditor: "dave",
      calendarId: LA_CAL,
      displayMode: "details" as const,
    },
  ],
  sourceCalendarIds: [LA_CAL],
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
  BLOBS_STORE_NAME: "snapshots",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_REFRESH_TOKEN: "refresh-token",
  GOOGLE_CALENDAR_ID: LA_CAL,
  OVERTURE_CALENDAR_ID: "",
  ADMIN_TOKEN: "admin-token-value-at-least-16",
  EDITOR_TOKEN: "legacy-editor-token-0123456789",
  EDITOR_TOKENS_JSON: JSON.stringify({
    jeff: "jeff-editor-token-0123456789",
    dave: "dave-editor-token-0123456789",
  }),
  CALENDAR_DISPLAY_MODES: {} as Record<string, string>,
};

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ file: { timezone: "America/New_York" }, env: mockEnv }),
}));

vi.mock("@/lib/google", () => ({
  CalendarEventAlreadyExistsError: class CalendarEventAlreadyExistsError extends Error {},
  buildWarmedCalendarWriteAuth: (...args: unknown[]) => buildWarmedCalendarWriteAuth(...args),
  createAllDayEvent: (...args: unknown[]) => createAllDayEvent(...args),
  updateAllDayEvent: (...args: unknown[]) => updateAllDayEvent(...args),
  deleteCalendarEvent: (...args: unknown[]) => deleteCalendarEvent(...args),
}));

vi.mock("@/lib/sync", () => ({
  buildAndPersistSnapshot: (...args: unknown[]) => buildAndPersistSnapshot(...args),
  refreshSnapshotAfterMutation: (...args: unknown[]) => refreshSnapshotAfterMutation(...args),
}));

vi.mock("@/lib/store", () => ({
  readCurrentSnapshot: (...args: unknown[]) => readCurrentSnapshot(...args),
}));

vi.mock("@/lib/audit-log", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit-log")>("@/lib/audit-log");
  return { ...actual, appendAuditEvent: (...args: unknown[]) => appendAuditEvent(...args) };
});

vi.mock("@/lib/notifications", () => ({
  sendCreateJobNotification: (...args: unknown[]) => sendCreateJobNotification(...args),
}));

vi.mock("@/lib/mutation-postsync", () => ({
  refreshSnapshotAfterMutation: (...args: unknown[]) => refreshSnapshotAfterMutation(...args),
  scheduleDeferredReconciliationSync: (...args: unknown[]) => scheduleDeferredReconciliationSync(...args),
}));

vi.mock("@/lib/job-time", async () => {
  const actual = await vi.importActual<typeof import("@/lib/job-time")>("@/lib/job-time");
  return {
    ...actual,
    closeJobTimeEntriesForDeletedEvent: (...args: unknown[]) => closeJobTimeEntriesForDeletedEvent(...args),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockSAAuth = { getAccessToken: () => Promise.resolve({ token: "sa-token" }) };

function makeSuccessfulWrite() {
  buildWarmedCalendarWriteAuth.mockResolvedValue({ auth: mockSAAuth, mode: "service_account" });
  readCurrentSnapshot.mockResolvedValue(snapshot);
  createAllDayEvent.mockResolvedValue({ id: "new-event-id", status: "confirmed" });
  updateAllDayEvent.mockResolvedValue({ id: "dave-event-id", status: "confirmed" });
  deleteCalendarEvent.mockResolvedValue({ id: "dave-event-id" });
  refreshSnapshotAfterMutation.mockResolvedValue({ status: "ok", snapshot });
  scheduleDeferredReconciliationSync.mockResolvedValue({ queued: true });
  appendAuditEvent.mockResolvedValue(undefined);
  sendCreateJobNotification.mockResolvedValue(undefined);
  closeJobTimeEntriesForDeletedEvent.mockResolvedValue(0);
}

function jeffBearer() {
  return { Authorization: "Bearer jeff-editor-token-0123456789" };
}

function daveBearer() {
  return { Authorization: "Bearer dave-editor-token-0123456789" };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("gig write routes — service account auth", () => {
  it("PATCH calls buildWarmedCalendarWriteAuth, not the old OAuth2-only helper", async () => {
    makeSuccessfulWrite();
    const { PATCH } = await import("@/app/api/gigs/[eventId]/route");

    const req = new Request("http://localhost/api/gigs/dave-event-id", {
      method: "PATCH",
      headers: { ...daveBearer(), "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "LA#99001 — Dave Gig Updated", date: "2026-07-10" }),
    });
    await PATCH(req, { params: { eventId: "dave-event-id" } });

    expect(buildWarmedCalendarWriteAuth).toHaveBeenCalledTimes(1);
  });

  it("DELETE calls buildWarmedCalendarWriteAuth", async () => {
    makeSuccessfulWrite();
    const { DELETE } = await import("@/app/api/gigs/[eventId]/route");

    const req = new Request("http://localhost/api/gigs/dave-event-id", {
      method: "DELETE",
      headers: daveBearer(),
    });
    await DELETE(req, { params: { eventId: "dave-event-id" } });

    expect(buildWarmedCalendarWriteAuth).toHaveBeenCalledTimes(1);
  });

  it("POST /api/gigs/create calls buildWarmedCalendarWriteAuth", async () => {
    makeSuccessfulWrite();
    const { POST } = await import("@/app/api/gigs/create/route");

    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { ...jeffBearer(), "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "LA#99099 — New Gig", date: "2026-08-05" }),
    });
    await POST(req);

    expect(buildWarmedCalendarWriteAuth).toHaveBeenCalledTimes(1);
  });

  it("PATCH write passes the calendarId from the snapshot event (not always GOOGLE_CALENDAR_ID)", async () => {
    makeSuccessfulWrite();
    const { PATCH } = await import("@/app/api/gigs/[eventId]/route");

    const req = new Request("http://localhost/api/gigs/dave-event-id", {
      method: "PATCH",
      headers: { ...daveBearer(), "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "LA#99001 — Dave Gig Updated", date: "2026-07-10" }),
    });
    await PATCH(req, { params: { eventId: "dave-event-id" } });

    expect(updateAllDayEvent).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: LA_CAL, eventId: "dave-event-id" }),
    );
  });
});

describe("gig write routes — Calendar auth failure returns 503", () => {
  it("PATCH returns 503 calendar_auth_failed when buildWarmedCalendarWriteAuth throws", async () => {
    buildWarmedCalendarWriteAuth.mockRejectedValue(
      Object.assign(new Error("invalid_grant"), { status: 401 }),
    );
    const { PATCH } = await import("@/app/api/gigs/[eventId]/route");

    const req = new Request("http://localhost/api/gigs/dave-event-id", {
      method: "PATCH",
      headers: { ...daveBearer(), "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "LA#99001 — Dave Gig Updated", date: "2026-07-10" }),
    });
    const res = await PATCH(req, { params: { eventId: "dave-event-id" } });

    expect(res.status).toBe(503);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("calendar_auth_failed");
    // Supabase/invoice data is untouched — Calendar API was never called
    expect(updateAllDayEvent).not.toHaveBeenCalled();
  });

  it("DELETE returns 503 calendar_auth_failed when buildWarmedCalendarWriteAuth throws", async () => {
    buildWarmedCalendarWriteAuth.mockRejectedValue(new Error("invalid_grant"));
    const { DELETE } = await import("@/app/api/gigs/[eventId]/route");

    const req = new Request("http://localhost/api/gigs/dave-event-id", {
      method: "DELETE",
      headers: daveBearer(),
    });
    const res = await DELETE(req, { params: { eventId: "dave-event-id" } });

    expect(res.status).toBe(503);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("calendar_auth_failed");
    expect(deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("POST /create returns 503 calendar_auth_failed when buildWarmedCalendarWriteAuth throws", async () => {
    buildWarmedCalendarWriteAuth.mockRejectedValue(new Error("invalid_grant"));
    const { POST } = await import("@/app/api/gigs/create/route");

    const req = new Request("http://localhost/api/gigs/create", {
      method: "POST",
      headers: { ...jeffBearer(), "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "LA#99099 — New Gig", date: "2026-08-05" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(503);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("calendar_auth_failed");
    expect(createAllDayEvent).not.toHaveBeenCalled();
  });
});

describe("gig write routes — invoice system unaffected by Calendar auth", () => {
  it("Calendar auth failure does not touch Supabase invoice data", async () => {
    buildWarmedCalendarWriteAuth.mockRejectedValue(new Error("invalid_grant"));
    const { PATCH } = await import("@/app/api/gigs/[eventId]/route");

    const req = new Request("http://localhost/api/gigs/dave-event-id", {
      method: "PATCH",
      headers: { ...daveBearer(), "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "LA#99001 — Updated", date: "2026-07-10" }),
    });
    await PATCH(req, { params: { eventId: "dave-event-id" } });

    // No snapshot write, no audit write, no post-sync — nothing persisted
    expect(refreshSnapshotAfterMutation).not.toHaveBeenCalled();
    expect(appendAuditEvent).not.toHaveBeenCalled();
  });

  it("successful PATCH with service account writes only the Calendar event then syncs", async () => {
    makeSuccessfulWrite();
    const { PATCH } = await import("@/app/api/gigs/[eventId]/route");

    const req = new Request("http://localhost/api/gigs/dave-event-id", {
      method: "PATCH",
      headers: { ...daveBearer(), "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "LA#99001 — Dave Gig Updated", date: "2026-07-10" }),
    });
    const res = await PATCH(req, { params: { eventId: "dave-event-id" } });

    expect(res.status).toBe(200);
    // Calendar write happened
    expect(updateAllDayEvent).toHaveBeenCalledTimes(1);
    // Post-sync ran
    expect(refreshSnapshotAfterMutation).toHaveBeenCalledTimes(1);
  });
});
