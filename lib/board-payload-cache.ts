import "server-only";
import type { BoardWindowPayload } from "./board-window";
import {
  deleteBoardPayloadCache as deleteBoardPayloadCacheFromSupabase,
  readBoardPayloadCache as readBoardPayloadCacheFromSupabase,
  type BoardPayloadCacheKey,
  type BoardPayloadCacheRecord,
  writeBoardPayloadCache as writeBoardPayloadCacheToSupabase,
} from "./board-payload-cache-supabase";

function isFeatureEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

export function isBoardCacheEnabled(): boolean {
  return isFeatureEnabled(process.env.BOARD_CACHE_ENABLED);
}

export function resolveBoardPayloadEditorBucket(editorId: string | null): string {
  const normalized = editorId?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : "public";
}

export type { BoardPayloadCacheKey, BoardPayloadCacheRecord };

export async function readBoardPayloadCache(
  key: BoardPayloadCacheKey,
): Promise<BoardPayloadCacheRecord | null> {
  if (!isBoardCacheEnabled()) return null;

  try {
    return await readBoardPayloadCacheFromSupabase(key);
  } catch (err) {
    console.error("[board-cache] read failed; bypassing cache.", err);
    return null;
  }
}

export async function writeBoardPayloadCache(
  key: BoardPayloadCacheKey,
  payload: BoardWindowPayload,
): Promise<void> {
  if (!isBoardCacheEnabled()) return;

  try {
    await writeBoardPayloadCacheToSupabase(key, payload);
  } catch (err) {
    console.error("[board-cache] write failed; continuing without cache.", err);
  }
}

export async function deleteBoardPayloadCache(
  key: BoardPayloadCacheKey,
): Promise<void> {
  if (!isBoardCacheEnabled()) return;

  try {
    await deleteBoardPayloadCacheFromSupabase(key);
  } catch (err) {
    console.error("[board-cache] delete failed; continuing without cache.", err);
  }
}
