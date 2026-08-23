import "server-only";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import type { ReceiptPageData } from "./invoice-attachments";

// Brand colors matching the invoice stylesheet
const BRAND = {
  teal:  rgb(59 / 255,  165 / 255, 174 / 255), // #3BA5AE
  white: rgb(1,         1,         1),
  muted: rgb(111 / 255, 120 / 255, 128 / 255),  // #6F7880 — unused, kept for reference
};

// Stamp bar height: 28pt covers the typical browser-printed header region (URL / title).
// Since we draw on top of the existing PDF content, this visually overrides browser headers
// without requiring us to modify or re-rasterize the receipt content.
const STAMP_HEIGHT    = 28;
const STAMP_FONT_SIZE = 9;
const STAMP_INNER_PAD = 8; // horizontal padding inside the bar

// ── Pure helpers (exported for testing without server-only) ──────────────────

/** Normalises any "LA# …" variant into canonical "LA# 71803", or null if absent. */
export function formatStampLa(laJobNumber: string | null): string | null {
  if (!laJobNumber) return null;
  const digits = laJobNumber.replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "");
  return digits ? `LA# ${digits}` : null;
}

/** Right-side label: saved category is preferred; filename is the fallback (truncated). */
export function formatStampLabel(receipt: { category: string | null; originalFilename: string }): string {
  if (receipt.category?.trim()) return receipt.category.trim();
  const name = receipt.originalFilename;
  return name.length > 30 ? name.slice(0, 28) + "…" : name;
}

/**
 * Metadata suffix showing only explicitly saved values — never the current date.
 * Returns an empty string when nothing was saved.
 */
export function formatStampMeta(receipt: {
  receiptDate: string | null;
  amount: number | null;
}): string {
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const parts: string[] = [];

  if (receipt.receiptDate) {
    const [yStr, moStr, dStr] = receipt.receiptDate.split("-");
    const y  = parseInt(yStr  ?? "0", 10);
    const mo = parseInt(moStr ?? "1", 10);
    const d  = parseInt(dStr  ?? "1", 10);
    const monthName = MONTHS[mo - 1];
    if (monthName) parts.push(`${monthName} ${d}, ${y}`);
  }

  if (receipt.amount != null) parts.push(`$${receipt.amount.toFixed(2)}`);

  return parts.join(" · "); // " · "
}

// ── Internal: stamp one page ─────────────────────────────────────────────────

function stampReceiptPageHeader(
  page: PDFPage,
  receipt: ReceiptPageData,
  regular: PDFFont,
  bold: PDFFont,
): void {
  const { width, height } = page.getSize();

  // Teal bar drawn at the very top of the page.  This visually covers any
  // browser-generated URL / title header that may be baked into the PDF.
  page.drawRectangle({
    x:      0,
    y:      height - STAMP_HEIGHT,
    width,
    height: STAMP_HEIGHT,
    color:  BRAND.teal,
  });

  // Vertically centre the text within the bar.
  // PDF baseline is roughly (STAMP_HEIGHT - fontSize) / 2 above the rectangle bottom.
  const textY = height - STAMP_HEIGHT + (STAMP_HEIGHT - STAMP_FONT_SIZE) / 2 - 1;

  // Left side: LA# in bold (or nothing if no job number)
  const laStr = formatStampLa(receipt.laJobNumber);
  if (laStr) {
    page.drawText(laStr, {
      x:    STAMP_INNER_PAD,
      y:    textY,
      size: STAMP_FONT_SIZE,
      font: bold,
      color: BRAND.white,
    });
  }

  // Right side: label [ · date] [ · $amount]  — only saved metadata, never current date
  const label     = formatStampLabel(receipt);
  const meta      = formatStampMeta(receipt);
  const rightText = meta ? `${label} · ${meta}` : label;
  const rightW    = regular.widthOfTextAtSize(rightText, STAMP_FONT_SIZE);

  page.drawText(rightText, {
    x:    width - STAMP_INNER_PAD - rightW,
    y:    textY,
    size: STAMP_FONT_SIZE,
    font: regular,
    color: BRAND.white,
  });
}

// ── Public: merge ─────────────────────────────────────────────────────────────

/**
 * Appends pages from PDF receipt attachments to an existing invoice PDF buffer,
 * stamping each imported page with a branded teal header (LA#, receipt label,
 * saved metadata only — never the current date or a browser-generated header).
 *
 * Strategy: stamp directly onto the copied PDF page rather than inserting a
 * separate cover page, keeping the packet minimal.  The stamp height (28pt) is
 * sized to visually overwrite the browser-printed header region most receipt PDFs
 * have when saved via Safari/Chrome "Print to PDF."  We do NOT attempt to erase
 * or re-rasterise the underlying PDF content — the stamp draws on top.
 *
 * Returns the original buffer unchanged when there are no PDF receipts to merge.
 * Fails closed: if the invoice PDF can't be loaded, or any individual receipt
 * can't be merged, this throws rather than silently returning a packet that's
 * missing a receipt the caller believes was included (see ReceiptEmbedError
 * in lib/invoice-pdf.tsx for the equivalent guard on image receipts).
 */
export async function appendPdfReceiptPages(
  invoiceBuffer: Buffer,
  receiptPages: ReceiptPageData[],
): Promise<Buffer> {
  const pdfReceipts = receiptPages.filter((r) => r.pdfBytes != null);
  if (pdfReceipts.length === 0) return invoiceBuffer;

  let merged: PDFDocument;
  try {
    merged = await PDFDocument.load(invoiceBuffer);
  } catch (e) {
    throw new Error(`[invoice-pdf-merge] could not load invoice PDF: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Embed fonts once into the target document; all stamped pages share them.
  const regular = await merged.embedFont(StandardFonts.Helvetica);
  const bold    = await merged.embedFont(StandardFonts.HelveticaBold);

  const failed: string[] = [];
  for (const receipt of pdfReceipts) {
    try {
      const receiptDoc = await PDFDocument.load(receipt.pdfBytes!);
      const indices    = receiptDoc.getPageIndices();
      const pages      = await merged.copyPages(receiptDoc, indices);

      for (const page of pages) {
        merged.addPage(page);
        stampReceiptPageHeader(page, receipt, regular, bold);
      }

      console.log(`[invoice-pdf-merge] appended + stamped ${indices.length} page(s) from ${receipt.originalFilename}`);
    } catch (e) {
      console.error(
        `[invoice-pdf-merge] failed to merge ${receipt.originalFilename}: ${e instanceof Error ? e.message : String(e)}`,
      );
      failed.push(receipt.originalFilename);
    }
  }

  if (failed.length > 0) {
    throw new Error(
      `Receipt PDF(s) failed to merge into the invoice packet: ${failed.join(", ")}. Refusing to generate the invoice packet.`,
    );
  }

  const out = await merged.save();
  return Buffer.from(out);
}
