/**
 * Tests for the verify-pipeline fetch timeout (InvoiceSection.tsx).
 *
 * Regression: "Verify buttons remain stuck showing 'Verifying…'" — the PDF
 * regen / sheet sync fetches inside runVerifiedPipeline had no timeout, so a
 * hung serverless response left verifyState stuck at "verifying" forever.
 * fetchWithTimeout aborts a hung request instead of waiting indefinitely,
 * which lets the caller's existing try/catch move the state to "failed".
 *
 * Mirrors the (module-private) helper in components/InvoiceSection.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

describe("fetchWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves normally when the underlying fetch responds before the timeout", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await fetchWithTimeout("/api/x", {}, 45_000, mockFetch);
    expect(res.status).toBe(200);
  });

  it("aborts a hung request once the timeout elapses, instead of waiting forever", async () => {
    const hungFetch = vi.fn((_input: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const err = new DOMException("The operation was aborted.", "AbortError");
          reject(err);
        });
      });
    });

    const promise = fetchWithTimeout("/api/x", {}, 45_000, hungFetch as unknown as typeof fetch);
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });

    await vi.advanceTimersByTimeAsync(45_000);
    await assertion;
  });

  it("does not fire the abort after a fast response (no dangling timer side effects)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await fetchWithTimeout("/api/x", {}, 45_000, mockFetch);
    expect(res.status).toBe(200);
    // Advancing time after resolution must not throw or reject anything further.
    await vi.advanceTimersByTimeAsync(45_000);
  });
});
