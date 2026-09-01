/**
 * Tests for POST /api/invoice/mark-sent/[eventId]
 *
 * This route is the only way the Gmail-draft workflow reaches
 * invoice_status = "sent" — the send itself happens inside Gmail, so the user
 * has to confirm it explicitly.
 *
 * Verifies:
 *   - Jeff-only auth (401 unauthorized, 403 forbidden)
 *   - 404 when the invoice row does not exist
 *   - 409 before a PDF exists, and for statuses markInvoiceSent won't move
 *   - markInvoiceSent called with the confirmed recipients + subject
 *   - Recipients are never fabricated (stored value reused; else null)
 *   - Sheet re-synced with the sent packet
 *   - 500 when the status did not actually persist
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getInvoiceData:     vi.fn(),
  markInvoiceSent:    vi.fn(),
  markSheetSynced:    vi.fn(),
  markSheetSyncError: vi.fn(),
  upsertSheetRow:     vi.fn(),
  calculateInvoicePacket: vi.fn(),
  generateSheetRow:       vi.fn(),
}));

vi.mock("@/lib/invoice-data", () => ({
  getInvoiceData:     mocks.getInvoiceData,
  markInvoiceSent:    mocks.markInvoiceSent,
  markSheetSynced:    mocks.markSheetSynced,
  markSheetSyncError: mocks.markSheetSyncError,
}));

vi.mock("@/lib/google-sheets", () => ({
  upsertSheetRow: mocks.upsertSheetRow,
  COLUMN_ORDER:   [],
}));

vi.mock("@/lib/invoice-calculations", () => ({
  calculateInvoicePacket: mocks.calculateInvoicePacket,
  generateSheetRow:       mocks.generateSheetRow,
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    env: {
      EDITOR_TOKENS_JSON: JSON.stringify({ jeff: "jeff-token-abc123", dave: "dave-token-abc123" }),
    },
  }),
}));

vi.mock("@/lib/job-time", () => ({
  isJeffEditorId: (id: string) => id === "jeff",
}));

const DRAFTED_INVOICE = {
  google_event_id:      "evt123",
  invoice_number:       "1014",
  la_number:            "72180",
  invoice_status:       "draft_created",
  invoice_pdf_url:      "https://storage.example.com/invoice-1014.pdf",
  invoice_total:        3194.06,
  invoice_sent_at:      null,
  invoice_sent_to:      null,
  invoice_sent_subject: null,
  invoice_job_name_override: null,
  amount_paid:          0,
  remaining_balance:    3194.06,
};

const SENT_INVOICE = {
  ...DRAFTED_INVOICE,
  invoice_status:  "sent",
  invoice_sent_at: "2026-09-01T20:00:00.000Z",
  invoice_sent_to: "payroll@laproduction.com",
};

function post(body: unknown, headers: Record<string, string>) {
  return new Request("https://app.local/api/invoice/mark-sent/evt123", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const jeff = { Authorization: "Bearer jeff-token-abc123" };
const dave = { Authorization: "Bearer dave-token-abc123" };

async function loadRoute() {
  return (await import("@/app/api/invoice/mark-sent/[eventId]/route")).POST;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calculateInvoicePacket.mockReturnValue({ invoiceStatus: "sent", estimatedTotal: 3194.06 });
  mocks.generateSheetRow.mockReturnValue({ invoiceNumber: "1014", status: "sent" });
  mocks.upsertSheetRow.mockResolvedValue(undefined);
  mocks.markSheetSynced.mockResolvedValue(undefined);
  mocks.markInvoiceSent.mockResolvedValue(undefined);
});

describe("POST /api/invoice/mark-sent/[eventId] — auth", () => {
  it("401 without a token", async () => {
    const POST = await loadRoute();
    const res = await POST(post({}, {}) as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(401);
    expect(mocks.markInvoiceSent).not.toHaveBeenCalled();
  });

  it("403 for a non-Jeff editor", async () => {
    const POST = await loadRoute();
    const res = await POST(post({}, dave) as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(403);
    expect(mocks.markInvoiceSent).not.toHaveBeenCalled();
  });
});

describe("POST /api/invoice/mark-sent/[eventId] — guards", () => {
  it("404 when the invoice row is missing", async () => {
    mocks.getInvoiceData.mockResolvedValue(null);
    const POST = await loadRoute();
    const res = await POST(post({}, jeff) as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(404);
    expect(mocks.markInvoiceSent).not.toHaveBeenCalled();
  });

  it("409 when no PDF has been created yet", async () => {
    mocks.getInvoiceData.mockResolvedValue({ ...DRAFTED_INVOICE, invoice_pdf_url: null });
    const POST = await loadRoute();
    const res = await POST(post({}, jeff) as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "invoice_not_created" });
    expect(mocks.markInvoiceSent).not.toHaveBeenCalled();
  });

  it("409 for a status markInvoiceSent would silently skip", async () => {
    mocks.getInvoiceData.mockResolvedValue({ ...DRAFTED_INVOICE, invoice_status: "none" });
    const POST = await loadRoute();
    const res = await POST(post({}, jeff) as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "invalid_status" });
    expect(mocks.markInvoiceSent).not.toHaveBeenCalled();
  });

  it("500 when the status did not persist", async () => {
    mocks.getInvoiceData
      .mockResolvedValueOnce(DRAFTED_INVOICE)
      .mockResolvedValueOnce(DRAFTED_INVOICE); // still draft_created after the update
    const POST = await loadRoute();
    const res = await POST(post({}, jeff) as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "mark_sent_not_applied" });
    expect(mocks.upsertSheetRow).not.toHaveBeenCalled();
  });
});

describe("POST /api/invoice/mark-sent/[eventId] — success", () => {
  beforeEach(() => {
    mocks.getInvoiceData
      .mockResolvedValueOnce(DRAFTED_INVOICE)
      .mockResolvedValue(SENT_INVOICE);
  });

  it("marks sent with the confirmed recipients and subject", async () => {
    const POST = await loadRoute();
    const res = await POST(
      post({
        to: ["payroll@laproduction.com"],
        cc: ["ap@laproduction.com"],
        subject: "Jeff Ulsh - Invoice LA #72180",
        gigSummary: "LA#72180 — Cole Swindell After game concert",
      }, jeff) as never,
      { params: { eventId: "evt123" } },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(mocks.markInvoiceSent).toHaveBeenCalledTimes(1);
    const [eventId, sentAt, sentTo, sentSubject] = mocks.markInvoiceSent.mock.calls[0]!;
    expect(eventId).toBe("evt123");
    expect(typeof sentAt).toBe("string");
    expect(sentTo).toBe("payroll@laproduction.com, ap@laproduction.com");
    expect(sentSubject).toBe("Jeff Ulsh - Invoice LA #72180");
  });

  it("re-syncs the Sheet with the sent record", async () => {
    const POST = await loadRoute();
    await POST(post({ to: ["payroll@laproduction.com"] }, jeff) as never, { params: { eventId: "evt123" } });
    expect(mocks.upsertSheetRow).toHaveBeenCalledTimes(1);
    expect(mocks.markSheetSynced).toHaveBeenCalledTimes(1);
    expect(mocks.generateSheetRow).toHaveBeenCalledWith(
      expect.anything(),
      "", // no gigSummary in this request body
      "1014",
      undefined,
      expect.objectContaining({ sentTo: SENT_INVOICE.invoice_sent_to }),
    );
  });

  it("still returns ok when the Sheet sync fails", async () => {
    mocks.upsertSheetRow.mockRejectedValue(new Error("sheets down"));
    const POST = await loadRoute();
    const res = await POST(post({ to: ["payroll@laproduction.com"] }, jeff) as never, { params: { eventId: "evt123" } });
    expect(res.status).toBe(200);
    expect(mocks.markSheetSyncError).toHaveBeenCalled();
  });
});

describe("POST /api/invoice/mark-sent/[eventId] — recipients are never invented", () => {
  it("passes null when no recipients are supplied or stored", async () => {
    mocks.getInvoiceData
      .mockResolvedValueOnce(DRAFTED_INVOICE)
      .mockResolvedValue({ ...SENT_INVOICE, invoice_sent_to: null });
    const POST = await loadRoute();
    await POST(post({}, jeff) as never, { params: { eventId: "evt123" } });
    const [, , sentTo, sentSubject] = mocks.markInvoiceSent.mock.calls[0]!;
    expect(sentTo).toBeNull();
    expect(sentSubject).toBeNull();
  });

  it("falls back to the stored recipient when the caller supplies none", async () => {
    mocks.getInvoiceData
      .mockResolvedValueOnce({
        ...DRAFTED_INVOICE,
        invoice_sent_to: "payroll@laproduction.com",
        invoice_sent_subject: "Jeff Ulsh - Invoice LA #72180",
      })
      .mockResolvedValue(SENT_INVOICE);
    const POST = await loadRoute();
    await POST(post({}, jeff) as never, { params: { eventId: "evt123" } });
    const [, , sentTo, sentSubject] = mocks.markInvoiceSent.mock.calls[0]!;
    expect(sentTo).toBe("payroll@laproduction.com");
    expect(sentSubject).toBe("Jeff Ulsh - Invoice LA #72180");
  });
});
