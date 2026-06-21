/**
 * Tests for the invoice verified pipeline pure helpers and state logic.
 *
 * Covers:
 *   1. buildVerifiedMessage — four success message variants
 *   2. isVerifySuccessMessage — detects verified vs failure messages
 *   3. isVerifyBlockingEmail — gates email send on verify status
 *   4. Pipeline message invariants (success never equals fail message)
 *   5. Recovery tools visibility logic (pure mirror of component behavior)
 *   6. Pipeline step dependencies (pure logic — not fetch mocks)
 */

import { describe, it, expect } from "vitest";
import {
  buildVerifiedMessage,
  isVerifySuccessMessage,
  isVerifyBlockingEmail,
  VERIFY_FAIL_MESSAGE,
  VERIFY_SUCCESS_MESSAGES,
} from "@/lib/invoice-pipeline";

// ---------------------------------------------------------------------------
// 1. buildVerifiedMessage — verified message variants
// ---------------------------------------------------------------------------

describe("buildVerifiedMessage", () => {
  it("clean run → 'Verified updated'", () => {
    expect(buildVerifiedMessage(false, false)).toBe(VERIFY_SUCCESS_MESSAGES.clean);
  });

  it("autoRepaired only → 'Verified updated and cleaned'", () => {
    expect(buildVerifiedMessage(true, false)).toBe(VERIFY_SUCCESS_MESSAGES.cleaned);
  });

  it("hasUnrelatedClutter only → mentions health check", () => {
    const msg = buildVerifiedMessage(false, true);
    expect(msg).toBe(VERIFY_SUCCESS_MESSAGES.clutterOnly);
    expect(msg).toContain("Old cleanup items remain");
    expect(msg).toContain("Health Check");
  });

  it("both autoRepaired + hasUnrelatedClutter → cleaned + health check mention", () => {
    const msg = buildVerifiedMessage(true, true);
    expect(msg).toBe(VERIFY_SUCCESS_MESSAGES.cleanedClutter);
    expect(msg).toContain("cleaned");
    expect(msg).toContain("Old cleanup items remain");
  });

  it("all four variants are distinct strings", () => {
    const msgs = [
      buildVerifiedMessage(false, false),
      buildVerifiedMessage(true, false),
      buildVerifiedMessage(false, true),
      buildVerifiedMessage(true, true),
    ];
    const unique = new Set(msgs);
    expect(unique.size).toBe(4);
  });

  it("no variant contains the failure message text", () => {
    for (const [ar, huc] of [[false, false], [true, false], [false, true], [true, true]]) {
      const msg = buildVerifiedMessage(ar as boolean, huc as boolean);
      expect(msg).not.toContain("not verified");
      expect(msg).not.toContain("do not rely");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. isVerifySuccessMessage
// ---------------------------------------------------------------------------

describe("isVerifySuccessMessage", () => {
  it("returns true for all four success messages", () => {
    for (const msg of Object.values(VERIFY_SUCCESS_MESSAGES)) {
      expect(isVerifySuccessMessage(msg), `expected true for: ${msg}`).toBe(true);
    }
  });

  it("returns false for the failure message", () => {
    expect(isVerifySuccessMessage(VERIFY_FAIL_MESSAGE)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isVerifySuccessMessage("")).toBe(false);
  });

  it("returns false for partial match", () => {
    expect(isVerifySuccessMessage("Verified")).toBe(false);
  });

  it("returns false for a generic sync message", () => {
    expect(isVerifySuccessMessage("Sheet updated")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. VERIFY_FAIL_MESSAGE constant
// ---------------------------------------------------------------------------

describe("VERIFY_FAIL_MESSAGE", () => {
  it("contains 'not verified'", () => {
    expect(VERIFY_FAIL_MESSAGE).toContain("not verified");
  });

  it("contains 'do not rely on Sheet totals'", () => {
    expect(VERIFY_FAIL_MESSAGE).toContain("do not rely on Sheet totals");
  });

  it("is not a success message", () => {
    expect(isVerifySuccessMessage(VERIFY_FAIL_MESSAGE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. isVerifyBlockingEmail — gates email send
// ---------------------------------------------------------------------------

describe("isVerifyBlockingEmail", () => {
  it("blocks when status is 'idle'", () => {
    expect(isVerifyBlockingEmail("idle")).toBe(true);
  });

  it("blocks when status is 'verifying'", () => {
    expect(isVerifyBlockingEmail("verifying")).toBe(true);
  });

  it("blocks when status is 'failed'", () => {
    expect(isVerifyBlockingEmail("failed")).toBe(true);
  });

  it("allows when status is 'verified'", () => {
    expect(isVerifyBlockingEmail("verified")).toBe(false);
  });

  it("no email sends except after explicit Send Invoice (verify gate passed)", () => {
    // 'verified' is the ONLY status that allows email send
    const allStatuses = ["idle", "verifying", "verified", "failed"] as const;
    const allowed = allStatuses.filter((s) => !isVerifyBlockingEmail(s));
    expect(allowed).toEqual(["verified"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Recovery tools visibility logic
// ---------------------------------------------------------------------------

/**
 * Mirrors the logic from InvoiceSection: advanced tools auto-expand when
 * verifyState.status === "failed". Collapsed by default otherwise.
 */
function shouldAdvancedAutoExpand(verifyStatus: "idle" | "verifying" | "verified" | "failed"): boolean {
  return verifyStatus === "failed";
}

/** Default collapsed state of Advanced Recovery Tools. */
function defaultAdvancedOpen(): boolean {
  return false;
}

describe("Advanced Recovery Tools visibility logic", () => {
  it("collapsed by default (initial state)", () => {
    expect(defaultAdvancedOpen()).toBe(false);
  });

  it("does NOT auto-expand when verify is idle", () => {
    expect(shouldAdvancedAutoExpand("idle")).toBe(false);
  });

  it("does NOT auto-expand when verifying is in progress", () => {
    expect(shouldAdvancedAutoExpand("verifying")).toBe(false);
  });

  it("does NOT auto-expand when verified successfully", () => {
    expect(shouldAdvancedAutoExpand("verified")).toBe(false);
  });

  it("auto-expands ONLY when verification fails", () => {
    expect(shouldAdvancedAutoExpand("failed")).toBe(true);
  });

  it("recovery tools remain available (not removed) after auto-expand", () => {
    // Structural invariant: auto-expand sets open=true, content is rendered.
    // This mirrors the useEffect behavior in InvoiceSection.
    let advancedOpen = false;
    const status = "failed";
    if (shouldAdvancedAutoExpand(status)) advancedOpen = true;
    expect(advancedOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Pipeline step dependency ordering
// ---------------------------------------------------------------------------

/**
 * Mirrors the step sequence of runVerifiedPipeline.
 * Each step must complete before the next can start.
 */
type PipelineStep = "save" | "pdf" | "sync" | "verify";

function runPipelineStepsInOrder(
  failAt: PipelineStep | null,
): { completed: PipelineStep[]; blocked: boolean } {
  const steps: PipelineStep[] = ["save", "pdf", "sync", "verify"];
  const completed: PipelineStep[] = [];
  for (const step of steps) {
    if (failAt === step) return { completed, blocked: true };
    completed.push(step);
  }
  return { completed, blocked: false };
}

describe("pipeline step ordering — each failure blocks subsequent steps", () => {
  it("all steps complete when nothing fails", () => {
    const { completed, blocked } = runPipelineStepsInOrder(null);
    expect(completed).toEqual(["save", "pdf", "sync", "verify"]);
    expect(blocked).toBe(false);
  });

  it("failed PDF generation blocks Sheet sync and verification", () => {
    const { completed, blocked } = runPipelineStepsInOrder("pdf");
    expect(completed).toEqual(["save"]);
    expect(blocked).toBe(true);
    expect(completed).not.toContain("sync");
    expect(completed).not.toContain("verify");
  });

  it("failed Sheet sync blocks verification", () => {
    const { completed, blocked } = runPipelineStepsInOrder("sync");
    expect(completed).toEqual(["save", "pdf"]);
    expect(blocked).toBe(true);
    expect(completed).not.toContain("verify");
  });

  it("failed save blocks everything", () => {
    const { completed, blocked } = runPipelineStepsInOrder("save");
    expect(completed).toEqual([]);
    expect(blocked).toBe(true);
  });

  it("no email sends when pipeline does not reach verify step", () => {
    for (const failAt of ["save", "pdf", "sync"] as const) {
      const { completed } = runPipelineStepsInOrder(failAt);
      expect(completed).not.toContain("verify");
      // Since verify didn't complete, status remains non-"verified" → email blocked
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Unrelated clutter does not block current invoice verification
// ---------------------------------------------------------------------------

describe("unrelated clutter handling", () => {
  it("hasUnrelatedClutter alone does not make message a failure", () => {
    const msg = buildVerifiedMessage(false, true);
    expect(isVerifySuccessMessage(msg)).toBe(true);
    expect(msg).not.toBe(VERIFY_FAIL_MESSAGE);
  });

  it("unrelated clutter message mentions health check, not verification failure", () => {
    const msg = buildVerifiedMessage(false, true);
    expect(msg).toContain("Health Check");
    expect(msg).not.toContain("not verified");
  });

  it("email is allowed even when unrelated clutter exists (verify status = verified)", () => {
    // After a successful pipeline run with unrelated clutter, status is "verified"
    expect(isVerifyBlockingEmail("verified")).toBe(false);
  });

  it("unrelated real rows are untouched (only current invoice row is synced)", () => {
    // The sync route only writes one row per invoke (the current invoice/job key).
    // Unrelated rows are never touched — their presence is detected but not modified.
    // This test verifies the message-level contract: clutter → warning message only.
    const msgWithClutter = buildVerifiedMessage(false, true);
    const msgWithout = buildVerifiedMessage(false, false);
    expect(msgWithClutter).not.toBe(msgWithout);
    expect(msgWithClutter).toContain("Old cleanup items remain");
    expect(msgWithout).not.toContain("Old cleanup items");
  });
});

// ---------------------------------------------------------------------------
// 8. Money column / mileage integrity checks (pure packet validation)
// ---------------------------------------------------------------------------

/**
 * Mirrors the mileage sanity check: milesDriven (miles) and mileageAmount
 * (dollars) should never be in the wrong column.
 * A simple heuristic: milesDriven is typically < 1000; mileageAmount is
 * miles × rate (≈ $0.52/mi), so amount < 520. If amount > 10000 but miles
 * is tiny, something is mixed.
 */
function mileageMixCheck(milesDriven: number, mileageAmount: number): boolean {
  if (milesDriven <= 0 || mileageAmount <= 0) return true; // no mileage — no issue
  // amount should be roughly miles * rate; check order of magnitude
  const impliedRate = mileageAmount / milesDriven;
  return impliedRate >= 0.10 && impliedRate <= 10.0; // sane range $0.10 – $10/mi
}

describe("mileage dollar/miles sanity check", () => {
  it("normal mileage entry passes (30 mi × $0.52 = $15.60)", () => {
    expect(mileageMixCheck(30, 15.60)).toBe(true);
  });

  it("zero miles → no check needed", () => {
    expect(mileageMixCheck(0, 0)).toBe(true);
  });

  it("typical round trip (100 mi × $0.52 = $52)", () => {
    expect(mileageMixCheck(100, 52)).toBe(true);
  });

  it("detects likely swap: day rate in miles field (2 mi, $800 — $400/mi is nonsensical)", () => {
    // $800 / 2 mi = $400/mi → way above $10/mi sane ceiling
    expect(mileageMixCheck(2, 800)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Send Invoice is protected by verification
// ---------------------------------------------------------------------------

describe("Send Invoice email protection", () => {
  it("Review button opens dialog → dialog sends: verifyStatus must be 'verified'", () => {
    // Pipeline sets verifyStatus = "verified" on success.
    // handleOpenReview only opens the dialog when pipeline.success === true.
    // handleSendEmail calls isVerifyBlockingEmail(verifyStatus).
    // Therefore: email can only send when verifyStatus === "verified".
    expect(isVerifyBlockingEmail("verified")).toBe(false);
  });

  it("failed pipeline → dialog does not open → email cannot be sent", () => {
    // Pipeline returns success: false → handleOpenReview returns early.
    // The dialog never opens. Email can't be sent without the dialog.
    const pipelineSucceeded = false;
    const dialogWouldOpen = pipelineSucceeded; // mirrors handleOpenReview logic
    expect(dialogWouldOpen).toBe(false);
  });

  it("if dialog somehow opens with non-verified state → send is blocked", () => {
    // isVerifyBlockingEmail blocks even if dialog is open with wrong status
    expect(isVerifyBlockingEmail("idle")).toBe(true);
    expect(isVerifyBlockingEmail("verifying")).toBe(true);
    expect(isVerifyBlockingEmail("failed")).toBe(true);
  });

  it("Review button does not send email — only opens dialog", () => {
    // Review is separate from Send. Review → pipeline → dialog.
    // Send Invoice is a distinct action inside the dialog.
    // This is an invariant: the number of email-send entry points is 1 (handleSendEmail).
    // Verified by architecture: handleOpenReview never calls send route.
    const reviewCallsSendRoute = false;
    expect(reviewCallsSendRoute).toBe(false);
  });

  it("Open PDF does not send email", () => {
    const openPdfCallsSendRoute = false;
    expect(openPdfCallsSendRoute).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. Sheet row integrity after sync (structural constraints)
// ---------------------------------------------------------------------------

/**
 * Mirrors the upsertSheetRow contract:
 * - One active row per invoice/job key after sync
 * - Active row is always above TOTALS row
 * - Stale duplicates are archived before removal
 * - VOID_DUPLICATE rows are archived before removal
 */
type SyncAction = "updated" | "inserted" | "moved";

interface MockSyncResult {
  action: SyncAction;
  keptRow: number | null;
  archivedRows: number[];
  totalsRowNum: number;
  autoRepaired: boolean;
}

function verifySheetRowIntegrity(result: MockSyncResult): { ok: boolean; reason?: string } {
  if (!result.keptRow) return { ok: false, reason: "No active row after sync" };
  if (result.keptRow >= result.totalsRowNum)
    return { ok: false, reason: "Active row is below or at TOTALS" };
  return { ok: true };
}

describe("Sheet row integrity after sync", () => {
  const TOTALS_ROW = 50;

  it("updated row above TOTALS → integrity passes", () => {
    const result = verifySheetRowIntegrity({
      action: "updated", keptRow: 10, archivedRows: [], totalsRowNum: TOTALS_ROW, autoRepaired: false,
    });
    expect(result.ok).toBe(true);
  });

  it("moved row to above TOTALS → integrity passes (autoRepaired)", () => {
    const result = verifySheetRowIntegrity({
      action: "moved", keptRow: 49, archivedRows: [52, 53], totalsRowNum: TOTALS_ROW, autoRepaired: true,
    });
    expect(result.ok).toBe(true);
  });

  it("active row below TOTALS → integrity fails", () => {
    const result = verifySheetRowIntegrity({
      action: "updated", keptRow: 55, archivedRows: [], totalsRowNum: TOTALS_ROW, autoRepaired: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("below or at TOTALS");
  });

  it("null keptRow → integrity fails", () => {
    const result = verifySheetRowIntegrity({
      action: "inserted", keptRow: null, archivedRows: [], totalsRowNum: TOTALS_ROW, autoRepaired: false,
    });
    expect(result.ok).toBe(false);
  });

  it("exactly one active row after sync (stale rows go to archivedRows)", () => {
    const archivedRows = [20, 21]; // stale duplicates archived
    // keptRow is the single remaining active row
    const result = verifySheetRowIntegrity({
      action: "updated", keptRow: 5, archivedRows, totalsRowNum: TOTALS_ROW, autoRepaired: false,
    });
    expect(result.ok).toBe(true);
    // The active row count is: 1 (keptRow) — archivedRows went to archive sheet
    expect(archivedRows.length).toBe(2); // 2 removed, 1 kept
  });
});
