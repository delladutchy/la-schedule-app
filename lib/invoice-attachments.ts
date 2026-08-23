import "server-only";
import sharp from "sharp";
import { getSupabaseServerClient } from "./supabase";

export const ATTACHMENT_BUCKET = "invoice-attachments";

/** Max file size: 20 MB */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Allowed MIME types */
export const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

export interface AttachmentRecord {
  id: string;
  google_event_id: string;
  invoice_number: string | null;
  la_job_number: string | null;
  original_filename: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  include_in_email: boolean;
  uploaded_by: string | null;
  created_at: string;
  archived_at: string | null;
  // Receipt metadata — used for the PDF appendix header/subtitle
  receipt_date: string | null;     // YYYY-MM-DD
  receipt_category: string | null; // e.g. "Parking", "Hotel"
  receipt_amount: number | null;   // dollar amount
}

/** Ensure the storage bucket exists (idempotent). */
export async function ensureAttachmentBucket(): Promise<void> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.storage.createBucket(ATTACHMENT_BUCKET, {
    public: false,
    fileSizeLimit: MAX_ATTACHMENT_BYTES,
  });
  if (error && !error.message.toLowerCase().includes("already exists")) {
    throw new Error(`[invoice-attachments] bucket create failed: ${error.message}`);
  }
}

/** Upload a file to Storage and insert a metadata row. Returns the new record. */
export async function uploadAttachment(opts: {
  googleEventId: string;
  invoiceNumber: string | null;
  laJobNumber: string | null;
  originalFilename: string;
  mimeType: string;
  buffer: Buffer;
  uploadedBy: string | null;
}): Promise<AttachmentRecord> {
  const supabase = getSupabaseServerClient();

  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const safeFilename = opts.originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const storagePath = `${opts.googleEventId}/${ts}-${safeFilename}`;

  const { error: uploadError } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .upload(storagePath, opts.buffer, {
      contentType: opts.mimeType,
      upsert: false,
    });
  if (uploadError) {
    throw new Error(`[invoice-attachments] storage upload failed: ${uploadError.message}`);
  }

  const row = {
    google_event_id: opts.googleEventId,
    invoice_number: opts.invoiceNumber,
    la_job_number: opts.laJobNumber,
    original_filename: opts.originalFilename,
    storage_path: storagePath,
    mime_type: opts.mimeType,
    size_bytes: opts.buffer.byteLength,
    include_in_email: true,
    uploaded_by: opts.uploadedBy,
  };

  const { data, error: insertError } = await supabase
    .from("invoice_attachments")
    .insert(row)
    .select()
    .single();

  if (insertError || !data) {
    await supabase.storage.from(ATTACHMENT_BUCKET).remove([storagePath]).catch(() => undefined);
    throw new Error(`[invoice-attachments] metadata insert failed: ${insertError?.message}`);
  }

  return data as AttachmentRecord;
}

/** List non-archived attachments for an event. */
export async function listAttachments(googleEventId: string): Promise<AttachmentRecord[]> {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("invoice_attachments")
    .select("*")
    .eq("google_event_id", googleEventId)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`[invoice-attachments] list failed: ${error.message}`);
  return (data ?? []) as AttachmentRecord[];
}

/** Update the include_in_email flag for an attachment. */
export async function setAttachmentEmailFlag(id: string, includeInEmail: boolean): Promise<void> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase
    .from("invoice_attachments")
    .update({ include_in_email: includeInEmail })
    .eq("id", id)
    .is("archived_at", null);
  if (error) throw new Error(`[invoice-attachments] update failed: ${error.message}`);
}

/** Soft-delete an attachment (sets archived_at). Does not remove from Storage. */
export async function archiveAttachment(id: string): Promise<void> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase
    .from("invoice_attachments")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`[invoice-attachments] archive failed: ${error.message}`);
}

/**
 * Create a short-lived signed URL for downloading an attachment.
 * Never expose permanent public URLs for receipt files.
 * Returns null if the attachment is not found or archived.
 */
