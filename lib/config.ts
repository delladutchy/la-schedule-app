/**
 * Runtime configuration.
 *
 * Two sources:
 *   1. Environment variables (secrets, deploy-controlled values)
 *   2. /config/availability.config.json (non-secret, git-tracked)
 *
 * Everything is validated with Zod on first access. If validation fails,
 * the process throws immediately — we never want to run with bad config.
 */

import { z } from "zod";
import fileConfig from "../config/availability.config.json";
import type { CalendarDisplayMode } from "./types";

const FileConfigSchema = z.object({
  /** IANA timezone used to render the page, e.g. "America/Los_Angeles". */
  timezone: z.string().min(1),
  /** Workday start hour in display timezone (inclusive), 0–23. */
  workdayStartHour: z.number().int().min(0).max(23),
  /** Workday end hour in display timezone (exclusive), 1–24. */
  workdayEndHour: z.number().int().min(1).max(24),
  /** If true, weekend columns are hidden in the weekly view. */
  hideWeekends: z.boolean(),
  /** Slot granularity in minutes — must divide 60 evenly. */
  slotMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  /** Pre-meeting buffer applied to every busy block, in minutes. */
  preBufferMinutes: z.number().int().min(0).max(120),
  /** Post-meeting buffer applied to every busy block, in minutes. */
  postBufferMinutes: z.number().int().min(0).max(120),
  /** How many days forward to project availability. */
  horizonDays: z.number().int().min(1).max(365),
  /** Whether to render tentative events as a distinct state. */
  showTentative: z.boolean(),
  /** Freshness: snapshot older than this shows a "stale" warning. */
  freshTtlMinutes: z.number().int().min(1).max(1440),
  /** Hard TTL: older than this fails closed to "unavailable". */
  hardTtlMinutes: z.number().int().min(1).max(10080),
  /** Page title and optional subtitle. */
  pageTitle: z.string().min(1),
  pageSubtitle: z.string().optional(),
  /** A short footer note shown under the calendar. */
  footerNote: z.string().optional(),
}).refine(
  (c) => c.workdayEndHour > c.workdayStartHour,
  { message: "workdayEndHour must be greater than workdayStartHour" }
).refine(
  (c) => c.hardTtlMinutes >= c.freshTtlMinutes,
  { message: "hardTtlMinutes must be >= freshTtlMinutes" }
);

const EnvSchema = z.object({
  /**
   * Comma-separated list of Google Calendar IDs that are authoritative
   * "blocker" calendars. Only these affect public availability.
   *
   * Example: "primary,abcd1234@group.calendar.google.com"
   */
  BLOCKER_CALENDAR_IDS: z.string().min(1)
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .refine((arr) => arr.length > 0, "At least one calendar id required"),

  /**
   * Optional per-calendar display overrides.
   *
   * Format:
   *   "calendarId:details,calendarId2:private"
   *   "calendarId=details,calendarId2=private"
   *
   * Any calendar not listed here defaults to "details".
   */
  CALENDAR_DISPLAY_MODES: z.string().optional()
    .transform((raw): Record<string, CalendarDisplayMode> => {
      if (!raw || raw.trim().length === 0) return {};
      const map: Record<string, CalendarDisplayMode> = {};

      for (const entry of raw.split(",")) {
        const part = entry.trim();
        if (!part) continue;
        const eqIndex = part.indexOf("=");
        const colonIndex = part.indexOf(":");
        const splitIndex = eqIndex >= 0 ? eqIndex : colonIndex;
        if (splitIndex <= 0 || splitIndex === part.length - 1) {
          throw new Error(
            `Invalid CALENDAR_DISPLAY_MODES entry "${part}". Use "calendarId:details" or "calendarId:private".`
          );
        }
        const calendarId = part.slice(0, splitIndex).trim();
        const modeRaw = part.slice(splitIndex + 1).trim().toLowerCase();
        if (!calendarId) {
          throw new Error(`Invalid CALENDAR_DISPLAY_MODES entry "${part}" (missing calendar id).`);
        }
        if (modeRaw !== "details" && modeRaw !== "private") {
          throw new Error(
            `Invalid CALENDAR_DISPLAY_MODES mode "${modeRaw}" for calendar "${calendarId}". Use "details" or "private".`
          );
        }
        map[calendarId] = modeRaw;
      }

      return map;
    }),

  /** OAuth client id. */
  GOOGLE_CLIENT_ID: z.string().min(1),
  /** OAuth client secret. */
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  /** Long-lived refresh token produced during one-time setup. */
  GOOGLE_REFRESH_TOKEN: z.string().min(1),

  /** Token that must be presented to view /admin status page. */
  ADMIN_TOKEN: z.string().min(16, "ADMIN_TOKEN must be at least 16 chars"),

  /** Token that must be presented to create/edit gigs. */
  EDITOR_TOKEN: z.string().min(16, "EDITOR_TOKEN must be at least 16 chars"),

  /** Calendar ID used for editor write-through gig creation. */
  GOOGLE_CALENDAR_ID: z.string().min(1, "GOOGLE_CALENDAR_ID is required"),

  /** Optional override for Netlify Blobs store name. */
  BLOBS_STORE_NAME: z.string().default("availability-snapshots"),

  /**
   * If true (default), the public homepage will attempt a one-time server-side
   * snapshot bootstrap when it detects an unavailable state (for example, a
   * brand-new deploy before the first scheduled sync has run).
   *
   * This does NOT weaken /api/sync auth; manual sync remains token-gated.
   */
  AUTO_BOOTSTRAP_ON_UNAVAILABLE: z.string().optional()
    .transform((raw) => {
      if (raw === undefined) return true;
      const normalized = raw.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
      throw new Error(
        `Invalid AUTO_BOOTSTRAP_ON_UNAVAILABLE value "${raw}". Use true/false.`,
      );
    }),

  /** Set by Netlify automatically; used to detect deploy environment. */
  CONTEXT: z.string().optional(),
});

export type FileConfig = z.infer<typeof FileConfigSchema>;
export type EnvConfig = z.infer<typeof EnvSchema>;

let cachedFile: FileConfig | null = null;
let cachedEnv: EnvConfig | null = null;

export function getFileConfig(): FileConfig {
  if (cachedFile) return cachedFile;
  const parsed = FileConfigSchema.safeParse(fileConfig);
  if (!parsed.success) {
    throw new Error(
      `Invalid availability.config.json: ${parsed.error.message}`
    );
  }
  cachedFile = parsed.data;
  return cachedFile;
}

export function getEnvConfig(): EnvConfig {
  if (cachedEnv) return cachedEnv;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Redact values, only show which keys failed.
    const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration: ${keys}`);
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

/** Convenience accessor that combines both for ergonomics. */
export function getConfig() {
  return { file: getFileConfig(), env: getEnvConfig() };
}
