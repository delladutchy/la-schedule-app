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
  if (!isSupabaseWritesEnabled()) return;

  try {
    await writeCurrentSnapshotToSupabase(storeName, snapshot);
  } catch (err) {
    // Blobs remains the primary write path in this migration stage.
    console.error(
      "[snapshot] Supabase write-through failed; continuing with Netlify Blobs snapshot.",
      err,
    );
  }
}
