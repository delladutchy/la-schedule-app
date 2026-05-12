import { describe, expect, it } from "vitest";
import {
  classifyGoogleError,
  CALENDAR_AUTH_FAILED_MESSAGE,
  CALENDAR_RATE_LIMIT_MESSAGE,
} from "@/lib/google-error";

describe("classifyGoogleError", () => {
  describe("isRateLimit", () => {
    it("detects exact quota exceeded message from Google Calendar API", () => {
      const err = new Error(
        "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'calendar-json.googleapis.com' for consumer 'project_number:123456789'.",
      );
      const cls = classifyGoogleError(err);
      expect(cls.isRateLimit).toBe(true);
      expect(cls.isAuthFailure).toBe(false);
    });

    it("detects rateLimitExceeded", () => {
      expect(classifyGoogleError(new Error("rateLimitExceeded")).isRateLimit).toBe(true);
    });

    it("detects userRateLimitExceeded", () => {
      expect(classifyGoogleError(new Error("userRateLimitExceeded")).isRateLimit).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(classifyGoogleError(new Error("QUOTA EXCEEDED")).isRateLimit).toBe(true);
      expect(classifyGoogleError(new Error("RateLimitExceeded")).isRateLimit).toBe(true);
    });

    it("does not flag auth errors as rate limit", () => {
      const cls = classifyGoogleError(new Error("invalid_grant"));
      expect(cls.isRateLimit).toBe(false);
      expect(cls.isAuthFailure).toBe(true);
    });

    it("does not flag generic network errors as rate limit", () => {
      const cls = classifyGoogleError(new Error("ECONNRESET"));
      expect(cls.isRateLimit).toBe(false);
      expect(cls.isAuthFailure).toBe(false);
    });

    it("handles non-Error values", () => {
      expect(classifyGoogleError("quota exceeded").isRateLimit).toBe(true);
      expect(classifyGoogleError("some string").isRateLimit).toBe(false);
      expect(classifyGoogleError(null).isRateLimit).toBe(false);
    });
  });

  describe("isAuthFailure", () => {
    it("detects invalid_grant", () => {
      expect(classifyGoogleError(new Error("invalid_grant")).isAuthFailure).toBe(true);
    });

    it("detects invalid_client", () => {
      expect(classifyGoogleError(new Error("invalid_client")).isAuthFailure).toBe(true);
    });

    it("detects unauthorized_client", () => {
      expect(classifyGoogleError(new Error("unauthorized_client")).isAuthFailure).toBe(true);
    });
  });

  describe("raw", () => {
    it("returns the error message string", () => {
      expect(classifyGoogleError(new Error("some error")).raw).toBe("some error");
    });

    it("stringifies non-Error values", () => {
      expect(classifyGoogleError("raw string").raw).toBe("raw string");
    });
  });
});

describe("CALENDAR_RATE_LIMIT_MESSAGE", () => {
  it("does not contain raw quota text or project identifiers", () => {
    expect(CALENDAR_RATE_LIMIT_MESSAGE).not.toMatch(/quota/i);
    expect(CALENDAR_RATE_LIMIT_MESSAGE).not.toMatch(/project_number/i);
    expect(CALENDAR_RATE_LIMIT_MESSAGE).not.toMatch(/googleapis/i);
  });

  it("tells the user to wait and try again", () => {
    expect(CALENDAR_RATE_LIMIT_MESSAGE).toMatch(/wait/i);
    expect(CALENDAR_RATE_LIMIT_MESSAGE).toMatch(/try again/i);
  });
});

describe("CALENDAR_AUTH_FAILED_MESSAGE", () => {
  it("is defined and non-empty", () => {
    expect(typeof CALENDAR_AUTH_FAILED_MESSAGE).toBe("string");
    expect(CALENDAR_AUTH_FAILED_MESSAGE.length).toBeGreaterThan(0);
  });
});
