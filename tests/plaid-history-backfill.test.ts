import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "lib/plaid-bank-sync.ts"), "utf8");
const body = source.slice(source.indexOf("export async function backfillPlaid2026History"));
const route = fs.readFileSync(path.join(process.cwd(), "app/api/cron/bank-history-backfill/route.ts"), "utf8");

describe("Plaid 2026 historical backfill safety", () => {
  it("replays the current Item from an empty cursor without changing the incremental cursor", () => {
    expect(body).toContain("fetchPlaidSync(config, accessToken, null)");
    expect(body).not.toContain("advance_bank_provider_sync");
    expect(body).not.toContain("sync_cursor:");
  });

  it("is hard-bounded to 2026 and defaults to ending before August", () => {
    expect(body).toContain('"2026-01-01"');
    expect(body).toContain('"2026-07-31"');
    expect(body).toContain('/^2026-\\d{2}-\\d{2}$/');
  });

  it("refuses all writes unless every new 8155 Light Action deposit is one clear duplicate", () => {
    const blocker = body.indexOf("if (blocked.length > 0)");
    const write = body.indexOf("await importOrRefreshPostedTransaction");
    expect(blocker).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(blocker);
    expect(body).toContain('scoped[0]?.mask !== "8155"');
  });

  it("uses the normalized importer rather than direct bank-transaction inserts", () => {
    expect(body).toContain("normalizePlaidPostedTransaction");
    expect(body).toContain("importOrRefreshPostedTransaction");
    expect(body).not.toContain('.from("bank_transactions").insert');
  });

  it("exposes preview and apply only behind the server admin token", () => {
    expect(route).toContain("getEnvConfig().ADMIN_TOKEN");
    expect(route).toContain("constantTimeEqual");
    expect(route).toContain("run(false)");
    expect(route).toContain("run(true)");
    expect(route).not.toContain('x-netlify-event');
  });
});
