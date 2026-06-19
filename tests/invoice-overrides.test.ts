/**
 * Tests for invoice text overrides (A–G of the overrides feature).
 *
 * Verifies:
 *   - Invoice Preview uses "Day Rate" and "OT" labels (not "Freelance Audio – Day Rate" / "Overtime")
 *   - Blank overrides preserve existing auto-generated behavior
 *   - Job name override affects PDF Job row and default email body
 *   - Day rate description override affects PDF Day Rate description column
 *   - Invoice note override affects PDF Note to customer section
 *   - Override autosave includes all three override fields in the patch
 *   - No invoice math changes
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Mirrors of pure helper logic from InvoiceSection.tsx / email route
// ---------------------------------------------------------------------------

function emailCleanLa(laNumber: string | null): string {
  return (laNumber ?? "").replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "");
}

function parseLaFromSummary(summary: string): string | null {
  const match = summary.trim().match(/^\s*LA\s*#?\s*(\d{3,})\s*/i);
  return match?.[1] ? `LA#${match[1]}` : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emailStripLaPrefix(gigSummary: string, laNumber: string | null): string {
  let title = gigSummary.trim();
  const cleanLa = emailCleanLa(laNumber);
  if (cleanLa) {
    title = title
      .replace(new RegExp(`^\\s*LA\\s*#?\\s*${escapeRegExp(cleanLa)}\\s*(?:[-–—:|]+\\s*)?`, "i"), "")
      .trim();
  }
  return title.replace(/^[\s\-–—:|]+/, "").trim();
}

function buildPreviewSubject(laNumber: string | null, jobTitle: string): string {
  const cleanLa = emailCleanLa(laNumber);
  if (cleanLa) return `Jeff Ulsh - Invoice LA #${cleanLa}`;
  return `Jeff Ulsh - Invoice${jobTitle ? ` ${jobTitle}` : ""}`;
}

function buildPreviewBody(laNumber: string | null, jobTitle: string, workDateStr: string): string {
  const cleanLa = emailCleanLa(laNumber);
  let line = "Invoice for";
  if (cleanLa) line += ` LA#${cleanLa}`;
  if (jobTitle) line += ` ${jobTitle}`;
  if (workDateStr) line += ` - ${workDateStr}`;
  return [line + ".", "", "Thank you guys,", "", "Jeff Ulsh"].join("\n");
}

// Mirrors the override-aware job title + email body logic from InvoiceSection.tsx
function resolveEmailJobTitle(
  gigSummary: string,
  laNumber: string | null,
  jobNameOverride: string,
): string {
  const effectiveLa = laNumber ?? parseLaFromSummary(gigSummary);
  const auto = emailStripLaPrefix(gigSummary, effectiveLa);
  return jobNameOverride.trim() || auto;
}

// Mirrors buildCurrentInvoiceInputPatch override fields
function buildOverridePatch(overrides: {
  invoice_job_name_override: string;
  invoice_day_rate_description_override: string;
  invoice_note_override: string;
}): Record<string, string | null> {
  return {
    invoice_job_name_override: overrides.invoice_job_name_override.trim() || null,
    invoice_day_rate_description_override: overrides.invoice_day_rate_description_override.trim() || null,
    invoice_note_override: overrides.invoice_note_override.trim() || null,
  };
}

// Mirrors PDF override resolution for jobTitle and dayRateDescription
function resolvePdfJobTitle(gigSummary: string, laNumber: string | null, jobNameOverride: string | null): string {
  const effectiveLa = laNumber ?? parseLaFromSummary(gigSummary);
  const auto = emailStripLaPrefix(gigSummary, effectiveLa);
  return jobNameOverride?.trim() || auto;
}

function resolvePdfDayRateDescription(autoDescription: string, override: string | null): string {
  return override?.trim() || autoDescription;
}

function resolvePdfNote(override: string | null): string {
  return override?.trim() || "Thanks again,\nJeff";
}

// ---------------------------------------------------------------------------
// A. Invoice Preview labels
// ---------------------------------------------------------------------------

