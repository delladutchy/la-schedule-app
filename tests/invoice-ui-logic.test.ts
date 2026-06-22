/**
 * Tests for pure-function logic underlying the invoice UI changes.
 *
 * Covers:
 *   1. SaveStatus state machine transitions
 *   2. isEditableKeyboardTarget extended cases
 *   3. Autosave feedback text mapping (status → display text)
 *   4. Unsaved changes detection (saveStatus === "unsaved" || isSaving → hasPending)
 *   5. VOID_STATUS cross-reference: VOID rows don't trigger the duplicate warning
 *   6. Gmail Draft success opens draft URL and keeps fallback link
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { isEditableKeyboardTarget } from "@/lib/keyboard";
import { isInvoiceDataRow, VOID_STATUS } from "@/lib/google-sheets";
import { openGmailDraftUrl } from "@/components/InvoiceSection";

// ---------------------------------------------------------------------------
// 1. SaveStatus state machine transitions
// ---------------------------------------------------------------------------

type SaveStatus = "idle" | "unsaved" | "saving" | "saved" | "error";

/**
 * Mirrors the transition logic in InvoiceSection:
 * - scheduleSave() → "unsaved"
 * - save() starts  → "saving"
 * - save() succeeds (same version) → "saved"
 * - save() fails   (same version) → "error"
 * - fetch / mount  → "idle"
 */
function applyTransition(
  current: SaveStatus,
  action: "scheduleSave" | "saveStart" | "saveSucceeded" | "saveFailed" | "reset",
): SaveStatus {
  switch (action) {
    case "scheduleSave":   return "unsaved";
    case "saveStart":      return "saving";
    case "saveSucceeded":  return "saved";
    case "saveFailed":     return "error";
    case "reset":          return "idle";
  }
}

