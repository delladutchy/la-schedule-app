import { describe, it, expect } from "vitest";
import { normalizeLaNumber } from "@/lib/la-number";

describe("normalizeLaNumber", () => {
  it("passes bare digits through unchanged", () => {
    expect(normalizeLaNumber("72813")).toBe("72813");
  });

  it("strips a 'LA#' prefix", () => {
    expect(normalizeLaNumber("LA#72813")).toBe("72813");
  });

  it("strips a 'LA #' (spaced) prefix", () => {
    expect(normalizeLaNumber("LA #72813")).toBe("72813");
  });

  it("strips a lowercase 'la#' prefix", () => {
    expect(normalizeLaNumber("la#72813")).toBe("72813");
  });

  it("does not duplicate the prefix on an already-normalized value", () => {
    expect(normalizeLaNumber(normalizeLaNumber("LA#72813")!)).toBe("72813");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeLaNumber("  72813  ")).toBe("72813");
  });

  it("returns null for null input", () => {
    expect(normalizeLaNumber(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(normalizeLaNumber(undefined)).toBeNull();
  });

  it("returns null for empty string, never a '0000' placeholder", () => {
    expect(normalizeLaNumber("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(normalizeLaNumber("   ")).toBeNull();
  });
});