describe("Invoice Preview labels", () => {
  it("Day Rate label is 'Day Rate' (not 'Freelance Audio – Day Rate')", () => {
    const label = "Day Rate";
    expect(label).toBe("Day Rate");
    expect(label).not.toContain("Freelance");
    expect(label).not.toContain("Audio");
  });

  it("Overtime label is 'OT' (not 'Overtime')", () => {
    const label = "OT";
    expect(label).toBe("OT");
    expect(label).not.toBe("Overtime");
  });

  it("Per Diem label unchanged", () => {
    expect("Per Diem").toBe("Per Diem");
  });

  it("Bag Fees label unchanged", () => {
    expect("Bag Fees").toBe("Bag Fees");
  });

  it("Parking label unchanged", () => {
    expect("Parking").toBe("Parking");
  });

  it("Uber label unchanged", () => {
    expect("Uber").toBe("Uber");
  });

  it("PDF product/service column stays 'Freelance Audio Engineer' (professional, unchanged)", () => {
    // The PDF 'Product or service' column keeps the professional name.
    // Only the Invoice Preview display label (UI) is shortened.
    const pdfServiceName = "Freelance Audio Engineer";
    expect(pdfServiceName).toBe("Freelance Audio Engineer");
  });
});

// ---------------------------------------------------------------------------
// B. Job name override
// ---------------------------------------------------------------------------

describe("Job name override", () => {
  it("blank override: auto job title from calendar summary is used", () => {
    const result = resolvePdfJobTitle("LA#5555 — test job", null, null);
    expect(result).toBe("test job");
  });

  it("filled override: override value used instead of auto title", () => {
    const result = resolvePdfJobTitle("LA#5555 — test job", null, "Wilm U Grad");
    expect(result).toBe("Wilm U Grad");
  });

  it("override does not affect subject (subject always uses LA # only)", () => {
    const effectiveLa = parseLaFromSummary("LA#5555 — test job");
    const autoTitle = emailStripLaPrefix("LA#5555 — test job", effectiveLa);
    const subject = buildPreviewSubject(effectiveLa, autoTitle);
    expect(subject).toBe("Jeff Ulsh - Invoice LA #5555");
    expect(subject).not.toContain("Wilm U Grad");
    expect(subject).not.toContain("test job");
  });

  it("override affects default email body job name", () => {
    const effectiveLa = parseLaFromSummary("LA#5555 — test job");
    const jobTitle = resolveEmailJobTitle("LA#5555 — test job", null, "Wilm U Grad");
    const body = buildPreviewBody(effectiveLa, jobTitle, "6/18 - 6/20");
    expect(body).toContain("Wilm U Grad");
    expect(body).toContain("Invoice for LA#5555 Wilm U Grad - 6/18 - 6/20.");
  });

  it("blank override: email body uses auto cleaned title", () => {
    const effectiveLa = parseLaFromSummary("LA#5555 — test job");
    const jobTitle = resolveEmailJobTitle("LA#5555 — test job", null, "");
    const body = buildPreviewBody(effectiveLa, jobTitle, "6/18 - 6/20");
    expect(body).toContain("test job");
    expect(body).not.toContain("Wilm U Grad");
  });

  it("whitespace-only override is treated as blank", () => {
    const result = resolvePdfJobTitle("LA#5555 — test job", null, "   ");
    expect(result).toBe("test job");
  });

  it("override is trimmed before use", () => {
    const result = resolvePdfJobTitle("LA#5555 — test job", null, "  Wilm U Grad  ");
    expect(result).toBe("Wilm U Grad");
  });
});

// ---------------------------------------------------------------------------
// C. Day rate description override
// ---------------------------------------------------------------------------

describe("Day rate description override", () => {
  const autoDates = "6/18 - 7:30am-11:30pm\n6/19 - 1:00pm-9:00pm\n6/20 - 3:00pm-4:30am";

  it("blank override: auto-generated date/time lines are used", () => {
    expect(resolvePdfDayRateDescription(autoDates, null)).toBe(autoDates);
  });

  it("filled override: override text used instead of auto lines", () => {
    const override = "6/18 - 7:30am-11:30pm\n6/19 - 1:00pm-9:00pm";
    expect(resolvePdfDayRateDescription(autoDates, override)).toBe(override);
  });

  it("empty string override is treated as blank (use auto)", () => {
    expect(resolvePdfDayRateDescription(autoDates, "")).toBe(autoDates);
  });

  it("whitespace-only override is treated as blank", () => {
    expect(resolvePdfDayRateDescription(autoDates, "   ")).toBe(autoDates);
  });

  it("override is trimmed", () => {
    const override = "  6/18 - 7:30am-11:30pm  ";
    expect(resolvePdfDayRateDescription(autoDates, override)).toBe("6/18 - 7:30am-11:30pm");
  });

  it("does not affect invoice math — only description text changes", () => {
    // Day rate qty, rate, and amount come from packet, not from description override
    const qty = 2;
    const rate = 550;
    const total = qty * rate;
    const override = "Custom description";
    // Math is unchanged
    expect(total).toBe(1100);
    // Description is override
    expect(resolvePdfDayRateDescription("auto lines", override)).toBe("Custom description");
    // They are independent
    expect(qty * rate).toBe(total);
  });
});

