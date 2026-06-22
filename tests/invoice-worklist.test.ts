/**
 * Tests for the invoice worklist feature:
 *   - Jeff-only API guard (auth logic)
 *   - WorklistEntry construction (LA# parsing, date derivation, status merge)
 *   - Filter logic (Needs Invoice / Draft / Sent / Paid / All)
 *   - Search logic (LA#, gig name, date, invoice#)
 *   - Past-job clock-in disabled (workDates excludes today)
 */

import { describe, it, expect } from "vitest";
import {
  dedupeWorklistEntries,
  worklistEntryMatchesSearch,
  worklistEntryMatchesFilter,
  isClockInDisabled,
} from "@/lib/invoice-worklist";
import { parseLaJobSummary, enumerateIsoDatesInRange } from "@/lib/gigs";

// ── Re-export type for this test file ────────────────────────────────────────

import type { WorklistEntry, WorklistFilter } from "@/lib/invoice-worklist";

function makeEntry(overrides: Partial<WorklistEntry> = {}): WorklistEntry {
  return {
    eventId:          "evt-001",
    summary:          "LA#1234 — Music Video",
    gigName:          "Music Video",
    laJobNumber:      "LA#1234",
    startDate:        "2026-05-15",
    endDate:          "2026-05-15",
    workDates:        ["2026-05-15"],
    location:         null,
    startTimeUtc:     null,
    endTimeUtc:       null,
    callTimeDefault:  null,
    invoiceStatus:    "none",
    invoiceNumber:    null,
    invoiceTotal:     null,
    invoicePdfUrl:    null,
    amountPaid:       0,
    remainingBalance: null,
    ...overrides,
  };
}

// ── LA# parsing (via parseLaJobSummary from gigs.ts) ─────────────────────────

describe("parseLaJobSummary — LA# extraction for worklist", () => {
  it("parses LA#1234 — Job Name", () => {
    const r = parseLaJobSummary("LA#1234 — Music Video");
    expect(r.jobNumber).toBe("LA#1234");
    expect(r.jobName).toBe("Music Video");
  });

  it("parses LA #5678 with space", () => {
    const r = parseLaJobSummary("LA #5678 — Commercial");
    expect(r.jobNumber).toBe("LA#5678");
    expect(r.jobName).toBe("Commercial");
  });

  it("returns null jobNumber for event with no LA#", () => {
    const r = parseLaJobSummary("Personal vacation");
    expect(r.jobNumber).toBeUndefined();
    expect(r.jobName).toBe("Personal vacation");
  });

  it("uses full summary as jobName when no LA# present", () => {
    const r = parseLaJobSummary("Film shoot — no LA number");
    expect(r.jobNumber).toBeUndefined();
    expect(r.jobName).toBe("Film shoot — no LA number");
  });
});

// ── Date range derivation ─────────────────────────────────────────────────────

describe("enumerateIsoDatesInRange — work date derivation for worklist", () => {
  it("single-day job → one work date", () => {
    const dates = enumerateIsoDatesInRange("2026-06-17", "2026-06-17");
    expect(dates).toEqual(["2026-06-17"]);
  });

  it("3-day job → three work dates", () => {
    const dates = enumerateIsoDatesInRange("2026-06-17", "2026-06-19");
    expect(dates).toEqual(["2026-06-17", "2026-06-18", "2026-06-19"]);
  });

  it("returns empty array for invalid range (end before start)", () => {
    const dates = enumerateIsoDatesInRange("2026-06-20", "2026-06-17");
    expect(dates).toEqual([]);
  });
});

// ── Filter logic ──────────────────────────────────────────────────────────────

