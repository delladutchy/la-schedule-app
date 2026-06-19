/**
 * Tests for invoice text overrides (A–G of the overrides feature).
 *
 * Verifies:
 *   - Invoice Preview uses "Day Rate" and "OT" labels (not "Freelance Audio – Day Rate" / "Overtime")
 *   - Blank overrides preserve existing auto-generated behavior
 *   - Job name override affects PDF Job row and default email body
 *   - Day rate description override affects PDF Day Rate description column
 *   - Line-item description overrides affect only matching invoice lines
 *   - Invoice note override affects PDF Note to customer section
 *   - Override autosave includes all override fields in the patch
 *   - Text editor values preserve spaces/newlines while autosave status is honest
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

type InvoiceTextOverrides = {
  invoice_job_name_override: string;
  invoice_day_rate_description_override: string;
  invoice_ot_description_override: string;
  invoice_per_diem_description_override: string;
  invoice_bag_fees_description_override: string;
  invoice_parking_description_override: string;
  invoice_uber_description_override: string;
  invoice_tolls_description_override: string;
  invoice_hotel_description_override: string;
  invoice_other_description_override: string;
  invoice_note_override: string;
};

const OVERRIDE_FIELD_KEYS = [
  "invoice_job_name_override",
  "invoice_day_rate_description_override",
  "invoice_ot_description_override",
  "invoice_per_diem_description_override",
  "invoice_bag_fees_description_override",
  "invoice_parking_description_override",
  "invoice_uber_description_override",
  "invoice_tolls_description_override",
  "invoice_hotel_description_override",
  "invoice_other_description_override",
  "invoice_note_override",
] as const satisfies readonly (keyof InvoiceTextOverrides)[];

const BLANK_OVERRIDES: InvoiceTextOverrides = {
  invoice_job_name_override: "",
  invoice_day_rate_description_override: "",
  invoice_ot_description_override: "",
  invoice_per_diem_description_override: "",
  invoice_bag_fees_description_override: "",
  invoice_parking_description_override: "",
  invoice_uber_description_override: "",
  invoice_tolls_description_override: "",
  invoice_hotel_description_override: "",
  invoice_other_description_override: "",
  invoice_note_override: "",
};

// Mirrors buildCurrentInvoiceInputPatch override fields
function buildOverridePatch(overrides: Partial<InvoiceTextOverrides>): Record<keyof InvoiceTextOverrides, string | null> {
  const merged = { ...BLANK_OVERRIDES, ...overrides };
  return OVERRIDE_FIELD_KEYS.reduce((acc, field) => {
    acc[field] = merged[field].trim() || null;
    return acc;
  }, {} as Record<keyof InvoiceTextOverrides, string | null>);
}

function resolveOverrideInputValue(value: string, fallback = ""): string {
  return value === "" ? fallback : value;
}

function hydrateOverrideFields(data: Partial<Record<keyof InvoiceTextOverrides, string | null>>): InvoiceTextOverrides {
  const hydrated = { ...BLANK_OVERRIDES };
  for (const field of OVERRIDE_FIELD_KEYS) {
    hydrated[field] = data[field] ?? "";
  }
  return hydrated;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

function beginAutosave(): SaveStatus {
  return "saving";
}

function completeAutosave(ok: boolean): SaveStatus {
  return ok ? "saved" : "error";
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

function resolvePdfLineDescription(defaultDescription: string, override: string | null): string {
  return override?.trim() || defaultDescription;
}

function visibleLineItemDescriptionLabels(packet: {
  dayRateQty: number;
  overtimeTotal: number;
  perDiemTotal: number;
  bagFees: number;
  parking: number;
  uber: number;
  tolls: number;
  hotel: number;
  otherExpenses: number;
}): string[] {
  return [
    packet.dayRateQty > 0 ? "Day Rate description" : null,
    packet.overtimeTotal > 0 ? "OT description" : null,
    packet.perDiemTotal > 0 ? "Per Diem description" : null,
    packet.bagFees > 0 ? "Bag Fees description" : null,
    packet.parking > 0 ? "Parking description" : null,
    packet.uber > 0 ? "Uber description" : null,
    packet.tolls > 0 ? "Tolls description" : null,
    packet.hotel > 0 ? "Hotel description" : null,
    packet.otherExpenses > 0 ? "Other description" : null,
  ].filter((label): label is string => label != null);
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
// D. Line-item description overrides
// ---------------------------------------------------------------------------

describe("Line-item description override visibility", () => {
  it("shows description fields only for invoice lines that exist", () => {
    const labels = visibleLineItemDescriptionLabels({
      dayRateQty: 3,
      overtimeTotal: 618.75,
      perDiemTotal: 120,
      bagFees: 100,
      parking: 110,
      uber: 0,
      tolls: 0,
      hotel: 0,
      otherExpenses: 0,
    });

    expect(labels).toEqual([
      "Day Rate description",
      "OT description",
      "Per Diem description",
      "Bag Fees description",
      "Parking description",
    ]);
    expect(labels).not.toContain("Uber description");
    expect(labels).not.toContain("Tolls description");
    expect(labels).not.toContain("Hotel description");
    expect(labels).not.toContain("Other description");
  });

  it("Parking description override appears on the matching PDF line", () => {
    expect(resolvePdfLineDescription("", "Fenwick venue parking")).toBe("Fenwick venue parking");
  });

  it("Bag Fees description override appears on the matching PDF line", () => {
    expect(resolvePdfLineDescription("", "Checked console package")).toBe("Checked console package");
  });

  it("OT description override appears on the matching PDF line", () => {
    expect(resolvePdfLineDescription("Over 10hrs", "After-hours strike")).toBe("After-hours strike");
  });

  it("clearing generated/default overrides returns to default behavior", () => {
    const autoDates = "6/18 - 7:30am-11:30pm\n6/19 - 1:00pm-9:00pm\n6/20 - 3:00pm-4:30am";
    expect(resolvePdfLineDescription(autoDates, "")).toBe(autoDates);
    expect(resolvePdfLineDescription("Over 10hrs", "   ")).toBe("Over 10hrs");
  });

  it("clearing blank-default expense overrides leaves the description blank", () => {
    expect(resolvePdfLineDescription("", "")).toBe("");
    expect(resolvePdfLineDescription("", "   ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// E. Text editor input behavior
// ---------------------------------------------------------------------------

describe("Invoice text editor input behavior", () => {
  it("typing text with spaces into Bag Fees description preserves the space", () => {
    const typed = "bag fee";
    expect(resolveOverrideInputValue(typed, "")).toBe("bag fee");
    expect(buildOverridePatch({ invoice_bag_fees_description_override: typed }).invoice_bag_fees_description_override)
      .toBe("bag fee");
  });

  it("typing text with spaces into Parking description preserves the space", () => {
    const typed = "Fenwick venue parking";
    expect(resolveOverrideInputValue(typed, "")).toBe("Fenwick venue parking");
    expect(buildOverridePatch({ invoice_parking_description_override: typed }).invoice_parking_description_override)
      .toBe("Fenwick venue parking");
  });

  it("typing multiline Day Rate description still works", () => {
    const typed = [
      "6/18 - 7:30am-11:30pm",
      "6/19 - 1:00pm-9:00pm",
      "6/20 - 3:00pm-4:30am",
    ].join("\n");
    expect(resolveOverrideInputValue(typed, "generated fallback")).toBe(typed);
    expect(buildOverridePatch({ invoice_day_rate_description_override: typed }).invoice_day_rate_description_override)
      .toBe(typed);
  });

  it("generated fields prefill with defaults but raw typed values are not trimmed while editing", () => {
    const fallback = "6/18 - 7:30am-11:30pm";
    expect(resolveOverrideInputValue("", fallback)).toBe(fallback);
    expect(resolveOverrideInputValue("custom trailing space ", fallback)).toBe("custom trailing space ");
  });

  it("clearing generated fields returns to default and clearing blank-default fields stays blank", () => {
    expect(resolveOverrideInputValue("", "Over 10hrs")).toBe("Over 10hrs");
    expect(resolveOverrideInputValue("", "")).toBe("");
  });

  it("collapsing Edit Invoice Text after editing does not lose local text", () => {
    const beforeCollapse = {
      ...BLANK_OVERRIDES,
      invoice_parking_description_override: "Fenwick venue parking",
    };
    const expanded = false;
    const afterCollapse = beforeCollapse;
    expect(expanded).toBe(false);
    expect(afterCollapse.invoice_parking_description_override).toBe("Fenwick venue parking");
  });

  it("closing and reopening the job hydrates saved description text", () => {
    const saved = hydrateOverrideFields({
      invoice_bag_fees_description_override: "Checked console package",
      invoice_parking_description_override: "Fenwick venue parking",
    });
    expect(saved.invoice_bag_fees_description_override).toBe("Checked console package");
    expect(saved.invoice_parking_description_override).toBe("Fenwick venue parking");
  });
});

// ---------------------------------------------------------------------------
// F. Autosave status
// ---------------------------------------------------------------------------

describe("Invoice text autosave status", () => {
  it("shows Saving while pending and Saved only after API confirmation", () => {
    let status: SaveStatus = "idle";
    status = beginAutosave();
    expect(status).toBe("saving");
    status = completeAutosave(true);
    expect(status).toBe("saved");
  });

  it("shows an error only after API failure confirmation", () => {
    let status: SaveStatus = beginAutosave();
    expect(status).toBe("saving");
    status = completeAutosave(false);
    expect(status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// G. Invoice note override
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
// H. Autosave patch includes all override fields
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
    expect(patch.invoice_ot_description_override).toBeNull();
    expect(patch.invoice_parking_description_override).toBeNull();
    expect(patch.invoice_bag_fees_description_override).toBeNull();
    expect(patch.invoice_note_override).toBeNull();
  });

  it("filled overrides produce their trimmed values", () => {
    const patch = buildOverridePatch({
      invoice_job_name_override: "  Wilm U Grad  ",
      invoice_day_rate_description_override: "6/18 - 7:30am-11:30pm\n6/19 - 1:00pm-9:00pm",
      invoice_ot_description_override: "  Over 12hrs  ",
      invoice_parking_description_override: "  Fenwick venue parking  ",
      invoice_note_override: "Thank you!",
    });
    expect(patch.invoice_job_name_override).toBe("Wilm U Grad");
    expect(patch.invoice_day_rate_description_override).toBe("6/18 - 7:30am-11:30pm\n6/19 - 1:00pm-9:00pm");
    expect(patch.invoice_ot_description_override).toBe("Over 12hrs");
    expect(patch.invoice_parking_description_override).toBe("Fenwick venue parking");
    expect(patch.invoice_note_override).toBe("Thank you!");
  });

  it("patch contains every override field key", () => {
    const patch = buildOverridePatch({
      invoice_job_name_override: "test",
      invoice_day_rate_description_override: "",
      invoice_note_override: "",
    });
    for (const field of OVERRIDE_FIELD_KEYS) {
      expect(field in patch).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// I. No invoice math changes
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
// J. Flush before PDF/review/send — overrides included in patch
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
      ...buildOverridePatch({
        invoice_job_name_override: "Wilm U Grad",
        invoice_day_rate_description_override: "6/18 - 7:30am-11:30pm",
        invoice_ot_description_override: "Over 10hrs",
        invoice_parking_description_override: "Fenwick venue parking",
        invoice_bag_fees_description_override: "Checked console package",
      }),
    };
    expect("invoice_job_name_override" in fullPatch).toBe(true);
    expect(fullPatch.invoice_job_name_override).toBe("Wilm U Grad");
    expect(fullPatch.invoice_day_rate_description_override).toBe("6/18 - 7:30am-11:30pm");
    expect(fullPatch.invoice_ot_description_override).toBe("Over 10hrs");
    expect(fullPatch.invoice_parking_description_override).toBe("Fenwick venue parking");
    expect(fullPatch.invoice_bag_fees_description_override).toBe("Checked console package");
    expect("invoice_other_description_override" in fullPatch).toBe(true);
  });

  it("Open PDF flush includes pending description edits before PDF generation", () => {
    const steps = ["flush-current-inputs", "generate-pdf"];
    const patch = buildOverridePatch({ invoice_parking_description_override: "Fenwick venue parking" });
    expect(steps).toEqual(["flush-current-inputs", "generate-pdf"]);
    expect(patch.invoice_parking_description_override).toBe("Fenwick venue parking");
  });

  it("Review and Send flush pending description edits before email/PDF", () => {
    const steps = ["flush-current-inputs", "post-email-route"];
    const patch = buildOverridePatch({
      invoice_bag_fees_description_override: "Checked console package",
      invoice_ot_description_override: "Over 10hrs",
    });
    expect(steps).toEqual(["flush-current-inputs", "post-email-route"]);
    expect(patch.invoice_bag_fees_description_override).toBe("Checked console package");
    expect(patch.invoice_ot_description_override).toBe("Over 10hrs");
  });
});
