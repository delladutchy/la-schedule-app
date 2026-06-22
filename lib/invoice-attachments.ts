import "server-only";
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