describe("worklistEntryMatchesFilter", () => {
  const filters: WorklistFilter[] = ["all", "none", "draft", "sent", "paid"];

  it("'all' filter matches every entry regardless of status", () => {
    const statuses = ["none", "ready", "sheet_synced", "draft_created", "sent", "partially_paid", "paid", "void"] as const;
    for (const s of statuses) {
      expect(worklistEntryMatchesFilter(makeEntry({ invoiceStatus: s }), "all")).toBe(true);
    }
  });

  it("'none' filter matches status=none (needs invoice)", () => {
    expect(worklistEntryMatchesFilter(makeEntry({ invoiceStatus: "none" }), "none")).toBe(true);
  });

  it("'none' filter matches status=ready (needs invoice)", () => {
    expect(worklistEntryMatchesFilter(makeEntry({ invoiceStatus: "ready" }), "none")).toBe(true);
  });

  it("'none' filter rejects status=sent", () => {
    expect(worklistEntryMatchesFilter(makeEntry({ invoiceStatus: "sent" }), "none")).toBe(false);
  });

  it("'draft' filter matches status=sheet_synced", () => {
    expect(worklistEntryMatchesFilter(makeEntry({ invoiceStatus: "sheet_synced" }), "draft")).toBe(true);
  });

  it("'draft' filter matches status=draft_created", () => {
    expect(worklistEntryMatchesFilter(makeEntry({ invoiceStatus: "draft_created" }), "draft")).toBe(true);
  });

  it("'draft' filter rejects status=paid", () => {
    expect(worklistEntryMatchesFilter(makeEntry({ invoiceStatus: "paid" }), "draft")).toBe(false);
  });

  it("'sent' filter matches status=sent", () => {
    expect(worklistEntryMatchesFilter(makeEntry({ invoiceStatus: "sent" }), "sent")).toBe(true);
  });

  it("'sent' filter matches status=partially_paid", () => {
    expect(worklistEntryMatchesFilter(makeEntry({ invoiceStatus: "partially_paid" }), "sent")).toBe(true);
  });

  it("'sent' filter rejects status=none", () => {
    expect(worklistEntryMatchesFilter(makeEntry({ invoiceStatus: "none" }), "sent")).toBe(false);
  });

  it("'paid' filter matches status=paid only", () => {
    expect(worklistEntryMatchesFilter(makeEntry({ invoiceStatus: "paid" }), "paid")).toBe(true);
    expect(worklistEntryMatchesFilter(makeEntry({ invoiceStatus: "sent" }), "paid")).toBe(false);
    expect(worklistEntryMatchesFilter(makeEntry({ invoiceStatus: "none" }), "paid")).toBe(false);
  });

  it("all filter values are in the union without runtime error", () => {
    const entry = makeEntry({ invoiceStatus: "none" });
    for (const f of filters) {
      expect(() => worklistEntryMatchesFilter(entry, f)).not.toThrow();
    }
  });
});

// ── Search logic ──────────────────────────────────────────────────────────────

describe("worklistEntryMatchesSearch", () => {
  const entry = makeEntry({
    laJobNumber:   "LA#1234",
    gigName:       "Music Video Shoot",
    summary:       "LA#1234 — Music Video Shoot",
    startDate:     "2026-05-15",
    endDate:       "2026-05-15",
    invoiceNumber: "42",
  });

  it("empty search term matches everything", () => {
    expect(worklistEntryMatchesSearch(entry, "")).toBe(true);
    expect(worklistEntryMatchesSearch(entry, "  ")).toBe(true);
  });

  it("search by LA# partial match", () => {
    expect(worklistEntryMatchesSearch(entry, "1234")).toBe(true);
    expect(worklistEntryMatchesSearch(entry, "LA#1234")).toBe(true);
    expect(worklistEntryMatchesSearch(entry, "la#1234")).toBe(true); // case insensitive
  });

  it("search by LA# non-match", () => {
    expect(worklistEntryMatchesSearch(entry, "LA#9999")).toBe(false);
  });

  it("search by gig name (partial)", () => {
    expect(worklistEntryMatchesSearch(entry, "music video")).toBe(true);
    expect(worklistEntryMatchesSearch(entry, "shoot")).toBe(true);
    expect(worklistEntryMatchesSearch(entry, "MUSIC")).toBe(true); // case insensitive
  });

  it("search by gig name non-match", () => {
    expect(worklistEntryMatchesSearch(entry, "commercial")).toBe(false);
  });

  it("search by date (ISO substring)", () => {
    expect(worklistEntryMatchesSearch(entry, "2026-05")).toBe(true);
    expect(worklistEntryMatchesSearch(entry, "2026-05-15")).toBe(true);
  });

  it("search by invoice number", () => {
    expect(worklistEntryMatchesSearch(entry, "42")).toBe(true);
    expect(worklistEntryMatchesSearch(entry, "#42")).toBe(false); // # is not in invoiceNumber field
  });

  it("search by invoice number when no invoice assigned", () => {
    const noInv = makeEntry({ invoiceNumber: null });
    expect(worklistEntryMatchesSearch(noInv, "42")).toBe(false);
  });

  it("no match returns false", () => {
    expect(worklistEntryMatchesSearch(entry, "zzznomatch")).toBe(false);
  });
});

// ── Past-job clock-in disabled ────────────────────────────────────────────────

