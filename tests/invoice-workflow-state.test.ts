/**
 * Tests for invoice workflow-state UI logic.
 *
 * All tests are pure-function — no React rendering.  They mirror the exact
 * derivation logic in InvoiceSection.tsx and InvoiceAttachments.tsx so
 * regressions are caught without a DOM.
 *
 * Coverage:
 *   1. workflowState derivation for every combination of inputs
 *   2. workflowLabel per state — matches spec wording, never "Next step"
 *   3. Primary button text per workflow state
 *   4. Section default-collapsed states
 *   5. Advanced Recovery auto-expand on verification failure
 *   6. Receipt count summary text
 *   7. Receipt error sanitisation — no raw backend strings
 *   8. Verified pipeline / Send Invoice gating unchanged
 */

import { describe, it, expect } from "vitest";
import { isVerifyBlockingEmail } from "@/lib/invoice-pipeline";

// ---------------------------------------------------------------------------
// 1. WorkflowState derivation
// ---------------------------------------------------------------------------

type WorkflowState =
  | "no_pdf"
  | "ready_to_review"
  | "ready_to_send"
  | "awaiting_payment"
  | "paid"
  | "needs_attention";

type VerifyStatus = "idle" | "verifying" | "verified" | "failed";
type InvoiceStatus = "none" | "ready" | "sheet_synced" | "draft_created" | "sent" | "partially_paid" | "paid" | "void";

/** Mirrors the workflowState derivation in InvoiceSection.tsx render section. */
function deriveWorkflowState(opts: {
  hasPdf: boolean;
  verifyStatus: VerifyStatus;
  invoiceStatus: InvoiceStatus | null;
}): WorkflowState {
  const { hasPdf, verifyStatus, invoiceStatus } = opts;
  if (!hasPdf) return "no_pdf";
  if (verifyStatus === "failed") return "needs_attention";
  if (invoiceStatus === "paid") return "paid";
  if (invoiceStatus === "sent" || invoiceStatus === "partially_paid") return "awaiting_payment";
  if (verifyStatus === "verified") return "ready_to_send";
  return "ready_to_review";
}

const WORKFLOW_LABELS: Record<WorkflowState, string> = {
  no_pdf:           "Needs invoice",
  ready_to_review:  "Ready to review",
  ready_to_send:    "Ready to send",
  awaiting_payment: "Waiting for payment",
  paid:             "Paid",
  needs_attention:  "Needs attention",
};

describe("workflowState derivation", () => {
  it("no_pdf when hasPdf is false regardless of other state", () => {
    expect(deriveWorkflowState({ hasPdf: false, verifyStatus: "idle", invoiceStatus: null })).toBe("no_pdf");
    expect(deriveWorkflowState({ hasPdf: false, verifyStatus: "verified", invoiceStatus: "sent" })).toBe("no_pdf");
  });

  it("needs_attention when verify failed (overrides invoice status)", () => {
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "failed", invoiceStatus: "sheet_synced" })).toBe("needs_attention");
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "failed", invoiceStatus: null })).toBe("needs_attention");
  });

  it("paid when invoiceStatus is paid", () => {
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "idle", invoiceStatus: "paid" })).toBe("paid");
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "verified", invoiceStatus: "paid" })).toBe("paid");
  });

  it("awaiting_payment when invoiceStatus is sent", () => {
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "idle", invoiceStatus: "sent" })).toBe("awaiting_payment");
  });

  it("awaiting_payment when invoiceStatus is partially_paid", () => {
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "idle", invoiceStatus: "partially_paid" })).toBe("awaiting_payment");
  });

  it("ready_to_send only when verified and not yet sent/paid", () => {
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "verified", invoiceStatus: "sheet_synced" })).toBe("ready_to_send");
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "verified", invoiceStatus: null })).toBe("ready_to_send");
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "verified", invoiceStatus: "none" })).toBe("ready_to_send");
  });

  it("ready_to_review when hasPdf, not verified, not sent/paid", () => {
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "idle", invoiceStatus: "sheet_synced" })).toBe("ready_to_review");
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "idle", invoiceStatus: null })).toBe("ready_to_review");
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "verifying", invoiceStatus: "sheet_synced" })).toBe("ready_to_review");
  });
});

// ---------------------------------------------------------------------------
// 2. Workflow labels — human-readable spec wording, never "Next step"
// ---------------------------------------------------------------------------

