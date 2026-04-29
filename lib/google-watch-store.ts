import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStore } from "@netlify/blobs";
import { z } from "zod";

const WATCH_KEY = "google-calendar-watch";

const WatchMetadataSchema = z.object({
  version: z.literal(1),
  channelId: z.string().min(1),
  resourceId: z.string().min(1),
  resourceUri: z.string().optional(),
  expiration: z.string().optional(),
  calendarId: z.string().min(1),
  webhookUrl: z.string().url(),
  createdAtUtc: z.string().datetime(),
});

export type GoogleCalendarWatchMetadata = z.infer<typeof WatchMetadataSchema>;

function isLocalDev(): boolean {
  if (process.env.NODE_ENV === "production") return false;
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

function localWatchPath(storeName: string): string {
  return path.join(localStoreDir(storeName), `${WATCH_KEY}.json`);
}

function store(name: string) {
  return getStore({ name, consistency: "strong" });
}

async function ensureLocalStoreDir(storeName: string): Promise<void> {
  await mkdir(localStoreDir(storeName), { recursive: true });
}

export async function readGoogleCalendarWatchMetadata(
  storeName: string,
): Promise<GoogleCalendarWatchMetadata | null> {
  try {
    if (isLocalDev()) {
      const raw = await readFile(localWatchPath(storeName), "utf8");
      return WatchMetadataSchema.parse(JSON.parse(raw));
    }
    const raw = await store(storeName).get(WATCH_KEY, { type: "json" });
    if (!raw) return null;
    return WatchMetadataSchema.parse(raw);
  } catch {
    return null;
  }
}

export async function writeGoogleCalendarWatchMetadata(
  storeName: string,
  metadata: Omit<GoogleCalendarWatchMetadata, "version">,
): Promise<GoogleCalendarWatchMetadata> {
  const payload = WatchMetadataSchema.parse({
    version: 1,
    ...metadata,
  });

  if (isLocalDev()) {
    await ensureLocalStoreDir(storeName);
    await writeFile(localWatchPath(storeName), JSON.stringify(payload, null, 2), "utf8");
    return payload;
  }

  await store(storeName).setJSON(WATCH_KEY, payload);
  return payload;
}
