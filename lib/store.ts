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

function isLocalDev(): boolean {
  return !process.env.NETLIFY;
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

function store(name: string) {
  // `getStore` works both inside Netlify functions and in Next.js
  // server runtime when NETLIFY_BLOBS_CONTEXT is set at build time.
  return getStore({ name, consistency: "strong" });
}

export async function readCurrentSnapshot(
  storeName: string,
): Promise<Snapshot | null> {
  if (isLocalDev()) {
    return readLocalCurrentSnapshot(storeName);
  }

  try {
    const raw = await store(storeName).get(CURRENT_KEY, { type: "json" });
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

export async function writeCurrentSnapshot(
  storeName: string,
  snapshot: Snapshot,
): Promise<void> {
  if (isLocalDev()) {
    return writeLocalCurrentSnapshot(storeName, snapshot);
  }

  const parsed = SnapshotSchema.parse(snapshot);
  const s = store(storeName);
  const historyKey = `history/${snapshot.generatedAtUtc}`;
  await s.setJSON(historyKey, parsed);
  await s.setJSON(CURRENT_KEY, parsed);
}
