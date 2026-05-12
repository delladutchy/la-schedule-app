import "server-only";
import {
  BOARD_WINDOW_FULL_DEFAULTS,
  buildSanitizedBoardWindowPayload,
  type BoardWindowQuery,
} from "./board-window";
import {
  resolveBoardPayloadEditorBucket,
  writeBoardPayloadCache,
} from "./board-payload-cache";
import type { EnvConfig, FileConfig } from "./config";
import type { Snapshot } from "./types";

type ViewMode = "list" | "month";
type CacheScope = "selected" | "full";

const PRECOMPUTE_VIEW_MODES: readonly ViewMode[] = ["list", "month"] as const;
const PRECOMPUTE_SCOPES: readonly CacheScope[] = ["selected", "full"] as const;
const PRECOMPUTE_EDITOR_IDS: readonly (string | null)[] = [
  null,
  "legacy",
  "jeff",
  "dave",
  "milos",
  "mike",
] as const;
const PUBLIC_ANON_BUCKET_ALIAS = "anon";

export interface PrecomputeBoardPayloadCacheOptions {
  snapshot: Snapshot;
  file: Pick<FileConfig, "timezone" | "workdayStartHour" | "workdayEndHour">;
  env: Pick<EnvConfig, "GOOGLE_CALENDAR_ID" | "OVERTURE_CALENDAR_ID">;
  nowMs?: number;
  scopes?: readonly CacheScope[];
}

export interface PrecomputeBoardPayloadCacheResult {
  attempted: number;
  written: number;
  failed: number;
}

interface EditorTarget {
  resolvedEditorId: string | null;
  editorBucket: string;
}

function buildPrecomputeQuery(viewMode: ViewMode, scope: CacheScope): BoardWindowQuery {
  if (scope === "selected") {
    return {
      viewMode,
      requestedWeek: null,
      requestedMonth: null,
      weeksBefore: 0,
      weeksAfter: 0,
      monthsBefore: 0,
      monthsAfter: 0,
      scope: "selected",
    };
  }

  return {
    viewMode,
    requestedWeek: null,
    requestedMonth: null,
    weeksBefore: BOARD_WINDOW_FULL_DEFAULTS.weeksBefore,
    weeksAfter: BOARD_WINDOW_FULL_DEFAULTS.weeksAfter,
    monthsBefore: BOARD_WINDOW_FULL_DEFAULTS.monthsBefore,
    monthsAfter: BOARD_WINDOW_FULL_DEFAULTS.monthsAfter,
    scope: "full",
  };
}

function buildEditorTargets(): EditorTarget[] {
  const targets: EditorTarget[] = [];
  const seen = new Set<string>();

  for (const editorId of PRECOMPUTE_EDITOR_IDS) {
    const bucket = resolveBoardPayloadEditorBucket(editorId);
    const primaryKey = `${editorId ?? "null"}|${bucket}`;
    if (!seen.has(primaryKey)) {
      seen.add(primaryKey);
      targets.push({ resolvedEditorId: editorId, editorBucket: bucket });
    }

    // Compatibility alias for unauthenticated bucket naming.
    if (editorId === null && bucket !== PUBLIC_ANON_BUCKET_ALIAS) {
      const aliasKey = `${editorId ?? "null"}|${PUBLIC_ANON_BUCKET_ALIAS}`;
      if (!seen.has(aliasKey)) {
        seen.add(aliasKey);
        targets.push({
          resolvedEditorId: editorId,
          editorBucket: PUBLIC_ANON_BUCKET_ALIAS,
        });
      }
    }
  }

  return targets;
}

function toSafeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function precomputeBoardPayloadCaches(
  opts: PrecomputeBoardPayloadCacheOptions,
): Promise<PrecomputeBoardPayloadCacheResult> {
  const result: PrecomputeBoardPayloadCacheResult = {
    attempted: 0,
    written: 0,
    failed: 0,
  };
  const editorTargets = buildEditorTargets();
  const nowMs = opts.nowMs ?? Date.now();
  const scopes = opts.scopes && opts.scopes.length > 0
    ? opts.scopes
    : PRECOMPUTE_SCOPES;

  for (const editorTarget of editorTargets) {
    for (const scope of scopes) {
      for (const viewMode of PRECOMPUTE_VIEW_MODES) {
        result.attempted += 1;
        try {
          const payload = buildSanitizedBoardWindowPayload({
            snapshot: opts.snapshot,
            snapshotStatus: "ok",
            file: opts.file,
            env: opts.env,
            query: buildPrecomputeQuery(viewMode, scope),
            resolvedEditorId: editorTarget.resolvedEditorId,
            nowMs,
          });

          await writeBoardPayloadCache(
            {
              viewMode,
              weekStart: payload.selected.weekStart,
              monthKey: payload.selected.monthKey,
              editorBucket: editorTarget.editorBucket,
              scope,
            },
            payload,
          );
          result.written += 1;
        } catch (err) {
          result.failed += 1;
          console.error(
            `[board-cache:precompute] payload write failed editor=${editorTarget.editorBucket} view=${viewMode} scope=${scope} message=${toSafeErrorMessage(err)}`,
          );
        }
      }
    }
  }

  return result;
}
