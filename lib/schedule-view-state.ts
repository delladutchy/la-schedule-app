import type { BoardWindowPayload } from "./board-window";

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
