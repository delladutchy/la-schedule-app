export interface PlaidSyncPage<TAdded, TRemoved> {
  added: TAdded[];
  modified: TAdded[];
  removed: TRemoved[];
  nextCursor: string;
  hasMore: boolean;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const response = "response" in error ? (error as { response?: { data?: { error_code?: unknown } } }).response : undefined;
  return typeof response?.data?.error_code === "string" ? response.data.error_code : null;
}

/** Plaid requires the whole page sequence to restart if its dataset mutates mid-pagination. */
export async function collectPlaidSyncUpdates<TAdded, TRemoved>(
  fetchPage: (cursor: string | undefined) => Promise<PlaidSyncPage<TAdded, TRemoved>>,
  initialCursor: string | null,
  maxMutationRestarts = 2,
): Promise<{ added: TAdded[]; modified: TAdded[]; removed: TRemoved[]; nextCursor: string }> {
  for (let attempt = 0; attempt <= maxMutationRestarts; attempt++) {
    let cursor = initialCursor ?? undefined;
    const added: TAdded[] = [];
    const modified: TAdded[] = [];
    const removed: TRemoved[] = [];
    try {
      while (true) {
        const page = await fetchPage(cursor);
        added.push(...page.added);
        modified.push(...page.modified);
        removed.push(...page.removed);
        cursor = page.nextCursor;
        if (!page.hasMore) return { added, modified, removed, nextCursor: cursor ?? initialCursor ?? "" };
      }
    } catch (error) {
      if (errorCode(error) !== "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" || attempt === maxMutationRestarts) throw error;
    }
  }
  throw new Error("Plaid pagination restart limit exhausted");
}