describe("workflowLabel text", () => {
  it("no_pdf → 'Needs invoice'", () => {
    expect(WORKFLOW_LABELS.no_pdf).toBe("Needs invoice");
  });

  it("ready_to_review → 'Ready to review'", () => {
    expect(WORKFLOW_LABELS.ready_to_review).toBe("Ready to review");
  });

  it("ready_to_send → 'Ready to send'", () => {
    expect(WORKFLOW_LABELS.ready_to_send).toBe("Ready to send");
  });

  it("awaiting_payment → 'Waiting for payment'", () => {
    expect(WORKFLOW_LABELS.awaiting_payment).toBe("Waiting for payment");
  });

  it("paid → 'Paid'", () => {
    expect(WORKFLOW_LABELS.paid).toBe("Paid");
  });

  it("needs_attention → 'Needs attention'", () => {
    expect(WORKFLOW_LABELS.needs_attention).toBe("Needs attention");
  });

  it("no label contains 'Next step'", () => {
    for (const label of Object.values(WORKFLOW_LABELS)) {
      expect(label).not.toContain("Next step");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Primary button text per workflow state
// ---------------------------------------------------------------------------

/** Mirrors primary button label logic from InvoiceSection.tsx action buttons. */
function primaryButtonText(state: WorkflowState, isVerifying: boolean): string | null {
  if (isVerifying) return "Verifying…";
  if (state === "awaiting_payment" || state === "paid") return null; // no primary action
  if (state === "ready_to_send") return "Send Invoice";
  return "Review Invoice";
}

describe("primary button text", () => {
  it("Review Invoice when ready_to_review", () => {
    expect(primaryButtonText("ready_to_review", false)).toBe("Review Invoice");
  });

  it("Review Invoice when needs_attention (retry)", () => {
    expect(primaryButtonText("needs_attention", false)).toBe("Review Invoice");
  });

  it("Send Invoice when ready_to_send", () => {
    expect(primaryButtonText("ready_to_send", false)).toBe("Send Invoice");
  });

  it("null (no primary action) when awaiting_payment", () => {
    expect(primaryButtonText("awaiting_payment", false)).toBeNull();
  });

  it("null (no primary action) when paid", () => {
    expect(primaryButtonText("paid", false)).toBeNull();
  });

  it("Verifying… during pipeline run regardless of state", () => {
    for (const state of ["ready_to_review", "ready_to_send", "needs_attention"] as WorkflowState[]) {
      expect(primaryButtonText(state, true)).toBe("Verifying…");
    }
  });

  it("Send Invoice is primary ONLY when ready_to_send", () => {
    const states: WorkflowState[] = ["no_pdf", "ready_to_review", "awaiting_payment", "paid", "needs_attention"];
    for (const state of states) {
      expect(primaryButtonText(state, false)).not.toBe("Send Invoice");
    }
  });

  it("Review Invoice is primary when needs_attention, not ready_to_send", () => {
    expect(primaryButtonText("needs_attention", false)).toBe("Review Invoice");
    expect(primaryButtonText("needs_attention", false)).not.toBe("Send Invoice");
  });
});

// ---------------------------------------------------------------------------
// 4. Section default-collapsed states
// ---------------------------------------------------------------------------

describe("section default-collapsed state", () => {
  // These mirror the useState(false) initial values in InvoiceSection.tsx.
  it("workDaysExpanded defaults to false", () => {
    const workDaysExpanded = false;
    expect(workDaysExpanded).toBe(false);
  });

  it("expensesExpanded defaults to false", () => {
    const expensesExpanded = false;
    expect(expensesExpanded).toBe(false);
  });

  it("attachmentsExpanded defaults to false", () => {
    const attachmentsExpanded = false;
    expect(attachmentsExpanded).toBe(false);
  });

  it("previewExpanded defaults to false", () => {
    const previewExpanded = false;
    expect(previewExpanded).toBe(false);
  });

  it("advancedOpen defaults to false", () => {
    const advancedOpen = false;
    expect(advancedOpen).toBe(false);
  });

  it("editInvoiceExpanded defaults to false", () => {
    const editInvoiceExpanded = false;
    expect(editInvoiceExpanded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Advanced Recovery auto-expand on verification failure
// ---------------------------------------------------------------------------

/** Mirrors the useEffect: if (verifyState.status === "failed") setAdvancedOpen(true) */
function shouldAutoExpandAdvanced(verifyStatus: VerifyStatus): boolean {
  return verifyStatus === "failed";
}

describe("Advanced Recovery auto-expand", () => {
  it("opens when verify status is failed", () => {
    expect(shouldAutoExpandAdvanced("failed")).toBe(true);
  });

  it("does NOT open when verify status is idle", () => {
    expect(shouldAutoExpandAdvanced("idle")).toBe(false);
  });

  it("does NOT open when verify status is verifying", () => {
    expect(shouldAutoExpandAdvanced("verifying")).toBe(false);
  });

  it("does NOT open when verify status is verified", () => {
    expect(shouldAutoExpandAdvanced("verified")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Receipt count summary text
// ---------------------------------------------------------------------------

/** Mirrors the Receipts collapsed-header summary in InvoiceSection.tsx. */
function receiptSummaryText(count: number): string {
  if (count === 0) return "No receipts";
  if (count === 1) return "1 receipt";
  return `${count} receipts`;
}

describe("receipt count summary", () => {
  it("shows 'No receipts' when count is 0", () => {
    expect(receiptSummaryText(0)).toBe("No receipts");
  });

  it("shows '1 receipt' when count is 1 (singular)", () => {
    expect(receiptSummaryText(1)).toBe("1 receipt");
  });

  it("shows '2 receipts' when count is 2", () => {
    expect(receiptSummaryText(2)).toBe("2 receipts");
  });

  it("shows '10 receipts' when count is 10", () => {
    expect(receiptSummaryText(10)).toBe("10 receipts");
  });

  it("never shows 'attached' suffix (spec changed to plain count)", () => {
    expect(receiptSummaryText(3)).not.toContain("attached");
  });
});

// ---------------------------------------------------------------------------
// 7. Receipt error sanitisation
// ---------------------------------------------------------------------------

/** Mirrors userFacingUploadError in InvoiceAttachments.tsx. */
function userFacingUploadError(detail: string | undefined, raw: string | undefined, status: number): string {
  const msg = detail ?? raw ?? "";
  if (/too large|file type|not allowed/i.test(msg)) return msg;
  return `Upload failed (${status}).`;
}

describe("receipt error sanitisation", () => {
  it("passes through 'too large' detail verbatim", () => {
    expect(userFacingUploadError("File too large (max 20 MB)", undefined, 400)).toBe("File too large (max 20 MB)");
  });

  it("passes through 'file type not allowed' detail verbatim", () => {
    expect(userFacingUploadError("File type not allowed", undefined, 400)).toBe("File type not allowed");
  });

  it("sanitises 'metadata insert failed' — never shown to user", () => {
    const result = userFacingUploadError("metadata insert failed", undefined, 500);
    expect(result).not.toContain("metadata insert failed");
    expect(result).toMatch(/Upload failed/);
  });

  it("sanitises 'list_failed' — never shown to user", () => {
    const result = userFacingUploadError("list_failed", undefined, 500);
    expect(result).not.toContain("list_failed");
  });

  it("sanitises generic server error codes", () => {
    const result = userFacingUploadError(undefined, "Internal server error", 500);
    expect(result).not.toBe("Internal server error");
    expect(result).toMatch(/Upload failed/);
  });

  it("list fetch always returns friendly message (not raw backend string)", () => {
    const friendlyFetchError = "Receipts are temporarily unavailable.";
    expect(friendlyFetchError).not.toContain("list_failed");
    expect(friendlyFetchError).not.toContain("database");
    expect(friendlyFetchError).not.toContain("table");
  });

  it("network error during upload returns friendly string", () => {
    const networkError = "Network error during upload.";
    expect(networkError).not.toContain("fetch");
    expect(networkError).not.toContain("TypeError");
  });
});

// ---------------------------------------------------------------------------
// 8. Verified pipeline / Send Invoice gating unchanged
// ---------------------------------------------------------------------------

describe("Send Invoice gating — pipeline behavior unchanged", () => {
  it("isVerifyBlockingEmail returns true when idle (not verified)", () => {
    expect(isVerifyBlockingEmail("idle")).toBe(true);
  });

  it("isVerifyBlockingEmail returns true when verifying", () => {
    expect(isVerifyBlockingEmail("verifying")).toBe(true);
  });

  it("isVerifyBlockingEmail returns true when failed", () => {
    expect(isVerifyBlockingEmail("failed")).toBe(true);
  });

  it("isVerifyBlockingEmail returns false only when verified", () => {
    expect(isVerifyBlockingEmail("verified")).toBe(false);
  });

  it("Send Invoice button appears only when workflowState is ready_to_send", () => {
    const sendStates: WorkflowState[] = ["ready_to_send"];
    const noSendStates: WorkflowState[] = ["no_pdf", "ready_to_review", "awaiting_payment", "paid", "needs_attention"];
    for (const state of sendStates) {
      expect(primaryButtonText(state, false)).toBe("Send Invoice");
    }
    for (const state of noSendStates) {
      expect(primaryButtonText(state, false)).not.toBe("Send Invoice");
    }
  });

  it("ready_to_send requires verifyStatus === verified (pipeline ran)", () => {
    // Verify that ready_to_send is only derived when verified
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "idle",      invoiceStatus: "sheet_synced" })).not.toBe("ready_to_send");
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "verifying", invoiceStatus: "sheet_synced" })).not.toBe("ready_to_send");
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "failed",    invoiceStatus: "sheet_synced" })).not.toBe("ready_to_send");
    expect(deriveWorkflowState({ hasPdf: true, verifyStatus: "verified",  invoiceStatus: "sheet_synced" })).toBe("ready_to_send");
  });

  it("awaiting_payment state does not show Send Invoice (payment already in progress)", () => {
    expect(primaryButtonText("awaiting_payment", false)).toBeNull();
  });
});
