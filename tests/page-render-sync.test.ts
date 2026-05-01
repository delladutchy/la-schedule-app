import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

const readCurrentSnapshot = vi.fn();
const buildAndPersistSnapshot = vi.fn();
const authorizeEditorRequest = vi.fn();
const classifySnapshot = vi.fn();
const cookiesMock = vi.fn();

(globalThis as { React?: typeof React }).React = React;

const snapshot = {
  version: 1 as const,
  generatedAtUtc: "2026-05-01T00:00:00.000Z",
  windowStartUtc: "2026-05-01T00:00:00.000Z",
  windowEndUtc: "2026-07-01T00:00:00.000Z",
  busy: [],
  sourceCalendarIds: ["la-calendar@example.com"],
  config: {
    timezone: "America/New_York",
    workdayStartHour: 9,
    workdayEndHour: 18,
    hideWeekends: false,
    showTentative: false,
    pageTitle: "Availability",
  },
};

vi.mock("next/headers", () => ({
  cookies: (...args: unknown[]) => cookiesMock(...args),
}));

vi.mock("@/lib/store", () => ({
  readCurrentSnapshot: (...args: unknown[]) => readCurrentSnapshot(...args),
}));

vi.mock("@/lib/sync", () => ({
  buildAndPersistSnapshot: (...args: unknown[]) => buildAndPersistSnapshot(...args),
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    file: {
      freshTtlMinutes: 30,
      hardTtlMinutes: 180,
      timezone: "America/New_York",
      workdayStartHour: 9,
      workdayEndHour: 18,
      pageTitle: "Availability",
    },
    env: {
      BLOBS_STORE_NAME: "availability-snapshots",
      AUTO_BOOTSTRAP_ON_UNAVAILABLE: true,
      GOOGLE_CALENDAR_ID: "la-calendar@example.com",
      OVERTURE_CALENDAR_ID: "overture-calendar@example.com",
    },
  }),
}));

vi.mock("@/lib/editor-auth", () => ({
  authorizeEditorRequest: (...args: unknown[]) => authorizeEditorRequest(...args),
}));

vi.mock("@/lib/time", () => ({
  todayInZone: () => "2026-05-01",
}));

vi.mock("@/lib/view", () => ({
  classifySnapshot: (...args: unknown[]) => classifySnapshot(...args),
  buildDayBoard: () => [],
  trimWeekRowsForScheduleList: ({ weeks }: { weeks: unknown[] }) => weeks,
  resolveWeekNavigation: () => ({
    weekStart: "2026-05-04",
    prevStart: "2026-04-27",
    nextStart: "2026-05-11",
    hasPrev: true,
    hasNext: true,
  }),
  buildMonthBoard: () => ({
    label: "May 2026",
    monthKey: "2026-05",
    weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    weeks: [],
  }),
  resolveMonthNavigation: () => ({
    monthKey: "2026-05",
    prevMonth: "2026-04",
    nextMonth: "2026-06",
    hasPrev: true,
    hasNext: true,
  }),
}));

vi.mock("@/components/ScheduleView", () => ({
  ScheduleView: () => null,
}));

vi.mock("@/components/ThemeToggle", () => ({
  ThemeToggle: () => null,
}));

vi.mock("@/components/EditorSyncButton", () => ({
  EditorSyncButton: () => null,
}));

vi.mock("@/components/EditorHistoryButton", () => ({
  EditorHistoryButton: () => null,
}));

vi.mock("@/components/EditorTokenBridge", () => ({
  EditorTokenBridge: () => null,
}));

describe("Availability page render sync behavior", () => {
  beforeEach(() => {
    readCurrentSnapshot.mockReset();
    buildAndPersistSnapshot.mockReset();
    authorizeEditorRequest.mockReset();
    classifySnapshot.mockReset();
    cookiesMock.mockReset();

    readCurrentSnapshot.mockResolvedValue(snapshot);
    authorizeEditorRequest.mockReturnValue({ ok: false });
    classifySnapshot.mockReturnValue({
      status: "stale",
      snapshot,
      ageMinutes: 61,
    });
    cookiesMock.mockReturnValue({
      toString: () => "",
      get: () => undefined,
    });
  });

  it("does not trigger snapshot rebuild when a stale snapshot already exists", async () => {
    const mod = await import("@/app/page");
    await mod.default({
      searchParams: {
        view: "month",
        month: "2026-05",
      },
    });

    expect(readCurrentSnapshot).toHaveBeenCalledTimes(1);
    expect(classifySnapshot).toHaveBeenCalledTimes(1);
    expect(buildAndPersistSnapshot).not.toHaveBeenCalled();
  });
});
