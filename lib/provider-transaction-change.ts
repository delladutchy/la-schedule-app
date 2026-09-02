export type ProviderTransactionChangeAction = "review_applied_change" | "refresh_and_reconcile" | "ignore_removed";

export function decideProviderTransactionChange(
  reconciliationStatus: string,
  change: "modified" | "removed",
): ProviderTransactionChangeAction {
  if (reconciliationStatus === "applied") return "review_applied_change";
  return change === "modified" ? "refresh_and_reconcile" : "ignore_removed";
}
