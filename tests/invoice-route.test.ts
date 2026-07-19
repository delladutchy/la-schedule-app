/**
 * Tests for the invoice PATCH route (app/api/invoice/[eventId]/route.ts).
 *
 * Regression coverage for the invoice #1007 LA# bug: la_number is a stored
 * snapshot (lib/invoice-data.ts) that must be directly editable and
 * persisted through this route, normalized so "72813", "LA#72813", and
 * "LA #72813" never produce a duplicated "LA#LA#..." prefix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeEditorRequest: vi.fn(),
  isJeffEditorId:         vi.fn(),
  getInvoiceData:         vi.fn(),
  upsertInvoiceData:      vi.fn(),
  markSheetSynced:        vi.fn(),
  markSheetSyncError:     vi.fn(),
  calculateInvoicePacket: vi.fn(),
  generateSheetRow:       vi.fn(),
  upsertSheetRow:         vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ env: {} }),
}));

vi.mock("@/lib/editor-auth", () => ({
  authorizeEditorRequest: (...args: unknown[]) => mocks.authorizeEditorRequest(...args),
}));

vi.mock("@/lib/job-time", () => ({
  isJeffEditorId: (...args: unknown[]) => mocks.isJeffEditorId(...args),
}));

vi.mock("@/lib/invoice-data", () => ({
  getInvoiceData:     (...args: unknown[]) => mocks.getInvoiceData(...args),
  upsertInvoiceData:  (...args: unknown[]) => mocks.upsertInvoiceData(...args),
  markSheetSynced:    (...args: unknown[]) => mocks.markSheetSynced(...args),
  markSheetSyncError: (...args: unknown[]) => mocks.markSheetSyncError(...args),
}));

vi.mock("@/lib/invoice-calculations", () => ({
  calculateInvoicePacket: (...args: unknown[]) => mocks.calculateInvoicePacket(...args),
  generateSheetRow:       (...args: unknown[]) => mocks.generateSheetRow(...args),
}));

vi.mock("@/lib/google-sheets", () => ({
  upsertSheetRow: (...args: unknown[]) => mocks.upsertSheetRow(...args),
}));

import { PATCH } from "@/app/api/invoice/[eventId]/route";
import type { NextRequest } from "next/server";

function makeRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/invoice/evt-1007", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

describe("PATCH /api/invoice/[eventId] — la_number persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeEditorRequest.mockReturnValue({ ok: true, editorId: "jeff" });
    mocks.isJeffEditorId.mockReturnValue(true);
    mocks.calculateInvoicePacket.mockReturnValue({ laNumber: null });
    mocks.generateSheetRow.mockReturnValue({});
    mocks.upsertSheetRow.mockResolvedValue(undefined);
    mocks.markSheetSynced.mockResolvedValue(undefined);
    // Echo whatever patch was written so the test can assert on it.
    mocks.upsertInvoiceData.mockImplementation((_eventId: string, patch: Record<string, unknown>) =>
      Promise.resolve({ google_event_id: "evt-1007", ...patch }),
    );
  });

  it("persists a bare digit la_number unchanged", async () => {
    const res = await PATCH(makeRequest({ la_number: "72813" }), { params: Promise.resolve({ eventId: "evt-1007" }) });
    expect(res.status).toBe(200);
    expect(mocks.upsertInvoiceData).toHaveBeenCalledWith(
      "evt-1007",
      expect.objectContaining({ la_number: "72813" }),
    );
  });

  it("strips an 'LA#' prefix so it isn't duplicated by downstream formatters", async () => {
    await PATCH(makeRequest({ la_number: "LA#72813" }), { params: Promise.resolve({ eventId: "evt-1007" }) });
    expect(mocks.upsertInvoiceData).toHaveBeenCalledWith(
      "evt-1007",
      expect.objectContaining({ la_number: "72813" }),
    );
  });

  it("strips an 'LA #' (spaced) prefix the same way", async () => {
    await PATCH(makeRequest({ la_number: "LA #72813" }), { params: Promise.resolve({ eventId: "evt-1007" }) });
    expect(mocks.upsertInvoiceData).toHaveBeenCalledWith(
      "evt-1007",
      expect.objectContaining({ la_number: "72813" }),
    );
  });

  it("stores null (not empty string, not '0000') when cleared", async () => {
    await PATCH(makeRequest({ la_number: "" }), { params: Promise.resolve({ eventId: "evt-1007" }) });
    expect(mocks.upsertInvoiceData).toHaveBeenCalledWith(
      "evt-1007",
      expect.objectContaining({ la_number: null }),
    );
  });

  it("a stale stored value ('0000') is overwritten by a later edit — proves editing is no longer a no-op", async () => {
    mocks.upsertInvoiceData.mockResolvedValueOnce({ google_event_id: "evt-1007", la_number: "0000" });
    // First call simulates the pre-fix stale state; second call is the actual edit under test.
    await PATCH(makeRequest({ la_number: "0000" }), { params: Promise.resolve({ eventId: "evt-1007" }) });

    const res = await PATCH(makeRequest({ la_number: "72813" }), { params: Promise.resolve({ eventId: "evt-1007" }) });
    const json = await res.json() as { invoiceData: { la_number: string | null } };
    expect(json.invoiceData.la_number).toBe("72813");
  });

  it("rejects non-Jeff editors", async () => {
    mocks.isJeffEditorId.mockReturnValue(false);
    const res = await PATCH(makeRequest({ la_number: "72813" }), { params: Promise.resolve({ eventId: "evt-1007" }) });
    expect(res.status).toBe(403);
    expect(mocks.upsertInvoiceData).not.toHaveBeenCalled();
  });
});
