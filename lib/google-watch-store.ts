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
export type GoogleCalendarWatchMetadataMap = Record<string, GoogleCalendarWatchMetadata>;

const WatchCollectionSchema = z.object({
  version: z.literal(2),
  watches: z.array(WatchMetadataSchema),
});

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

function normalizeCalendarId(calendarId: string): string {
  return calendarId.trim();
}

function mapFromWatches(
  watches: GoogleCalendarWatchMetadata[],
): GoogleCalendarWatchMetadataMap {
  const map: GoogleCalendarWatchMetadataMap = {};
  for (const watch of watches) {
    map[normalizeCalendarId(watch.calendarId)] = watch;
  }
  return map;
}

function parseWatchPayload(raw: unknown): GoogleCalendarWatchMetadataMap {
  const legacy = WatchMetadataSchema.safeParse(raw);
  if (legacy.success) {
    const calendarId = normalizeCalendarId(legacy.data.calendarId);
    return { [calendarId]: legacy.data };
  }

  const collection = WatchCollectionSchema.safeParse(raw);
  if (collection.success) {
    return mapFromWatches(collection.data.watches);
  }

  return {};
}

function sortedWatchValues(
  map: GoogleCalendarWatchMetadataMap,
): GoogleCalendarWatchMetadata[] {
  return Object.values(map).sort((a, b) =>
    Date.parse(b.createdAtUtc) - Date.parse(a.createdAtUtc));
}

export async function readGoogleCalendarWatchMetadataMap(
  storeName: string,
): Promise<GoogleCalendarWatchMetadataMap> {
  try {
    if (isLocalDev()) {
      const raw = await readFile(localWatchPath(storeName), "utf8");
      return parseWatchPayload(JSON.parse(raw));
    }
    const raw = await store(storeName).get(WATCH_KEY, { type: "json" });
    if (!raw) return {};
    return parseWatchPayload(raw);
  } catch {
    return {};
  }
}

export async function writeGoogleCalendarWatchMetadataMap(
  storeName: string,
  metadataMap: GoogleCalendarWatchMetadataMap,
): Promise<GoogleCalendarWatchMetadataMap> {
  const watches = Object.values(metadataMap).map((metadata) =>
    WatchMetadataSchema.parse(metadata));
  const payload = WatchCollectionSchema.parse({
    version: 2,
    watches,
  });

  if (isLocalDev()) {
    await ensureLocalStoreDir(storeName);
    await writeFile(localWatchPath(storeName), JSON.stringify(payload, null, 2), "utf8");
    return mapFromWatches(payload.watches);
  }

  await store(storeName).setJSON(WATCH_KEY, payload);
  return mapFromWatches(payload.watches);
}

export async function readGoogleCalendarWatchMetadata(
  storeName: string,
  calendarId?: string,
): Promise<GoogleCalendarWatchMetadata | null> {
  const metadataMap = await readGoogleCalendarWatchMetadataMap(storeName);
  if (calendarId) {
    return metadataMap[normalizeCalendarId(calendarId)] ?? null;
  }
  const sorted = sortedWatchValues(metadataMap);
  return sorted[0] ?? null;
}

export async function writeGoogleCalendarWatchMetadata(
  storeName: string,
  metadata: Omit<GoogleCalendarWatchMetadata, "version">,
): Promise<GoogleCalendarWatchMetadata> {
  const payload = WatchMetadataSchema.parse({
    version: 1,
    ...metadata,
  });
  const existingMap = await readGoogleCalendarWatchMetadataMap(storeName);
  existingMap[normalizeCalendarId(payload.calendarId)] = payload;
  const written = await writeGoogleCalendarWatchMetadataMap(storeName, existingMap);
  return written[normalizeCalendarId(payload.calendarId)] ?? payload;
}
