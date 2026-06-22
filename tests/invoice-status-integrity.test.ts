import { describe, expect, it } from "vitest";
import {
  resolveGmailDraftCreatedStatus,
  resolveSheetSyncedStatus,
} from "@/lib/invoice-data";
import type { InvoiceStatus } from "@/lib/invoice-types";

describe("invoice status integrity helpers", () => {
  it("Sheet sync only promotes pre-invoice statuses to sheet_synced", () => {
    expect(resolveSheetSyncedStatus("none")).toBe("sheet_synced");
    expect(resolveSheetSyncedStatus("ready")).toBe("sheet_synced");
    expect(resolveSheetSyncedStatus("sheet_synced")).toBe("sheet_synced");
  });

  it("Sheet sync does not regress draft/sent/payment statuses", () => {
    const statuses: InvoiceStatus[] = ["draft_created", "sent", "partially_paid", "paid", "void"];
    for (const status of statuses) {
      expect(resolveSheetSyncedStatus(status)).toBe(status);
    }
  });

  it("Gmail Draft creation marks unsent invoice states as draft_created", () => {
    const statuses: InvoiceStatus[] = ["none", "ready", "sheet_synced", "draft_created"];
    for (const status of statuses) {
      expect(resolveGmailDraftCreatedStatus(status)).toBe("draft_created");
    }
  });

  it("Gmail Draft creation does not mark sent/paid invoices backward", () => {
    const statuses: InvoiceStatus[] = ["sent", "partially_paid", "paid", "void"];
    for (const status of statuses) {
      expect(resolveGmailDraftCreatedStatus(status)).toBe(status);
    }
  });
});
