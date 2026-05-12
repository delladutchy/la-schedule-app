import type { BoardWindowPayload } from "./board-window";

export interface PayloadTargetCoordinates {
  weekStart: string;
  monthKey: string;
}

export function isPayloadRenderableForViewTarget(opts: {
  viewMode: "list" | "month";
  target: PayloadTargetCoordinates;
  payload: BoardWindowPayload | null;
}): boolean {
  if (!opts.payload) return false;
  if (opts.payload.selected.view !== opts.viewMode) return false;
  if (opts.viewMode === "list") {
    return opts.payload.selected.weekStart === opts.target.weekStart;
  }
  return opts.payload.selected.monthKey === opts.target.monthKey;
}

/**
 * Decide whether `incoming` is a strict improvement over `current` for the
 * **same view slot**. Callers route responses to the matching slot by
 * `incoming.selected.view` before reaching this helper, so cross-view
 * contamination is not its concern — only timestamp, target-coord match,
 * and wide-window richness.
 *
 * Order of preference:
 *   1. anything beats `null`
 *   2. newer `generatedAtUtc` wins
 *   3. same age → whichever matches the URL's `{weekStart, monthKey}` wins
 *      (lets a fresh fetch for the new URL coordinates replace a
 *      stale-coord fallback that was carried across a navigation)
 *   4. same age, same target match → whichever has more wide-window data
 *      wins (lets the stage-2 full response upgrade the stage-1
 *      selected-only one without flicker)
 */
export function isPayloadAnImprovement(opts: {
  incoming: BoardWindowPayload;
  current: BoardWindowPayload | null;
  target: PayloadTargetCoordinates;
}): boolean {
  if (!opts.current) return true;
  if (opts.incoming.generatedAtUtc > opts.current.generatedAtUtc) return true;
  if (opts.incoming.generatedAtUtc < opts.current.generatedAtUtc) return false;

  const incomingMatchesTarget =
    opts.incoming.selected.weekStart === opts.target.weekStart
    && opts.incoming.selected.monthKey === opts.target.monthKey;
  const currentMatchesTarget =
    opts.current.selected.weekStart === opts.target.weekStart
    && opts.current.selected.monthKey === opts.target.monthKey;
  if (incomingMatchesTarget && !currentMatchesTarget) return true;
  if (!incomingMatchesTarget && currentMatchesTarget) return false;

  if (opts.incoming.weekWindow.weeks.length > opts.current.weekWindow.weeks.length) return true;
  if (opts.incoming.monthWindow.months.length > opts.current.monthWindow.months.length) return true;
  return false;
}
