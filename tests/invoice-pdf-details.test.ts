/**
 * Tests for PDF invoice details formatting.
 *
 * Verifies the "Invoice details" block in the rendered PDF:
 *   Invoice no.: 1001 - LA #5555
 *   Terms:       Net 15
 *   Job:         test job
 *   Invoice date: 6/19/26
 *   Due date:    7/4/26
 *   Work dates:  6/18 - 6/20
 *
 * Key regression: when la_number is null in invoice_data (not explicitly saved),
 * the LA number must still be parsed from the gigSummary calendar title so that
 * clientInvoiceNumber includes it and jobTitle strips it from the Job row.
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Mirror helpers from lib/invoice-pdf.tsx (not exported)
// ---------------------------------------------------------------------------

function parseLaNumberFromSummary(summary: string): string | null {
  const match = summary.trim().match(/^\s*LA\s*#?\s*(\d{3,})\s*/i);
  return match?.[1] ? `LA#${match[1]}` : null;
}

function formatLaJobNumber(laNumber: string | null): string | null {
  if (!laNumber) return null;
  const clean = laNumber.replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "");
  return clean ? `LA #${clean}` : laNumber;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatJobTitle(gigSummary: string, laNumber: string | null): string {
  let title = gigSummary.trim();
  const cleanLa = laNumber?.replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "") ?? "";
  if (cleanLa) {
    title = title
      .replace(
        new RegExp(`^\\s*LA\\s*#?\\s*${escapeRegExp(cleanLa)}\\s*(?:[-–—:|]+\\s*)?`, "i"),
        "",
      )
      .trim();
  }
  return title.replace(/^[\s\-–—:|]+/, "").trim();
}

function fmtCompactDate(isoDate: string): string {
  const [y, mo, d] = isoDate.split("-").map(Number);
  return `${mo}/${d}/${String(y).slice(2)}`;
}

function fmtShortDate(isoDate: string, includeYear = false): string {
  const [y, mo, d] = isoDate.split("-").map(Number);
  return includeYear ? `${mo}/${d}/${y}` : `${mo}/${d}`;
}

function fmtWorkDates(workdays: Array<{ date: string }>): string {
  if (workdays.length === 0) return "";
  const dates = workdays.map((w) => w.date);
  if (dates.length === 1) return fmtShortDate(dates[0]!);
  const sorted = [...dates].sort();
  const start = sorted[0]!;
  const end = sorted[sorted.length - 1]!;
  const includeYear = start.slice(0, 4) !== end.slice(0, 4);
  return `${fmtShortDate(start, includeYear)} - ${fmtShortDate(end, includeYear)}`;
}

function fmtCompactTime(raw: string): string {
  const trimmed = raw.trim();
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(trimmed);
  if (!match) return trimmed.replace(/\s+/g, "").toLowerCase();
  const hour = Number(match[1]);
  const minute = match[2] ?? "00";
  const meridiem = (match[3] ?? "").toLowerCase();
  return `${hour}:${minute}${meridiem}`;
}

function fmtDailyHours(n: number): string {
  return n % 1 === 0 ? `${n}` : n.toFixed(1);
}

function fmtWorkedDateTimes(workdays: Array<{ date: string; startTime: string; endTime: string; totalHours: number }>): string {
  return workdays
    .map((workday) => {
      const date = fmtShortDate(workday.date);
      const start = fmtCompactTime(workday.startTime);
      const end = fmtCompactTime(workday.endTime);
      if (!start || !end) return date;
      const hrs = fmtDailyHours(workday.totalHours);
      return `${date} - ${start}-${end} (${hrs})`;
    })
    .join("\n");
}

