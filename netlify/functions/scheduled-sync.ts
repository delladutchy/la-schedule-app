import type { Config } from "@netlify/functions";
import { buildAndPersistSnapshot } from "../../lib/sync";

export default async () => {
  const started = Date.now();
  try {
    const result = await buildAndPersistSnapshot();
    const durMs = Date.now() - started;
    if (result.status === "ok") {
      console.log(`[scheduled-sync] ok in ${durMs}ms, ${result.snapshot?.busy.length ?? 0} busy blocks`);
      return new Response(JSON.stringify({ status: "ok", durationMs: durMs }), { status: 200 });
    }
    console.error(`[scheduled-sync] failed in ${durMs}ms: ${result.error}`);
    return new Response(
      JSON.stringify({ status: "failed", error: result.error, durationMs: durMs }),
      { status: 500 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduled-sync] exception: ${msg}`);
    return new Response(JSON.stringify({ status: "error", error: msg }), { status: 500 });
  }
};

export const config: Config = {
  schedule: "*/10 * * * *",
};
