/**
 * Tests for invoice attachment API routes.
 *
 * Verifies:
 *   - Jeff-only auth on all attachment endpoints
 *   - File type and size validation on upload
 *   - Storage error handling (non-crashing 500, error payload returned)
 *   - List returns attachments array
 *   - Toggle (PATCH) validates body, calls setAttachmentEmailFlag
 *   - Archive (DELETE) calls archiveAttachment
 *   - Signed URL (GET /[id]/update) returns 404 when not found
 *   - Email send blocks when a selected receipt is missing (missingIds present)
 *   - Excluded / archived receipts are never sent (controlled by getEmailAttachments)
 *   - ensureAttachmentBucket is idempotent (no throw on "already exists")
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist mock functions so they can be referenced in vi.mock factories ───────

const mocks = vi.hoisted(() => ({
  listAttachments:          vi.fn(),
  uploadAttachment:         vi.fn(),
  ensureAttachmentBucket:   vi.fn(),
  setAttachmentEmailFlag:   vi.fn(),
  updateAttachmentMetadata: vi.fn(),
  archiveAttachment:        vi.fn(),
  getAttachmentSignedUrl:   vi.fn(),
  getEmailAttachments:      vi.fn(),
  getReceiptPagesForPdf:    vi.fn(),
  createBucket:             vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/invoice-attachments", () => ({
  listAttachments:          mocks.listAttachments,
  uploadAttachment:         mocks.uploadAttachment,
  ensureAttachmentBucket:   mocks.ensureAttachmentBucket,
  setAttachmentEmailFlag:   mocks.setAttachmentEmailFlag,
  updateAttachmentMetadata: mocks.updateAttachmentMetadata,
  archiveAttachment:        mocks.archiveAttachment,
  getAttachmentSignedUrl:   mocks.getAttachmentSignedUrl,
  getEmailAttachments:      mocks.getEmailAttachments,
  getReceiptPagesForPdf:    mocks.getReceiptPagesForPdf,
  ATTACHMENT_BUCKET:        "invoice-attachments",
  ALLOWED_MIME_TYPES: new Set([
    "image/jpeg", "image/png", "image/webp",
    "image/gif", "image/heic", "image/heif", "application/pdf",
  ]),
  MAX_ATTACHMENT_BYTES: 20 * 1024 * 1024,
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
      EDITOR_TOKEN: "jeff-token-abc123",
      EDITOR_TOKENS_JSON: JSON.stringify({ jeff: "jeff-token-abc123", dave: "dave-token-abc123" }),
      RESEND_API_KEY: "re_test_key_for_testing_only",
    },
  }),
}));

vi.mock("@/lib/job-time", () => ({
  isJeffEditorId: (id: string) => id === "jeff",
}));

vi.mock("@/lib/invoice-data", () => ({
  getInvoiceData: vi.fn().mockResolvedValue({
    invoice_number: "1001",
    la_number: "LA#5555",
    invoice_status: "draft_created",
    invoice_pdf_url: "https://storage.example.com/pdf.pdf",
    invoice_pdf_path: "evt123/pdf.pdf",
    invoice_total: 1500,
    invoice_sent_at: null,
    invoice_sent_to: null,
    invoice_sent_subject: null,
    recipients: null,
    invoice_created_at: "2026-06-01T00:00:00Z",
    invoice_updated_at: "2026-06-01T00:00:00Z",
    day_rate: 1500,
    ot_rate: null,
    per_diem: null,
    bag_fees: null,
    hotel: null,
    parking: null,
    tolls: null,
    uber: null,
    other_expenses: null,
    job_name_override: null,
    line_item_overrides: null,
    mileage_mode: null,
    mileage_distance_meters: null,
    work_dates_json: null,
    verify_state: null,
    verify_state_updated_at: null,
  }),
  markInvoiceSent: vi.fn(),
  getAllInvoiceNumbers: vi.fn().mockResolvedValue([]),
}));

// Additional mocks needed for email route
vi.mock("@/lib/invoice-calculations", () => ({
  calculateInvoicePacket: vi.fn().mockReturnValue({
    estimatedTotal: 1500,
    amountPaid: 0,
    invoiceStatus: "draft_created",
    invoiceSentAt: null,
    invoicePdfUrl: null,
    invoiceNumber: "1001",
    laNumber: "5555",
    dayRateTotal: 1500,
    overtimeTotal: 0,
    perDiemTotal: 0,
    parking: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0,
    mileage: null,
    totalOvertimeHours: 0,
    workdays: [],
  }),
  generateSheetRow: vi.fn().mockReturnValue({
    invoiceNumber: "1001", laJobNumber: "5555", gigEvent: "Test Job",
    totalPay: 1500, labor: 1500, ot: 0, perDiem: 0,
    parking: 0, mileage: 0, hotel: 0, tolls: 0, bagFees: 0, uber: 0, otherExpenses: 0,
    status: "draft_created", invoicePdfUrl: "", invoiceSentDate: "",
    amountPaid: 0, remainingBalance: 1500,
    sentTo: "", sentSubject: "", internalReservedAe: "", internalReservedAf: "", internalReservedAg: "",
  }),
}));
vi.mock("@/lib/invoice-number", () => ({
  resolveInvoiceNumber: vi.fn().mockReturnValue("1001"),
}));
vi.mock("@/lib/google-sheets", () => ({
  upsertSheetRow: vi.fn().mockResolvedValue({
    userMessage: "ok", rowNumber: 2, action: "upsert",
    archivedRows: [], hasDuplicates: false,
    autoRepaired: false, formulasRepaired: false, hasUnrelatedClutter: false,
  }),
  COLUMN_ORDER: [],
}));
vi.mock("@/lib/invoice-pipeline", () => ({
  runVerifiedPipeline: vi.fn(),
  isVerifyBlockingEmail: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/invoice-pdf", () => ({
  renderInvoicePDF: vi.fn().mockResolvedValue(Buffer.from("FAKEPDF")),
}));
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: vi.fn().mockResolvedValue({ id: "email-sent-id" }) },
  })),
}));

// ── Fake attachment record ────────────────────────────────────────────────────

const FAKE_RECORD = {
  id: "att-uuid-1",
  google_event_id: "evt123",
  invoice_number: "1001",
  la_job_number: "LA#5555",
  original_filename: "receipt.pdf",
  storage_path: "evt123/20260617120000-receipt.pdf",
  mime_type: "application/pdf",
  size_bytes: 12345,
  include_in_email: true,
  uploaded_by: "jeff",
  created_at: "2026-06-17T12:00:00Z",
  archived_at: null,
};

// ── Auth helpers ──────────────────────────────────────────────────────────────

function jeffHeaders(): Record<string, string> {
  return { Authorization: "Bearer jeff-token-abc123" };
}
function daveHeaders(): Record<string, string> {
  return { Authorization: "Bearer dave-token-abc123" };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path returns
  mocks.listAttachments.mockResolvedValue([FAKE_RECORD]);
  mocks.uploadAttachment.mockResolvedValue(FAKE_RECORD);
  mocks.ensureAttachmentBucket.mockResolvedValue(undefined);
  mocks.setAttachmentEmailFlag.mockResolvedValue(undefined);
  mocks.archiveAttachment.mockResolvedValue(undefined);
  mocks.getAttachmentSignedUrl.mockResolvedValue("https://signed.example.com/file?token=abc");
  mocks.getEmailAttachments.mockResolvedValue({ attachments: [], missingIds: [] });
  mocks.getReceiptPagesForPdf.mockResolvedValue([]);
});

// ── Lazy route loaders ────────────────────────────────────────────────────────

async function loadListRoute() {
  const mod = await import("@/app/api/invoice/attachments/[id]/route");
  return mod;
}
async function loadUpdateRoute() {
  const mod = await import("@/app/api/invoice/attachments/[id]/update/route");
  return mod;
}

// ── GET /api/invoice/attachments/[id] (list) ─────────────────────────────────

describe("GET /api/invoice/attachments/[id] (list)", () => {
  it("returns 401 without auth token", async () => {
    const { GET } = await loadListRoute();
    const req = new Request("https://app.local/api/invoice/attachments/evt123");
    const res = await GET(req as never, { params: { id: "evt123" } });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("returns 403 for non-Jeff editor", async () => {
    const { GET } = await loadListRoute();
    const req = new Request("https://app.local/api/invoice/attachments/evt123", {
      headers: daveHeaders(),
    });
    const res = await GET(req as never, { params: { id: "evt123" } });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("forbidden");
  });

  it("returns attachments array for Jeff", async () => {
    const { GET } = await loadListRoute();
    const req = new Request("https://app.local/api/invoice/attachments/evt123", {
      headers: jeffHeaders(),
    });
    const res = await GET(req as never, { params: { id: "evt123" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { attachments: unknown[] };
    expect(Array.isArray(body.attachments)).toBe(true);
    expect(body.attachments).toHaveLength(1);
  });

  it("returns 500 when listAttachments throws", async () => {
    mocks.listAttachments.mockRejectedValue(new Error("db connection failed"));
    const { GET } = await loadListRoute();
    const req = new Request("https://app.local/api/invoice/attachments/evt123", {
      headers: jeffHeaders(),
    });
    const res = await GET(req as never, { params: { id: "evt123" } });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; detail: string };
    expect(body.error).toBe("list_failed");
    expect(body.detail).toContain("db connection failed");
  });
});

// ── POST /api/invoice/attachments/[id] (upload) ──────────────────────────────

function makePdfFile(sizeBytes = 1024, name = "receipt.pdf"): File {
  return new File([new Uint8Array(sizeBytes).fill(0x25)], name, { type: "application/pdf" });
}

function makeUploadRequest(file: File, eventId = "evt123") {
  const form = new FormData();
  form.append("file", file);
  return new Request(`https://app.local/api/invoice/attachments/${eventId}`, {
    method: "POST",
    headers: jeffHeaders(),
    body: form,
  });
}

describe("POST /api/invoice/attachments/[id] (upload)", () => {
  it("returns 403 for non-Jeff editor", async () => {
    const { POST } = await loadListRoute();
    const file = makePdfFile();
    const form = new FormData();
    form.append("file", file);
    const req = new Request("https://app.local/api/invoice/attachments/evt123", {
      method: "POST",
      headers: daveHeaders(),
      body: form,
    });
    const res = await POST(req as never, { params: { id: "evt123" } });
    expect(res.status).toBe(403);
  });

  it("returns 400 when no file field in form data", async () => {
    const { POST } = await loadListRoute();
    const form = new FormData();
    form.append("other_field", "value");
    const req = new Request("https://app.local/api/invoice/attachments/evt123", {
      method: "POST",
      headers: jeffHeaders(),
      body: form,
    });
    const res = await POST(req as never, { params: { id: "evt123" } });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("file_required");
  });

  it("returns 400 for unsupported MIME type", async () => {
    const { POST } = await loadListRoute();
    const badFile = new File(["data"], "virus.exe", { type: "application/octet-stream" });
    const form = new FormData();
    form.append("file", badFile);
    const req = new Request("https://app.local/api/invoice/attachments/evt123", {
      method: "POST",
      headers: jeffHeaders(),
      body: form,
    });
    const res = await POST(req as never, { params: { id: "evt123" } });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_file_type");
  });

  it("returns 400 when file exceeds 20 MB", async () => {
    const { POST } = await loadListRoute();
    const bigFile = new File([new Uint8Array(21 * 1024 * 1024)], "huge.pdf", { type: "application/pdf" });
    const form = new FormData();
    form.append("file", bigFile);
    const req = new Request("https://app.local/api/invoice/attachments/evt123", {
      method: "POST",
      headers: jeffHeaders(),
      body: form,
    });
    const res = await POST(req as never, { params: { id: "evt123" } });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("file_too_large");
  });

  it("returns 500 when storage upload fails", async () => {
    mocks.uploadAttachment.mockRejectedValue(new Error("storage upload failed: bucket missing"));
    const { POST } = await loadListRoute();
    const res = await POST(makeUploadRequest(makePdfFile()) as never, { params: { id: "evt123" } });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; detail: string };
    expect(body.error).toBe("upload_failed");
    expect(body.detail).toContain("storage upload failed");
  });

  it("returns 201 with attachment record on successful upload", async () => {
    const { POST } = await loadListRoute();
    const res = await POST(makeUploadRequest(makePdfFile()) as never, { params: { id: "evt123" } });
    expect(res.status).toBe(201);
    const body = await res.json() as { attachment: typeof FAKE_RECORD };
    expect(body.attachment.id).toBe(FAKE_RECORD.id);
    expect(body.attachment.original_filename).toBe("receipt.pdf");
  });

  it("calls ensureAttachmentBucket before uploading", async () => {
    const { POST } = await loadListRoute();
    await POST(makeUploadRequest(makePdfFile()) as never, { params: { id: "evt123" } });
    expect(mocks.ensureAttachmentBucket).toHaveBeenCalledOnce();
    expect(mocks.uploadAttachment).toHaveBeenCalledOnce();
  });
});

// ── PATCH /api/invoice/attachments/[id]/update (toggle include_in_email) ─────

describe("PATCH /api/invoice/attachments/[id]/update (toggle email flag)", () => {
  it("returns 401 without auth", async () => {
    const { PATCH } = await loadUpdateRoute();
    const req = new Request("https://app.local/api/invoice/attachments/att-uuid-1/update", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ include_in_email: false }),
    });
    const res = await PATCH(req as never, { params: { id: "att-uuid-1" } });
    expect(res.status).toBe(401);
  });

  it("returns 400 when no recognized fields are provided", async () => {
    const { PATCH } = await loadUpdateRoute();
    const req = new Request("https://app.local/api/invoice/attachments/att-uuid-1/update", {
      method: "PATCH",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ other: "field" }),
    });
    const res = await PATCH(req as never, { params: { id: "att-uuid-1" } });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("no_fields_provided");
  });

  it("returns 400 when include_in_email is a string instead of boolean", async () => {
    const { PATCH } = await loadUpdateRoute();
    const req = new Request("https://app.local/api/invoice/attachments/att-uuid-1/update", {
      method: "PATCH",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ include_in_email: "true" }),
    });
    const res = await PATCH(req as never, { params: { id: "att-uuid-1" } });
    expect(res.status).toBe(400);
  });

  it("calls updateAttachmentMetadata with correct args and returns ok", async () => {
    const { PATCH } = await loadUpdateRoute();
    const req = new Request("https://app.local/api/invoice/attachments/att-uuid-1/update", {
      method: "PATCH",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ include_in_email: false }),
    });
    const res = await PATCH(req as never, { params: { id: "att-uuid-1" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mocks.updateAttachmentMetadata).toHaveBeenCalledWith("att-uuid-1", { include_in_email: false });
  });

  it("accepts receipt metadata fields in PATCH", async () => {
    const { PATCH } = await loadUpdateRoute();
    const req = new Request("https://app.local/api/invoice/attachments/att-uuid-1/update", {
      method: "PATCH",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ receipt_date: "2026-05-21", receipt_category: "Parking", receipt_amount: 25.20 }),
    });
    const res = await PATCH(req as never, { params: { id: "att-uuid-1" } });
    expect(res.status).toBe(200);
    expect(mocks.updateAttachmentMetadata).toHaveBeenCalledWith("att-uuid-1", {
      receipt_date: "2026-05-21",
      receipt_category: "Parking",
      receipt_amount: 25.20,
    });
  });
});

// ── DELETE /api/invoice/attachments/[id]/update (archive) ────────────────────

describe("DELETE /api/invoice/attachments/[id]/update (archive)", () => {
  it("returns 403 for non-Jeff", async () => {
    const { DELETE } = await loadUpdateRoute();
    const req = new Request("https://app.local/api/invoice/attachments/att-uuid-1/update", {
      method: "DELETE",
      headers: daveHeaders(),
    });
    const res = await DELETE(req as never, { params: { id: "att-uuid-1" } });
    expect(res.status).toBe(403);
    expect(mocks.archiveAttachment).not.toHaveBeenCalled();
  });

  it("calls archiveAttachment and returns ok", async () => {
    const { DELETE } = await loadUpdateRoute();
    const req = new Request("https://app.local/api/invoice/attachments/att-uuid-1/update", {
      method: "DELETE",
      headers: jeffHeaders(),
    });
    const res = await DELETE(req as never, { params: { id: "att-uuid-1" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mocks.archiveAttachment).toHaveBeenCalledWith("att-uuid-1");
  });

  it("returns 500 when archiveAttachment throws", async () => {
    mocks.archiveAttachment.mockRejectedValue(new Error("db gone"));
    const { DELETE } = await loadUpdateRoute();
    const req = new Request("https://app.local/api/invoice/attachments/att-uuid-1/update", {
      method: "DELETE",
      headers: jeffHeaders(),
    });
    const res = await DELETE(req as never, { params: { id: "att-uuid-1" } });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("archive_failed");
  });
});

// ── GET /api/invoice/attachments/[id]/update (signed URL) ────────────────────

describe("GET /api/invoice/attachments/[id]/update (signed URL)", () => {
  it("returns 404 when attachment not found or archived", async () => {
    mocks.getAttachmentSignedUrl.mockResolvedValue(null);
    const { GET } = await loadUpdateRoute();
    const req = new Request("https://app.local/api/invoice/attachments/missing-id/update", {
      headers: jeffHeaders(),
    });
    const res = await GET(req as never, { params: { id: "missing-id" } });
    expect(res.status).toBe(404);
  });

  it("returns signed URL when attachment exists", async () => {
    const SIGNED = "https://supabase.example.com/storage/v1/signed?token=abc123";
    mocks.getAttachmentSignedUrl.mockResolvedValue(SIGNED);
    const { GET } = await loadUpdateRoute();
    const req = new Request("https://app.local/api/invoice/attachments/att-uuid-1/update", {
      headers: jeffHeaders(),
    });
    const res = await GET(req as never, { params: { id: "att-uuid-1" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { signedUrl: string };
    expect(body.signedUrl).toBe(SIGNED);
  });

  it("returns 401 without auth", async () => {
    const { GET } = await loadUpdateRoute();
    const req = new Request("https://app.local/api/invoice/attachments/att-uuid-1/update");
    const res = await GET(req as never, { params: { id: "att-uuid-1" } });
    expect(res.status).toBe(401);
    expect(mocks.getAttachmentSignedUrl).not.toHaveBeenCalled();
  });
});

// ── Email send: attachment blocking ──────────────────────────────────────────

describe("Email send: receipt attachment blocking", () => {
  it("blocks send (400) when a selected receipt is missing from storage", async () => {
    mocks.getEmailAttachments.mockResolvedValue({
      attachments: [],
      missingIds: ["att-missing-1"],
    });

    const { POST } = await import("@/app/api/invoice/email/[eventId]/route");
    const req = new Request("https://app.local/api/invoice/email/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        gigSummary: "LA #5555 - Test Job",
        to: "payroll@laproduction.com",
        workdays: [{ date: "2026-06-01", hours: 8, overtime: 0 }],
      }),
    });

    const res = await POST(req as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; missingIds: string[] };
    expect(body.error).toBe("attachment_missing");
    expect(body.missingIds).toContain("att-missing-1");
  });

  it("does not block send when no receipts are missing", async () => {
    mocks.getEmailAttachments.mockResolvedValue({
      attachments: [
        { id: "att-1", buffer: Buffer.from("RECEIPT"), filename: "hotel.jpg", mimeType: "image/jpeg" },
      ],
      missingIds: [],
    });

    const { POST } = await import("@/app/api/invoice/email/[eventId]/route");
    const req = new Request("https://app.local/api/invoice/email/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        gigSummary: "LA #5555 - Test Job",
        to: "payroll@laproduction.com",
        workdays: [{ date: "2026-06-01", hours: 8, overtime: 0 }],
      }),
    });

    const res = await POST(req as never, { params: { eventId: "evt123" } });
    // Should not block on attachment_missing; whatever status it returns is fine
    const body = await res.json() as { error?: string };
    expect(body.error).not.toBe("attachment_missing");
  });

  it("excluded and archived receipts are not sent (getEmailAttachments filters them)", async () => {
    // getEmailAttachments only fetches include_in_email=true AND archived_at=null.
    // When it returns empty attachments [], no receipts get added to the send payload.
    mocks.getEmailAttachments.mockResolvedValue({ attachments: [], missingIds: [] });

    const { POST } = await import("@/app/api/invoice/email/[eventId]/route");
    const req = new Request("https://app.local/api/invoice/email/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        gigSummary: "LA #5555 - Test Job",
        to: "payroll@laproduction.com",
        workdays: [{ date: "2026-06-01", hours: 8, overtime: 0 }],
      }),
    });

    const res = await POST(req as never, { params: { eventId: "evt123" } });
    // The send should proceed (no missing receipts)
    const body = await res.json() as { error?: string };
    expect(body.error).not.toBe("attachment_missing");
    // getEmailAttachments must have been called
    expect(mocks.getEmailAttachments).toHaveBeenCalledWith("evt123");
  });
});

// ── Email send: receipt appendix in PDF ──────────────────────────────────────

describe("Email send: receipt appendix included in PDF", () => {
  it("calls getReceiptPagesForPdf for the event and passes pages to renderInvoicePDF", async () => {
    const fakeReceiptPages = [
      {
        id: "att-r1",
        mimeType: "image/jpeg",
        imageDataUrl: "data:image/jpeg;base64,abc",
        receiptDate: "2026-06-01",
        laJobNumber: "LA#5555",
        category: "Parking",
        amount: 25,
        originalFilename: "parking.jpg",
      },
    ];
    mocks.getReceiptPagesForPdf.mockResolvedValue(fakeReceiptPages);
    mocks.getEmailAttachments.mockResolvedValue({ attachments: [], missingIds: [] });

    // Import the mocked renderInvoicePDF so we can assert on its args
    const { renderInvoicePDF } = await import("@/lib/invoice-pdf") as { renderInvoicePDF: ReturnType<typeof vi.fn> };
    const { POST } = await import("@/app/api/invoice/email/[eventId]/route");

    const req = new Request("https://app.local/api/invoice/email/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        gigSummary: "LA #5555 - Test Job",
        to: "payroll@laproduction.com",
        workdays: [{ date: "2026-06-01", hours: 8, overtime: 0 }],
      }),
    });

    await POST(req as never, { params: { eventId: "evt123" } });

    expect(mocks.getReceiptPagesForPdf).toHaveBeenCalledWith("evt123", "LA#5555");
    expect(renderInvoicePDF).toHaveBeenCalledWith(
      expect.objectContaining({ receiptPages: fakeReceiptPages }),
    );
  });

  it("passes empty receiptPages to renderInvoicePDF when no receipts are included", async () => {
    mocks.getReceiptPagesForPdf.mockResolvedValue([]);
    mocks.getEmailAttachments.mockResolvedValue({ attachments: [], missingIds: [] });

    const { renderInvoicePDF } = await import("@/lib/invoice-pdf") as { renderInvoicePDF: ReturnType<typeof vi.fn> };
    const { POST } = await import("@/app/api/invoice/email/[eventId]/route");

    const req = new Request("https://app.local/api/invoice/email/evt123", {
      method: "POST",
      headers: { ...jeffHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        gigSummary: "LA #5555 - Test Job",
        to: "payroll@laproduction.com",
        workdays: [{ date: "2026-06-01", hours: 8, overtime: 0 }],
      }),
    });

    await POST(req as never, { params: { eventId: "evt123" } });

    expect(mocks.getReceiptPagesForPdf).toHaveBeenCalledWith("evt123", "LA#5555");
    expect(renderInvoicePDF).toHaveBeenCalledWith(
      expect.objectContaining({ receiptPages: [] }),
    );
  });
});

// Note: ensureAttachmentBucket real-implementation tests are in
// tests/invoice-attachments-lib.test.ts (requires a fresh module context
// where @/lib/invoice-attachments is NOT mocked as a whole).