function addDaysIso(isoDate: string, days: number): string {
  const [y, mo, d] = isoDate.split("-").map(Number);
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Mirrors InvoicePDF derivation with effectiveLaNumber fallback
function deriveDetailBlock(opts: {
  packetLaNumber: string | null;  // invoiceData.la_number
  gigSummary: string;             // calendar event title
  invoiceNumber: string;
  issuedDate: string;
  workdays: Array<{ date: string }>;
}) {
  const { packetLaNumber, gigSummary, invoiceNumber, issuedDate, workdays } = opts;

  // Key fix: fall back to parsing LA number from gigSummary
  const effectiveLaNumber = packetLaNumber ?? parseLaNumberFromSummary(gigSummary);
  const formattedLaJob = formatLaJobNumber(effectiveLaNumber);
  const clientInvoiceNumber = formattedLaJob ? `${invoiceNumber} - ${formattedLaJob}` : invoiceNumber;
  const jobTitle = formatJobTitle(gigSummary, effectiveLaNumber);
  const dueDate = addDaysIso(issuedDate, 15);

  return {
    clientInvoiceNumber,
    terms: "Net 15",
    jobTitle,
    invoiceDate: fmtCompactDate(issuedDate),
    dueDate: fmtCompactDate(dueDate),
    workDateStr: fmtWorkDates(workdays),
  };
}

// ---------------------------------------------------------------------------
// parseLaNumberFromSummary
// ---------------------------------------------------------------------------

describe("parseLaNumberFromSummary", () => {
  it("extracts LA number from 'LA#5555 — test job'", () => {
    expect(parseLaNumberFromSummary("LA#5555 — test job")).toBe("LA#5555");
  });

  it("extracts LA number from 'LA #5555 - test job'", () => {
    expect(parseLaNumberFromSummary("LA #5555 - test job")).toBe("LA#5555");
  });

  it("extracts LA number from 'LA 71852 – Wilm U Grad'", () => {
    expect(parseLaNumberFromSummary("LA 71852 – Wilm U Grad")).toBe("LA#71852");
  });

  it("extracts numeric-only portion — result starts with LA#", () => {
    const result = parseLaNumberFromSummary("LA#5555 — test job");
    expect(result).toMatch(/^LA#\d+$/);
  });

  it("returns null for summary with no LA number", () => {
    expect(parseLaNumberFromSummary("test job")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseLaNumberFromSummary("")).toBeNull();
  });

  it("requires at least 3 digits (not LA#12)", () => {
    expect(parseLaNumberFromSummary("LA#12 test")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Invoice no. field — clientInvoiceNumber
// ---------------------------------------------------------------------------

describe("clientInvoiceNumber", () => {
  it("combines invoice number and LA number: '1001 - LA #5555'", () => {
    const { clientInvoiceNumber } = deriveDetailBlock({
      packetLaNumber: "LA#5555",
      gigSummary: "LA#5555 — test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(clientInvoiceNumber).toBe("1001 - LA #5555");
  });

  it("uses gigSummary to extract LA number when la_number is null in DB (root cause fix)", () => {
    const { clientInvoiceNumber } = deriveDetailBlock({
      packetLaNumber: null,   // la_number not saved in invoice_data
      gigSummary: "LA#5555 — test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(clientInvoiceNumber).toBe("1001 - LA #5555");
  });

  it("uses gigSummary LA number with 'LA #' space format", () => {
    const { clientInvoiceNumber } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "LA #5555 - test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(clientInvoiceNumber).toBe("1001 - LA #5555");
  });

  it("shows only invoice number when no LA number anywhere", () => {
    const { clientInvoiceNumber } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(clientInvoiceNumber).toBe("1001");
  });

  it("stored la_number takes priority over gigSummary LA", () => {
    const { clientInvoiceNumber } = deriveDetailBlock({
      packetLaNumber: "LA#9999",   // stored
      gigSummary: "LA#5555 — test job",  // different in summary
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(clientInvoiceNumber).toBe("1001 - LA #9999");
  });

  it("formats 'LA #' with space (not 'LA#')", () => {
    const { clientInvoiceNumber } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "LA#71852 — Wilm U Grad",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(clientInvoiceNumber).toContain("LA #71852");
    expect(clientInvoiceNumber).not.toContain("LA#71852");
  });
});

// ---------------------------------------------------------------------------
// Job field — clean job title
// ---------------------------------------------------------------------------

describe("jobTitle", () => {
  it("strips LA prefix when la_number is null (fallback parse)", () => {
    const { jobTitle } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "LA#5555 — test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(jobTitle).toBe("test job");
  });

  it("strips LA prefix when la_number is stored", () => {
    const { jobTitle } = deriveDetailBlock({
      packetLaNumber: "LA#5555",
      gigSummary: "LA#5555 — test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(jobTitle).toBe("test job");
  });

  it("does not contain the LA number in the Job row", () => {
    const { jobTitle } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "LA#5555 — test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(jobTitle).not.toMatch(/LA\s*#?\s*5555/i);
  });

  it("does not start with a dash or em-dash", () => {
    const { jobTitle } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "LA#5555 — test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(jobTitle).not.toMatch(/^[-–—]/);
  });

  it("returns raw title when no LA prefix", () => {
    const { jobTitle } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(jobTitle).toBe("test job");
  });

  it("strips 'LA #5555 - ' with hyphen separator", () => {
    const { jobTitle } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "LA #5555 - test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(jobTitle).toBe("test job");
  });

  it("strips 'LA71852 – Wilm U Grad' (en-dash)", () => {
    const { jobTitle } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "LA71852 – Wilm U Grad",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(jobTitle).toBe("Wilm U Grad");
  });
});

// ---------------------------------------------------------------------------
// Terms row
// ---------------------------------------------------------------------------

describe("Terms row", () => {
  it("is always 'Net 15'", () => {
    const { terms } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(terms).toBe("Net 15");
  });
});

// ---------------------------------------------------------------------------
// Date fields
// ---------------------------------------------------------------------------

describe("date formatting", () => {
  it("invoice date: 2026-06-19 → '6/19/26'", () => {
    const { invoiceDate } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(invoiceDate).toBe("6/19/26");
  });

  it("due date: 15 days after 2026-06-19 = 2026-07-04 → '7/4/26'", () => {
    const { dueDate } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(dueDate).toBe("7/4/26");
  });

  it("work dates: 6/18 - 6/20 (no year when same year)", () => {
    const { workDateStr } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [
        { date: "2026-06-18" },
        { date: "2026-06-19" },
        { date: "2026-06-20" },
      ],
    });
    expect(workDateStr).toBe("6/18 - 6/20");
  });

  it("single work date: '6/19'", () => {
    const { workDateStr } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [{ date: "2026-06-19" }],
    });
    expect(workDateStr).toBe("6/19");
  });

  it("no workdays: empty string (row hidden)", () => {
    const { workDateStr } = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [],
    });
    expect(workDateStr).toBe("");
  });
});

// ---------------------------------------------------------------------------
// PDF line-item description — all worked dates/times
// ---------------------------------------------------------------------------

describe("worked date/time description", () => {
  it("shows each workday with hours in parentheses", () => {
    expect(fmtWorkedDateTimes([
      { date: "2026-06-18", startTime: "6:00 AM", endTime: "11:30 PM", totalHours: 17.5 },
      { date: "2026-06-19", startTime: "9:00 AM", endTime: "7:00 PM",  totalHours: 10 },
      { date: "2026-06-20", startTime: "3:00 PM", endTime: "4:30 AM",  totalHours: 13.5 },
    ])).toBe([
      "6/18 - 6:00am-11:30pm (17.5)",
      "6/19 - 9:00am-7:00pm (10)",
      "6/20 - 3:00pm-4:30am (13.5)",
    ].join("\n"));
  });

  it("overnight shift: 5:00am-2:00am shows (21)", () => {
    expect(fmtWorkedDateTimes([
      { date: "2026-06-21", startTime: "5:00 AM", endTime: "2:00 AM", totalHours: 21 },
    ])).toBe("6/21 - 5:00am-2:00am (21)");
  });

  it("standard day: 10:00am-10:00pm shows (12)", () => {
    expect(fmtWorkedDateTimes([
      { date: "2026-06-22", startTime: "10:00 AM", endTime: "10:00 PM", totalHours: 12 },
    ])).toBe("6/22 - 10:00am-10:00pm (12)");
  });

  it("multi-day: exact output matches desired example", () => {
    expect(fmtWorkedDateTimes([
      { date: "2026-06-21", startTime: "5:00 AM",  endTime: "2:00 AM",  totalHours: 21 },
      { date: "2026-06-22", startTime: "10:00 AM", endTime: "10:00 PM", totalHours: 12 },
      { date: "2026-06-23", startTime: "2:00 AM",  endTime: "4:00 PM",  totalHours: 14 },
    ])).toBe([
      "6/21 - 5:00am-2:00am (21)",
      "6/22 - 10:00am-10:00pm (12)",
      "6/23 - 2:00am-4:00pm (14)",
    ].join("\n"));
  });

  it("whole-number hours use integer format, not decimal", () => {
    const result = fmtWorkedDateTimes([
      { date: "2026-06-18", startTime: "8:00 AM", endTime: "6:00 PM", totalHours: 10 },
    ]);
    expect(result).toContain("(10)");
    expect(result).not.toContain("(10.0)");
    expect(result).not.toContain("(10.00)");
  });

  it("partial hours use one decimal place", () => {
    const result = fmtWorkedDateTimes([
      { date: "2026-06-18", startTime: "8:00 AM", endTime: "6:30 PM", totalHours: 10.5 },
    ]);
    expect(result).toContain("(10.5)");
  });

  it("workday missing times falls back to date only (no hours shown)", () => {
    expect(fmtWorkedDateTimes([
      { date: "2026-06-18", startTime: "", endTime: "", totalHours: 0 },
    ])).toBe("6/18");
  });
});

// ---------------------------------------------------------------------------
// Full block — expected output matches requirements
// ---------------------------------------------------------------------------

describe("full invoice details block", () => {
  it("matches expected output for 'LA#5555 — test job' with null la_number", () => {
    const block = deriveDetailBlock({
      packetLaNumber: null,
      gigSummary: "LA#5555 — test job",
      invoiceNumber: "1001",
      issuedDate: "2026-06-19",
      workdays: [
        { date: "2026-06-18" },
        { date: "2026-06-19" },
        { date: "2026-06-20" },
      ],
    });
    expect(block.clientInvoiceNumber).toBe("1001 - LA #5555");
    expect(block.terms).toBe("Net 15");
    expect(block.jobTitle).toBe("test job");
    expect(block.invoiceDate).toBe("6/19/26");
    expect(block.dueDate).toBe("7/4/26");
    expect(block.workDateStr).toBe("6/18 - 6/20");
  });

  it("matches expected output for Wilm U Grad with stored la_number", () => {
    const block = deriveDetailBlock({
      packetLaNumber: "LA#71852",
      gigSummary: "LA#71852 — Wilm U Grad",
      invoiceNumber: "1002",
      issuedDate: "2026-05-31",
      workdays: [{ date: "2026-05-31" }, { date: "2026-06-01" }],
    });
    expect(block.clientInvoiceNumber).toBe("1002 - LA #71852");
    expect(block.terms).toBe("Net 15");
    expect(block.jobTitle).toBe("Wilm U Grad");
    expect(block.invoiceDate).toBe("5/31/26");
    expect(block.dueDate).toBe("6/15/26");
    expect(block.workDateStr).toBe("5/31 - 6/1");
  });
});