describe("SaveStatus state machine", () => {
  it("transitions idle → unsaved on scheduleSave", () => {
    expect(applyTransition("idle", "scheduleSave")).toBe("unsaved");
  });

  it("transitions unsaved → saving when the fetch starts", () => {
    expect(applyTransition("unsaved", "saveStart")).toBe("saving");
  });

  it("transitions saving → saved on success", () => {
    expect(applyTransition("saving", "saveSucceeded")).toBe("saved");
  });

  it("transitions saving → error on failure", () => {
    expect(applyTransition("saving", "saveFailed")).toBe("error");
  });

  it("transitions error → unsaved when user makes another change", () => {
    expect(applyTransition("error", "scheduleSave")).toBe("unsaved");
  });

  it("transitions any state → idle on reset (new event loaded)", () => {
    for (const s of ["idle", "unsaved", "saving", "saved", "error"] as SaveStatus[]) {
      expect(applyTransition(s, "reset")).toBe("idle");
    }
  });

  it("new status type 'unsaved' is distinct from all other statuses", () => {
    const statuses: SaveStatus[] = ["idle", "unsaved", "saving", "saved", "error"];
    // Ensure "unsaved" appears exactly once in the union
    expect(statuses.filter((s) => s === "unsaved")).toHaveLength(1);
    expect(statuses.filter((s) => s === "idle")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. isEditableKeyboardTarget — extended cases
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for DOM elements without a real DOM.
 * Matches the shape cast inside isEditableKeyboardTarget.
 */
function fakeElement(
  tagName: string,
  extras: { isContentEditable?: boolean; getAttribute?: (name: string) => string | null; closest?: (selector: string) => null } = {},
): EventTarget {
  return {
    tagName: tagName.toUpperCase(),
    isContentEditable: false,
    getAttribute: () => null,
    closest: () => null,
    ...extras,
  } as unknown as EventTarget;
}

describe("isEditableKeyboardTarget — extended cases", () => {
  it("returns true for <textarea>", () => {
    expect(isEditableKeyboardTarget(fakeElement("textarea"))).toBe(true);
  });

  it("returns true for <input>", () => {
    expect(isEditableKeyboardTarget(fakeElement("input"))).toBe(true);
  });

  it("returns true for <select>", () => {
    expect(isEditableKeyboardTarget(fakeElement("select"))).toBe(true);
  });

  it("returns false for <button>", () => {
    expect(isEditableKeyboardTarget(fakeElement("button"))).toBe(false);
  });

  it("returns false for <div>", () => {
    expect(isEditableKeyboardTarget(fakeElement("div"))).toBe(false);
  });

  it("returns false for <span>", () => {
    expect(isEditableKeyboardTarget(fakeElement("span"))).toBe(false);
  });

  it("returns false for null target", () => {
    expect(isEditableKeyboardTarget(null)).toBe(false);
  });

  it("returns true for contentEditable element", () => {
    const el = fakeElement("div", { isContentEditable: true });
    expect(isEditableKeyboardTarget(el)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Autosave feedback text mapping
// ---------------------------------------------------------------------------

function saveStatusToDisplayText(status: SaveStatus): string | null {
  if (status === "idle") return null;
  if (status === "unsaved") return "Unsaved changes";
  if (status === "saving")  return "Saving…";
  if (status === "saved")   return "Saved";
  if (status === "error")   return "Save failed";
  return null;
}

describe("Autosave feedback text mapping", () => {
  it("returns null for idle (no indicator shown)", () => {
    expect(saveStatusToDisplayText("idle")).toBeNull();
  });

  it("returns 'Unsaved changes' for unsaved", () => {
    expect(saveStatusToDisplayText("unsaved")).toBe("Unsaved changes");
  });

  it("returns 'Saving…' for saving", () => {
    expect(saveStatusToDisplayText("saving")).toBe("Saving…");
  });

  it("returns 'Saved' for saved", () => {
    expect(saveStatusToDisplayText("saved")).toBe("Saved");
  });

  it("returns 'Save failed' for error", () => {
    expect(saveStatusToDisplayText("error")).toBe("Save failed");
  });

  it("every non-idle status produces a non-null string", () => {
    const nonIdle: SaveStatus[] = ["unsaved", "saving", "saved", "error"];
    for (const s of nonIdle) {
      expect(saveStatusToDisplayText(s)).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Unsaved changes detection (hasPending)
// ---------------------------------------------------------------------------

function computeHasPending(saveStatus: SaveStatus, isSaving: boolean): boolean {
  return saveStatus === "unsaved" || isSaving;
}

describe("Unsaved changes detection (hasPending)", () => {
  it("is true when saveStatus is 'unsaved' and not saving", () => {
    expect(computeHasPending("unsaved", false)).toBe(true);
  });

  it("is true when isSaving is true regardless of saveStatus", () => {
    expect(computeHasPending("saving", true)).toBe(true);
    expect(computeHasPending("saved", true)).toBe(true);
    expect(computeHasPending("idle", true)).toBe(true);
  });

  it("is false when idle and not saving", () => {
    expect(computeHasPending("idle", false)).toBe(false);
  });

  it("is false when saved and not saving", () => {
    expect(computeHasPending("saved", false)).toBe(false);
  });

  it("is false when error and not saving", () => {
    expect(computeHasPending("error", false)).toBe(false);
  });

  it("is true when both unsaved and saving (double-pending)", () => {
    expect(computeHasPending("unsaved", true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. VOID_STATUS cross-reference: VOID rows don't trigger duplicate warning
// ---------------------------------------------------------------------------

describe("VOID_STATUS — voided rows are excluded from live invoice row detection", () => {
  it("VOID_STATUS constant is 'VOID_DUPLICATE'", () => {
    expect(VOID_STATUS).toBe("VOID_DUPLICATE");
  });

  it("isInvoiceDataRow returns false for a VOID_DUPLICATE row with otherwise valid data", () => {
    // A row that looks like a live invoice row but has been voided
    expect(isInvoiceDataRow("42", "LA#5555", "VOID_DUPLICATE")).toBe(false);
  });

  it("isInvoiceDataRow returns false for VOID_DUPLICATE with leading/trailing space", () => {
    expect(isInvoiceDataRow("42", "LA#5555", "  VOID_DUPLICATE  ")).toBe(false);
  });

  it("isInvoiceDataRow returns true for an active row with numeric invoice number", () => {
    expect(isInvoiceDataRow("42", "", undefined)).toBe(true);
  });

  it("isInvoiceDataRow returns true for an active row with LA# in col C", () => {
    expect(isInvoiceDataRow("", "LA#5555", undefined)).toBe(true);
  });

  it("isInvoiceDataRow returns false for a row with no invoice number and no LA#", () => {
    expect(isInvoiceDataRow("", "", undefined)).toBe(false);
  });

  it("isInvoiceDataRow returns true for a JU-style legacy invoice number (non-void)", () => {
    expect(isInvoiceDataRow("JU-001", "", undefined)).toBe(true);
  });

  it("VOID rows with JU-style numbers are still excluded", () => {
    expect(isInvoiceDataRow("JU-001", "LA#5555", "VOID_DUPLICATE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Gmail Draft success behavior
// ---------------------------------------------------------------------------

const originalWindow = globalThis.window;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
  } else {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
  }
});

describe("Gmail Draft success behavior", () => {
  it("opens a successful Gmail draft URL in a new tab", () => {
    const open = vi.fn();
    Object.defineProperty(globalThis, "window", {
      value: { open },
      configurable: true,
      writable: true,
    });

    expect(openGmailDraftUrl("https://mail.google.com/mail/#drafts/msg-123")).toBe(true);
    expect(open).toHaveBeenCalledWith(
      "https://mail.google.com/mail/#drafts/msg-123",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("does not open a window when draft creation did not return a URL", () => {
    const open = vi.fn();
    Object.defineProperty(globalThis, "window", {
      value: { open },
      configurable: true,
      writable: true,
    });

    expect(openGmailDraftUrl(null)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps the visible fallback Open Draft link in the dialog source", () => {
    const source = readFileSync(join(process.cwd(), "components/InvoiceSection.tsx"), "utf8");
    expect(source).toContain("Open Draft in Gmail");
    expect(source).toContain('href={dialog.draftUrl}');
  });
});
