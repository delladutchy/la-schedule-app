import type { EnvConfig } from "./config";

interface CreateJobNotificationInput {
  editorId: string;
  jobNumber?: string;
  jobTitle?: string;
  startDate?: string;
  endDate?: string;
  callTime?: string;
}

function titleCaseEditorId(editorId: string): string {
  if (!editorId) return "Editor";
  return editorId.charAt(0).toUpperCase() + editorId.slice(1);
}

function dateRangeLabel(startDate?: string, endDate?: string): string {
  if (!startDate) return "N/A";
  if (!endDate || endDate === startDate) return startDate;
  return `${startDate} to ${endDate}`;
}

export async function sendCreateJobNotification(
  env: Pick<EnvConfig, "RESEND_API_KEY" | "NOTIFY_EMAIL_TO" | "NOTIFY_EMAIL_FROM">,
  input: CreateJobNotificationInput,
): Promise<"sent" | "skipped"> {
  const apiKey = env.RESEND_API_KEY?.trim();
  const to = env.NOTIFY_EMAIL_TO?.trim();
  const from = env.NOTIFY_EMAIL_FROM?.trim();
  if (!apiKey || !to || !from) {
    return "skipped";
  }

  const editorName = titleCaseEditorId(input.editorId);
  const subject = `New LA job booked by ${editorName}`;
  const jobLine = input.jobNumber
    ? `${input.jobNumber}${input.jobTitle ? ` — ${input.jobTitle}` : ""}`
    : (input.jobTitle || "N/A");
  const text = [
    `Editor: ${editorName}`,
    `Job: ${jobLine}`,
    `Dates: ${dateRangeLabel(input.startDate, input.endDate)}`,
    `Call Time: ${input.callTime ?? "N/A"}`,
  ].join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const trimmed = bodyText.trim();
    throw new Error(
      `Resend email failed (${response.status})${trimmed ? `: ${trimmed.slice(0, 220)}` : ""}`,
    );
  }

  return "sent";
}
