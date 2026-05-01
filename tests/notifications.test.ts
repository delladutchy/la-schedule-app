import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendCreateJobNotification } from "@/lib/notifications";

const fetchMock = vi.fn();

const env = {
  RESEND_API_KEY: "resend-key",
  NOTIFY_EMAIL_TO: "jeff@example.com",
  NOTIFY_EMAIL_FROM: "la-schedule@example.com",
};

describe("sendCreateJobNotification", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses LA wording by default", async () => {
    const result = await sendCreateJobNotification(env, {
      editorId: "dave",
      bookingMode: "la",
      jobNumber: "12345",
      jobTitle: "Flower Market",
      startDate: "2026-05-07",
      endDate: "2026-05-08",
      callTime: "8:00 AM",
    });

    expect(result).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body)) as {
      subject: string;
      text: string;
    };
    expect(body.subject).toBe("New LA job booked by Dave");
    expect(body.text).toContain("Job: 12345 — Flower Market");
  });

  it("uses Overture wording for overture bookings", async () => {
    const result = await sendCreateJobNotification(env, {
      editorId: "mike",
      bookingMode: "overture",
      startDate: "2026-05-09",
      endDate: "2026-05-09",
    });

    expect(result).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body)) as {
      subject: string;
      text: string;
    };
    expect(body.subject).toBe("New Overture booking by Mike");
    expect(body.text).toContain("Booking: Overture");
    expect(body.subject).not.toContain("LA job");
  });
});
