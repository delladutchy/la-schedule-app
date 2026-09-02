import { describe, expect, it } from "vitest";
import { collectPlaidSyncUpdates } from "@/lib/plaid-sync-pages";
import { decideProviderTransactionChange } from "@/lib/provider-transaction-change";
import { classifyPlaidItemWebhook } from "@/lib/plaid-webhook-events";
import { webhookReceiptHash } from "@/lib/bank-webhook-receipts";

describe("Plaid reliability controls", () => {
  it("restarts cursor pagination from the original cursor after a mutation error", async () => {
    const cursors: Array<string | undefined> = [];
    let mutationThrown = false;
    const result = await collectPlaidSyncUpdates(async (cursor) => {
      cursors.push(cursor);
      if (cursor === "page-2" && !mutationThrown) {
        mutationThrown = true;
        throw { response: { data: { error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" } } };
      }
      return cursor === "start"
        ? { added: ["one"], modified: [], removed: [], nextCursor: "page-2", hasMore: true }
        : { added: ["two"], modified: [], removed: [], nextCursor: "done", hasMore: false };
    }, "start");
    expect(cursors).toEqual(["start", "page-2", "start", "page-2"]);
    expect(result.added).toEqual(["one", "two"]);
  });

  it("never auto-reverses a modified or removed applied transaction", () => {
    expect(decideProviderTransactionChange("applied", "modified")).toBe("review_applied_change");
    expect(decideProviderTransactionChange("applied", "removed")).toBe("review_applied_change");
    expect(decideProviderTransactionChange("pending", "removed")).toBe("ignore_removed");
  });

  it("maps login/consent events to reconnect and repaired login to recovery", () => {
    expect(classifyPlaidItemWebhook("PENDING_EXPIRATION").action).toBe("reconnect");
    expect(classifyPlaidItemWebhook("ERROR", { error_code: "ITEM_LOGIN_REQUIRED" }).action).toBe("reconnect");
    expect(classifyPlaidItemWebhook("LOGIN_REPAIRED").action).toBe("repaired");
  });

  it("deduplicates exact delivery replay without suppressing a later re-signed notification", () => {
    expect(webhookReceiptHash("signature-a", "{\"same\":true}"))
      .toBe(webhookReceiptHash("signature-a", "{\"same\":true}"));
    expect(webhookReceiptHash("signature-a", "{\"same\":true}"))
      .not.toBe(webhookReceiptHash("signature-b", "{\"same\":true}"));
  });
});
