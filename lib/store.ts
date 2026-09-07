import {
  readCurrentSnapshot as readCurrentSnapshotFromBlobs,
  type ReadSnapshotOptions,
  writeCurrentSnapshot as writeCurrentSnapshotToBlobs,
} from "./store-blobs";
import {
  readCurrentSnapshot as readCurrentSnapshotFromSupabase,
  writeCurrentSnapshot as writeCurrentSnapshotToSupabase,
} from "./store-supabase";
import type { Snapshot } from "./types";

function isFeatureEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function isSupabaseReadsEnabled(): boolean {
  return isFeatureEnabled(process.env.SUPABASE_READS_ENABLED);
}

function isSupabaseWritesEnabled(): boolean {
  return isFeatureEnabled(process.env.SUPABASE_WRITES_ENABLED);
}

function parseGeneratedAtMs(snapshot: Snapshot | null): number | null {
  if (!snapshot) return null;
  const parsed = Date.parse(snapshot.generatedAtUtc);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractSafeErrorDetails(err: unknown): { code?: string; message: string } {
  if (err instanceof Error) {
    const code = (() => {
      const asRecord = err as unknown as Record<string, unknown>;
      return typeof asRecord.code === "string" ? asRecord.code : undefined;
    })();
    return { ...(code ? { code } : {}), message: err.message };
  }
  if (typeof err === "object" && err) {
    const asRecord = err as Record<string, unknown>;
    const code = typeof asRecord.code === "string" ? asRecord.code : undefined;
    const message = typeof asRecord.message === "string"
      ? asRecord.message
      : String(err);
    return { ...(code ? { code } : {}), message };
  }
  return { message: String(err) };
}

export type { ReadSnapshotOptions };
export interface SnapshotWriteResult {
  supabaseWriteAttempted: boolean;
  supabaseWriteSucceeded: boolean;
  supabaseWriteErrorCode?: string;
  supabaseWriteErrorMessage?: string;
}

export async function readCurrentSnapshot(
  storeName: string,
  options: ReadSnapshotOptions = {},
): Promise<Snapshot | null> {
  if (isSupabaseReadsEnabled()) {
    // Both stores hold the same snapshot; we read them only to compare
    // `generatedAtUtc` and keep the newer one. The reads are independent, so
    // issue them concurrently — the pair then costs max(supabase, blobs)
    // instead of supabase + blobs. This sits on the critical path of every
    // /api/board/window request, so the saving is per page load.
    const [supabaseResult, blobsResult] = await Promise.allSettled([
      readCurrentSnapshotFromSupabase(storeName, options),
      readCurrentSnapshotFromBlobs(storeName, options),
    ]);

    // readCurrentSnapshotFromBlobs handles its own errors and resolves to
    // null, so a rejection here is unexpected — treat it as "no snapshot".
    const blobsSnapshot = blobsResult.status === "fulfilled" ? blobsResult.value : null;

    if (supabaseResult.status === "rejected") {
      console.error(
        "[snapshot] Supabase read failed; falling back to Netlify Blobs.",
        supabaseResult.reason,
      );
      return blobsSnapshot;
    }

    const supabaseSnapshot = supabaseResult.value;

    if (!supabaseSnapshot) {
      return blobsSnapshot;
    }
    if (!blobsSnapshot) {
      return supabaseSnapshot;
    }

    const supabaseGeneratedAtMs = parseGeneratedAtMs(supabaseSnapshot);
    const blobsGeneratedAtMs = parseGeneratedAtMs(blobsSnapshot);
    if (
      supabaseGeneratedAtMs === null
      || blobsGeneratedAtMs === null
      || supabaseGeneratedAtMs < blobsGeneratedAtMs
    ) {
      console.info(
        `[snapshot] Supabase snapshot stale; using Netlify Blobs fallback store=${storeName} supabaseGeneratedAt=${supabaseSnapshot.generatedAtUtc} blobsGeneratedAt=${blobsSnapshot.generatedAtUtc}`,
      );
      return blobsSnapshot;
    }

    return supabaseSnapshot;
  }

  return readCurrentSnapshotFromBlobs(storeName, options);
}

export async function writeCurrentSnapshot(
  storeName: string,
  snapshot: Snapshot,
): Promise<SnapshotWriteResult> {
  await writeCurrentSnapshotToBlobs(storeName, snapshot);
  const generatedAtUtc = snapshot.generatedAtUtc;
  if (!isSupabaseWritesEnabled()) {
    console.info(
      `[snapshot] Supabase write-through skipped enabled=false store=${storeName} generatedAtUtc=${generatedAtUtc}`,
    );
    return {
      supabaseWriteAttempted: false,
      supabaseWriteSucceeded: false,
    };
  }

  console.info(
    `[snapshot] Supabase write-through attempting enabled=true store=${storeName} generatedAtUtc=${generatedAtUtc}`,
  );

  try {
    await writeCurrentSnapshotToSupabase(storeName, snapshot);
    console.info(
      `[snapshot] Supabase write-through success store=${storeName} generatedAtUtc=${generatedAtUtc}`,
    );
    return {
      supabaseWriteAttempted: true,
      supabaseWriteSucceeded: true,
    };
  } catch (err) {
    // Blobs remains the primary write path in this migration stage.
    const safe = extractSafeErrorDetails(err);
    const codePart = safe.code ? ` code=${safe.code}` : "";
    console.error(
      `[snapshot] Supabase write-through failed; continuing with Netlify Blobs snapshot. store=${storeName} generatedAtUtc=${generatedAtUtc}${codePart} message=${safe.message}`,
    );
    return {
      supabaseWriteAttempted: true,
      supabaseWriteSucceeded: false,
      ...(safe.code ? { supabaseWriteErrorCode: safe.code } : {}),
      supabaseWriteErrorMessage: safe.message,
    };
  }
}
