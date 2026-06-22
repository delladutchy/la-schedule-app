import "server-only";
import { google } from "googleapis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GmailAttachment {
  filename: string;
  content: Buffer;
  mimeType: string;
}

export interface GmailDraftOptions {
  clientId: string;
  clientSecret: string;
  gmailRefreshToken: string;
  /** RFC 5322 From header, e.g. "Jeff Ulsh <jeffulsh@gmail.com>" */
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  htmlBody: string;
  attachments: GmailAttachment[];
}

export interface GmailDraftResult {
  draftId: string;
  messageId: string;
  threadId: string | null;
  /** Deep link into Gmail drafts for this message. */
  draftUrl: string;
}

// ---------------------------------------------------------------------------
// MIME builder (exported for unit tests)
// ---------------------------------------------------------------------------

/** Wrap a subject in RFC 2047 UTF-8 encoded-word only when non-ASCII chars are present. */
function encodeSubject(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

/**
 * Build a raw RFC 2822 MIME message suitable for the Gmail API `raw` field.
 *
 * Pass explicit `boundaries` in tests to get deterministic output;
 * in production, omit them and unique boundaries are generated automatically.
 */
export function buildMimeMessage(
  opts: Omit<GmailDraftOptions, "clientId" | "clientSecret" | "gmailRefreshToken">,
  boundaries?: { mixed: string; alt: string },
): string {
  const b = boundaries ?? {
    mixed: `mix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    alt:   `alt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  };

  const headers = [
    "MIME-Version: 1.0",
    `From: ${opts.from}`,
    `To: ${opts.to.join(", ")}`,
    ...(opts.cc && opts.cc.length > 0 ? [`Cc: ${opts.cc.join(", ")}`] : []),
    ...(opts.bcc && opts.bcc.length > 0 ? [`Bcc: ${opts.bcc.join(", ")}`] : []),
    `Subject: ${encodeSubject(opts.subject)}`,
    `Content-Type: multipart/mixed; boundary="${b.mixed}"`,
  ];

  // multipart/alternative: plain text + HTML
  const altPart = [
    `Content-Type: multipart/alternative; boundary="${b.alt}"`,
    "",
    `--${b.alt}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    "",
    opts.textBody,
    "",
    `--${b.alt}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    "",
    opts.htmlBody,
    "",
    `--${b.alt}--`,
  ];

  const lines: string[] = [
    ...headers,
    "",
    `--${b.mixed}`,
    ...altPart,
  ];

  for (const att of opts.attachments) {
    // RFC 2045: base64 lines must not exceed 76 chars.
    const b64Lines = att.content.toString("base64").match(/.{1,76}/g) ?? [];
    lines.push(
      `--${b.mixed}`,
      `Content-Type: ${att.mimeType}; name="${att.filename}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      "",
      ...b64Lines,
      "",
    );
  }

  lines.push(`--${b.mixed}--`);

  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// Gmail API
// ---------------------------------------------------------------------------

export async function createGmailDraft(opts: GmailDraftOptions): Promise<GmailDraftResult> {
  const auth = new google.auth.OAuth2(opts.clientId, opts.clientSecret);
  auth.setCredentials({ refresh_token: opts.gmailRefreshToken });

  const gmail = google.gmail({ version: "v1", auth });

  const mimeRaw = buildMimeMessage(opts);
  // Gmail API requires base64url encoding (no padding, - and _ instead of + and /).
  const rawField = Buffer.from(mimeRaw).toString("base64url");

  const response = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw: rawField } },
  });

  const draftId = response.data.id;
  const messageId = response.data.message?.id;
  const threadId = response.data.message?.threadId ?? null;

  if (!draftId || !messageId) {
    throw new Error("[gmail-draft] API returned no draft id or message id");
  }

  return {
    draftId,
    messageId,
    threadId: threadId ?? null,
    // Deep-link to the specific draft message in Gmail.
    draftUrl: `https://mail.google.com/mail/#drafts/${messageId}`,
  };
}
