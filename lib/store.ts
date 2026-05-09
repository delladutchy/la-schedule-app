/**
 * Snapshot persistence.
 *
 * Primary store: Netlify Blobs (durable, global, consistent reads in the
 * same region, eventual across regions — fine for our 10-minute cadence).
 *
 * In local development we fallback to a simple file-backed current snapshot
 * so `npm run sync:local` and `npm run dev` can work without Netlify Blobs.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStore } from "@netlify/blobs";
import { SnapshotSchema, type Snapshot } from "./types";

const CURRENT_KEY = "current";
const lastKnownGoodSnapshots = new Map<string, Snapshot>();

function isLocalDev(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }

  // Use local file fallback only when we're clearly outside Netlify.
  // Production/deploy runtimes can expose different env markers depending
  // on route/runtime shape, so check a small set of Netlify indicators.
  return !(
    process.env.NETLIFY
    || process.env.NETLIFY_BLOBS_CONTEXT
    || process.env.CONTEXT
    || process.env.LAMBDA_TASK_ROOT
  );
}

function localStoreDir(storeName: string): string {
  return path.resolve(process.cwd(), ".netlify-blobs", storeName);
}

function localCurrentPath(storeName: string): string {
  return path.join(localStoreDir(storeName), `${CURRENT_KEY}.json`);
}

async function ensureLocalStoreDir(storeName: string): Promise<void> {
  await mkdir(localStoreDir(storeName), { recursive: true });
}

async function readLocalCurrentSnapshot(
  storeName: string,
): Promise<Snapshot | null> {
  try {
    const raw = await readFile(localCurrentPath(storeName), "utf8");
    const parsedJson = JSON.parse(raw);
    const parsed = SnapshotSchema.safeParse(parsedJson);
    if (!parsed.success) {
      console.error("[snapshot] local parse failed:", parsed.error.message);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

async function writeLocalCurrentSnapshot(
  storeName: string,
  snapshot: Snapshot,
): Promise<void> {
  await ensureLocalStoreDir(storeName);
  const parsed = SnapshotSchema.parse(snapshot);
  await writeFile(localCurrentPath(storeName), JSON.stringify(parsed, null, 2), "utf8");
}

type ReadConsistency = "eventual" | "strong";

function store(name: string) {
  // `getStore` works both inside Netlify functions and in Next.js
  // server runtime when NETLIFY_BLOBS_CONTEXT is set at build time.
  return getStore({ name });
}

function rememberLastKnownGoodSnapshot(storeName: string, snapshot: Snapshot): Snapshot {
  lastKnownGoodSnapshots.set(storeName, snapshot);
  return snapshot;
}

async function readRemoteCurrentSnapshot(
  storeName: string,
  consistency: ReadConsistency,
): Promise<Snapshot | null> {
  try {
    const raw = await store(storeName).get(CURRENT_KEY, { type: "json", consistency });
    if (!raw) return null;
    const parsed = SnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("[snapshot] parse failed:", parsed.error.message);
      return null;
    }
    return parsed.data;
  } catch (err) {
    console.error("[snapshot] read failed:", err);
    return null;
  }
}

export interface ReadSnapshotOptions {
  /**
   * Defaults to "strong" so reads after writes (manual sync, booking save
   * → router.refresh SSR, post-write /api/board/window revalidation) are
   * guaranteed to see the just-written snapshot. Eventual is available as
   * an opt-in for callers that don't need read-after-write coherence.
   */
  consistency?: ReadConsistency;
}

export async function readCurrentSnapshot(
  storeName: string,
  options: ReadSnapshotOptions = {},
): Promise<Snapshot | null> {
  if (isLocalDev()) {
    const localSnapshot = await readLocalCurrentSnapshot(storeName);
    if (localSnapshot) {
      return rememberLastKnownGoodSnapshot(storeName, localSnapshot);
    }
    return null;
  }

  const consistency: ReadConsistency = options.consistency ?? "strong";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remoteSnapshot = await readRemoteCurrentSnapshot(storeName, consistency);
    if (remoteSnapshot) {
      return rememberLastKnownGoodSnapshot(storeName, remoteSnapshot);
    }
  }

  const cachedSnapshot = lastKnownGoodSnapshots.get(storeName);
  if (cachedSnapshot) {
    console.warn(
      `[snapshot] remote read failed twice; serving in-memory last-known-good generatedAt=${cachedSnapshot.generatedAtUtc}`,
    );
    return cachedSnapshot;
  }

  console.warn(`[snapshot] remote read returned no snapshot store=${storeName}`);
  return null;
}

export async function writeCurrentSnapshot(
  storeName: string,
  snapshot: Snapshot,
): Promise<void> {
  const parsed = SnapshotSchema.parse(snapshot);
  if (isLocalDev()) {
    await writeLocalCurrentSnapshot(storeName, parsed);
    rememberLastKnownGoodSnapshot(storeName, parsed);
    return;
  }

  const s = store(storeName);
  const historyKey = `history/${snapshot.generatedAtUtc}`;
  await s.setJSON(historyKey, parsed);
  await s.setJSON(CURRENT_KEY, parsed);
  rememberLastKnownGoodSnapshot(storeName, parsed);
}