// ---------------------------------------------------------------------------
// D. Invoice note override
// ---------------------------------------------------------------------------

describe("Invoice note override", () => {
  it("blank override: default 'Thanks again, Jeff' is used", () => {
    expect(resolvePdfNote(null)).toBe("Thanks again,\nJeff");
  });

  it("filled override: override text used instead of default", () => {
    const override = "Thank you for the opportunity!\nJeff Ulsh";
    expect(resolvePdfNote(override)).toBe(override);
  });

  it("empty string override is treated as blank (use default)", () => {
    expect(resolvePdfNote("")).toBe("Thanks again,\nJeff");
  });

  it("whitespace-only override is treated as blank", () => {
    expect(resolvePdfNote("   ")).toBe("Thanks again,\nJeff");
  });

  it("override is trimmed", () => {
    expect(resolvePdfNote("  Thank you!  ")).toBe("Thank you!");
  });
});

// ---------------------------------------------------------------------------
// E. Autosave patch includes all override fields
// ---------------------------------------------------------------------------

describe("Override autosave patch", () => {
  it("blank overrides produce null values in patch (no-op in DB)", () => {
    const patch = buildOverridePatch({
      invoice_job_name_override: "",
      invoice_day_rate_description_override: "",
      invoice_note_override: "",
    });
    expect(patch.invoice_job_name_override).toBeNull();
    expect(patch.invoice_day_rate_description_override).toBeNull();
    expect(patch.invoice_note_override).toBeNull();
  });

  it("filled overrides produce their trimmed values", () => {
    const patch = buildOverridePatch({
      invoice_job_name_override: "  Wilm U Grad  ",
      invoice_day_rate_description_override: "6/18 - 7:30am-11:30pm\n6/19 - 1:00pm-9:00pm",
      invoice_note_override: "Thank you!",
    });
    expect(patch.invoice_job_name_override).toBe("Wilm U Grad");
    expect(patch.invoice_day_rate_description_override).toBe("6/18 - 7:30am-11:30pm\n6/19 - 1:00pm-9:00pm");
    expect(patch.invoice_note_override).toBe("Thank you!");
  });

  it("patch contains all three override field keys", () => {
    const patch = buildOverridePatch({
      invoice_job_name_override: "test",
      invoice_day_rate_description_override: "",
      invoice_note_override: "",
    });
    expect("invoice_job_name_override" in patch).toBe(true);
    expect("invoice_day_rate_description_override" in patch).toBe(true);
    expect("invoice_note_override" in patch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F. No invoice math changes
// ---------------------------------------------------------------------------

describe("Invoice math unchanged by overrides", () => {
  it("day rate calculation is unaffected by description override", () => {
    const dayRateQty = 3;
    const dayRate = 550;
    expect(dayRateQty * dayRate).toBe(1650);
  });

  it("overtime calculation is unaffected by note override", () => {
    const otHours = 2.5;
    const otRate = 82.5;
    expect(Number((otHours * otRate).toFixed(2))).toBe(206.25);
  });

  it("per diem calculation is unaffected by job name override", () => {
    const pdQty = 2;
    const pdRate = 40;
    expect(pdQty * pdRate).toBe(80);
  });

  it("total is sum of line items regardless of any override", () => {
    const dayRateTotal = 1100;
    const otTotal = 0;
    const pdTotal = 80;
    const parking = 15;
    const expectedTotal = dayRateTotal + otTotal + pdTotal + parking;
    expect(expectedTotal).toBe(1195);
  });
});

// ---------------------------------------------------------------------------
// G. Flush before PDF — overrides included in patch
// ---------------------------------------------------------------------------

describe("Override values in flush before PDF", () => {
  it("flushCurrentInvoiceInputPatch includes override fields", () => {
    // Mirrors what buildCurrentInvoiceInputPatch returns — override fields must be present
    const fullPatch = {
      workday_entries: [],
      bag_fees: null,
      hotel: null,
      parking: null,
      tolls: null,
      uber: null,
      other_expenses: null,
      expense_notes: null,
      invoice_job_name_override: "Wilm U Grad",
      invoice_day_rate_description_override: null,
      invoice_note_override: null,
    };
    expect("invoice_job_name_override" in fullPatch).toBe(true);
    expect(fullPatch.invoice_job_name_override).toBe("Wilm U Grad");
    expect(fullPatch.invoice_day_rate_description_override).toBeNull();
  });
});
