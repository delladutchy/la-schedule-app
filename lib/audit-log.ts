import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStore } from "@netlify/blobs";
import {
  AuditEventSchema,
  AuditLogSchema,
  type AuditAction,
  type AuditEvent,
} from "./types";
import { parseGigDescription, parseLaJobSummary } from "./gigs";

const AUDIT_KEY = "editor-audit-log";
const MAX_AUDIT_EVENTS = 200;

function isLocalDev(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }

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

function localAuditPath(storeName: string): string {
  return path.join(localStoreDir(storeName), `${AUDIT_KEY}.json`);
}

function store(name: string) {
  return getStore({ name, consistency: "strong" });
}

async function ensureLocalStoreDir(storeName: string): Promise<void> {
  await mkdir(localStoreDir(storeName), { recursive: true });
}

async function readLocalAuditEvents(storeName: string): Promise<AuditEvent[]> {
  try {
    const raw = await readFile(localAuditPath(storeName), "utf8");
    const parsedJson = JSON.parse(raw);
    const parsed = AuditLogSchema.safeParse(parsedJson);
    if (!parsed.success) {
      console.error("[audit] local parse failed:", parsed.error.message);
      return [];
    }
    return parsed.data.events;
  } catch {
    return [];
  }
}

async function writeLocalAuditEvents(storeName: string, events: AuditEvent[]): Promise<void> {
  await ensureLocalStoreDir(storeName);
  const payload = AuditLogSchema.parse({ version: 1, events });
  await writeFile(localAuditPath(storeName), JSON.stringify(payload, null, 2), "utf8");
}

function capEvents(events: AuditEvent[]): AuditEvent[] {
  return events.slice(0, MAX_AUDIT_EVENTS);
}

async function readRemoteAuditEvents(storeName: string): Promise<AuditEvent[]> {
  try {
    const raw = await store(storeName).get(AUDIT_KEY, { type: "json" });
    if (!raw) return [];
    const parsed = AuditLogSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("[audit] parse failed:", parsed.error.message);
      return [];
    }
    return parsed.data.events;
  } catch (err) {
    console.error("[audit] read failed:", err);
    return [];
  }
}

async function writeRemoteAuditEvents(storeName: string, events: AuditEvent[]): Promise<void> {
  const payload = AuditLogSchema.parse({ version: 1, events });
  await store(storeName).setJSON(AUDIT_KEY, payload);
}

export async function readAuditEvents(storeName: string, limit: number = MAX_AUDIT_EVENTS): Promise<AuditEvent[]> {
  const cappedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(MAX_AUDIT_EVENTS, Math.floor(limit)))
    : MAX_AUDIT_EVENTS;
  const events = isLocalDev()
    ? await readLocalAuditEvents(storeName)
    : await readRemoteAuditEvents(storeName);
  return events.slice(0, cappedLimit);
}

export interface AppendAuditEventInput {
  timestampUtc?: string;
  editorId: string;
  action: AuditAction;
  status: "success";
  eventId?: string;
  summary?: string;
  jobNumber?: string;
  jobTitle?: string;
  startDate?: string;
  endDate?: string;
  callTime?: string;
}

export async function appendAuditEvent(
  storeName: string,
  input: AppendAuditEventInput,
): Promise<void> {
  const auditEvent = AuditEventSchema.parse({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    timestampUtc: input.timestampUtc ?? new Date().toISOString(),
    editorId: input.editorId,
    action: input.action,
    status: input.status,
    ...(input.eventId ? { eventId: input.eventId } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.jobNumber ? { jobNumber: input.jobNumber } : {}),
    ...(input.jobTitle ? { jobTitle: input.jobTitle } : {}),
    ...(input.startDate ? { startDate: input.startDate } : {}),
    ...(input.endDate ? { endDate: input.endDate } : {}),
    ...(input.callTime ? { callTime: input.callTime } : {}),
  });

  const current = isLocalDev()
    ? await readLocalAuditEvents(storeName)
    : await readRemoteAuditEvents(storeName);
  const next = capEvents([auditEvent, ...current]);
  if (isLocalDev()) {
    await writeLocalAuditEvents(storeName, next);
    return;
  }
  await writeRemoteAuditEvents(storeName, next);
}

export async function clearAuditEvents(storeName: string): Promise<void> {
  const emptyEvents: AuditEvent[] = [];
  if (isLocalDev()) {
    await writeLocalAuditEvents(storeName, emptyEvents);
    return;
  }
  await writeRemoteAuditEvents(storeName, emptyEvents);
}

export function buildGigAuditFields(opts: {
  summary?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
}): Pick<AppendAuditEventInput, "summary" | "jobNumber" | "jobTitle" | "startDate" | "endDate" | "callTime"> {
  const summary = opts.summary?.trim();
  const parsedSummary = summary ? parseLaJobSummary(summary) : { jobName: "" as string, jobNumber: undefined as string | undefined };
  const parsedDescription = parseGigDescription(opts.description);
  return {
    ...(summary ? { summary } : {}),
    ...(parsedSummary.jobNumber ? { jobNumber: parsedSummary.jobNumber } : {}),
    ...(parsedSummary.jobName ? { jobTitle: parsedSummary.jobName } : {}),
    ...(opts.startDate ? { startDate: opts.startDate } : {}),
    ...(opts.endDate ? { endDate: opts.endDate } : {}),
    ...(parsedDescription.callTime ? { callTime: parsedDescription.callTime } : {}),
  };
}

export const AUDIT_EVENT_LIMIT = MAX_AUDIT_EVENTS;
