/**
 * Sanitized BoardWindowPayload cache.
 *
 * Stores ONLY the same `BoardWindowPayload` shape that
 * `buildSanitizedBoardWindowPayload` returns to the browser today —
 * never raw `Snapshot` data. Each editor identity has its own bucket;
 * payloads can never cross editors even if the underlying storage is
 * tampered with, because every read re-validates the bucket field.
 *
 * Storage is best-effort:
 *   - Safari private mode and quota errors are swallowed silently.
 *   - Any parse / schema / cross-editor mismatch drops the bucket.
 *   - SSR is always the source of truth; this layer is a fallback.
 */

import { z } from "zod";
import type { BoardWindowPayload } from "./board-window";

export const BOARD_WINDOW_CACHE_SCHEMA_VERSION = 1;
export const BOARD_WINDOW_CACHE_LRU_CAP = 8;
export const BOARD_WINDOW_CACHE_KEY_PREFIX = "la-schedule-cache";

const KNOWN_BUCKETS = ["jeff", "legacy", "dave", "milos", "mike", "anon"] as const;
export type CacheBucket = typeof KNOWN_BUCKETS[number];
const BUCKET_SET = new Set<string>(KNOWN_BUCKETS);

/**
 * Resolve any editor id (or null) to a known cache bucket. Unknown ids
 * collapse to "anon" so a typo can never write into another editor's bucket.
 */
export function editorIdToBucket(resolvedEditorId: string | null | undefined): CacheBucket {
  const normalized = resolvedEditorId?.trim().toLowerCase() ?? "";
  return BUCKET_SET.has(normalized) ? (normalized as CacheBucket) : "anon";
}

// Loose validation of the cached payload shape — we only care about
// the fields we actually consume when restoring state. Other fields are
// passed through unchanged because they were already produced by the
// server-side sanitizer when the payload was minted.
const BoardWindowPayloadShape = z.object({
  status: z.literal("ok"),
  generatedAtUtc: z.string().min(1),
  resolvedEditorId: z.string().nullable(),
  selected: z.object({
    view: z.union([z.literal("list"), z.literal("month")]),
    weekStart: z.string().min(1),
    monthKey: z.string().min(1),
  }).passthrough(),
}).passthrough();

const CacheEntrySchema = z.object({
  schemaVersion: z.literal(BOARD_WINDOW_CACHE_SCHEMA_VERSION),
  bucket: z.string().min(1),
  updatedAtMs: z.number().finite(),
  items: z.record(z.string(), BoardWindowPayloadShape),
});

export interface CacheEntry {
  schemaVersion: typeof BOARD_WINDOW_CACHE_SCHEMA_VERSION;
  bucket: CacheBucket;
  updatedAtMs: number;
  items: Record<string, BoardWindowPayload>;
}

export interface CacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

function defaultStorage(): CacheStorage | null {
  try {
    if (typeof window === "undefined") return null;
    const ls = window.localStorage;
    if (!ls) return null;
    const probeKey = `${BOARD_WINDOW_CACHE_KEY_PREFIX}:probe`;
    ls.setItem(probeKey, "1");
    ls.removeItem(probeKey);
    return ls;
  } catch {
    return null;
  }
}

function buildKey(bucket: CacheBucket): string {
  return `${BOARD_WINDOW_CACHE_KEY_PREFIX}:v${BOARD_WINDOW_CACHE_SCHEMA_VERSION}:${bucket}`;
}

export function buildViewKey(payload: BoardWindowPayload): string {
  return `${payload.selected.view}:${payload.selected.weekStart}:${payload.selected.monthKey}`;
}

function safeRemove(storage: CacheStorage, key: string): void {
  try { storage.removeItem(key); } catch { /* ignore */ }
}

export function readCache(
  bucket: CacheBucket,
  storage: CacheStorage | null = defaultStorage(),
): CacheEntry | null {
  if (!storage) return null;
  const key = buildKey(bucket);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeRemove(storage, key);
    return null;
  }
  const result = CacheEntrySchema.safeParse(parsed);
  if (!result.success) {
    safeRemove(storage, key);
    return null;
  }
  if (result.data.bucket !== bucket) {
    // Defense in depth: a payload labelled with a different bucket
    // must never be served from this bucket's slot.
    safeRemove(storage, key);
    return null;
  }
  return result.data as unknown as CacheEntry;
}

