import { z } from "zod";
import type { BoardWindowPayload } from "./board-window";

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

const DateKeySchema = z.string().regex(DATE_KEY_PATTERN);
const MonthKeySchema = z.string().regex(MONTH_KEY_PATTERN);
const UtcIsoSchema = z.string().datetime({ offset: true });

const DayEventDetailSchema = z.object({
  summary: z.string().min(1),
  startUtc: UtcIsoSchema,
  endUtc: UtcIsoSchema,
  startDate: DateKeySchema.optional(),
  endDateInclusive: DateKeySchema.optional(),
  eventId: z.string().min(1).optional(),
  description: z.string().optional(),
  dateRangeLabel: z.string().min(1),
  timeRangeLabel: z.string().min(1).optional(),
  calendarId: z.string().min(1).optional(),
  displayMode: z.enum(["details", "private"]).optional(),
}).passthrough();

const DayStatusSchema = z.object({
  date: DateKeySchema,
  label: z.string().min(1),
  isToday: z.boolean(),
  isWeekend: z.boolean(),
  status: z.enum(["available", "booked"]),
  eventNames: z.array(z.string().min(1)).optional(),
  eventDetails: z.array(DayEventDetailSchema).optional(),
  bookedDisplay: z.enum(["details", "private", "mixed"]).optional(),
}).passthrough();

const WeekGroupSchema = z.object({
  weekOf: DateKeySchema,
  label: z.string().min(1),
  days: z.array(DayStatusSchema),
}).passthrough();

const MonthEventBarDetailSchema = z.object({
  summary: z.string().min(1),
  jobNumber: z.string().min(1).optional(),
  eventId: z.string().min(1).optional(),
  description: z.string().optional(),
  ownerEditor: z.string().min(1).optional(),
  startUtc: UtcIsoSchema.optional(),
  endUtc: UtcIsoSchema.optional(),
  startDate: DateKeySchema.optional(),
  endDateInclusive: DateKeySchema.optional(),
  calendarId: z.string().min(1).optional(),
  dateRangeLabel: z.string().min(1).optional(),
  timeRangeLabel: z.string().min(1).optional(),
  displayMode: z.enum(["details", "private"]).optional(),
}).passthrough();

const MonthEventBarSchema = z.object({
  key: z.string().min(1),
  identity: z.string().min(1),
  startDayIndex: z.number().int().min(0),
  endDayIndex: z.number().int().min(0),
  laneIndex: z.number().int().min(0),
  segmentStartDate: DateKeySchema,
  segmentEndDate: DateKeySchema,
  label: z.string().min(1),
  title: z.string().min(1).optional(),
  jobNumber: z.string().min(1).optional(),
  isPrivateUnavailable: z.boolean(),
  details: z.array(MonthEventBarDetailSchema),
}).passthrough();

const MonthDayStatusSchema = z.object({
  date: DateKeySchema,
  dayOfMonth: z.number().int().min(1).max(31),
  status: z.enum(["available", "booked"]),
  isToday: z.boolean(),
  isWeekend: z.boolean(),
  isCurrentMonth: z.boolean(),
  eventNames: z.array(z.string().min(1)),
  eventDetails: z.array(DayEventDetailSchema).optional(),
  bookedDisplay: z.enum(["details", "private", "mixed"]).optional(),
}).passthrough();

const MonthWeekSchema = z.object({
  days: z.array(MonthDayStatusSchema),
  bars: z.array(MonthEventBarSchema),
}).passthrough();

const MonthBoardDataSchema = z.object({
  monthKey: MonthKeySchema,
  label: z.string().min(1),
  weeks: z.array(MonthWeekSchema),
}).passthrough();

const WeekNavSchema = z.object({
  weekStart: DateKeySchema,
  prevStart: DateKeySchema,
  nextStart: DateKeySchema,
  hasPrev: z.boolean(),
  hasNext: z.boolean(),
  canGoPrev: z.boolean(),
  canGoNext: z.boolean(),
}).passthrough();

const MonthNavSchema = z.object({
  monthKey: MonthKeySchema,
  prevMonth: MonthKeySchema,
  nextMonth: MonthKeySchema,
  hasPrev: z.boolean(),
  hasNext: z.boolean(),
  canGoPrev: z.boolean(),
  canGoNext: z.boolean(),
}).passthrough();

const SelectedSchema = z.object({
  view: z.enum(["list", "month"]),
  weekStart: DateKeySchema,
  monthKey: MonthKeySchema,
  weekNav: WeekNavSchema,
  monthNav: MonthNavSchema,
}).passthrough();

export const BoardWindowPayloadSchema = z.object({
  status: z.literal("ok"),
  snapshotStatus: z.enum(["ok", "stale"]),
  generatedAtUtc: UtcIsoSchema,
  snapshotWindowStartUtc: UtcIsoSchema,
  snapshotWindowEndUtc: UtcIsoSchema,
  timezone: z.string().min(1),
  resolvedEditorId: z.string().nullable(),
  todayKey: DateKeySchema,
  todayMonthKey: MonthKeySchema,
  selected: SelectedSchema,
  selectedBoards: z.object({
    weekRows: z.array(WeekGroupSchema),
    month: MonthBoardDataSchema,
  }).passthrough(),
  weekWindow: z.object({
    startWeek: DateKeySchema,
    endWeek: DateKeySchema,
    weekCount: z.number().int().min(0),
    weeks: z.array(WeekGroupSchema),
  }).passthrough(),
  monthWindow: z.object({
    startMonth: MonthKeySchema,
    endMonth: MonthKeySchema,
    monthCount: z.number().int().min(0),
    months: z.array(MonthBoardDataSchema),
  }).passthrough(),
}).passthrough();

export function parseBoardWindowPayload(value: unknown): BoardWindowPayload | null {
  const result = BoardWindowPayloadSchema.safeParse(value);
  if (!result.success) return null;
  return result.data as BoardWindowPayload;
}
