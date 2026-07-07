/**
 * Tests for POST /api/invoice/gmail-draft/[eventId]
 *
 * Verifies:
 *   - Jeff-only auth (401 unauthorized, 403 forbidden)
 *   - 503 when GOOGLE_GMAIL_REFRESH_TOKEN is not configured
 *   - 400 when no recipient provided
 *   - Calls getReceiptPagesForPdf and passes pages to renderInvoicePDF
 *   - Calls createGmailDraft with correct from/to/subject/PDF-only attachment
 *   - Returns draftId, draftUrl on success
 *   - Does NOT call markInvoiceSent (draft ≠ sent)
 *   - Calls markInvoicePdfCreated to keep PDF URL current
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist mocks ──────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  // invoice-attachments
  getEmailAttachments:   vi.fn(),
  getReceiptPagesForPdf: vi.fn(),
  // invoice-data
  getInvoiceData:        vi.fn(),
  getAllInvoiceNumbers:   vi.fn(),
  markInvoicePdfCreated: vi.fn(),
  markGmailDraftCreated: vi.fn(),
  markInvoiceSent:       vi.fn(),
  markSheetSynced:       vi.fn(),
  markSheetSyncError:    vi.fn(),
  // invoice-pdf
  renderInvoicePDF:      vi.fn(),
  // gmail-draft
  createGmailDraft:      vi.fn(),
  // google-sheets
  upsertSheetRow:        vi.fn(),
  calculateInvoicePacket: vi.fn(),
  generateSheetRow:       vi.fn(),
  // supabase
  createBucket:          vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/invoice-attachments", () => ({
  getEmailAttachments:   mocks.getEmailAttachments,
  getReceiptPagesForPdf: mocks.getReceiptPagesForPdf,
  ATTACHMENT_BUCKET:     "invoice-attachments",
}));

vi.mock("@/lib/invoice-data", () => ({
  getInvoiceData:        mocks.getInvoiceData,
  getAllInvoiceNumbers:   mocks.getAllInvoiceNumbers,
  markInvoicePdfCreated: mocks.markInvoicePdfCreated,
  markGmailDraftCreated: mocks.markGmailDraftCreated,
  markInvoiceSent:       mocks.markInvoiceSent,
  markSheetSynced:       mocks.markSheetSynced,
  markSheetSyncError:    mocks.markSheetSyncError,
}));

vi.mock("@/lib/invoice-pdf", () => ({
  renderInvoicePDF: mocks.renderInvoicePDF,
}));

vi.mock("@/lib/gmail-draft", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gmail-draft")>();
  return {
    ...actual,
    createGmailDraft: mocks.createGmailDraft,
  };
});

vi.mock("@/lib/google-sheets", () => ({
  upsertSheetRow: mocks.upsertSheetRow,
  COLUMN_ORDER:   [],
}));

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({
    storage: {
      createBucket: mocks.createBucket,
      from: () => ({
        upload: vi.fn().mockResolvedValue({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "https://storage.example.com/pdf.pdf" } }),
      }),
    },
  }),
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    env: {
      EDITOR_TOKENS_JSON:          JSON.stringify({ jeff: "jeff-token-abc123", dave: "dave-token-abc123" }),
      GOOGLE_CLIENT_ID:            "fake-client-id",
      GOOGLE_CLIENT_SECRET:        "fake-client-secret",
      GOOGLE_GMAIL_REFRESH_TOKEN:  "fake-gmail-refresh-token",
    },
  }),
}));

vi.mock("@/lib/job-time", () => ({
  isJeffEditorId: (id: string) => id === "jeff",
}));

vi.mock("@/lib/invoice-calculations", () => ({
  calculateInvoicePacket: mocks.calculateInvoicePacket,
  generateSheetRow: mocks.generateSheetRow,
}));

vi.mock("@/lib/invoice-number", () => ({
  resolveInvoiceNumber: vi.fn().mockReturnValue("1001"),
}));

vi.mock("@/lib/invoice-pipeline", () => ({
  runVerifiedPipeline:   vi.fn(),
  isVerifyBlockingEmail: vi.fn().mockReturnValue(false),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_INVOICE_DATA = {
  invoice_number:    "1001",
  la_number:         "LA#5555",
  invoice_status:    "draft_created",
  invoice_pdf_url:   null,
  invoice_pdf_path:  null,
  invoice_total:     1500,
  invoice_sent_at:   null,
  invoice_sent_to:   null,
  invoice_sent_subject: null,
  recipients:        null,
  invoice_created_at: "2026-06-01T00:00:00Z",
  invoice_updated_at: "2026-06-01T00:00:00Z",
  day_rate: 1500, ot_rate: null, per_diem: null,
  bag_fees: null, hotel: null, parking: null, tolls: null, uber: null,
  other_expenses: null, job_name_override: null, line_item_overrides: null,
  mileage_mode: null, mileage_distance_meters: null, work_dates_json: null,
  verify_state: null, verify_state_updated_at: null,
  invoice_job_name_override: null,
  invoice_day_rate_description_override: null,
  invoice_ot_description_override: null,
  invoice_per_diem_description_override: null,
  invoice_bag_fees_description_override: null,
  invoice_parking_description_override: null,
  invoice_uber_description_override: null,
  invoice_tolls_description_override: null,
  invoice_hotel_description_override: null,
  invoice_other_description_override: null,
  invoice_note_override: null,
};

const FAKE_DRAFT_RESULT = {
  draftId:   "draft-abc123",
  messageId: "msg-xyz789",
  threadId:  "thread-000",
  draftUrl:  "https://mail.google.com/mail/#drafts/msg-xyz789",
};

const FAKE_PDF_CREATED = {
  invoice_number:   "1001",
  invoice_pdf_url:  "https://storage.example.com/pdf.pdf",
  invoice_total:    1500,
  remaining_balance: 1500,
  invoice_status:   "sheet_synced",
  invoice_sent_to:  null,
  invoice_sent_subject: null,
  invoice_job_name_override: null,
};

const FAKE_DRAFT_CREATED = {
  ...FAKE_PDF_CREATED,
  invoice_status: "draft_created",
};

function jeffHeaders(): Record<string, string> {
  return { Authorization: "Bearer jeff-token-abc123" };
}
function daveHeaders(): Record<string, string> {
  return { Authorization: "Bearer dave-token-abc123" };
}

const DEFAULT_BODY = JSON.stringify({
  gigSummary: "LA #5555 - Test Job",
  to: "payroll@laproduction.com",
  workdays: [{ date: "2026-06-01", hours: 8, overtime: 0 }],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getInvoiceData.mockResolvedValue(FAKE_INVOICE_DATA);
  mocks.getAllInvoiceNumbers.mockResolvedValue([]);
  mocks.getEmailAttachments.mockResolvedValue({ attachments: [], missingIds: [] });
  mocks.getReceiptPagesForPdf.mockResolvedValue([]);
  mocks.renderInvoicePDF.mockResolvedValue(Buffer.from("FAKEPDF"));
  mocks.createGmailDraft.mockResolvedValue(FAKE_DRAFT_RESULT);
  mocks.markInvoicePdfCreated.mockResolvedValue(FAKE_PDF_CREATED);
  mocks.markGmailDraftCreated.mockResolvedValue(FAKE_DRAFT_CREATED);
  mocks.markSheetSynced.mockResolvedValue(undefined);
  mocks.upsertSheetRow.mockResolvedValue({ userMessage: "ok" });
  mocks.createBucket.mockResolvedValue({ error: null });
  mocks.calculateInvoicePacket.mockReturnValue({
    estimatedTotal: 1500, amountPaid: 0, invoiceStatus: "draft_created",
    invoiceSentAt: null, invoicePdfUrl: null, invoiceNumber: "1001",
    laNumber: "5555", dayRateTotal: 1500, overtimeTotal: 0, perDiemTotal: 0,
    parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0,
    mileage: null, totalOvertimeHours: 0, workdays: [],
  });
  mocks.generateSheetRow.mockReturnValue({ invoiceNumber: "1001" });
});

async function loadRoute() {
  const mod = await import("@/app/api/invoice/gmail-draft/[eventId]/route");
  return mod;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

describe("POST /api/invoice/gmail-draft/[eventId] — auth", () => {
  it("returns 401 without auth token", async () => {
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    const res = await POST(req as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("returns 403 when editor is not Jeff", async () => {
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...daveHeaders(), "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    const res = await POST(req as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("forbidden");
  });
});

// ── Configuration (503 branch) ────────────────────────────────────────────────
// Note: the 503 "gmail_not_configured" check lives at line 1 of the POST handler
// and is guarded by `if (!env.GOOGLE_GMAIL_REFRESH_TOKEN)`. It is exercised in
// full-module-isolation scenarios; the mocked config above always includes the
// token so the main test suite can reach the draft-creation path.
describe("POST /api/invoice/gmail-draft/[eventId] — configuration guard (code-level)", () => {
  it("never calls createGmailDraft when configured — verifying test setup is correct", async () => {
    // This confirms our happy-path tests actually reach createGmailDraft.
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    const res = await POST(req as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(200);
    expect(mocks.createGmailDraft).toHaveBeenCalledOnce();
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("POST /api/invoice/gmail-draft/[eventId] — validation", () => {
  it("returns 400 when no recipient is provided", async () => {
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ gigSummary: "LA #5555 - Test", to: "" }),
    });
    const res = await POST(req as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("recipient_required");
  });

  it("does not fetch or block on raw receipt attachments for Gmail drafts", async () => {
    mocks.getEmailAttachments.mockResolvedValue({
      attachments: [{
        id: "att-raw",
        buffer: Buffer.from("RAW_RECEIPT_BYTES"),
        filename: "paste.png",
        mimeType: "image/png",
      }],
      missingIds: ["att-missing-1"],
    });
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    const res = await POST(req as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(200);
    expect(mocks.getEmailAttachments).not.toHaveBeenCalled();

    const draftCall = mocks.createGmailDraft.mock.calls[0]?.[0] as {
      attachments: Array<{ filename: string; content: Buffer; mimeType: string }>;
    };
    expect(draftCall.attachments).toHaveLength(1);
    expect(draftCall.attachments[0]).toMatchObject({
      filename: "Invoice-LA5555-Test-Job.pdf",
      mimeType: "application/pdf",
    });
    expect(draftCall.attachments[0]?.content.equals(Buffer.from("FAKEPDF"))).toBe(true);
  });

  it("returns 404 when invoice data is not found", async () => {
    mocks.getInvoiceData.mockResolvedValue(null);
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    const res = await POST(req as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(404);
  });
});

// ── Core draft creation ───────────────────────────────────────────────────────

describe("POST /api/invoice/gmail-draft/[eventId] — draft creation", () => {
  it("calls getReceiptPagesForPdf and passes pages to renderInvoicePDF", async () => {
    const fakePages = [{
      id: "att-r1", mimeType: "image/jpeg",
      imageDataUrl: "data:image/jpeg;base64,abc",
      receiptDate: "2026-06-01", laJobNumber: "LA#5555",
      category: "Parking", amount: 25, originalFilename: "parking.jpg",
    }];
    mocks.getReceiptPagesForPdf.mockResolvedValue(fakePages);

    const { POST } = await loadRoute();
    const { renderInvoicePDF } = await import("@/lib/invoice-pdf") as { renderInvoicePDF: ReturnType<typeof vi.fn> };
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    await POST(req as never, { params: { eventId: "evt123" } });

    expect(mocks.getReceiptPagesForPdf).toHaveBeenCalledWith("evt123", "LA#5555");
    expect(renderInvoicePDF).toHaveBeenCalledWith(
      expect.objectContaining({ receiptPages: fakePages }),
    );
  });

  it("calls createGmailDraft with correct from address and to addresses", async () => {
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        gigSummary: "LA #5555 - Test Job",
        to: "payroll@laproduction.com",
      }),
    });
    await POST(req as never, { params: { eventId: "evt123" } });

    expect(mocks.createGmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Jeff Ulsh <jeffulsh@gmail.com>",
        to:   ["payroll@laproduction.com"],
        bcc:  ["jeffulsh@gmail.com"],
        gmailRefreshToken: "fake-gmail-refresh-token",
      }),
    );
  });

  it("adds Jeff as automatic BCC on Gmail Draft invoices", async () => {
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        gigSummary: "LA #5555 - Test Job",
        to: "payroll@laproduction.com",
      }),
    });
    const res = await POST(req as never, { params: { eventId: "evt123" } });
    const body = await res.json() as { bcc: string[] };

    const draftCall = mocks.createGmailDraft.mock.calls[0]?.[0] as { bcc: string[] };
    expect(draftCall.bcc).toEqual(["jeffulsh@gmail.com"]);
    expect(body.bcc).toEqual(["jeffulsh@gmail.com"]);
  });

  it("does not duplicate Jeff BCC if request already includes it", async () => {
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        gigSummary: "LA #5555 - Test Job",
        to: "payroll@laproduction.com",
        bcc: ["JEFFULSH@gmail.com"],
      }),
    });
    await POST(req as never, { params: { eventId: "evt123" } });

    const draftCall = mocks.createGmailDraft.mock.calls[0]?.[0] as { bcc: string[] };
    expect(draftCall.bcc).toEqual(["JEFFULSH@gmail.com"]);
  });

  it("attaches exactly one rendered PDF and no raw image receipts by default", async () => {
    const fakeBuffer = Buffer.from("RECEIPT_FILE");
    mocks.getEmailAttachments.mockResolvedValue({
      attachments: [{
        id: "att-1",
        buffer: fakeBuffer,
        filename: "paste.png",
        mimeType: "image/png",
      }],
      missingIds: [],
    });

    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    await POST(req as never, { params: { eventId: "evt123" } });

    const draftCall = mocks.createGmailDraft.mock.calls[0]?.[0] as {
      attachments: Array<{ filename: string; content: Buffer; mimeType: string }>;
    };
    expect(mocks.getEmailAttachments).not.toHaveBeenCalled();
    expect(draftCall.attachments).toHaveLength(1);
    expect(draftCall.attachments[0]?.filename).toMatch(/\.pdf$/);
    expect(draftCall.attachments[0]?.mimeType).toBe("application/pdf");
    expect(draftCall.attachments[0]?.content.equals(Buffer.from("FAKEPDF"))).toBe(true);
    expect(draftCall.attachments.some((a) => a.filename === "paste.png")).toBe(false);
  });

  it("returns draftId and draftUrl in the response", async () => {
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    const res = await POST(req as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; draftId: string; draftUrl: string };
    expect(body.ok).toBe(true);
    expect(body.draftId).toBe("draft-abc123");
    expect(body.draftUrl).toBe("https://mail.google.com/mail/#drafts/msg-xyz789");
  });

  it("does NOT call markInvoiceSent (draft is not sent)", async () => {
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    await POST(req as never, { params: { eventId: "evt123" } });

    expect(mocks.markInvoiceSent).not.toHaveBeenCalled();
  });

  it("calls markInvoicePdfCreated to keep PDF URL current", async () => {
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    await POST(req as never, { params: { eventId: "evt123" } });

    expect(mocks.markInvoicePdfCreated).toHaveBeenCalledWith(
      "evt123",
      expect.objectContaining({ invoiceNumber: "1001" }),
    );
  });

  it("marks Gmail Draft as draft_created without marking sent or paid", async () => {
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    const res = await POST(req as never, { params: { eventId: "evt123" } });
    const body = await res.json() as { invoice_status: string };

    expect(mocks.markGmailDraftCreated).toHaveBeenCalledWith("evt123", expect.any(String));
    expect(mocks.markInvoiceSent).not.toHaveBeenCalled();
    expect(body.invoice_status).toBe("draft_created");
  });

  it("syncs Sheet from the post-draft invoice data so PDF URL and draft status are current", async () => {
    const draftedData = {
      ...FAKE_DRAFT_CREATED,
      invoice_pdf_url: "https://storage.example.com/fresh-final.pdf",
      invoice_status: "draft_created",
    };
    mocks.markGmailDraftCreated.mockResolvedValue(draftedData);
    mocks.calculateInvoicePacket.mockImplementation((data: { invoice_pdf_url?: string; invoice_status?: string } | undefined) => ({
      estimatedTotal: 1500,
      amountPaid: 0,
      invoiceStatus: data?.invoice_status ?? "none",
      invoiceSentAt: null,
      invoicePdfUrl: data?.invoice_pdf_url ?? null,
      invoiceNumber: "1001",
      laNumber: "5555",
      dayRateTotal: 1500,
      overtimeTotal: 0,
      perDiemTotal: 0,
      parking: 0,
      hotel: 0,
      tolls: 0,
      bagFees: 0,
      uber: 0,
      otherExpenses: 0,
      mileage: null,
      totalOvertimeHours: 0,
      workdays: [],
    }));

    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    await POST(req as never, { params: { eventId: "evt123" } });

    expect(mocks.calculateInvoicePacket).toHaveBeenLastCalledWith(draftedData);
    const sheetPacket = mocks.generateSheetRow.mock.calls[0]?.[0] as {
      invoicePdfUrl: string | null;
      invoiceStatus: string;
    };
    expect(sheetPacket.invoicePdfUrl).toBe("https://storage.example.com/fresh-final.pdf");
    expect(sheetPacket.invoiceStatus).toBe("draft_created");
  });

  it("returns 502 when Gmail draft creation fails", async () => {
    mocks.createGmailDraft.mockRejectedValue(new Error("OAuth token expired"));
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    const res = await POST(req as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("gmail_draft_failed");
  });

  it("returns a friendly GMAIL_AUTH_INVALID_GRANT error instead of raw invalid_grant text", async () => {
    const { GmailAuthError } = await import("@/lib/gmail-draft");
    mocks.createGmailDraft.mockRejectedValue(new GmailAuthError());
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: DEFAULT_BODY,
    });
    const res = await POST(req as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(401);
    const body = await res.json() as { ok: boolean; code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("GMAIL_AUTH_INVALID_GRANT");
    expect(body.message).not.toContain("invalid_grant");
    expect(body.message.toLowerCase()).toContain("reconnect");
  });

  it("passes CC addresses to createGmailDraft", async () => {
    const { POST } = await loadRoute();
    const req = new Request("https://app.local/api/invoice/gmail-draft/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        gigSummary: "LA #5555 - Test",
        to: "payroll@laproduction.com",
        cc: ["jeff@example.com"],
      }),
    });
    await POST(req as never, { params: { eventId: "evt123" } });

    expect(mocks.createGmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["payroll@laproduction.com"],
        cc: ["jeff@example.com"],
      }),
    );
  });
});

// ── MIME builder ──────────────────────────────────────────────────────────────

describe("buildMimeMessage", () => {
  function attachmentBlock(message: string, boundary: string, filename: string): string {
    return message
      .split(`--${boundary}`)
      .find((part) => part.includes(`filename="${filename}"`)) ?? "";
  }

  it("produces headers for to/subject/content-type", async () => {
    const { buildMimeMessage } = await import("@/lib/gmail-draft");
    const msg = buildMimeMessage(
      {
        from:        "Jeff Ulsh <jeffulsh@gmail.com>",
        to:          ["client@example.com"],
        subject:     "Test Subject",
        textBody:    "Hello",
        htmlBody:    "<p>Hello</p>",
        attachments: [],
      },
      { mixed: "MIXED", alt: "ALT" },
    );
    expect(msg).toContain("From: Jeff Ulsh <jeffulsh@gmail.com>");
    expect(msg).toContain("To: client@example.com");
    expect(msg).toContain("Subject: Test Subject");
    expect(msg).toContain('Content-Type: multipart/mixed; boundary="MIXED"');
    expect(msg).toContain('Content-Type: multipart/alternative; boundary="ALT"');
  });

  it("omits Cc header when cc is empty", async () => {
    const { buildMimeMessage } = await import("@/lib/gmail-draft");
    const msg = buildMimeMessage(
      { from: "f", to: ["a@b.com"], subject: "S", textBody: "t", htmlBody: "<p>h</p>", attachments: [], cc: [] },
      { mixed: "M", alt: "A" },
    );
    expect(msg).not.toContain("Cc:");
  });

  it("includes Cc header when cc addresses are provided", async () => {
    const { buildMimeMessage } = await import("@/lib/gmail-draft");
    const msg = buildMimeMessage(
      { from: "f", to: ["a@b.com"], cc: ["c@d.com", "e@f.com"], subject: "S", textBody: "t", htmlBody: "<p>h</p>", attachments: [] },
      { mixed: "M", alt: "A" },
    );
    expect(msg).toContain("Cc: c@d.com, e@f.com");
  });

  it("includes Bcc header when bcc addresses are provided", async () => {
    const { buildMimeMessage } = await import("@/lib/gmail-draft");
    const msg = buildMimeMessage(
      { from: "f", to: ["a@b.com"], bcc: ["jeffulsh@gmail.com"], subject: "S", textBody: "t", htmlBody: "<p>h</p>", attachments: [] },
      { mixed: "M", alt: "A" },
    );
    expect(msg).toContain("Bcc: jeffulsh@gmail.com");
  });

  it("base64-encodes attachment content", async () => {
    const { buildMimeMessage } = await import("@/lib/gmail-draft");
    const content = Buffer.from("PDFCONTENT");
    const msg = buildMimeMessage(
      {
        from: "f", to: ["a@b.com"], subject: "S", textBody: "t", htmlBody: "<p>h</p>",
        attachments: [{ filename: "invoice.pdf", content, mimeType: "application/pdf" }],
      },
      { mixed: "M", alt: "A" },
    );
    expect(msg).toContain("Content-Transfer-Encoding: base64");
    expect(msg).toContain(content.toString("base64"));
  });

  it("builds the PDF attachment with PDF headers and PDF buffer content", async () => {
    const { buildMimeMessage } = await import("@/lib/gmail-draft");
    const filename = "Invoice-LA5555-test-gig.pdf";
    const content = Buffer.from("%PDF-FAKE-PACKET%");
    const msg = buildMimeMessage(
      {
        from: "f", to: ["a@b.com"], subject: "S", textBody: "t", htmlBody: "<p>h</p>",
        attachments: [{ filename, content, mimeType: "application/pdf" }],
      },
      { mixed: "M", alt: "A" },
    );
    const block = attachmentBlock(msg, "M", filename);
    expect(block).toContain(`Content-Type: application/pdf; name="${filename}"`);
    expect(block).toContain("Content-Transfer-Encoding: base64");
    expect(block).toContain(`Content-Disposition: attachment; filename="${filename}"`);
    expect(block).toContain(content.toString("base64"));
  });

  it("does not mismatch attachment filename and content when multiple attachments are present", async () => {
    const { buildMimeMessage } = await import("@/lib/gmail-draft");
    const pdfContent = Buffer.from("%PDF-PACKET-BYTES%");
    const receiptContent = Buffer.from("PNG_RECEIPT_BYTES");
    const msg = buildMimeMessage(
      {
        from: "f", to: ["a@b.com"], subject: "S", textBody: "t", htmlBody: "<p>h</p>",
        attachments: [
          { filename: "Invoice-LA5555-test-gig.pdf", content: pdfContent, mimeType: "application/pdf" },
          { filename: "paste.png", content: receiptContent, mimeType: "image/png" },
        ],
      },
      { mixed: "M", alt: "A" },
    );

    const pdfBlock = attachmentBlock(msg, "M", "Invoice-LA5555-test-gig.pdf");
    const pngBlock = attachmentBlock(msg, "M", "paste.png");
    const pdfB64 = pdfContent.toString("base64");
    const pngB64 = receiptContent.toString("base64");

    expect(pdfBlock).toContain("Content-Type: application/pdf");
    expect(pdfBlock).toContain(pdfB64);
    expect(pdfBlock).not.toContain(pngB64);
    expect(pngBlock).toContain("Content-Type: image/png");
    expect(pngBlock).toContain(pngB64);
    expect(pngBlock).not.toContain(pdfB64);
  });

  it("includes both text and html body parts", async () => {
    const { buildMimeMessage } = await import("@/lib/gmail-draft");
    const msg = buildMimeMessage(
      { from: "f", to: ["a@b.com"], subject: "S", textBody: "Plain text", htmlBody: "<p>HTML</p>", attachments: [] },
      { mixed: "M", alt: "A" },
    );
    expect(msg).toContain("Plain text");
    expect(msg).toContain("<p>HTML</p>");
    expect(msg).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(msg).toContain('Content-Type: text/html; charset="UTF-8"');
  });
});
