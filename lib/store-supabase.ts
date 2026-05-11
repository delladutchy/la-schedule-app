import { SnapshotSchema, type Snapshot } from "./types";
import { getSupabaseServerClient } from "./supabase";
import type { ReadSnapshotOptions } from "./store-blobs";

const SNAPSHOT_CACHE_TABLE = "snapshot_cache";

interface SnapshotCacheRow {
  store_name: string;
  snapshot: unknown;
}

interface SupabaseQueryError {
  code?: string;
  message: string;
}

function createSupabaseStoreError(
  operation: "read" | "write",
  storeName: string,
  error: SupabaseQueryError,
): Error {
  const code = error.code ? ` code=${error.code}` : "";
  return new Error(
    `[snapshot:supabase] ${operation} failed store=${storeName}${code} message=${error.message}`,
  );
}

export async function readCurrentSnapshot(
  storeName: string,
  _options: ReadSnapshotOptions = {},
): Promise<Snapshot | null> {
  const client = getSupabaseServerClient();
  const { data, error } = await client
    .from(SNAPSHOT_CACHE_TABLE)
    .select("snapshot")
    .eq("store_name", storeName)
    .maybeSingle<Pick<SnapshotCacheRow, "snapshot">>();

  if (error) {
    // PostgREST uses PGRST116 for "no rows" in some response paths.
    if (error.code === "PGRST116") {
      return null;
    }
    throw createSupabaseStoreError("read", storeName, error);
  }
  if (!data) {
    return null;
  }

  const parsed = SnapshotSchema.safeParse(data.snapshot);
  if (!parsed.success) {
    console.error("[snapshot:supabase] parse failed:", parsed.error.message);
    return null;
  }
  return parsed.data;
}

export async function writeCurrentSnapshot(
  storeName: string,
  snapshot: Snapshot,
): Promise<void> {
  const parsed = SnapshotSchema.parse(snapshot);
  const client = getSupabaseServerClient();
  const { error } = await client
    .from(SNAPSHOT_CACHE_TABLE)
    .upsert({ store_name: storeName, snapshot: parsed }, { onConflict: "store_name" });

  if (error) {
    throw createSupabaseStoreError("write", storeName, error);
  }
}