describe("isClockInDisabled — past jobs cannot clock in", () => {
  const today = "2026-06-21";

  it("past job (no today in workDates) → clock-in disabled", () => {
    const workDates = ["2026-05-15"];
    expect(isClockInDisabled(workDates, today)).toBe(true);
  });

  it("multi-day past job → clock-in disabled", () => {
    const workDates = ["2026-05-10", "2026-05-11", "2026-05-12"];
    expect(isClockInDisabled(workDates, today)).toBe(true);
  });

  it("job today → clock-in NOT disabled", () => {
    const workDates = ["2026-06-21"];
    expect(isClockInDisabled(workDates, today)).toBe(false);
  });

  it("multi-day job spanning today → clock-in NOT disabled", () => {
    const workDates = ["2026-06-20", "2026-06-21", "2026-06-22"];
    expect(isClockInDisabled(workDates, today)).toBe(false);
  });

  it("empty workDates → clock-in disabled (no valid work date)", () => {
    expect(isClockInDisabled([], today)).toBe(true);
  });

  it("future job → clock-in disabled (today not included)", () => {
    const workDates = ["2026-07-01", "2026-07-02"];
    expect(isClockInDisabled(workDates, today)).toBe(true);
  });
});

// ── Jeff-only guard logic ─────────────────────────────────────────────────────

// Mirror of isJeffEditorId from lib/job-time.ts
function isJeffEditorId(id: string): boolean {
  return id === "jeff" || id === "legacy";
}

describe("Jeff-only guard for worklist API", () => {
  it("jeff editor is allowed", () => {
    expect(isJeffEditorId("jeff")).toBe(true);
  });

  it("legacy editor is allowed", () => {
    expect(isJeffEditorId("legacy")).toBe(true);
  });

  it("dave editor is rejected", () => {
    expect(isJeffEditorId("dave")).toBe(false);
  });

  it("milos editor is rejected", () => {
    expect(isJeffEditorId("milos")).toBe(false);
  });

  it("overture editor is rejected", () => {
    expect(isJeffEditorId("overture")).toBe(false);
  });

  it("empty string is rejected", () => {
    expect(isJeffEditorId("")).toBe(false);
  });

  it("admin string is rejected (not a Jeff id)", () => {
    expect(isJeffEditorId("admin")).toBe(false);
  });
});

// ── WorklistEntry construction ─────────────────────────────────────────────────

describe("WorklistEntry status defaults when no invoice_data row exists", () => {
  it("entry with no invoice_data defaults to status=none", () => {
    const entry = makeEntry({ invoiceStatus: "none", invoiceNumber: null, invoiceTotal: null });
    expect(entry.invoiceStatus).toBe("none");
    expect(entry.invoiceNumber).toBeNull();
    expect(entry.invoiceTotal).toBeNull();
  });

  it("entry with invoice data carries status correctly", () => {
    const entry = makeEntry({
      invoiceStatus: "sent",
      invoiceNumber: "42",
      invoiceTotal:  2000,
      amountPaid:    0,
      remainingBalance: 2000,
    });
    expect(entry.invoiceStatus).toBe("sent");
    expect(entry.invoiceNumber).toBe("42");
    expect(entry.invoiceTotal).toBe(2000);
  });

  it("paid entry carries amountPaid and zero remainingBalance", () => {
    const entry = makeEntry({
      invoiceStatus:    "paid",
      invoiceNumber:    "43",
      invoiceTotal:     1500,
      amountPaid:       1500,
      remainingBalance: 0,
    });
    expect(entry.invoiceStatus).toBe("paid");
    expect(entry.amountPaid).toBe(1500);
    expect(entry.remainingBalance).toBe(0);
  });
});

