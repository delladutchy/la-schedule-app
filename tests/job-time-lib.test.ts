import { describe, expect, it } from "vitest";
import { normalizeWorkDate } from "@/lib/job-time";

describe("normalizeWorkDate", () => {
  it("returns YYYY-MM-DD unchanged", () => {
    expect(normalizeWorkDate("2026-05-18")).toBe("2026-05-18");
  });

  it("normalizes ISO datetime input to YYYY-MM-DD", () => {
    expect(normalizeWorkDate("2026-05-18T13:10:00.000Z")).toBe("2026-05-18");
  });

  it("rejects invalid calendar dates", () => {
    expect(normalizeWorkDate("2026-02-30")).toBeNull();
  });

  it("rejects malformed values", () => {
    expect(normalizeWorkDate("not-a-date")).toBeNull();
    expect(normalizeWorkDate("")).toBeNull();
  });
});
