import type { BoardWindowPayload } from "./board-window";

export interface LastSeenPayloadsByView {
  list: BoardWindowPayload | null;
  month: BoardWindowPayload | null;
}

export function shouldRetainDerivedPayloadOnSyntheticSwap(opts: {
  previousDerived: BoardWindowPayload | null;
  nextInitialPayload: BoardWindowPayload;
  initialPayloadIsSynthetic: boolean;
}): boolean {
  if (!opts.initialPayloadIsSynthetic) return false;
  if (!opts.previousDerived) return false;
  return opts.previousDerived.selected.view === opts.nextInitialPayload.selected.view;
}

export function isBackgroundPayloadCompatibleWithView(opts: {
  currentViewMode: "list" | "month";
  payload: BoardWindowPayload;
}): boolean {
  return opts.payload.selected.view === opts.currentViewMode;
}

/**
 * Pick a same-view payload from the per-view session memory to render
 * immediately during a Week ↔ Month toggle. Returns `null` for the
 * non-synthetic SSR path (the legacy server-baked payload is authoritative)
 * and when there is no remembered payload for the new view yet. The
 * payload's `selected.view` is verified defensively so a corrupted ref
 * entry can never bleed across views.
 *
 * Caller is expected to follow up with a background `/api/board/window`
 * fetch targeting the URL's coordinates; that response will replace this
 * fallback via the `applyIfBetter` merge once it arrives.
 */
export function pickFallbackPayloadForNewView(opts: {
  initialPayloadIsSynthetic: boolean;
  newView: "list" | "month";
  lastSeenByView: LastSeenPayloadsByView;
}): BoardWindowPayload | null {
  if (!opts.initialPayloadIsSynthetic) return null;
  const candidate = opts.lastSeenByView[opts.newView];
  if (!candidate) return null;
  if (candidate.selected.view !== opts.newView) return null;
  return candidate;
}

/**
 * Tie-breaker for `applyIfBetter`: when two payloads share `generatedAtUtc`
 * but only one matches the URL's target `{weekStart, monthKey}`, prefer
 * the matching one. Without this, a fresh fetch for new coordinates can
 * lose to a same-age fallback for old coordinates because the existing
 * "more wide-window data" check picks the wrong payload.
 */
export function shouldPreferIncomingForTargetMatch(opts: {
  incoming: BoardWindowPayload;
  baseline: BoardWindowPayload;
  target: { weekStart: string; monthKey: string };
}): boolean {
  const incomingMatchesTarget = opts.incoming.selected.weekStart === opts.target.weekStart
    && opts.incoming.selected.monthKey === opts.target.monthKey;
  const baselineMatchesTarget = opts.baseline.selected.weekStart === opts.target.weekStart
    && opts.baseline.selected.monthKey === opts.target.monthKey;
  return incomingMatchesTarget && !baselineMatchesTarget;
}