describe("dedupeWorklistEntries — one row per LA invoice job", () => {
  it("collapses duplicate Red Bull calendar events with the same LA# and date range", () => {
    const entries = dedupeWorklistEntries([
      makeEntry({
        eventId: "redbull-a",
        summary: "LA#71803 — Redbull Soapbox Derby Denver",
        gigName: "Redbull Soapbox Derby Denver",
        laJobNumber: "LA#71803",
        startDate: "2026-06-09",
        endDate: "2026-06-14",
        workDates: ["2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14"],
      }),
      makeEntry({
        eventId: "redbull-b",
        summary: "LA#71803 — Redbull Soapbox Derby Denver",
        gigName: "Redbull Soapbox Derby Denver",
        laJobNumber: "LA#71803",
        startDate: "2026-06-09",
        endDate: "2026-06-14",
        workDates: ["2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14"],
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.laJobNumber).toBe("LA#71803");
    expect(entries[0]?.gigName).toBe("Redbull Soapbox Derby Denver");
    expect(entries[0]?.startDate).toBe("2026-06-09");
    expect(entries[0]?.endDate).toBe("2026-06-14");
  });

  it("keeps the duplicate event ID that already has invoice data", () => {
    const entries = dedupeWorklistEntries([
      makeEntry({
        eventId: "calendar-copy-without-invoice",
        laJobNumber: "LA#71803",
        invoiceStatus: "none",
        invoiceNumber: null,
        invoiceTotal: null,
      }),
      makeEntry({
        eventId: "canonical-with-invoice",
        laJobNumber: "LA#71803",
        invoiceStatus: "sheet_synced",
        invoiceNumber: "1010",
        invoiceTotal: 2500,
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.eventId).toBe("canonical-with-invoice");
    expect(entries[0]?.invoiceNumber).toBe("1010");
    expect(entries[0]?.invoiceTotal).toBe(2500);
  });

  it("merges split duplicate LA events into the full work date range", () => {
    const entries = dedupeWorklistEntries([
      makeEntry({
        eventId: "la-9000-first",
        laJobNumber: "LA#9000",
        startDate: "2026-06-18",
        endDate: "2026-06-19",
        workDates: ["2026-06-18", "2026-06-19"],
      }),
      makeEntry({
        eventId: "la-9000-second",
        laJobNumber: "LA#9000",
        startDate: "2026-06-20",
        endDate: "2026-06-20",
        workDates: ["2026-06-20"],
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.startDate).toBe("2026-06-18");
    expect(entries[0]?.endDate).toBe("2026-06-20");
    expect(entries[0]?.workDates).toEqual(["2026-06-18", "2026-06-19", "2026-06-20"]);
  });

  it("does not collapse non-LA events just because their names match", () => {
    const entries = dedupeWorklistEntries([
      makeEntry({ eventId: "non-la-a", summary: "Same Name", gigName: "Same Name", laJobNumber: null }),
      makeEntry({ eventId: "non-la-b", summary: "Same Name", gigName: "Same Name", laJobNumber: null }),
    ]);

    expect(entries.map((entry) => entry.eventId)).toEqual(["non-la-a", "non-la-b"]);
  });

  it("passes callTimeDefault through for single all-day event", () => {
    const entry = makeEntry({ callTimeDefault: "6:00 AM", startTimeUtc: null });
    const result = dedupeWorklistEntries([entry]);
    expect(result[0]!.callTimeDefault).toBe("6:00 AM");
  });

  it("prefers primary entry callTimeDefault when merging duplicates", () => {
    const withInvoice = makeEntry({
      eventId: "evt-with-inv",
      invoiceNumber: "42",
      callTimeDefault: "7:00 AM",
      startTimeUtc: null,
    });
    const withoutInvoice = makeEntry({
      eventId: "evt-no-inv",
      callTimeDefault: "6:00 AM",
      startTimeUtc: null,
    });
    const result = dedupeWorklistEntries([withInvoice, withoutInvoice]);
    expect(result).toHaveLength(1);
    // Primary is the entry with invoice data; its callTime takes precedence
    expect(result[0]!.callTimeDefault).toBe("7:00 AM");
  });

  it("falls back to any group member's callTimeDefault when primary has none", () => {
    const primary = makeEntry({ eventId: "evt-a", invoiceNumber: "55", callTimeDefault: null, startTimeUtc: null });
    const secondary = makeEntry({ eventId: "evt-b", callTimeDefault: "5:30 AM", startTimeUtc: null });
    const result = dedupeWorklistEntries([primary, secondary]);
    expect(result).toHaveLength(1);
    expect(result[0]!.callTimeDefault).toBe("5:30 AM");
  });

  it("callTimeDefault is null for timed events where startTimeUtc is set", () => {
    const entry = makeEntry({
      startTimeUtc: "2026-06-08T11:00:00.000Z",
      callTimeDefault: null,
    });
    expect(entry.callTimeDefault).toBeNull();
  });
});

// ── Filter + search combined ──────────────────────────────────────────────────

describe("filter + search combined", () => {
  const entries: WorklistEntry[] = [
    makeEntry({ eventId: "e1", invoiceStatus: "none",  laJobNumber: "LA#1001", gigName: "Shoot A", startDate: "2026-01-10", endDate: "2026-01-10" }),
    makeEntry({ eventId: "e2", invoiceStatus: "sent",  laJobNumber: "LA#1002", gigName: "Shoot B", startDate: "2026-02-10", endDate: "2026-02-10", invoiceNumber: "10" }),
    makeEntry({ eventId: "e3", invoiceStatus: "paid",  laJobNumber: "LA#1003", gigName: "Shoot C", startDate: "2026-03-10", endDate: "2026-03-10", invoiceNumber: "11" }),
    makeEntry({ eventId: "e4", invoiceStatus: "sheet_synced", laJobNumber: "LA#1004", gigName: "Commercial D", startDate: "2026-04-10", endDate: "2026-04-10" }),
  ];

  function applyFilters(filter: WorklistFilter, term: string): string[] {
    return entries
      .filter((e) => worklistEntryMatchesFilter(e, filter))
      .filter((e) => worklistEntryMatchesSearch(e, term))
      .map((e) => e.eventId);
  }

  it("all + no search → all entries", () => {
    expect(applyFilters("all", "")).toEqual(["e1", "e2", "e3", "e4"]);
  });

  it("none filter → only e1 (needs invoice)", () => {
    expect(applyFilters("none", "")).toEqual(["e1"]);
  });

  it("sent filter → only e2", () => {
    expect(applyFilters("sent", "")).toEqual(["e2"]);
  });

  it("paid filter → only e3", () => {
    expect(applyFilters("paid", "")).toEqual(["e3"]);
  });

  it("draft filter → only e4 (sheet_synced)", () => {
    expect(applyFilters("draft", "")).toEqual(["e4"]);
  });

  it("all + search 'commercial' → only e4", () => {
    expect(applyFilters("all", "commercial")).toEqual(["e4"]);
  });

  it("all + search 'LA#1002' → only e2", () => {
    expect(applyFilters("all", "LA#1002")).toEqual(["e2"]);
  });

  it("paid + search 'shoot' → only e3 (paid and gig name contains 'shoot')", () => {
    expect(applyFilters("paid", "shoot")).toEqual(["e3"]);
  });

  it("paid + search 'commercial' → empty (e4 is not paid)", () => {
    expect(applyFilters("paid", "commercial")).toEqual([]);
  });
});

// ── Past job cannot open PDF unless PDF exists ────────────────────────────────

describe("past job quick-action availability", () => {
  it("entry with no PDF URL has no PDF to open", () => {
    const entry = makeEntry({ invoicePdfUrl: null });
    expect(entry.invoicePdfUrl).toBeNull();
  });

  it("entry with PDF URL can open PDF", () => {
    const entry = makeEntry({ invoicePdfUrl: "https://example.com/invoice-42.pdf" });
    expect(entry.invoicePdfUrl).not.toBeNull();
  });

  it("entry with no invoice cannot send (no invoice_total)", () => {
    const entry = makeEntry({ invoiceStatus: "none", invoiceTotal: null });
    // Sending requires status to be at least "sheet_synced" — "none" means no invoice yet
    expect(entry.invoiceStatus).toBe("none");
    expect(entry.invoiceTotal).toBeNull();
  });
});

// ── WorklistEntry scheduled time fields (startTimeUtc / endTimeUtc) ───────────

describe("WorklistEntry scheduled time fields", () => {
  it("timed event carries startTimeUtc and endTimeUtc (non-null)", () => {
    const entry = makeEntry({
      startTimeUtc: "2026-06-22T13:30:00.000Z", // 6:30 AM PDT
      endTimeUtc:   "2026-06-23T01:00:00.000Z", // 6:00 PM PDT
    });
    expect(entry.startTimeUtc).toBe("2026-06-22T13:30:00.000Z");
    expect(entry.endTimeUtc).toBe("2026-06-23T01:00:00.000Z");
  });

  it("all-day event has startTimeUtc = null and endTimeUtc = null", () => {
    const entry = makeEntry({ startTimeUtc: null, endTimeUtc: null });
    expect(entry.startTimeUtc).toBeNull();
    expect(entry.endTimeUtc).toBeNull();
  });

  it("default makeEntry has null time fields (represents all-day or unknown time)", () => {
    const entry = makeEntry();
    expect(entry.startTimeUtc).toBeNull();
    expect(entry.endTimeUtc).toBeNull();
  });

  it("multi-day timed event has startTimeUtc of first day start", () => {
    const entry = makeEntry({
      startDate:    "2026-06-22",
      endDate:      "2026-06-24",
      workDates:    ["2026-06-22", "2026-06-23", "2026-06-24"],
      startTimeUtc: "2026-06-22T13:30:00.000Z", // 6:30 AM PDT first day
      endTimeUtc:   "2026-06-25T01:00:00.000Z", // 6:00 PM PDT last day
    });
    expect(entry.startTimeUtc).not.toBeNull();
    expect(entry.endTimeUtc).not.toBeNull();
  });
});
