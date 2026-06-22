/**
 * Tests for lib/invoice-attachments.ts real implementation.
 *
 * Verifies:
 *   - ensureAttachmentBucket is idempotent (no throw on "already exists")
 *   - ensureAttachmentBucket throws on unexpected storage errors
 *   - ensureAttachmentBucket succeeds when bucket is freshly created
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist the createBucket mock so it can be referenced in vi.mock ────────────

const createBucket = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase", () => ({
  getSupabaseServerClient: () => ({
    storage: { createBucket },
  }),
}));

// No mock of @/lib/invoice-attachments — we test the real implementation.

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureAttachmentBucket: idempotent on already-exists", () => {
  it("does not throw when Supabase reports bucket already exists", async () => {
    createBucket.mockResolvedValue({
      error: { message: "The resource already exists" },
    });
    const { ensureAttachmentBucket } = await import("@/lib/invoice-attachments");
    await expect(ensureAttachmentBucket()).resolves.not.toThrow();
  });

  it("does not throw when bucket is created successfully (no error)", async () => {
    createBucket.mockResolvedValue({ error: null });
    const { ensureAttachmentBucket } = await import("@/lib/invoice-attachments");
    await expect(ensureAttachmentBucket()).resolves.not.toThrow();
  });

  it("throws when bucket creation fails for an unexpected reason", async () => {
    createBucket.mockResolvedValue({
      error: { message: "network timeout" },
    });
    const { ensureAttachmentBucket } = await import("@/lib/invoice-attachments");
    await expect(ensureAttachmentBucket()).rejects.toThrow("bucket create failed");
  });

  it("passes correct options: public=false and 20 MB limit", async () => {
    createBucket.mockResolvedValue({ error: null });
    const { ensureAttachmentBucket, ATTACHMENT_BUCKET, MAX_ATTACHMENT_BYTES } =
      await import("@/lib/invoice-attachments");

    await ensureAttachmentBucket();

    expect(createBucket).toHaveBeenCalledWith(
      ATTACHMENT_BUCKET,
      expect.objectContaining({
        public: false,
        fileSizeLimit: MAX_ATTACHMENT_BYTES,
      }),
    );
  });
});
