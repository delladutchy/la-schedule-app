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

export async function readCurrentSnapshot(
  storeName: string,
  options: ReadSnapshotOptions = {},
): Promise<Snapshot | null> {
  if (isSupabaseReadsEnabled()) {
    try {
      const supabaseSnapshot = await readCurrentSnapshotFromSupabase(storeName, options);
      if (supabaseSnapshot) {
        return supabaseSnapshot;
      }
    } catch (err) {
      console.error(
        "[snapshot] Supabase read failed; falling back to Netlify Blobs.",
        err,
      );
    }
  }

  return readCurrentSnapshotFromBlobs(storeName, options);
}

export async function writeCurrentSnapshot(
  storeName: string,
  snapshot: Snapshot,
): Promise<void> {
  await writeCurrentSnapshotToBlobs(storeName, snapshot);
  const generatedAtUtc = snapshot.generatedAtUtc;
  if (!isSupabaseWritesEnabled()) {
    console.info(
      `[snapshot] Supabase write-through skipped enabled=false store=${storeName} generatedAtUtc=${generatedAtUtc}`,
    );
    return;
  }

  console.info(
    `[snapshot] Supabase write-through attempting enabled=true store=${storeName} generatedAtUtc=${generatedAtUtc}`,
  );

  try {
    await writeCurrentSnapshotToSupabase(storeName, snapshot);
    console.info(
      `[snapshot] Supabase write-through success store=${storeName} generatedAtUtc=${generatedAtUtc}`,
    );
  } catch (err) {
    // Blobs remains the primary write path in this migration stage.
    const safe = extractSafeErrorDetails(err);
    const codePart = safe.code ? ` code=${safe.code}` : "";
    console.error(
      `[snapshot] Supabase write-through failed; continuing with Netlify Blobs snapshot. store=${storeName} generatedAtUtc=${generatedAtUtc}${codePart} message=${safe.message}`,
    );
  }
}
