import "server-only";
import type { BoardWindowPayload } from "./board-window";
import { getSupabaseServerClient } from "./supabase";

const BOARD_PAYLOAD_CACHE_TABLE = "board_payload_cache";

export interface BoardPayloadCacheKey {
  viewMode: "list" | "month";
  weekStart: string;
  monthKey: string;
  editorBucket: string;
  scope: "selected" | "full";
}

export interface BoardPayloadCacheRecord {
  payload: BoardWindowPayload;
  generatedAtUtc: string;
}

interface BoardPayloadCacheRow {
  view_mode: string;
  week_start: string;
  month_key: string;
  editor_bucket: string;
  scope: string;
  payload: unknown;
  generated_at_utc: string;
}

interface SupabaseQueryError {
  code?: string;
  message: string;
}

function createBoardCacheError(
  operation: "read" | "write" | "delete",
  key: BoardPayloadCacheKey,
  error: SupabaseQueryError,
): Error {
  const code = error.code ? ` code=${error.code}` : "";
  return new Error(
    `[board-cache:supabase] ${operation} failed view=${key.viewMode} week=${key.weekStart} month=${key.monthKey} editor=${key.editorBucket} scope=${key.scope}${code} message=${error.message}`,
  );
}

function isBoardPayload(value: unknown): value is BoardWindowPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { status?: unknown; generatedAtUtc?: unknown };
  return candidate.status === "ok" && typeof candidate.generatedAtUtc === "string";
}

export async function readBoardPayloadCache(
  key: BoardPayloadCacheKey,
): Promise<BoardPayloadCacheRecord | null> {
  const client = getSupabaseServerClient();
  const { data, error } = await client
    .from(BOARD_PAYLOAD_CACHE_TABLE)
    .select("payload,generated_at_utc")
    .eq("view_mode", key.viewMode)
    .eq("week_start", key.weekStart)
    .eq("month_key", key.monthKey)
    .eq("editor_bucket", key.editorBucket)
    .eq("scope", key.scope)
    .maybeSingle<Pick<BoardPayloadCacheRow, "payload" | "generated_at_utc">>();

  if (error) {
    // PostgREST may return this for singular queries with no rows.
    if (error.code === "PGRST116") return null;
    throw createBoardCacheError("read", key, error);
  }
  if (!data || !isBoardPayload(data.payload)) {
    return null;
  }

  return {
    payload: data.payload,
    generatedAtUtc: data.generated_at_utc,
  };
}

export async function writeBoardPayloadCache(
  key: BoardPayloadCacheKey,
  payload: BoardWindowPayload,
): Promise<void> {
  const client = getSupabaseServerClient();
  const { error } = await client
    .from(BOARD_PAYLOAD_CACHE_TABLE)
    .upsert(
      {
        view_mode: key.viewMode,
        week_start: key.weekStart,
        month_key: key.monthKey,
        editor_bucket: key.editorBucket,
        scope: key.scope,
        payload,
        generated_at_utc: payload.generatedAtUtc,
      },
      { onConflict: "view_mode,week_start,month_key,editor_bucket,scope" },
    );

  if (error) {
    throw createBoardCacheError("write", key, error);
  }
}

export async function deleteBoardPayloadCache(
  key: BoardPayloadCacheKey,
): Promise<void> {
  const client = getSupabaseServerClient();
  const { error } = await client
    .from(BOARD_PAYLOAD_CACHE_TABLE)
    .delete()
    .eq("view_mode", key.viewMode)
    .eq("week_start", key.weekStart)
    .eq("month_key", key.monthKey)
    .eq("editor_bucket", key.editorBucket)
    .eq("scope", key.scope);

  if (error) {
    throw createBoardCacheError("delete", key, error);
  }
}