export async function getAttachmentSignedUrl(
  id: string,
  expiresInSeconds = 3600,
): Promise<string | null> {
  const supabase = getSupabaseServerClient();

  const { data: record, error: fetchError } = await supabase
    .from("invoice_attachments")
    .select("storage_path, archived_at")
    .eq("id", id)
    .single();
  if (fetchError || !record || (record as AttachmentRecord).archived_at) return null;

  const { data: urlData, error: urlError } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl((record as AttachmentRecord).storage_path, expiresInSeconds);
  if (urlError || !urlData?.signedUrl) return null;

  return urlData.signedUrl;
}

// ---------------------------------------------------------------------------
// Receipt appendix types and page builder
// ---------------------------------------------------------------------------

/**
 * Data for one receipt appendix page in the invoice PDF.
 * Exported so lib/invoice-pdf.tsx and both PDF-generation routes share this type
 * without circular imports.
 */
export interface ReceiptPageData {
  /** Attachment DB id — used as React key in the PDF Document */
  id: string;
  /** MIME type of the original file */
  mimeType: string;
  /** Base64 data URL for embeddable images (JPEG/PNG/WEBP/GIF), null for PDF/HEIC */
  imageDataUrl: string | null;
  /**
   * Raw PDF bytes for PDF receipts that were successfully downloaded.
   * Non-null only when mimeType is "application/pdf" and the download succeeded.
   * These pages are merged into the invoice PDF packet after react-pdf rendering,
   * so they do not appear as placeholder pages in the appendix.
   * null for image receipts, HEIC receipts, or PDF receipts where download failed.
   */
  pdfBytes: Buffer | null;
  /** YYYY-MM-DD from receipt_date column; null when no receipt date was explicitly saved */
  receiptDate: string | null;
  /** la_job_number stored on the attachment record */
  laJobNumber: string | null;
  /** receipt_category from the attachment record */
  category: string | null;
  /** receipt_amount from the attachment record */
  amount: number | null;
  /** Original filename, shown on placeholder pages */
  originalFilename: string;
}

// react-pdf Image supports JPEG, PNG, WEBP, GIF; HEIC/HEIF and PDF fall back to placeholder pages.
const EMBEDDABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * Re-encode a receipt image into a plain baseline sRGB JPEG before handing it to
 * react-pdf's <Image>. react-pdf's internal JPEG parser (the `jay-peg` package)
 * hardcodes a fixed 16-byte read for the APP0/JFIF segment and never consumes
 * its own declared segment length past that — so any legally-longer JFIF
 * segment (common from camera/export tools; confirmed on real receipt photos)
 * desyncs its marker scan and it throws "Unknown version N" trying to parse
 * scan bytes as a marker. react-pdf swallows that per-image and renders
 * nothing — no error, no placeholder text, just a blank appendix page.
 * Normalizing here re-encodes with a clean, minimal JFIF header that avoids
 * the bug entirely (rotate applies EXIF orientation then strips it;
 * toColorspace flattens to sRGB). Falls back to the original bytes if sharp
 * itself fails. See tests/invoice-receipt-image-embed.test.ts for a
 * deterministic repro/regression test, and lib/invoice-pdf.tsx's
 * verifyImageReceiptsEmbedded() for the fail-closed backstop.
 */
