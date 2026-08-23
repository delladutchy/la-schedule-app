/**
 * Regression test for a real production failure: a receipt photo whose JPEG
 * structure makes @react-pdf/renderer's internal decoder (the `jay-peg`
 * package) silently fail to embed the image. The failure is swallowed inside
 * react-pdf — no exception reaches our code, no placeholder text renders —
 * so the receipt appendix page comes out completely blank.
 *
 * Root cause: jay-peg's JFIFMarker struct (node_modules/jay-peg/src/markers/jfif.js)
 * hardcodes exactly 16 bytes of fields (identifier, version, units, density,
 * thumbnail dims) and never consumes the segment's own declared `length` for
 * anything past those fields. A JPEG whose APP0/JFIF segment is legally longer
 * than 16 bytes (real camera/export tools do this) desyncs jay-peg's marker
 * scan by the extra byte count, and it throws "Unknown version N" trying to
 * interpret mid-scan-data bytes as the next marker code. @react-pdf/renderer
 * catches that per-image and just renders nothing.
 *
 * Fix: lib/invoice-attachments.ts re-encodes every receipt image through
 * `sharp` (clean baseline sRGB JPEG, no oversized JFIF segment) before handing
 * it to react-pdf. Fail-closed backstop: lib/invoice-pdf.tsx's
 * verifyImageReceiptsEmbedded() checks the *rendered PDF* for an actual
 * embedded image XObject per expected receipt and throws ReceiptEmbedError
 * if one is missing, so a blank-page packet can never be generated or sent —
 * even if some future change breaks normalization again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";
import { PDFDocument, PDFDict, PDFName } from "pdf-lib";

// ---------------------------------------------------------------------------
// Fixture: a small, content-free JPEG whose APP0/JFIF segment is 4 bytes
// longer than jay-peg's JFIFMarker struct reads. This is legal JPEG (readers
// must use the segment's own length to skip unknown trailing bytes — sharp/
// libjpeg read it fine) and deterministically reproduces the "Unknown version"
// desync without needing any real photo or personal data.
// ---------------------------------------------------------------------------

async function buildMalformedJfifJpeg(): Promise<Buffer> {
  const base = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 200, b: 200 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();

  const PAD = 4;
  const declaredLen = 16 + PAD; // 16 = minimal JFIF fields jay-peg reads; +4 = bytes it never consumes
  const jfifSegment = Buffer.concat([
    Buffer.from([0xff, 0xe0]), // APP0 marker
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(declaredLen, 0); return b; })(),
    Buffer.from("JFIF\0", "ascii"),
    Buffer.from([0x01, 0x02]), // version
    Buffer.from([0x00]),       // units
    Buffer.from([0x00, 0x48]), // xDensity
    Buffer.from([0x00, 0x48]), // yDensity
    Buffer.from([0x00]),       // thumbnailWidth
    Buffer.from([0x00]),       // thumbnailHeight
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // extra bytes jay-peg's struct never reads
  ]);

  return Buffer.concat([base.subarray(0, 2), jfifSegment, base.subarray(2)]);
}

async function hasEmbeddedImage(pdfBuffer: Buffer, pageIndex: number): Promise<boolean> {
  const doc = await PDFDocument.load(pdfBuffer);
  const page = doc.getPage(pageIndex);
  const xobj = page.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  return !!xobj && xobj.keys().length > 0;
}

describe("malformed-JFIF fixture reproduces the upstream jay-peg desync", () => {
  it("jay-peg fails to decode the fixture's markers", async () => {
    // @ts-expect-error jay-peg ships no type declarations
    const jaypeg = (await import("jay-peg")).default as { decode: (buf: Buffer) => unknown };
    const bytes = await buildMalformedJfifJpeg();
    expect(() => jaypeg.decode(bytes)).toThrow(/Unknown version/);
  });

  it("sharp itself still reads the fixture correctly (it is legal JPEG)", async () => {
    const bytes = await buildMalformedJfifJpeg();
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// getReceiptPagesForPdf: normalization must fix the fixture before it ever
// reaches react-pdf.
// ---------------------------------------------------------------------------

const downloadMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            is: () => ({
              order: async () => ({
                data: [
                  {
                    id: "att-1",
                    storage_path: "evt/malformed.jpeg",
                    mime_type: "image/jpeg",
                    original_filename: "malformed.jpeg",
                    la_job_number: null,
                    receipt_date: null,
                    receipt_category: null,
                    receipt_amount: null,
                    created_at: "2026-01-01T00:00:00Z",
                  },
                ],
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
    storage: {
      from: () => ({ download: downloadMock }),
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getReceiptPagesForPdf normalizes a receipt that would otherwise break react-pdf", () => {
  it("produces an imageDataUrl that react-pdf can actually embed", async () => {
    const bytes = await buildMalformedJfifJpeg();
    downloadMock.mockResolvedValue({ data: { arrayBuffer: async () => bytes }, error: null });

    const { getReceiptPagesForPdf } = await import("@/lib/invoice-attachments");
    const pages = await getReceiptPagesForPdf("evt", null);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.imageDataUrl).toBeTruthy();

    // The real assertion: react-pdf must actually embed it, not just receive a data URL.
    const React = (await import("react")).default;
    const { Document, Page, Image, View, renderToBuffer } = await import("@react-pdf/renderer");
    const el = React.createElement(Document, {},
      React.createElement(Page, { size: "LETTER" },
        React.createElement(View, {}, React.createElement(Image, { src: pages[0]!.imageDataUrl! })),
      ),
    );
    const pdf = await renderToBuffer(el as React.ReactElement);
    expect(await hasEmbeddedImage(Buffer.from(pdf), 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderInvoicePDF: fail-closed guard. If normalization is bypassed/broken —
// simulated here by handing renderInvoicePDF the raw malformed bytes directly
// as imageDataUrl, as if some future change skipped the sharp step — it must
// throw ReceiptEmbedError rather than return a packet with a blank page.
// ---------------------------------------------------------------------------

describe("renderInvoicePDF fails closed when a receipt image can't actually embed", () => {
  it("throws ReceiptEmbedError instead of silently returning a blank-page PDF", async () => {
    const bytes = await buildMalformedJfifJpeg();
    const { renderInvoicePDF, ReceiptEmbedError } = await import("@/lib/invoice-pdf");

    const packet = minimalPacket();

    await expect(
      renderInvoicePDF({
        packet,
        invoiceNumber: "1001",
        gigSummary: "LA#1234 Test Job",
        issuedDate: "2026-01-01",
        receiptPages: [{
          id: "att-1",
          mimeType: "image/jpeg",
          imageDataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
          pdfBytes: null,
          receiptDate: null,
          laJobNumber: null,
          category: null,
          amount: null,
          originalFilename: "malformed.jpeg",
        }],
      }),
    ).rejects.toThrow(ReceiptEmbedError);
  }, 15000);

  it("succeeds and embeds when the same receipt is normalized first", async () => {
    const bytes = await buildMalformedJfifJpeg();
    const normalized = await sharp(bytes).rotate().toColorspace("srgb").flatten({ background: "#ffffff" }).jpeg({ quality: 90, progressive: false }).toBuffer();
    const { renderInvoicePDF } = await import("@/lib/invoice-pdf");

    const packet = minimalPacket();

    const pdf = await renderInvoicePDF({
      packet,
      invoiceNumber: "1001",
      gigSummary: "LA#1234 Test Job",
      issuedDate: "2026-01-01",
      receiptPages: [{
        id: "att-1",
        mimeType: "image/jpeg",
        imageDataUrl: `data:image/jpeg;base64,${normalized.toString("base64")}`,
        pdfBytes: null,
        receiptDate: null,
        laJobNumber: null,
        category: null,
        amount: null,
        originalFilename: "malformed.jpeg",
      }],
    });

    // Receipt page is appended after the (single) invoice page.
    expect(await hasEmbeddedImage(pdf, 1)).toBe(true);
  }, 15000);
});

function minimalPacket() {
  return {
    client: "Light Action",
    laNumber: "LA#1234",
    workdays: [{ date: "2026-01-01", startTime: "9:00 AM", endTime: "5:00 PM", totalHours: 8, mileageMode: null, milesDriven: 0 }],
    dayRateQty: 1,
    dayRate: 550,
    dayRateTotal: 550,
    overtimeTotal: 0,
    totalOvertimeHours: 0,
    overtimeRate: 82.5,
    perDiemTotal: 0,
    perDiemQty: 0,
    perDiemRate: 40,
    mileage: {
      totalMiles: 0,
      deductionMiles: 0,
      reimbursedMiles: 0,
      unreimbursedMiles: 0,
      grossMileageAmount: 0,
      mileageAmount: 0,
      mileageAdjustmentAmount: 0,
      mileageRate: 0.52,
    },
    bagFees: 0,
    parking: 0,
    uber: 0,
    tolls: 0,
    hotel: 0,
    otherExpenses: 0,
    estimatedTotal: 550,
    invoiceStatus: "draft_created",
    amountPaid: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