export function writeCache(
  bucket: CacheBucket,
  payload: BoardWindowPayload,
  storage: CacheStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  if (payload.status !== "ok") return;
  // Hard guard: never store a payload whose resolved editor doesn't
  // match the bucket we're writing into. This prevents Mike's notes
  // from ever landing in Dave's bucket if a future caller wires the
  // helpers wrong.
  if (editorIdToBucket(payload.resolvedEditorId) !== bucket) return;

  const existing = readCache(bucket, storage);
  const viewKey = buildViewKey(payload);
  const items = mergeWithLruCap(existing?.items, viewKey, payload, BOARD_WINDOW_CACHE_LRU_CAP);

  const entry: CacheEntry = {
    schemaVersion: BOARD_WINDOW_CACHE_SCHEMA_VERSION,
    bucket,
    updatedAtMs: Date.now(),
    items,
  };
  try {
    storage.setItem(buildKey(bucket), JSON.stringify(entry));
  } catch {
    // Quota exceeded or storage gone — best-effort, ignore.
  }
}

export function clearCache(
  bucket: CacheBucket,
  storage: CacheStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  safeRemove(storage, buildKey(bucket));
}

export function clearAllCaches(
  storage: CacheStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    const toDelete: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k && k.startsWith(`${BOARD_WINDOW_CACHE_KEY_PREFIX}:`)) toDelete.push(k);
    }
    for (const k of toDelete) safeRemove(storage, k);
  } catch {
    // ignore
  }
}

/**
 * Return the cached payload for `viewKey` only when it is strictly newer
 * than the SSR payload, belongs to the same editor bucket, and has the
 * matching view selection. Anything else returns null and SSR wins.
 */
export function pickFreshestForView(
  entry: CacheEntry | null,
  bucket: CacheBucket,
  viewKey: string,
  ssrPayload: BoardWindowPayload,
): BoardWindowPayload | null {
  if (!entry) return null;
  if (entry.bucket !== bucket) return null;
  const cached = entry.items[viewKey];
  if (!cached) return null;
  if (editorIdToBucket(cached.resolvedEditorId) !== bucket) return null;
  if (buildViewKey(cached) !== viewKey) return null;
  if (cached.generatedAtUtc <= ssrPayload.generatedAtUtc) return null;
  return cached;
}

export function isHydrationPayloadCompatible(opts: {
  currentViewMode: "list" | "month";
  targetWeekStart?: string | null;
  targetMonthKey?: string | null;
  payload: BoardWindowPayload;
}): boolean {
  if (opts.payload.selected.view !== opts.currentViewMode) return false;
  const targetWeekStart = opts.targetWeekStart?.trim();
  const targetMonthKey = opts.targetMonthKey?.trim();
  // Match the active view's primary coordinate only:
  // - list/week view keys on `weekStart`
  // - month view keys on `monthKey`
  // This preserves cross-view/target protections without rejecting valid
  // month payloads when their companion `weekStart` differs.
  if (opts.currentViewMode === "list") {
    if (targetWeekStart && opts.payload.selected.weekStart !== targetWeekStart) return false;
    return true;
  }
  if (targetMonthKey && opts.payload.selected.monthKey !== targetMonthKey) return false;
  return true;
}

function mergeWithLruCap(
  prev: Record<string, BoardWindowPayload> | undefined,
  freshKey: string,
  freshValue: BoardWindowPayload,
  cap: number,
): Record<string, BoardWindowPayload> {
  // Insertion-order LRU: copy older entries skipping the just-written
  // key, then append the fresh value at the end. The newest entry is
  // therefore always last, and overflow is dropped from the front.
  const out: Record<string, BoardWindowPayload> = {};
  if (prev) {
    for (const [k, v] of Object.entries(prev)) {
      if (k !== freshKey) out[k] = v;
    }
  }
  out[freshKey] = freshValue;

  const keys = Object.keys(out);
  if (keys.length <= cap) return out;
  const drop = keys.length - cap;
  const trimmed: Record<string, BoardWindowPayload> = {};
  for (let i = drop; i < keys.length; i += 1) {
    const k = keys[i] as string;
    trimmed[k] = out[k] as BoardWindowPayload;
  }
  return trimmed;
}
