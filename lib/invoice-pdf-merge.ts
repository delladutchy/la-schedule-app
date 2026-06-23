import "server-only";
import { PDFDocument } from "pdf-lib";
import type { ReceiptPageData } from "./invoice-attachments";

/**
 * Appends pages from PDF receipt attachments to an existing invoice PDF buffer.
 *
 * Only processes receipts where pdfBytes is non-null (successfully downloaded).
 * Returns the original buffer unchanged if there are no PDF receipts to merge.
 * Per-receipt merge failures are logged and skipped rather than aborting the whole packet.
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
    console.error("[invoice-pdf-merge] could not load invoice PDF:", e instanceof Error ? e.message : String(e));
    return invoiceBuffer;
  }

  for (const receipt of pdfReceipts) {
    try {
      const receiptDoc = await PDFDocument.load(receipt.pdfBytes!);
      const indices    = receiptDoc.getPageIndices();
      const pages      = await merged.copyPages(receiptDoc, indices);
      for (const page of pages) {
        merged.addPage(page);
      }
      console.log(`[invoice-pdf-merge] appended ${indices.length} page(s) from ${receipt.originalFilename}`);
    } catch (e) {
      console.error(
        `[invoice-pdf-merge] skipping ${receipt.originalFilename} — could not merge: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const out = await merged.save();
  return Buffer.from(out);
}