async function normalizeReceiptImage(buf: Buffer, mimeType: string, id: string): Promise<string> {
  try {
    const normalized = await sharp(buf)
      .rotate()
      .toColorspace("srgb")
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90, progressive: false })
      .toBuffer();
    return `data:image/jpeg;base64,${normalized.toString("base64")}`;
  } catch (e) {
    console.warn(`[invoice-attachments] image normalize failed for ${id}, using original bytes (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return `data:${mimeType};base64,${buf.toString("base64")}`;
  }
}

/**
 * Fetch included receipt attachments for an event and build ReceiptPageData for
 * each one.  Used by PDF, email, and Gmail Draft routes so each generates the
 * same full invoice packet. When older attachment rows are missing LA metadata,
 * fallbackLaJobNumber keeps the appendix header tied to the invoice/job.
 *
 * Non-fatal per-file: download errors produce a placeholder page (imageDataUrl null)
 * rather than aborting the whole PDF.
 */
export async function getReceiptPagesForPdf(
  googleEventId: string,
  fallbackLaJobNumber: string | null = null,
): Promise<ReceiptPageData[]> {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from("invoice_attachments")
    .select("id, storage_path, mime_type, original_filename, la_job_number, receipt_date, receipt_category, receipt_amount, created_at")
    .eq("google_event_id", googleEventId)
    .eq("include_in_email", true)
    .is("archived_at", null)
    .order("created_at", { ascending: true });

  if (error) {
    console.warn(`[invoice-attachments] receipt page fetch failed (non-fatal): ${error.message}`);
    return [];
  }

  const pages: ReceiptPageData[] = [];

  for (const rec of (data ?? []) as Array<{
    id: string;
    storage_path: string;
    mime_type: string;
    original_filename: string;
    la_job_number: string | null;
    receipt_date: string | null;
    receipt_category: string | null;
    receipt_amount: number | null;
    created_at: string;
  }>) {
    const canEmbed = EMBEDDABLE_IMAGE_TYPES.has(rec.mime_type);
    const isPdf    = rec.mime_type === "application/pdf";
    let imageDataUrl: string | null = null;
    let pdfBytes:     Buffer | null = null;

    if (canEmbed) {
      const { data: fileData, error: dlErr } = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .download(rec.storage_path);
      if (dlErr || !fileData) {
        console.warn(`[invoice-attachments] receipt download failed for ${rec.id} (non-fatal): ${dlErr?.message ?? "no data"}`);
      } else {
        const buf = Buffer.from(await fileData.arrayBuffer());
        imageDataUrl = await normalizeReceiptImage(buf, rec.mime_type, rec.id);
      }
    } else if (isPdf) {
      // Download PDF bytes so they can be merged into the invoice packet.
      // Failure is non-fatal: the receipt gets a "could not be embedded" placeholder page.
      const { data: fileData, error: dlErr } = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .download(rec.storage_path);
      if (dlErr || !fileData) {
        console.warn(`[invoice-attachments] PDF receipt download failed for ${rec.id} (non-fatal): ${dlErr?.message ?? "no data"}`);
      } else {
        pdfBytes = Buffer.from(await fileData.arrayBuffer());
      }
    }

    pages.push({
      id:               rec.id,
      mimeType:         rec.mime_type,
      imageDataUrl,
      pdfBytes,
      // Only show an explicitly saved receipt date. Do not invent one from upload/today.
      receiptDate:      rec.receipt_date,
      laJobNumber:      rec.la_job_number || fallbackLaJobNumber,
      category:         rec.receipt_category,
      amount:           rec.receipt_amount,
      originalFilename: rec.original_filename,
    });
  }

  return pages;
}

/** Update metadata fields for an attachment (any subset of fields). */
export async function updateAttachmentMetadata(
  id: string,
  fields: Partial<{
    include_in_email: boolean;
    receipt_date: string | null;
    receipt_category: string | null;
    receipt_amount: number | null;
  }>,
): Promise<void> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase
    .from("invoice_attachments")
    .update(fields)
    .eq("id", id)
    .is("archived_at", null);
  if (error) throw new Error(`[invoice-attachments] update failed: ${error.message}`);
}

/**
 * Get all email-included attachments for an event, with their bytes.
 * Used by the email route when sending invoices.
 */
export async function getEmailAttachments(googleEventId: string): Promise<{
  attachments: Array<{ buffer: Buffer; filename: string; mimeType: string; id: string }>;
  missingIds: string[];
}> {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from("invoice_attachments")
    .select("id, storage_path, original_filename, mime_type")
    .eq("google_event_id", googleEventId)
    .eq("include_in_email", true)
    .is("archived_at", null)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`[invoice-attachments] email fetch failed: ${error.message}`);

  const records = (data ?? []) as Array<{
    id: string;
    storage_path: string;
    original_filename: string;
    mime_type: string;
  }>;

  const attachments: Array<{ buffer: Buffer; filename: string; mimeType: string; id: string }> = [];
  const missingIds: string[] = [];

  for (const rec of records) {
    const { data: fileData, error: dlErr } = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .download(rec.storage_path);

    if (dlErr || !fileData) {
      missingIds.push(rec.id);
      continue;
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());
    attachments.push({
      id: rec.id,
      buffer,
      filename: rec.original_filename,
      mimeType: rec.mime_type,
    });
  }

  return { attachments, missingIds };
}
