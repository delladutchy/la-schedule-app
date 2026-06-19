/**
 * Tests for the PDF freshness logic that prevents stale PDFs.
 *
 * The three pure helpers (normalizeInvoicePdfMetadata, mergeInvoicePdfMetadata,
 * preferGeneratedPdfMetadata) and buildPdfActionUrl are defined inside
 * InvoiceSection.tsx and not exported. They are mirrored here verbatim so
 * the core logic can be unit-tested without a React environment.
 *
 * Invariants verified:
 *   - After regeneration, the state URL is the new URL returned by the POST.
 *   - A stale invoice_pdf_url from page load is never used when a fresh URL is available.
 *   - preferGeneratedPdfMetadata keeps the newly generated URL even after a
 *     background GET refresh.
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Types mirrored from InvoiceSection.tsx
// ---------------------------------------------------------------------------

interface InvoicePdfMetadataResponse {
  ok?: boolean;
  invoiceNumber?: string | null;
  invoice_number?: string | null;
  pdfUrl?: string | null;
  invoice_pdf_url?: string | null;
  storagePath?: string | null;
  invoice_pdf_path?: string | null;
  invoiceUpdatedAt?: string | null;
  invoice_updated_at?: string | null;
  timestamp?: string | null;
  invoiceCreatedAt?: string | null;
  invoice_created_at?: string | null;
  createdAt?: string | null;
  invoiceTotal?: number | null;
  invoice_total?: number | null;
  template?: string | null;
  error?: string;
  detail?: string;
}

interface NormalizedInvoicePdfMetadata {
  invoiceNumber: string | null;
  invoicePdfUrl: string | null;
  storagePath: string | null;
  invoiceUpdatedAt: string | null;
  invoiceCreatedAt: string | null;
  invoiceTotal: number | null;
  template: string | null;
}

interface InvoiceData {
  invoice_number: string | null;
  invoice_pdf_url: string | null;
  invoice_created_at: string | null;
  invoice_total: number | null;
  updated_at: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Functions mirrored from InvoiceSection.tsx
// ---------------------------------------------------------------------------

function normalizeInvoicePdfMetadata(json: InvoicePdfMetadataResponse): NormalizedInvoicePdfMetadata {
  return {
    invoiceNumber: json.invoice_number ?? json.invoiceNumber ?? null,
    invoicePdfUrl: json.invoice_pdf_url ?? json.pdfUrl ?? null,
    storagePath: json.invoice_pdf_path ?? json.storagePath ?? null,
    invoiceUpdatedAt: json.invoice_updated_at ?? json.invoiceUpdatedAt ?? json.timestamp ?? json.createdAt ?? null,
    invoiceCreatedAt: json.invoice_created_at ?? json.invoiceCreatedAt ?? json.createdAt ?? null,
    invoiceTotal: typeof json.invoice_total === "number"
      ? json.invoice_total
      : typeof json.invoiceTotal === "number"
        ? json.invoiceTotal
        : null,
    template: json.template ?? null,
  };
}

function preferGeneratedPdfMetadata(
  generated: NormalizedInvoicePdfMetadata,
  refreshed: NormalizedInvoicePdfMetadata,
): NormalizedInvoicePdfMetadata {
  return {
    invoiceNumber: generated.invoiceNumber ?? refreshed.invoiceNumber,
    invoicePdfUrl: generated.invoicePdfUrl ?? refreshed.invoicePdfUrl,
    storagePath: generated.storagePath ?? refreshed.storagePath,
    invoiceUpdatedAt: generated.invoiceUpdatedAt ?? refreshed.invoiceUpdatedAt,
    invoiceCreatedAt: generated.invoiceCreatedAt ?? refreshed.invoiceCreatedAt,
    invoiceTotal: generated.invoiceTotal ?? refreshed.invoiceTotal,
    template: generated.template ?? refreshed.template,
  };
}

function mergeInvoicePdfMetadata(
  data: InvoiceData | null,
  metadata: NormalizedInvoicePdfMetadata,
): InvoiceData | null {
  if (!data) return data;
  return {
    ...data,
    invoice_number: metadata.invoiceNumber ?? data.invoice_number,
    invoice_pdf_url: metadata.invoicePdfUrl ?? data.invoice_pdf_url,
    invoice_created_at: metadata.invoiceCreatedAt ?? data.invoice_created_at,
    invoice_total: metadata.invoiceTotal ?? data.invoice_total,
    updated_at: metadata.invoiceUpdatedAt ?? data.updated_at,
  };
}

function buildPdfActionUrl(pdfUrl: string | null, version: string | null): string {
  if (!pdfUrl) return "#";
  const separator = pdfUrl.includes("?") ? "&" : "?";
  return `${pdfUrl}${separator}v=${encodeURIComponent(version ?? String(Date.now()))}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OLD_URL = "https://storage.example.com/invoice-pdfs/evt123/Invoice-1001-LA5555-20260101120000.pdf";
const NEW_URL = "https://storage.example.com/invoice-pdfs/evt123/Invoice-1001-LA5555-20260619012345.pdf";

function makeInvoiceData(overrides?: Partial<InvoiceData>): InvoiceData {
  return {
    invoice_number: "1001",
    invoice_pdf_url: OLD_URL,
    invoice_created_at: "2026-01-01T12:00:00.000Z",
    invoice_total: 1500,
    updated_at: "2026-01-01T12:00:00.000Z",
    ...overrides,
  };
}

function makePostResponse(overrides?: Partial<InvoicePdfMetadataResponse>): InvoicePdfMetadataResponse {
  return {
    ok: true,
    invoice_number: "1001",
    invoice_pdf_url: NEW_URL,
    invoice_pdf_path: "evt123/Invoice-1001-LA5555-20260619012345.pdf",
    invoice_updated_at: "2026-06-19T01:23:45.000Z",
    invoice_created_at: "2026-06-19T01:23:45.000Z",
    invoice_total: 1500,
    template: "orange-2026",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeInvoicePdfMetadata
// ---------------------------------------------------------------------------

describe("normalizeInvoicePdfMetadata", () => {
  it("picks invoice_pdf_url from POST response", () => {
    const meta = normalizeInvoicePdfMetadata(makePostResponse());
    expect(meta.invoicePdfUrl).toBe(NEW_URL);
  });

  it("falls back to pdfUrl when invoice_pdf_url is absent", () => {
    const meta = normalizeInvoicePdfMetadata({ pdfUrl: NEW_URL });
    expect(meta.invoicePdfUrl).toBe(NEW_URL);
  });

  it("returns null invoicePdfUrl when neither field present", () => {
    const meta = normalizeInvoicePdfMetadata({});
    expect(meta.invoicePdfUrl).toBeNull();
  });

  it("picks invoice_updated_at for invoiceUpdatedAt", () => {
    const meta = normalizeInvoicePdfMetadata({ invoice_updated_at: "2026-06-19T01:23:45.000Z" });
    expect(meta.invoiceUpdatedAt).toBe("2026-06-19T01:23:45.000Z");
  });

  it("falls back to timestamp when invoice_updated_at absent", () => {
    const meta = normalizeInvoicePdfMetadata({ timestamp: "2026-06-19T01:23:45.000Z" });
    expect(meta.invoiceUpdatedAt).toBe("2026-06-19T01:23:45.000Z");
  });

  it("picks invoice_total as number", () => {
    const meta = normalizeInvoicePdfMetadata({ invoice_total: 2500 });
    expect(meta.invoiceTotal).toBe(2500);
  });

  it("picks storagePath from invoice_pdf_path", () => {
    const meta = normalizeInvoicePdfMetadata({ invoice_pdf_path: "evt123/Invoice-1001.pdf" });
    expect(meta.storagePath).toBe("evt123/Invoice-1001.pdf");
  });
});

// ---------------------------------------------------------------------------
// mergeInvoicePdfMetadata — the key anti-stale-URL guard
// ---------------------------------------------------------------------------

describe("mergeInvoicePdfMetadata", () => {
  it("replaces old URL with new URL from regeneration response", () => {
    const data = makeInvoiceData(); // has OLD_URL
    const meta = normalizeInvoicePdfMetadata(makePostResponse()); // has NEW_URL
    const merged = mergeInvoicePdfMetadata(data, meta);
    expect(merged?.invoice_pdf_url).toBe(NEW_URL);
    expect(merged?.invoice_pdf_url).not.toBe(OLD_URL);
  });

  it("keeps existing URL when metadata has null invoicePdfUrl", () => {
    const data = makeInvoiceData(); // has OLD_URL
    const meta = normalizeInvoicePdfMetadata({}); // invoicePdfUrl: null
    const merged = mergeInvoicePdfMetadata(data, meta);
    expect(merged?.invoice_pdf_url).toBe(OLD_URL);
  });

  it("returns null unchanged when data is null", () => {
    const meta = normalizeInvoicePdfMetadata(makePostResponse());
    expect(mergeInvoicePdfMetadata(null, meta)).toBeNull();
  });

  it("updates invoice_total from regeneration", () => {
    const data = makeInvoiceData({ invoice_total: 1000 });
    const meta = normalizeInvoicePdfMetadata({ invoice_total: 1500 });
    const merged = mergeInvoicePdfMetadata(data, meta);
    expect(merged?.invoice_total).toBe(1500);
  });

  it("updates updated_at from regeneration", () => {
    const data = makeInvoiceData({ updated_at: "2026-01-01T00:00:00.000Z" });
    const meta = normalizeInvoicePdfMetadata({ invoice_updated_at: "2026-06-19T01:23:45.000Z" });
    const merged = mergeInvoicePdfMetadata(data, meta);
    expect(merged?.updated_at).toBe("2026-06-19T01:23:45.000Z");
  });

  it("preserves all other invoiceData fields unchanged", () => {
    const data = makeInvoiceData({ amount_paid: 500, invoice_status: "sent" } as InvoiceData);
    const meta = normalizeInvoicePdfMetadata(makePostResponse());
    const merged = mergeInvoicePdfMetadata(data, meta);
    expect(merged?.amount_paid).toBe(500);
    expect(merged?.invoice_status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// preferGeneratedPdfMetadata — background refresh must not displace new URL
// ---------------------------------------------------------------------------

describe("preferGeneratedPdfMetadata", () => {
  it("keeps generated URL over refreshed URL", () => {
    const generated = normalizeInvoicePdfMetadata({ invoice_pdf_url: NEW_URL, invoice_updated_at: "2026-06-19T01:23:45.000Z" });
    const refreshed = normalizeInvoicePdfMetadata({ invoice_pdf_url: OLD_URL, invoice_updated_at: "2026-06-19T01:23:45.000Z" });
    const best = preferGeneratedPdfMetadata(generated, refreshed);
    expect(best.invoicePdfUrl).toBe(NEW_URL);
  });

  it("falls back to refreshed URL when generated has null", () => {
    const generated = normalizeInvoicePdfMetadata({});
    const refreshed = normalizeInvoicePdfMetadata({ invoice_pdf_url: NEW_URL });
    const best = preferGeneratedPdfMetadata(generated, refreshed);
    expect(best.invoicePdfUrl).toBe(NEW_URL);
  });

  it("keeps generated invoice_total", () => {
    const generated = normalizeInvoicePdfMetadata({ invoice_total: 1500 });
    const refreshed = normalizeInvoicePdfMetadata({ invoice_total: 999 });
    const best = preferGeneratedPdfMetadata(generated, refreshed);
    expect(best.invoiceTotal).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// buildPdfActionUrl — cache-busting URL construction
// ---------------------------------------------------------------------------

describe("buildPdfActionUrl", () => {
  it("returns # for null pdfUrl", () => {
    expect(buildPdfActionUrl(null, null)).toBe("#");
  });

  it("appends ?v= to URL without query string", () => {
    const url = buildPdfActionUrl(NEW_URL, "2026-06-19T01:23:45.000Z");
    expect(url).toContain("?v=");
    expect(url.startsWith(NEW_URL)).toBe(true);
  });

  it("appends &v= when URL already has query params", () => {
    const url = buildPdfActionUrl(`${NEW_URL}?foo=bar`, "2026-06-19T01:23:45.000Z");
    expect(url).toContain("&v=");
    expect(url).not.toContain("?v=");
  });

  it("produces different cache-busted URLs for different versions", () => {
    const url1 = buildPdfActionUrl(NEW_URL, "2026-06-19T01:23:45.000Z");
    const url2 = buildPdfActionUrl(NEW_URL, "2026-06-19T02:00:00.000Z");
    expect(url1).not.toBe(url2);
  });

  it("new URL after regeneration produces different href than old URL", () => {
    const oldActionUrl = buildPdfActionUrl(OLD_URL, "2026-01-01T12:00:00.000Z");
    const newActionUrl = buildPdfActionUrl(NEW_URL, "2026-06-19T01:23:45.000Z");
    expect(oldActionUrl).not.toBe(newActionUrl);
    expect(newActionUrl).toContain(NEW_URL);
  });
});

// ---------------------------------------------------------------------------
// End-to-end freshness scenario
// ---------------------------------------------------------------------------

describe("full regeneration sequence — stale URL never used", () => {
  it("Open PDF after regeneration uses new URL, not page-load URL", () => {
    // Simulates: page loads with OLD_URL → user clicks Open PDF → generateFreshPdf
    // POST returns NEW_URL → mergeInvoicePdfMetadata updates state.
    const pageLoadData = makeInvoiceData(); // OLD_URL from DB
    const postResponse = makePostResponse(); // NEW_URL from regeneration
    const generatedMeta = normalizeInvoicePdfMetadata(postResponse);

    // This is what happens inside generateFreshPdf after POST:
    const updatedData = mergeInvoicePdfMetadata(pageLoadData, generatedMeta);

    // The URL that handleOpenPdf uses to call window.open:
    const freshUrl = generatedMeta.invoicePdfUrl;

    // The URL that Open PDF <button> would derive from state after update:
    const stateUrl = updatedData?.invoice_pdf_url;

    expect(freshUrl).toBe(NEW_URL);
    expect(stateUrl).toBe(NEW_URL);
    expect(freshUrl).not.toBe(OLD_URL);
    expect(stateUrl).not.toBe(OLD_URL);
  });

  it("background refresh does not displace the fresh POST URL", () => {
    const generatedMeta = normalizeInvoicePdfMetadata(makePostResponse({ invoice_pdf_url: NEW_URL }));
    // DB GET refresh might return any URL — even if it's behind, preferGeneratedPdfMetadata wins.
    const refreshedMeta = normalizeInvoicePdfMetadata({ invoice_pdf_url: OLD_URL });
    const latestMeta = preferGeneratedPdfMetadata(generatedMeta, refreshedMeta);
    expect(latestMeta.invoicePdfUrl).toBe(NEW_URL);
  });
});
