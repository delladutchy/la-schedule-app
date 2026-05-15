"use client";

import { useEffect, useRef, useState, type TouchEventHandler } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { DateTime } from "luxon";
import { summarizeBookedDayLabel, type MonthBoardData } from "@/lib/view";
import { EDITOR_TOKEN_SESSION_KEY, sanitizeEditorToken } from "@/lib/editor-session";
import {
  buildGigDayDetailsForRange,
  buildGigDescription,
  buildLaJobSummary,
  enumerateIsoDatesInRange,
  mergeGigDescriptionWithDailyDetailsBlock,
  parseGigDescription,
  parseLaJobSummary,
  resolveParsedGigDetailForDate,
} from "@/lib/gigs";
import {
  CALL_TIME_OPTIONS,
  DAY_NOTE_CHIPS,
  applyDayNoteChip,
  isCallTimeOption,
  isDayNoteChipActive,
} from "@/lib/call-time-options";
import { LocationMapPreview } from "@/components/LocationMapPreview";
import { LocationSuggestions } from "@/components/LocationSuggestions";
import { useLocationAutocomplete, type LocationSuggestion } from "@/lib/useLocationAutocomplete";

interface Props {
  month: MonthBoardData;
  todayKey: string;
  initialEditorToken?: string;
  initialResolvedEditorId?: string | null;
  editorCalendarId?: string;
  overtureCalendarId?: string;
  prevHref?: string;
  nextHref?: string;
  canGoPrev?: boolean;
  canGoNext?: boolean;
  showWeekends?: boolean;
  onNavigate?: (href: string) => void;
  onDateFocus?: (date: string) => void;
  onMutationSuccess?: () => void;
  todayPulseToken?: number;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FULL_WEEK_DAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;
const WEEKDAY_ONLY_INDEXES = [0, 1, 2, 3, 4] as const;
type MonthWeek = MonthBoardData["weeks"][number];

const STAGED_LOADING_COPY: ReadonlyArray<{ delay: number; text: string }> = [
  { delay: 0, text: "Updating calendar…" },
  { delay: 700, text: "Confirming with Google…" },
  { delay: 1800, text: "Refreshing schedule…" },
  { delay: 5000, text: "Google Calendar is taking a little longer…" },
];
const MOBILE_BOOKING_MEDIA_QUERY = "(max-width: 760px) and (hover: none)";

function useStagedLoadingCopy(isActive: boolean): string {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (!isActive) {
      setStage(0);
      return undefined;
    }
    setStage(0);
    const timers = STAGED_LOADING_COPY.slice(1).map((entry, index) =>
      window.setTimeout(() => setStage(index + 1), entry.delay),
    );
    return () => {
      for (const id of timers) window.clearTimeout(id);
    };
  }, [isActive]);

  return STAGED_LOADING_COPY[stage]?.text ?? STAGED_LOADING_COPY[0]!.text;
}

type BookedLabel = ReturnType<typeof summarizeBookedDayLabel>;

interface ActiveDetailPanel {
  barKey: string;
  header: string;
  headerJobNumber?: string;
  details: BookedLabel["details"];
}

interface ActiveBookingPanel {
  mode: "create" | "edit";
  eventId?: string;
  date: string;
  bookingMode: "la" | "overture";
}

interface BookingDayOverride {
  callTimeOption: string;
  callTimeOther: string;
  notes: string;
}

type BookingDayOverrideMap = Record<string, BookingDayOverride>;

export function monthBarGridStyle(startDayIndex: number, endDayIndex: number, laneIndex: number): {
  gridColumn: string;
  gridRow: string;
} {
  return {
    gridColumn: `${startDayIndex + 1} / ${endDayIndex + 2}`,
    gridRow: String(laneIndex + 1),
  };
}

export function resolveVisibleDayIndexes(hideWeekends: boolean): number[] {
  return hideWeekends ? [...WEEKDAY_ONLY_INDEXES] : [...FULL_WEEK_DAY_INDEXES];
}

export function clipBarToVisibleDayIndexes(
  startDayIndex: number,
  endDayIndex: number,
  visibleDayIndexes: number[],
): { startDayIndex: number; endDayIndex: number } | null {
  const visibleSet = new Set(visibleDayIndexes);
  let clippedStart = startDayIndex;
  let clippedEnd = endDayIndex;

  while (clippedStart <= clippedEnd && !visibleSet.has(clippedStart)) {
    clippedStart += 1;
  }
  while (clippedEnd >= clippedStart && !visibleSet.has(clippedEnd)) {
    clippedEnd -= 1;
  }

  if (clippedStart > clippedEnd) return null;
  return { startDayIndex: clippedStart, endDayIndex: clippedEnd };
}

export function filterMonthWeeksForVisibleCurrentMonthDays(
  weeks: MonthWeek[],
  visibleDayIndexes: number[],
  hideWeekends: boolean,
): MonthWeek[] {
  if (!hideWeekends) return weeks;
  return weeks.filter((week) =>
    visibleDayIndexes.some((dayIndex) => week.days[dayIndex]?.isCurrentMonth));
}

function stripJobPrefix(summary: string, jobNumber?: string): string {
  if (!jobNumber) return summary;
  const digits = jobNumber.replace(/\D/g, "");
  if (!digits) return summary;
  const stripped = summary
    .replace(new RegExp(`^\\s*LA\\s*#?\\s*${digits}\\b[\\s\\-–—:|]*`, "i"), "")
    .trim();
  return stripped.length > 0 ? stripped : summary;
}

function formatCompactDate(isoDate: string): string {
  return DateTime.fromISO(isoDate, { zone: "utc" }).toFormat("ccc, LLL d");
}

function formatShortDate(isoDate: string): string {
  return DateTime.fromISO(isoDate, { zone: "utc" }).toFormat("LLL d");
}

function formatDayAbbrev(isoDate: string): string {
  return DateTime.fromISO(isoDate, { zone: "utc" }).toFormat("ccc");
}

interface MonthPopupDayDetailRow {
  date: string;
  startTime: string | null;
  dayNotes: string | null;
}

function formatMonthPopupRange(startDate: string, endDate: string): string {
  const start = DateTime.fromISO(startDate, { zone: "utc" });
  const end = DateTime.fromISO(endDate, { zone: "utc" });
  if (!start.isValid || !end.isValid || end < start) return `${startDate} – ${endDate}`;
  if (start.hasSame(end, "day")) return start.toFormat("LLL d");
  if (start.year === end.year && start.month === end.month) {
    return `${start.toFormat("LLL d")}–${end.toFormat("d")}`;
  }
  if (start.year === end.year) {
    return `${start.toFormat("LLL d")} – ${end.toFormat("LLL d")}`;
  }
  return `${start.toFormat("LLL d, yyyy")} – ${end.toFormat("LLL d, yyyy")}`;
}

function resolveDetailRangeBounds(detail: BookedLabel["details"][number]): { startDate: string; endDateInclusive: string } | null {
  const startDate = detail.startDate ?? detail.startUtc?.slice(0, 10);
  const endDateInclusive = detail.endDateInclusive ?? detail.endUtc?.slice(0, 10) ?? startDate;
  if (!startDate || !endDateInclusive || endDateInclusive < startDate) return null;
  return { startDate, endDateInclusive };
}

function detailIncludesDate(detail: BookedLabel["details"][number], date: string): boolean {
  const bounds = resolveDetailRangeBounds(detail);
  if (!bounds) return false;
  return date >= bounds.startDate && date <= bounds.endDateInclusive;
}

interface BookingCalendarDay {
  isoDate: string;
  dayNumber: string;
  isCurrentMonth: boolean;
  isBeforeStart: boolean;
}

function buildBookingCalendarDays(startIsoDate: string, monthKey: string): {
  monthLabel: string;
  days: BookingCalendarDay[];
} {
  const start = DateTime.fromISO(startIsoDate, { zone: "utc" });
  const viewedMonth = DateTime.fromFormat(monthKey, "yyyy-LL", { zone: "utc" });
  const monthStart = (viewedMonth.isValid ? viewedMonth : start).startOf("month");
  const gridStart = monthStart.minus({ days: monthStart.weekday - 1 });
  const viewedMonthEnd = monthStart.endOf("month");
  const gridEnd = viewedMonthEnd.plus({ days: 7 - viewedMonthEnd.weekday });

  const days: BookingCalendarDay[] = [];
  let cursor = gridStart;
  while (cursor <= gridEnd) {
    const isoDate = cursor.toFormat("yyyy-LL-dd");
    days.push({
      isoDate,
      dayNumber: cursor.toFormat("d"),
      isCurrentMonth: cursor.month === monthStart.month && cursor.year === monthStart.year,
      isBeforeStart: isoDate < startIsoDate,
    });
    cursor = cursor.plus({ days: 1 });
  }

  return {
    monthLabel: monthStart.toFormat("LLLL yyyy"),
    days,
  };
}

function normalizeEditorId(rawEditorId: string | null): string | null {
  const normalized = rawEditorId?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function resolveBookingModeFromDetail(
  detail: BookedLabel["details"][number],
  isMikeEditor: boolean,
  overtureCalendarId?: string,
): "la" | "overture" {
  if (isMikeEditor) return "overture";
  if (overtureCalendarId && detail.calendarId === overtureCalendarId) return "overture";
  return "la";
}

function isOvertureDetail(
  detail: BookedLabel["details"][number],
  overtureCalendarId?: string,
): boolean {
  const summary = detail.summary.trim().toLowerCase();
  const matchesSummary = summary === "overture";
  const matchesCalendar = !!overtureCalendarId && detail.calendarId === overtureCalendarId;
  return matchesSummary || matchesCalendar;
}

function isLaDetail(
  detail: BookedLabel["details"][number],
  laCalendarId?: string,
  overtureCalendarId?: string,
): boolean {
  if ((detail.displayMode ?? "details") !== "details") return false;
  if (isOvertureDetail(detail, overtureCalendarId)) return false;
  if (laCalendarId && detail.calendarId === laCalendarId) return true;
  return /^LA#\d+/i.test(detail.summary.trim());
}

function canViewDetailNotes(
  detail: BookedLabel["details"][number],
  resolvedEditorId: string | null,
  laCalendarId?: string,
  overtureCalendarId?: string,
): boolean {
  const editorId = normalizeEditorId(resolvedEditorId);
  if (!editorId) return false;
  if (editorId === "jeff" || editorId === "legacy") return true;
  return canManageDetailForEditor(
    detail,
    editorId,
    laCalendarId,
    overtureCalendarId,
  );
}

function canManageDetailForEditor(
  detail: BookedLabel["details"][number],
  resolvedEditorId: string | null,
  laCalendarId?: string,
  overtureCalendarId?: string,
): boolean {
  if ((detail.displayMode ?? "details") !== "details") return false;
  if (!detail.eventId) return false;

  const editorId = normalizeEditorId(resolvedEditorId);
  if (!editorId) return true;

  const calendarId = detail.calendarId;
  const ownerEditor = normalizeEditorId(detail.ownerEditor ?? null);

  if (editorId === "jeff" || editorId === "legacy") return true;

  if (editorId === "dave") {
    return !!laCalendarId && calendarId === laCalendarId;
  }

  if (editorId === "milos") {
    return !!laCalendarId
      && calendarId === laCalendarId
      && ownerEditor === editorId;
  }

  if (editorId === "mike") {
    return !!overtureCalendarId
      && calendarId === overtureCalendarId;
  }

  return true;
}

function findEditableDetail(
  details: BookedLabel["details"],
  resolvedEditorId: string | null,
  laCalendarId?: string,
  overtureCalendarId?: string,
): BookedLabel["details"][number] | null {
  return details.find((detail) =>
    canManageDetailForEditor(detail, resolvedEditorId, laCalendarId, overtureCalendarId)) ?? null;
}

/**
 * Monthly board with compact multi-day event bars.
 */
export function MonthBoard({
  month,
  todayKey,
  initialEditorToken,
  initialResolvedEditorId = null,
  editorCalendarId,
  overtureCalendarId,
  prevHref,
  nextHref,
  canGoPrev = false,
  canGoNext = false,
  showWeekends = true,
  onNavigate,
  onDateFocus,
  onMutationSuccess,
  todayPulseToken = 0,
}: Props) {
  const router = useRouter();
  const [todayPulseActive, setTodayPulseActive] = useState(false);
  useEffect(() => {
    if (todayPulseToken === 0) return;
    setTodayPulseActive(true);
    const id = window.setTimeout(() => setTodayPulseActive(false), 1100);
    return () => window.clearTimeout(id);
  }, [todayPulseToken]);
  const swipeRef = useRef<{
    tracking: boolean;
    startX: number;
    startY: number;
    moved: boolean;
  }>({
    tracking: false,
    startX: 0,
    startY: 0,
    moved: false,
  });
  const dayNoteInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const bookingNotesInputRef = useRef<HTMLTextAreaElement | null>(null);
  const mapsLinkRef = useRef<HTMLAnchorElement | null>(null);
  const locationInputRef = useRef<HTMLInputElement | null>(null);
  const [activeDetailPanel, setActiveDetailPanel] = useState<ActiveDetailPanel | null>(null);
  const [editorToken, setEditorToken] = useState<string | null>(null);
  const [resolvedEditorId, setResolvedEditorId] = useState<string | null>(initialResolvedEditorId);
  const [activeBookingPanel, setActiveBookingPanel] = useState<ActiveBookingPanel | null>(null);
  const [bookingLaNumber, setBookingLaNumber] = useState("");
  const [bookingJobName, setBookingJobName] = useState("");
  const [bookingEndDate, setBookingEndDate] = useState("");
  const [bookingPickerMonthKey, setBookingPickerMonthKey] = useState("");
  const [bookingPickerExpanded, setBookingPickerExpanded] = useState(false);
  const [bookingCallTimeOption, setBookingCallTimeOption] = useState("TBD");
  const [bookingCallTimeOther, setBookingCallTimeOther] = useState("");
  const [bookingNotes, setBookingNotes] = useState("");
  const [bookingLocation, setBookingLocation] = useState("");
  const [locationQuery, setLocationQuery] = useState("");
  const [locationCoords, setLocationCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [locationActiveIndex, setLocationActiveIndex] = useState(-1);
  const [bookingDayOverrides, setBookingDayOverrides] = useState<BookingDayOverrideMap>({});
  const [bookingExistingDescriptionRaw, setBookingExistingDescriptionRaw] = useState("");
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [isBookingSavePending, setIsBookingSavePending] = useState(false);
  const [singleDayPresetsExpanded, setSingleDayPresetsExpanded] = useState<boolean | null>(null);
  const [expandedDayPresetsByDate, setExpandedDayPresetsByDate] = useState<Record<string, boolean>>({});
  const [confirmDeleteEventId, setConfirmDeleteEventId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeletePending, setIsDeletePending] = useState(false);
  const stagedLoadingCopy = useStagedLoadingCopy(isBookingSavePending || isDeletePending);
  const editorModeActive = !!(editorToken || resolvedEditorId);
  const normalizedEditorId = resolvedEditorId?.trim().toLowerCase() ?? null;
  const isMikeEditor = normalizedEditorId === "mike";
  const isJeffCreateModeSelectable = normalizedEditorId === "jeff" || normalizedEditorId === "legacy";
  const defaultBookingMode: "la" | "overture" = isMikeEditor ? "overture" : "la";

  const { suggestions: locationSuggestions, isLoading: isLocationLoading } =
    useLocationAutocomplete(locationQuery);

  useEffect(() => {
    setLocationActiveIndex(-1);
  }, [locationSuggestions]);

  const handleSuggestionSelect = (suggestion: LocationSuggestion) => {
    setBookingLocation(suggestion.displayName);
    setLocationQuery("");
    setLocationCoords({ lat: suggestion.lat, lon: suggestion.lon });
    setLocationActiveIndex(-1);
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      locationInputRef.current?.blur();
      requestAnimationFrame(() => {
        setTimeout(() => {
          const form = mapsLinkRef.current?.closest('.month-booking-form') as HTMLElement | null;
          form?.scrollTo({ top: form.scrollHeight, behavior: 'auto' });
        }, 100);
      });
    }
  };

  useEffect(() => {
    if (!activeDetailPanel && !activeBookingPanel) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isBookingSavePending || isDeletePending) return;
        setActiveDetailPanel(null);
        closeBookingPanel();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDetailPanel, activeBookingPanel, isBookingSavePending, isDeletePending]);

  useEffect(() => {
    if (!activeDetailPanel && !activeBookingPanel) return undefined;
    const scrollY = window.scrollY;
    document.documentElement.style.setProperty("--modal-scroll-y", `-${scrollY}px`);
    document.documentElement.classList.add("modal-open");

    const updateViewport = () => {
      const h = window.innerHeight;
      const w = window.innerWidth;
      document.documentElement.style.setProperty("--visual-vh", `${h}px`);
      document.documentElement.style.setProperty("--visual-vw", `${w}px`);
    };
    updateViewport();
    window.addEventListener("resize", updateViewport);
    window.addEventListener("orientationchange", updateViewport);

    return () => {
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener("orientationchange", updateViewport);
      document.documentElement.classList.remove("modal-open");
      document.documentElement.style.removeProperty("--modal-scroll-y");
      document.documentElement.style.removeProperty("--visual-vh");
      document.documentElement.style.removeProperty("--visual-vw");
      window.scrollTo(0, scrollY);
    };
  }, [activeDetailPanel, activeBookingPanel]);

  useEffect(() => {
    const fromProp = sanitizeEditorToken(initialEditorToken);
    const fromUrl = sanitizeEditorToken(
      new URLSearchParams(window.location.search).get("editor"),
    );
    const fromSession = sanitizeEditorToken(
      window.localStorage.getItem(EDITOR_TOKEN_SESSION_KEY),
    );
    const resolved = fromProp ?? fromUrl ?? fromSession;

    if (resolved) {
      window.localStorage.setItem(EDITOR_TOKEN_SESSION_KEY, resolved);
      setEditorToken(resolved);
    } else {
      setEditorToken(null);
    }
  }, [initialEditorToken]);

  useEffect(() => {
    setResolvedEditorId(initialResolvedEditorId);
  }, [initialResolvedEditorId]);

  const closeDetailPanel = () => setActiveDetailPanel(null);
  const closeBookingPanel = () => {
    setActiveBookingPanel(null);
    setBookingLaNumber("");
    setBookingJobName("");
    setBookingEndDate("");
    setBookingPickerMonthKey("");
    setBookingPickerExpanded(false);
    setBookingCallTimeOption("TBD");
    setBookingCallTimeOther("");
    setBookingNotes("");
    setBookingLocation("");
    setLocationQuery("");
    setLocationCoords(null);
    setLocationActiveIndex(-1);
    setBookingDayOverrides({});
    setBookingExistingDescriptionRaw("");
    setBookingError(null);
    setIsBookingSavePending(false);
    setSingleDayPresetsExpanded(null);
    setExpandedDayPresetsByDate({});
    setConfirmDeleteEventId(null);
    setDeleteError(null);
    setIsDeletePending(false);
  };

  const openBookingPanel = (date: string) => {
    const startMonthKey = DateTime.fromISO(date, { zone: "utc" }).toFormat("yyyy-LL");
    setActiveDetailPanel(null);
    setActiveBookingPanel({ mode: "create", date, bookingMode: defaultBookingMode });
    setBookingLaNumber("");
    setBookingJobName("");
    setBookingEndDate(date);
    setBookingPickerMonthKey(startMonthKey);
    setBookingPickerExpanded(false);
    setBookingCallTimeOption("TBD");
    setBookingCallTimeOther("");
    setBookingNotes("");
    setBookingLocation("");
    setLocationQuery("");
    setLocationCoords(null);
    setLocationActiveIndex(-1);
    setBookingDayOverrides({});
    setBookingExistingDescriptionRaw("");
    setBookingError(null);
    setSingleDayPresetsExpanded(null);
    setExpandedDayPresetsByDate({});
    setConfirmDeleteEventId(null);
    setDeleteError(null);
  };

  const focusDateFromBarDetails = (details: BookedLabel["details"]): void => {
    const first = details[0];
    if (!first) return;
    const focusDate = first.startDate ?? first.startUtc?.slice(0, 10);
    if (!focusDate) return;
    onDateFocus?.(focusDate);
  };

  const openEditBookingPanel = (detail: BookedLabel["details"][number]) => {
    const startDate = detail.startDate ?? detail.startUtc?.slice(0, 10) ?? "";
    const endDate = detail.endDateInclusive ?? detail.endUtc?.slice(0, 10) ?? startDate;
    if (!startDate || !detail.eventId) {
      return;
    }

    const summary = parseLaJobSummary(detail.summary);
    const parsedDescription = parseGigDescription(detail.description);
    const startMonthKey = DateTime.fromISO(startDate, { zone: "utc" }).toFormat("yyyy-LL");
    const editBookingMode = resolveBookingModeFromDetail(detail, isMikeEditor, overtureCalendarId);

    const globalCallTimeOption = parsedDescription.callTime && isCallTimeOption(parsedDescription.callTime)
      ? parsedDescription.callTime
      : parsedDescription.callTime
        ? "Other"
        : "TBD";
    const globalCallTimeOther = parsedDescription.callTime && !isCallTimeOption(parsedDescription.callTime)
      ? parsedDescription.callTime
      : "";

    const rehydratedDayOverrides: BookingDayOverrideMap = {};
    if (parsedDescription.dayDetails) {
      for (const [date, dayDetail] of Object.entries(parsedDescription.dayDetails)) {
        const savedTime = dayDetail.startTime?.trim() ?? "";
        const savedNotes = dayDetail.notes?.trim() ?? "";
        const dayCallTimeOption = savedTime && isCallTimeOption(savedTime)
          ? savedTime
          : savedTime
            ? "Other"
            : "TBD";
        const dayCallTimeOther = savedTime && !isCallTimeOption(savedTime) ? savedTime : "";
        const differsFromGlobal = dayCallTimeOption !== globalCallTimeOption
          || dayCallTimeOther !== globalCallTimeOther;
        if (differsFromGlobal || savedNotes) {
          rehydratedDayOverrides[date] = {
            callTimeOption: dayCallTimeOption,
            callTimeOther: dayCallTimeOther,
            notes: savedNotes,
          };
        }
      }
    }

    setActiveBookingPanel({
      mode: "edit",
      eventId: detail.eventId,
      date: startDate,
      bookingMode: editBookingMode,
    });
    setBookingLaNumber(editBookingMode === "overture" ? "" : (summary.jobNumber?.replace(/\D/g, "") ?? ""));
    setBookingJobName(editBookingMode === "overture" ? (parsedDescription.jobTitle?.trim() ?? "") : summary.jobName);
    setBookingEndDate(endDate);
    setBookingPickerMonthKey(startMonthKey);
    setBookingPickerExpanded(false);
    setBookingCallTimeOption(globalCallTimeOption);
    setBookingCallTimeOther(globalCallTimeOther);
    setBookingNotes(parsedDescription.jobNotes ?? "");
    setBookingLocation(detail.location?.trim() ?? "");
    setLocationQuery("");
    setLocationCoords(null);
    setLocationActiveIndex(-1);
    setBookingDayOverrides(rehydratedDayOverrides);
    setBookingExistingDescriptionRaw(detail.description ?? "");
    setBookingError(null);
    setSingleDayPresetsExpanded(null);
    setExpandedDayPresetsByDate({});
    setConfirmDeleteEventId(null);
    setDeleteError(null);
    setIsDeletePending(false);
    setActiveDetailPanel(null);
  };

  const applySameDaySelection = () => {
    dismissMobileKeyboardForRangeChange();
    if (!activeBookingPanel) return;
    const sameDay = activeBookingPanel.date;
    setBookingEndDate(sameDay);
    setBookingPickerMonthKey(DateTime.fromISO(sameDay, { zone: "utc" }).toFormat("yyyy-LL"));
    setBookingPickerExpanded(false);
    if (bookingError) setBookingError(null);
  };

  const dismissMobileKeyboardForRangeChange = () => {
    if (typeof window === "undefined") return;
    if (!window.matchMedia(MOBILE_BOOKING_MEDIA_QUERY).matches) return;
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return;
    if (
      !(activeElement instanceof HTMLInputElement)
      && !(activeElement instanceof HTMLTextAreaElement)
      && !(activeElement instanceof HTMLSelectElement)
      && !activeElement.isContentEditable
    ) {
      return;
    }
    activeElement.blur();
  };

  const updateBookingDayOverride = (
    date: string,
    patch: Partial<BookingDayOverride>,
  ) => {
    setBookingDayOverrides((current) => {
      const previous = current[date] ?? {
        callTimeOption: bookingCallTimeOption,
        callTimeOther: bookingCallTimeOther,
        notes: "",
      };
      return {
        ...current,
        [date]: {
          ...previous,
          ...patch,
        },
      };
    });
    if (bookingError) setBookingError(null);
  };

  async function saveBooking() {
    if (!activeBookingPanel || isBookingSavePending) return;
    if (!editorModeActive) {
      setBookingError("Editor token missing. Re-open the editor link.");
      return;
    }
    let summary: string;
    if (activeBookingPanel.bookingMode === "overture") {
      summary = "Overture";
    } else {
      try {
        summary = buildLaJobSummary(bookingLaNumber, bookingJobName);
      } catch (error) {
        setBookingError(error instanceof Error ? error.message : "Invalid LA job details.");
        return;
      }
    }
    const startDate = activeBookingPanel.date;
    const endDate = bookingEndDate.trim() || startDate;
    if (!DateTime.fromISO(endDate, { zone: "utc" }).isValid) {
      setBookingError("Select a valid End Date.");
      return;
    }
    if (endDate < startDate) {
      setBookingError("End Date cannot be before Start Date.");
      return;
    }

    setBookingError(null);
    setIsBookingSavePending(true);
    const callTime = resolveCallTimeFromInputs(bookingCallTimeOption, bookingCallTimeOther);
    if (bookingCallTimeOption === "Other" && !callTime) {
      setBookingError("Enter a custom Call Time or choose another option.");
      setIsBookingSavePending(false);
      return;
    }
    const selectedDates = enumerateIsoDatesInRange(startDate, endDate);
    const bookingHasMultiDayRange = selectedDates.length > 1;
    const dailyOverrides = bookingHasMultiDayRange
      ? selectedDates
      .map((date) => {
        const override = bookingDayOverrides[date];
        if (!override) return null;
        const overrideCallTime = resolveCallTimeFromInputs(override.callTimeOption, override.callTimeOther);
        if (override.callTimeOption === "Other" && !overrideCallTime) {
          return { date, invalid: true as const };
        }
        return {
          date,
          startTime: overrideCallTime,
          notes: override.notes,
        };
      })
      .filter((row): row is { date: string; startTime: string; notes: string } | { date: string; invalid: true } => row != null)
      : [];
    const invalidDailyOverride = bookingHasMultiDayRange
      ? dailyOverrides.find((detail) => "invalid" in detail)
      : null;
    if (bookingHasMultiDayRange && invalidDailyOverride) {
      setBookingError(`Enter a custom start time for ${formatCompactDate(invalidDailyOverride.date)} or choose another option.`);
      setIsBookingSavePending(false);
      return;
    }
    const dayDetails = bookingHasMultiDayRange
      ? buildGigDayDetailsForRange({
          startDate,
          endDateInclusive: endDate,
          defaultStartTime: callTime,
          defaultNotes: undefined,
          overrides: dailyOverrides,
        })
      : undefined;
    const overtureJobTitle = activeBookingPanel.bookingMode === "overture" && bookingJobName.trim()
      ? bookingJobName.trim()
      : undefined;
    const description = activeBookingPanel.mode === "edit"
      ? mergeGigDescriptionWithDailyDetailsBlock(bookingExistingDescriptionRaw, {
          callTime,
          jobNotes: bookingNotes,
          dayDetails,
          jobTitle: overtureJobTitle,
        })
      : buildGigDescription(callTime, bookingNotes, dayDetails, overtureJobTitle);

    try {
      const endpoint = activeBookingPanel.mode === "edit"
        ? activeBookingPanel.eventId
          ? `/api/gigs/${encodeURIComponent(activeBookingPanel.eventId)}`
          : null
        : "/api/gigs/create";
      if (!endpoint) {
        setBookingError("Missing event id for edit.");
        setIsBookingSavePending(false);
        return;
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (editorToken) {
        headers.Authorization = `Bearer ${editorToken}`;
      }
      const response = await fetch(endpoint, {
        method: activeBookingPanel.mode === "edit" ? "PATCH" : "POST",
        headers,
        credentials: "same-origin",
        body: JSON.stringify({
          summary,
          ...(description ? { description } : {}),
          ...(activeBookingPanel.mode === "create" ? { bookingMode: activeBookingPanel.bookingMode } : {}),
          startDate,
          endDate,
        }),
      });

      if (response.ok) {
        closeBookingPanel();
        onMutationSuccess?.();
        router.refresh();
        return;
      }

      if (response.status === 401) {
        window.localStorage.removeItem(EDITOR_TOKEN_SESSION_KEY);
        setEditorToken(null);
        setResolvedEditorId(null);
        setBookingError("Editor session expired. Re-open the editor link.");
        return;
      }

      let message = "Could not save booking.";
      try {
        const payload = await response.json() as { message?: string };
        if (payload.message?.trim()) {
          message = payload.message.trim();
        }
      } catch {
        // ignore parse issues and keep generic message
      }
      setBookingError(message);
    } catch {
      setBookingError("Network error while saving booking.");
    } finally {
      setIsBookingSavePending(false);
    }
  }

  async function deleteActiveGig(eventId: string) {
    if (!editorModeActive || isDeletePending) return;

    setDeleteError(null);
    setIsDeletePending(true);
    try {
      const headers: Record<string, string> = {};
      if (editorToken) {
        headers.Authorization = `Bearer ${editorToken}`;
      }
      const response = await fetch(`/api/gigs/${encodeURIComponent(eventId)}`, {
        method: "DELETE",
        headers,
        credentials: "same-origin",
      });

      if (response.ok) {
        setConfirmDeleteEventId(null);
        setActiveDetailPanel(null);
        onMutationSuccess?.();
        router.refresh();
        return;
      }

      if (response.status === 401) {
        window.localStorage.removeItem(EDITOR_TOKEN_SESSION_KEY);
        setEditorToken(null);
        setResolvedEditorId(null);
        setDeleteError("Editor session expired. Re-open the editor link.");
        return;
      }

      let message = "Could not delete job.";
      try {
        const payload = await response.json() as { message?: string; error?: string };
        if (payload.message?.trim()) {
          message = payload.message.trim();
        } else if (payload.error?.trim()) {
          message = `Could not delete job (${response.status} ${payload.error.trim()}).`;
        }
      } catch {
        // ignore parse issues and keep generic message
      }
      setDeleteError(message);
    } catch {
      setDeleteError("Network error while deleting job.");
    } finally {
      setIsDeletePending(false);
    }
  }
  const todayMonthKey = todayKey.slice(0, 7);
  const monthIsPast = month.monthKey < todayMonthKey;
  const hideWeekends = isMikeEditor && !showWeekends;
  const visibleDayIndexes = resolveVisibleDayIndexes(hideWeekends);
  const visibleWeeks = filterMonthWeeksForVisibleCurrentMonthDays(
    month.weeks,
    visibleDayIndexes,
    hideWeekends,
  );
  const visibleDayCount = visibleDayIndexes.length;
  const weekdayLabels = visibleDayIndexes.map((index) => WEEKDAY_LABELS[index] ?? "");
  const bookingDateLabel = activeBookingPanel
    ? formatShortDate(activeBookingPanel.date)
    : null;
  const isOvertureBookingMode = activeBookingPanel?.bookingMode === "overture";
  const showBookingModeSelector = !!(
    activeBookingPanel
    && activeBookingPanel.mode === "create"
    && isJeffCreateModeSelectable
  );
  const bookingStartDate = activeBookingPanel?.date ?? "";
  const bookingStartMonth = bookingStartDate
    ? DateTime.fromISO(bookingStartDate, { zone: "utc" }).startOf("month")
    : null;
  const bookingViewMonth = bookingPickerMonthKey
    ? DateTime.fromFormat(bookingPickerMonthKey, "yyyy-LL", { zone: "utc" }).startOf("month")
    : bookingStartMonth;
  const bookingCalendar = bookingStartDate
    && bookingViewMonth?.isValid
    ? buildBookingCalendarDays(bookingStartDate, bookingViewMonth.toFormat("yyyy-LL"))
    : null;
  const parsedBookingEndDate = bookingEndDate.trim() || "";
  const bookingStartLabel = bookingStartDate ? formatShortDate(bookingStartDate) : "";
  const bookingRangeLabel = bookingStartDate
    ? (() => {
        if (!parsedBookingEndDate) {
          return "Select end date";
        }
        if (parsedBookingEndDate === bookingStartDate) {
          return `${bookingStartLabel} only`;
        }
        if (parsedBookingEndDate > bookingStartDate) {
          return `${bookingStartLabel} – ${formatShortDate(parsedBookingEndDate)}`;
        }
        return "Select end date";
      })()
    : "Select end date";
  const bookingSelectedDates = bookingStartDate && parsedBookingEndDate
    ? enumerateIsoDatesInRange(bookingStartDate, parsedBookingEndDate >= bookingStartDate ? parsedBookingEndDate : bookingStartDate)
    : [];
  const bookingHasMultiDayRange = bookingSelectedDates.length > 1;
  const defaultPresetsExpanded = false;
  const singleDayPresetsOpen = singleDayPresetsExpanded ?? defaultPresetsExpanded;
  const overallJobNotesLabel = "Job Notes";
  const resolveCallTimeFromInputs = (option: string, other: string): string => (
    option === "Other" ? other.trim() : option.trim()
  );
  const canGoToPreviousBookingMonth = bookingStartMonth && bookingViewMonth
    ? bookingViewMonth > bookingStartMonth
    : false;
  const activeEditableDetail = activeDetailPanel
    ? findEditableDetail(
        activeDetailPanel.details,
        normalizedEditorId,
        editorCalendarId,
        overtureCalendarId,
      )
    : null;
  const activeEditableSummary = activeEditableDetail
    ? parseLaJobSummary(activeEditableDetail.summary)
    : null;
  const activeEditableDescription = activeEditableDetail
    ? parseGigDescription(activeEditableDetail.description)
    : null;
  const activeDetailIsOverture = !!(
    activeDetailPanel
    && activeDetailPanel.details.some((detail) => isOvertureDetail(detail, overtureCalendarId))
  );
  const activeDetailIsLa = !!(
    activeDetailPanel
    && activeDetailPanel.details.some((detail) => isLaDetail(detail, editorCalendarId, overtureCalendarId))
  );
  const activeDetailRangeBounds = activeDetailPanel
    ? activeDetailPanel.details
      .map(resolveDetailRangeBounds)
      .filter((value): value is { startDate: string; endDateInclusive: string } => value != null)
      .reduce<{ startDate: string; endDateInclusive: string } | null>((acc, current) => {
        if (!acc) return current;
        return {
          startDate: current.startDate < acc.startDate ? current.startDate : acc.startDate,
          endDateInclusive: current.endDateInclusive > acc.endDateInclusive
            ? current.endDateInclusive
            : acc.endDateInclusive,
        };
      }, null)
    : null;
  const activeDetailRangeLabel = activeDetailRangeBounds
    ? formatMonthPopupRange(activeDetailRangeBounds.startDate, activeDetailRangeBounds.endDateInclusive)
    : activeDetailPanel?.details[0]?.dateRangeLabel ?? null;
  const activeDetailIsMultiDay = !!(
    activeDetailRangeBounds
    && activeDetailRangeBounds.startDate !== activeDetailRangeBounds.endDateInclusive
  );
  const activeDetailDayRows: MonthPopupDayDetailRow[] = (() => {
    if (!activeDetailPanel || !activeDetailRangeBounds) return [];
    const rows: MonthPopupDayDetailRow[] = [];
    const allDates = enumerateIsoDatesInRange(
      activeDetailRangeBounds.startDate,
      activeDetailRangeBounds.endDateInclusive,
    );
    for (const date of allDates) {
      let startTime: string | null = null;
      let dayNotes: string | null = null;
      for (const detail of activeDetailPanel.details) {
        if (!detailIncludesDate(detail, date)) continue;
        if (!canViewDetailNotes(detail, normalizedEditorId, editorCalendarId, overtureCalendarId)) {
          continue;
        }
        const parsed = parseGigDescription(detail.description);
        const resolved = resolveParsedGigDetailForDate(parsed, date);
        if (!startTime && resolved.startTime?.trim()) {
          startTime = resolved.startTime.trim();
        }
        if (!dayNotes && parsed.dayDetails?.[date]?.notes?.trim()) {
          dayNotes = parsed.dayDetails[date]?.notes?.trim() ?? null;
        }
        if (startTime && dayNotes) break;
      }
      rows.push({ date, startTime, dayNotes });
    }
    return rows;
  })();
  const activeDetailOverallNotes = (() => {
    if (!activeDetailPanel) return null;
    for (const detail of activeDetailPanel.details) {
      if (!canViewDetailNotes(detail, normalizedEditorId, editorCalendarId, overtureCalendarId)) {
        continue;
      }
      const parsed = parseGigDescription(detail.description);
      const notes = parsed.jobNotes?.trim();
      if (notes) return notes;
    }
    return null;
  })();
  const activeDetailLocation = (() => {
    if (!activeDetailPanel) return null;
    for (const detail of activeDetailPanel.details) {
      if (!canViewDetailNotes(detail, normalizedEditorId, editorCalendarId, overtureCalendarId)) continue;
      const loc = detail.location?.trim();
      if (loc) return loc;
    }
    return null;
  })();
  const activeDetailPrimaryTitle = (() => {
    if (!activeDetailPanel) return "";
    if (activeDetailIsOverture) {
      const firstDetail = activeDetailPanel.details[0];
      if (!firstDetail) return "";
      if (!canViewDetailNotes(firstDetail, normalizedEditorId, editorCalendarId, overtureCalendarId)) return "";
      return parseGigDescription(firstDetail.description).jobTitle?.trim() ?? "";
    }
    return stripJobPrefix(activeDetailPanel.details[0]?.summary ?? activeDetailPanel.header, activeDetailPanel.headerJobNumber);
  })();
  const canManageActiveDetail = editorModeActive
    && !!activeEditableDetail;
  const showDeleteConfirm = !!confirmDeleteEventId
    && !!activeEditableDetail
    && confirmDeleteEventId === activeEditableDetail.eventId;
  const detailModalIsLocked = isDeletePending;
  const bookingModalIsLocked = isBookingSavePending;
  const renderLoadingOverlay = (title: "Saving job…" | "Deleting job…") => (
    <div className="board-day-modal-loading-overlay" role="status" aria-live="polite">
      <div className="board-day-modal-loading-indicator">
        <div className="board-day-modal-loading-spinner" aria-hidden="true">
          <div className="board-day-modal-loading-spinner-track" />
          <div className="board-day-modal-loading-spinner-arc" />
        </div>
        <p className="board-day-modal-loading-title">{title}</p>
        <p className="board-day-modal-loading-copy">{stagedLoadingCopy}</p>
      </div>
    </div>
  );
  const swipeDisabled = !!activeDetailPanel || !!activeBookingPanel || isDeletePending || isBookingSavePending;

  const onTouchStart: TouchEventHandler<HTMLElement> = (event) => {
    if (swipeDisabled) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, a, input, select, textarea, [role='button']")) {
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    swipeRef.current = {
      tracking: true,
      startX: touch.clientX,
      startY: touch.clientY,
      moved: false,
    };
  };

  const onTouchMove: TouchEventHandler<HTMLElement> = (event) => {
    const state = swipeRef.current;
    if (!state.tracking || state.moved || swipeDisabled) return;
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - state.startX;
    const dy = touch.clientY - state.startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (absDy > absDx && absDy > 16) {
      state.tracking = false;
      return;
    }

    if (absDx < 64 || absDx <= absDy) return;

    state.moved = true;
    state.tracking = false;
    if (dx < 0 && canGoNext && nextHref) {
      if (onNavigate) {
        onNavigate(nextHref);
      } else {
        router.push(nextHref);
      }
      return;
    }
    if (dx > 0 && canGoPrev && prevHref) {
      if (onNavigate) {
        onNavigate(prevHref);
      } else {
        router.push(prevHref);
      }
    }
  };

  const onTouchEnd: TouchEventHandler<HTMLElement> = () => {
    swipeRef.current.tracking = false;
  };

  const onTouchCancel: TouchEventHandler<HTMLElement> = () => {
    swipeRef.current.tracking = false;
  };

  return (
    <section
      className="month-board"
      aria-label={month.label}
      style={{ ["--month-visible-days" as string]: String(visibleDayCount) }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <div className="month-label-row">
        <h2 className="month-label period-label-animate">{month.label}</h2>
      </div>

      <div className="month-weekdays" aria-hidden="true">
        {weekdayLabels.map((label) => (
          <div key={label} className="month-weekday">
            {label}
          </div>
        ))}
      </div>

      <div
        className="month-grid"
        role="grid"
        aria-label={`${month.label} schedule`}
        style={{ ["--month-week-count" as string]: String(visibleWeeks.length) }}
      >
        {visibleWeeks.map((week, weekIndex) => {
          const dayIndexToVisibleColumn = new Map(
            visibleDayIndexes.map((dayIndex, visibleColumnIndex) => [dayIndex, visibleColumnIndex]),
          );
          const currentMonthIndexes = visibleDayIndexes.filter((index) => week.days[index]?.isCurrentMonth);
          const currentMonthStartIndex = currentMonthIndexes[0] ?? -1;
          const currentMonthEndIndex = currentMonthIndexes[currentMonthIndexes.length - 1] ?? -1;
          const visibleBars = week.bars
            .filter((bar) => !bar.isPrivateUnavailable)
            .flatMap((bar) => {
              if (currentMonthStartIndex < 0 || currentMonthEndIndex < 0) {
                return [];
              }

              const clippedRange = clipBarToVisibleDayIndexes(
                Math.max(bar.startDayIndex, currentMonthStartIndex),
                Math.min(bar.endDayIndex, currentMonthEndIndex),
                visibleDayIndexes,
              );
              if (!clippedRange) {
                return [];
              }
              const mappedStartDayIndex = dayIndexToVisibleColumn.get(clippedRange.startDayIndex);
              const mappedEndDayIndex = dayIndexToVisibleColumn.get(clippedRange.endDayIndex);
              if (mappedStartDayIndex == null || mappedEndDayIndex == null) return [];

              return [{
                ...bar,
                startDayIndex: mappedStartDayIndex,
                endDayIndex: mappedEndDayIndex,
              }];
            });

          const laneIndexes = Array.from(new Set(visibleBars.map((bar) => bar.laneIndex))).sort((a, b) => a - b);
          const laneIndexMap = new Map(laneIndexes.map((laneIndex, compactLaneIndex) => [laneIndex, compactLaneIndex]));
          const laneCount = laneIndexes.length;
          const weekBarRows = laneCount;
          return (
            <section key={`${month.monthKey}-week-${weekIndex}`} className="month-week" role="row">
              <div
                className="month-week-body"
                style={{ ["--month-week-bar-rows" as string]: String(weekBarRows) }}
              >
                {visibleBars.length > 0 ? (
                  <div className="month-week-row-bars">
                    {visibleBars.map((bar) => {
                      const detailDate = bar.details[0]?.dateRangeLabel;
                      const safeAria = `${bar.label}${detailDate ? `, ${detailDate}` : ""}`;
                      const segmentPart = bar.startDayIndex === bar.endDayIndex
                        ? "single"
                        : "span";
                      const compactLaneIndex = laneIndexMap.get(bar.laneIndex) ?? 0;

                      return (
                        <button
                          key={bar.key}
                          type="button"
                          className={[
                            "month-row-bar",
                            `month-row-bar--${segmentPart}`,
                            "month-row-bar--details",
                          ].join(" ")}
                          style={monthBarGridStyle(bar.startDayIndex, bar.endDayIndex, compactLaneIndex)}
                          aria-label={safeAria}
                          onClick={() => {
                            focusDateFromBarDetails(bar.details);
                            closeBookingPanel();
                            if (activeDetailPanel?.barKey === bar.key) {
                              setActiveDetailPanel(null);
                              return;
                            }

                            const header = bar.jobNumber
                              ?? bar.details[0]?.summary
                              ?? bar.label
                              ?? "Busy";

                            setActiveDetailPanel({
                              barKey: bar.key,
                              header,
                              ...(bar.jobNumber ? { headerJobNumber: bar.jobNumber } : {}),
                              details: bar.details,
                            });
                          }}
                          aria-haspopup="dialog"
                          aria-expanded={activeDetailPanel?.barKey === bar.key}
                          aria-controls="month-job-detail-modal"
                          {...(!bar.isPrivateUnavailable && bar.title ? { title: bar.title } : {})}
                        >
                          <span className="month-row-bar-label">{bar.label}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <div className="month-week-days">
                  {visibleDayIndexes.map((sourceDayIndex) => {
                    const d = week.days[sourceDayIndex];
                    if (!d) return null;
                    const dayIndex = dayIndexToVisibleColumn.get(sourceDayIndex) ?? 0;
                    const isPastCurrentMonthDay = d.isCurrentMonth && (monthIsPast || d.date < todayKey);
                    const bookedLabel = d.status === "booked"
                      ? summarizeBookedDayLabel(d.eventNames, d.eventDetails, d.bookedDisplay)
                      : null;
                    const canBookDay = editorModeActive
                      && d.isCurrentMonth
                      && !isPastCurrentMonthDay
                      && d.status === "available";
                    const hasCoveringBar = visibleBars.some(
                      (bar) => dayIndex >= bar.startDayIndex && dayIndex <= bar.endDayIndex,
                    );

                    return (
                      <article
                        key={d.date}
                        role="gridcell"
                        aria-label={`${d.date}: ${d.status === "booked" ? (bookedLabel?.label ?? "Busy") : "Available"}`}
                        tabIndex={canBookDay ? 0 : undefined}
                        onClick={() => {
                          if (!d.isCurrentMonth) return;
                          onDateFocus?.(d.date);
                          if (canBookDay) {
                            openBookingPanel(d.date);
                          }
                        }}
                        onKeyDown={canBookDay
                          ? (event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                onDateFocus?.(d.date);
                                openBookingPanel(d.date);
                              }
                            }
                          : undefined}
                      className={[
                        "month-day",
                        d.status === "booked" ? "month-day--booked" : "month-day--available",
                        bookedLabel?.isPrivateUnavailable ? "month-day--booked-private" : "",
                        hasCoveringBar ? "month-day--occupied" : "",
                        isPastCurrentMonthDay ? "month-day--past" : "",
                        canBookDay ? "month-day--bookable" : "",
                        d.isToday ? "today" : "",
                        d.isToday && todayPulseActive ? "today-pulse" : "",
                        d.isCurrentMonth ? "current" : "outside",
                      ].filter(Boolean).join(" ")}
                      >
                        <div className={`month-day-num${d.isToday ? " month-day-num--today" : ""}`}>
                          {d.dayOfMonth}
                        </div>
                        {d.isCurrentMonth && !isPastCurrentMonthDay ? (
                          d.status === "available" ? (
                            canBookDay ? (
                              <span
                                className="month-day-book-button"
                                aria-hidden="true"
                              >
                                <span className="month-cell-label-full">Available</span>
                                <span className="month-cell-label-short">Avail</span>
                              </span>
                            ) : (
                              <div className="month-day-availability" aria-hidden="true">
                                <span className="month-cell-label-full">Available</span>
                                <span className="month-cell-label-short">Avail</span>
                              </div>
                            )
                          ) : bookedLabel?.isPrivateUnavailable ? (
                            <div className="month-day-unavailable-text" aria-hidden="true">
                              <span className="month-cell-label-full">Unavailable</span>
                              <span className="month-cell-label-short">Busy</span>
                            </div>
                          ) : hasCoveringBar ? (
                            <div className="month-day-placeholder" aria-hidden="true" />
                          ) : (
                            <div className="month-day-chip month-day-chip--booked" aria-hidden="true">
                              {bookedLabel?.label ?? "Busy"}
                            </div>
                          )
                        ) : (
                          <div className="month-day-placeholder" aria-hidden="true" />
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            </section>
          );
        })}
      </div>

      {activeDetailPanel ? (
        <div
          className="board-day-modal-backdrop"
          role="presentation"
          onClick={() => {
            if (detailModalIsLocked) return;
            closeDetailPanel();
          }}
        >
          <section
            id="month-job-detail-modal"
            className="board-day-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="month-job-detail-title"
            aria-busy={detailModalIsLocked || undefined}
            onClick={(event) => event.stopPropagation()}
          >
            {detailModalIsLocked ? renderLoadingOverlay("Deleting job…") : null}
            <button
              type="button"
              className="board-day-modal-close-icon"
              aria-label="Close details"
              onClick={closeDetailPanel}
              disabled={detailModalIsLocked}
            >
              ×
            </button>

            <h3 id="month-job-detail-title" className="board-day-modal-title">
              {activeDetailIsOverture ? (
                <img
                  src="/brand/overture-logo.png"
                  alt="Overture"
                  width={166}
                  height={43}
                  fetchPriority="high"
                  decoding="async"
                  className="board-day-modal-overture-logo board-day-modal-overture-logo--title"
                />
              ) : activeDetailIsLa ? (
                <span className="board-day-modal-title-with-la-brand">
                  <img
                    src="/brand/la-logo.png"
                    alt="LA"
                    width={136}
                    height={40}
                    fetchPriority="high"
                    decoding="async"
                    className="board-day-modal-la-logo"
                  />
                  <span className="board-day-modal-title-text">{activeDetailPanel.header}</span>
                </span>
              ) : (
                activeDetailPanel.header
              )}
            </h3>

            {activeDetailPanel.details.length > 0 ? (
              <div className="board-day-modal-events">
                {activeDetailPrimaryTitle && (activeDetailIsOverture || activeDetailPrimaryTitle.toLowerCase() !== activeDetailPanel.header.toLowerCase()) ? (
                  <p className="board-day-modal-event-title">{activeDetailPrimaryTitle}</p>
                ) : null}
                {activeDetailRangeLabel ? (
                  <p className="board-day-modal-event-date board-day-modal-event-date--range">{activeDetailRangeLabel}</p>
                ) : null}
                {!activeDetailIsMultiDay && activeDetailDayRows[0]?.startTime ? (
                  <p className="board-day-modal-event-meta">{activeDetailDayRows[0].startTime}</p>
                ) : null}
                {!activeDetailIsMultiDay && activeDetailDayRows[0]?.dayNotes ? (
                  <p className="board-day-modal-event-meta board-day-modal-event-meta--notes">
                    {activeDetailDayRows[0].dayNotes}
                  </p>
                ) : null}
                {activeDetailIsMultiDay && activeDetailDayRows.length > 0 ? (
                  <ul className="board-day-modal-day-breakdown">
                    {activeDetailDayRows.map((row) => (
                      <li key={row.date}>
                        <p className="board-day-modal-day-label">
                          <span className="board-day-modal-day-date">{formatShortDate(row.date)}</span>
                          <span className="board-day-modal-day-sep"> — </span>
                          <span className="board-day-modal-day-name">{formatDayAbbrev(row.date)}</span>
                        </p>
                        {row.startTime ? (
                          <p className="board-day-modal-event-meta">{row.startTime}</p>
                        ) : null}
                        {row.dayNotes ? (
                          <p className="board-day-modal-event-meta board-day-modal-event-meta--notes">
                            {row.dayNotes}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {activeDetailOverallNotes ? (
                  <>
                    <p className="board-day-modal-event-label">Job Notes</p>
                    <p className="board-day-modal-event-meta board-day-modal-event-meta--notes">
                      {activeDetailOverallNotes}
                    </p>
                  </>
                ) : null}
                {activeDetailLocation ? (
                  <>
                    <p className="board-day-modal-event-label">Job Location</p>
                    <p className="board-day-modal-event-meta">
                      {activeDetailLocation}
                    </p>
                    <LocationMapPreview location={activeDetailLocation} debounceMs={0} />
                    <a
                      href={`https://maps.apple.com/?q=${encodeURIComponent(activeDetailLocation)}`}
                      className="board-day-modal-maps-link"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in Apple Maps
                    </a>
                  </>
                ) : null}
              </div>
            ) : (
              <p className="board-day-modal-empty">No event details available.</p>
            )}

            {canManageActiveDetail ? (
              <div className="board-day-modal-actions">
                {showDeleteConfirm ? (
                  <div className="board-day-modal-confirm-delete">
                    <p className="board-day-modal-confirm-title">Delete this job?</p>
                    <p className="board-day-modal-confirm-copy">
                      This removes it from the calendar.
                    </p>
                    {deleteError ? (
                      <p className="month-booking-error" role="alert">{deleteError}</p>
                    ) : null}
                    <div className="board-day-modal-confirm-buttons">
                      <button
                        type="button"
                        className="month-booking-button month-booking-button--secondary"
                        onClick={() => setConfirmDeleteEventId(null)}
                        disabled={detailModalIsLocked}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="month-booking-button month-booking-button--danger"
                        onClick={() => {
                          if (!activeEditableDetail.eventId) return;
                          void deleteActiveGig(activeEditableDetail.eventId);
                        }}
                        disabled={detailModalIsLocked}
                      >
                        {detailModalIsLocked ? "Deleting..." : "Confirm Delete"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="board-day-modal-action-buttons">
                    <button
                      type="button"
                      className="month-booking-button month-booking-button--secondary"
                      onClick={() => openEditBookingPanel(activeEditableDetail)}
                      disabled={detailModalIsLocked}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="month-booking-button month-booking-button--secondary"
                      onClick={() => {
                        if (!activeEditableDetail.eventId) return;
                        setConfirmDeleteEventId(activeEditableDetail.eventId);
                        setDeleteError(null);
                      }}
                      disabled={detailModalIsLocked}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {activeBookingPanel && typeof document !== "undefined" ? createPortal(
        <div
          className="board-day-modal-backdrop board-day-modal-backdrop--booking board-day-modal-backdrop--booking-mobile-sheet"
          role="presentation"
          onClick={() => {
            if (bookingModalIsLocked) return;
            closeBookingPanel();
          }}
        >
          <section
            className="board-day-modal board-day-modal--booking board-day-modal--booking-mobile-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="month-booking-title"
            aria-busy={bookingModalIsLocked || undefined}
            onClick={(event) => event.stopPropagation()}
          >
            {bookingModalIsLocked ? renderLoadingOverlay("Saving job…") : null}
            <button
              type="button"
              className="board-day-modal-close-icon"
              aria-label="Close booking editor"
              onClick={closeBookingPanel}
              disabled={bookingModalIsLocked}
            >
              ×
            </button>

            <h3 id="month-booking-title" className="board-day-modal-title">
              Book Job
            </h3>
            <p className="board-day-modal-event-date">{bookingDateLabel}</p>

            <div className="month-booking-landscape-fallback" role="status" aria-live="polite">
              <h3 className="month-booking-landscape-fallback-title">Rotate to portrait</h3>
              <p className="month-booking-landscape-fallback-copy">
                Booking edits need more vertical space on mobile.
              </p>
              <p className="month-booking-landscape-fallback-subcopy">
                Turn your phone upright to continue.
              </p>
              <button
                type="button"
                className="month-booking-button month-booking-button--secondary month-booking-landscape-fallback-close"
                onClick={closeBookingPanel}
                disabled={bookingModalIsLocked}
              >
                Close
              </button>
            </div>

            <div className="month-booking-form">
              {showBookingModeSelector ? (
                <div className="month-booking-mode">
                  <p className="month-booking-label">Booking Type</p>
                  <div className="month-booking-mode-options" role="group" aria-label="Booking type">
                    <button
                      type="button"
                      className={`month-booking-mode-button${activeBookingPanel?.bookingMode === "la" ? " is-active" : ""}`}
                      onClick={() => {
                        setActiveBookingPanel((current) => {
                          if (!current || current.mode !== "create") return current;
                          return { ...current, bookingMode: "la" };
                        });
                        if (bookingError) setBookingError(null);
                      }}
                      disabled={bookingModalIsLocked}
                    >
                      LA Job
                    </button>
                    <button
                      type="button"
                      className={`month-booking-mode-button${activeBookingPanel?.bookingMode === "overture" ? " is-active" : ""}`}
                      onClick={() => {
                        setActiveBookingPanel((current) => {
                          if (!current || current.mode !== "create") return current;
                          return { ...current, bookingMode: "overture" };
                        });
                        if (bookingError) setBookingError(null);
                      }}
                      disabled={bookingModalIsLocked}
                    >
                      Overture
                    </button>
                  </div>
                </div>
              ) : null}
              {isOvertureBookingMode ? (
                <>
                  <p className="board-day-modal-event-meta board-day-modal-overture-brand board-day-modal-overture-brand--booking">
                    <img
                      src="/brand/overture-logo.png"
                      alt="Overture"
                      width={150}
                      height={44}
                      fetchPriority="high"
                      decoding="async"
                      className="board-day-modal-overture-logo board-day-modal-overture-logo--booking"
                    />
                  </p>
                  <label className="month-booking-label" htmlFor="booking-overture-title">
                    Job Title
                  </label>
                  <input
                    id="booking-overture-title"
                    name="overture-job-title"
                    className="month-booking-input"
                    autoComplete="off"
                    autoCapitalize="words"
                    value={bookingJobName}
                    onChange={(event) => {
                      setBookingJobName(event.target.value);
                      if (bookingError) setBookingError(null);
                    }}
                    placeholder="Event name"
                    maxLength={200}
                    disabled={bookingModalIsLocked}
                  />
                </>
              ) : (
                <>
                  <label
                    className="month-booking-label board-day-modal-la-brand-label"
                    htmlFor="booking-la-number"
                  >
                    <img
                      src="/brand/la-logo.png"
                      alt="LA"
                      width={132}
                      height={40}
                      fetchPriority="high"
                      decoding="async"
                      className="board-day-modal-la-logo board-day-modal-la-logo--booking"
                    />
                  </label>
                  <div className="month-booking-la-field">
                    <span className="month-booking-la-prefix" aria-hidden="true">LA#</span>
                    <input
                      id="booking-la-number"
                      name="job-number"
                      className="month-booking-input month-booking-input--la"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      value={bookingLaNumber}
                      onChange={(event) => {
                        setBookingLaNumber(event.target.value.replace(/\D/g, ""));
                        if (bookingError) setBookingError(null);
                      }}
                      placeholder="71411"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={12}
                      disabled={bookingModalIsLocked}
                    />
                  </div>

                  <label className="month-booking-label" htmlFor="booking-job-title">
                    Job Title
                  </label>
                  <input
                    id="booking-job-title"
                    name="job-title"
                    className="month-booking-input"
                    autoComplete="off"
                    autoCapitalize="words"
                    value={bookingJobName}
                    onChange={(event) => {
                      setBookingJobName(event.target.value);
                      if (bookingError) setBookingError(null);
                    }}
                    placeholder="Event name"
                    maxLength={200}
                    disabled={bookingModalIsLocked}
                  />
                </>
              )}

              <p className="month-booking-label">Date Range</p>
              <div className="month-booking-end-date-control">
                <button
                  type="button"
                  className={`month-booking-range-toggle${bookingPickerExpanded ? " is-open" : ""}`}
                  onClick={() => {
                    dismissMobileKeyboardForRangeChange();
                    setBookingPickerExpanded((prev) => !prev);
                  }}
                  aria-expanded={bookingPickerExpanded}
                  aria-controls="month-booking-calendar-panel"
                  disabled={bookingModalIsLocked}
                >
                  <span>{bookingRangeLabel}</span>
                  <span className="month-booking-range-toggle-caret" aria-hidden="true">▾</span>
                </button>
                {bookingPickerExpanded && bookingCalendar && bookingViewMonth ? (
                  <div
                    id="month-booking-calendar-panel"
                    className="month-booking-calendar"
                    role="group"
                    aria-label="End date calendar"
                  >
                    <div className="month-booking-calendar-head">
                      <button
                        type="button"
                        className="month-booking-calendar-nav"
                        onClick={() => {
                          if (!bookingViewMonth) return;
                          setBookingPickerMonthKey(bookingViewMonth.minus({ months: 1 }).toFormat("yyyy-LL"));
                          if (bookingError) setBookingError(null);
                        }}
                        disabled={bookingModalIsLocked || !canGoToPreviousBookingMonth}
                        aria-label="Previous month"
                      >
                        ‹
                      </button>
                      <div className="month-booking-calendar-header">{bookingCalendar.monthLabel}</div>
                      <button
                        type="button"
                        className="month-booking-calendar-nav"
                        onClick={() => {
                          if (!bookingViewMonth) return;
                          setBookingPickerMonthKey(bookingViewMonth.plus({ months: 1 }).toFormat("yyyy-LL"));
                          if (bookingError) setBookingError(null);
                        }}
                        disabled={bookingModalIsLocked}
                        aria-label="Next month"
                      >
                        ›
                      </button>
                    </div>
                    <div className="month-booking-calendar-weekdays" aria-hidden="true">
                      {WEEKDAY_LABELS.map((label) => (
                        <span key={label}>{label}</span>
                      ))}
                    </div>
                    <div className="month-booking-calendar-grid">
                      {bookingCalendar.days.map((day) => {
                        const isSelected = bookingEndDate === day.isoDate;
                        const isStart = day.isoDate === bookingStartDate;
                        const isEnd = day.isoDate === bookingEndDate;
                        const isInRange = !!bookingEndDate
                          && day.isoDate > bookingStartDate
                          && day.isoDate < bookingEndDate;
                        const isDisabled = day.isBeforeStart;
                        return (
                          <button
                            key={day.isoDate}
                            type="button"
                            className={[
                              "month-booking-calendar-day",
                              day.isCurrentMonth ? "is-current-month" : "is-outside-month",
                              isSelected ? "is-selected" : "",
                              isStart ? "is-start" : "",
                              isEnd ? "is-end" : "",
                              isInRange ? "is-in-range" : "",
                            ].filter(Boolean).join(" ")}
                            disabled={bookingModalIsLocked || isDisabled}
                            onClick={() => {
                              dismissMobileKeyboardForRangeChange();
                              setBookingEndDate(day.isoDate);
                              setBookingPickerExpanded(false);
                              if (bookingError) setBookingError(null);
                            }}
                            aria-label={`End date ${formatCompactDate(day.isoDate)}`}
                          >
                            {day.dayNumber}
                          </button>
                        );
                      })}
                    </div>
                    <div className="month-booking-calendar-actions">
                      <button
                        type="button"
                        className={`month-booking-same-day-button${bookingEndDate === bookingStartDate ? " is-active" : ""}`}
                        onClick={applySameDaySelection}
                        disabled={bookingModalIsLocked}
                      >
                        Same day
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              {!bookingHasMultiDayRange ? (
                <>
                  <label className="month-booking-label" htmlFor="booking-call-time">
                    Call Time
                  </label>
                  <select
                    id="booking-call-time"
                    name="job-call-time"
                    className="month-booking-input"
                    autoComplete="off"
                    value={bookingCallTimeOption}
                    onChange={(event) => {
                      setBookingCallTimeOption(event.target.value);
                      if (bookingError) setBookingError(null);
                    }}
                    disabled={bookingModalIsLocked}
                  >
                    {CALL_TIME_OPTIONS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                    <option value="Other">Other</option>
                  </select>
                  {bookingCallTimeOption === "Other" ? (
                    <input
                      id="booking-call-time-other"
                      name="job-call-time-other"
                      className="month-booking-input month-booking-input--small"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      value={bookingCallTimeOther}
                      onChange={(event) => {
                        setBookingCallTimeOther(event.target.value);
                        if (bookingError) setBookingError(null);
                      }}
                      placeholder="Custom call time"
                      maxLength={120}
                      disabled={bookingModalIsLocked}
                    />
                  ) : null}
                </>
              ) : null}

              {bookingHasMultiDayRange ? (
                <div className="month-booking-daily-details">
                  <p className="month-booking-label">
                    Call Times
                  </p>
                  <div className="month-booking-daily-list">
                    {bookingSelectedDates.map((date) => {
                      const override = bookingDayOverrides[date];
                      const dayCallTimeOption = override?.callTimeOption ?? bookingCallTimeOption;
                      const dayCallTimeOther = override?.callTimeOther ?? bookingCallTimeOther;
                      const dayNotes = override?.notes ?? "";
                      const dayPresetsExpanded = expandedDayPresetsByDate[date] ?? defaultPresetsExpanded;
                      return (
                        <div key={date} className="month-booking-daily-row">
                          <div className="month-booking-daily-row-header">
                            <span className="board-day-modal-day-date">{formatShortDate(date)}</span>
                            <span className="board-day-modal-day-sep"> — </span>
                            <span className="board-day-modal-day-name">{formatDayAbbrev(date)}</span>
                          </div>
                          <select
                            className="month-booking-input month-booking-input--small month-booking-day-time-field"
                            value={dayCallTimeOption}
                            onChange={(event) => {
                              updateBookingDayOverride(date, { callTimeOption: event.target.value });
                            }}
                            disabled={bookingModalIsLocked}
                          >
                            {CALL_TIME_OPTIONS.map((value) => (
                              <option key={value} value={value}>
                                {value}
                              </option>
                            ))}
                            <option value="Other">Other</option>
                          </select>
                          {dayCallTimeOption === "Other" ? (
                            <input
                              className="month-booking-input month-booking-input--small month-booking-day-time-field"
                              autoComplete="off"
                              autoCorrect="off"
                              autoCapitalize="off"
                              spellCheck={false}
                              value={dayCallTimeOther}
                              onChange={(event) => {
                                updateBookingDayOverride(date, { callTimeOther: event.target.value });
                              }}
                              placeholder="Custom start time"
                              maxLength={120}
                              disabled={bookingModalIsLocked}
                            />
                          ) : null}
                          <div className="month-booking-day-notes-group">
                            <input
                              ref={(el) => { dayNoteInputRefs.current[date] = el; }}
                              className="month-booking-input month-booking-input--small month-booking-day-notes-input"
                              autoComplete="off"
                              autoCapitalize="sentences"
                              value={dayNotes}
                              onChange={(event) => {
                                updateBookingDayOverride(date, { notes: event.target.value });
                              }}
                              placeholder="Notes"
                              maxLength={4000}
                              disabled={bookingModalIsLocked}
                            />
                            {!isOvertureBookingMode && (
                              <div className="month-booking-presets month-booking-presets--linked">
                                <button
                                  type="button"
                                  className={`month-booking-presets-toggle${dayPresetsExpanded ? " is-open" : ""}`}
                                  onClick={() => {
                                    setExpandedDayPresetsByDate((current) => {
                                      const currentValue = current[date] ?? defaultPresetsExpanded;
                                      return {
                                        ...current,
                                        [date]: !currentValue,
                                      };
                                    });
                                  }}
                                  disabled={bookingModalIsLocked}
                                  aria-expanded={dayPresetsExpanded}
                                  aria-controls={`day-presets-${date}`}
                                >
                                  <span>Presets</span>
                                  <span className="month-booking-presets-toggle-caret" aria-hidden="true">▾</span>
                                </button>
                                {dayPresetsExpanded ? (
                                  <div id={`day-presets-${date}`} className="month-booking-day-chips">
                                    {DAY_NOTE_CHIPS.map((chip) => {
                                      const isActive = isDayNoteChipActive(dayNotes, chip);
                                      return (
                                        <button
                                          key={chip}
                                          type="button"
                                          className={`month-booking-day-chip${isActive ? " month-booking-day-chip--active" : ""}`}
                                          onClick={() => {
                                            updateBookingDayOverride(date, { notes: applyDayNoteChip(dayNotes, chip) });
                                          }}
                                          disabled={bookingModalIsLocked}
                                        >
                                          {chip}
                                        </button>
                                      );
                                    })}
                                    <button
                                      type="button"
                                      className="month-booking-day-chip"
                                      onClick={() => {
                                        const input = dayNoteInputRefs.current[date];
                                        if (!dayNotes.trim()) {
                                          updateBookingDayOverride(date, { notes: "Other: " });
                                          setTimeout(() => input?.focus(), 0);
                                        } else {
                                          input?.focus();
                                        }
                                      }}
                                      disabled={bookingModalIsLocked}
                                    >
                                      Other
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <label className="month-booking-label" htmlFor="booking-notes">
                {overallJobNotesLabel}
              </label>
              <div className="month-booking-notes-group">
                <textarea
                  ref={bookingNotesInputRef}
                  id="booking-notes"
                  name="job-notes"
                  className="month-booking-textarea"
                  autoComplete="off"
                  autoCapitalize="sentences"
                  value={bookingNotes}
                  onChange={(event) => {
                    setBookingNotes(event.target.value);
                    if (bookingError) setBookingError(null);
                  }}
                  placeholder="Venue notes, contact, etc."
                  maxLength={4000}
                  rows={4}
                  disabled={bookingModalIsLocked}
                />
                {!bookingHasMultiDayRange && !isOvertureBookingMode ? (
                  <div className="month-booking-presets month-booking-presets--linked">
                    <button
                      type="button"
                      className={`month-booking-presets-toggle${singleDayPresetsOpen ? " is-open" : ""}`}
                      onClick={() => {
                        setSingleDayPresetsExpanded((current) => {
                          const currentValue = current ?? defaultPresetsExpanded;
                          return !currentValue;
                        });
                      }}
                      disabled={bookingModalIsLocked}
                      aria-expanded={singleDayPresetsOpen}
                      aria-controls="single-day-presets"
                    >
                      <span>Presets</span>
                      <span className="month-booking-presets-toggle-caret" aria-hidden="true">▾</span>
                    </button>
                    {singleDayPresetsOpen ? (
                      <div id="single-day-presets" className="month-booking-day-chips">
                        {DAY_NOTE_CHIPS.map((chip) => {
                          const isActive = isDayNoteChipActive(bookingNotes, chip);
                          return (
                            <button
                              key={chip}
                              type="button"
                              className={`month-booking-day-chip${isActive ? " month-booking-day-chip--active" : ""}`}
                              onClick={() => {
                                setBookingNotes((current) => applyDayNoteChip(current, chip));
                                if (bookingError) setBookingError(null);
                              }}
                              disabled={bookingModalIsLocked}
                            >
                              {chip}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          className="month-booking-day-chip"
                          onClick={() => {
                            if (!bookingNotes.trim()) {
                              setBookingNotes("Other: ");
                              if (bookingError) setBookingError(null);
                              setTimeout(() => bookingNotesInputRef.current?.focus(), 0);
                            } else {
                              bookingNotesInputRef.current?.focus();
                            }
                          }}
                          disabled={bookingModalIsLocked}
                        >
                          Other
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <label className="month-booking-label" htmlFor="booking-location">
                  Job Location
                </label>
                <input
                  ref={locationInputRef}
                  id="booking-location"
                  name="job-location"
                  type="text"
                  className="month-booking-input"
                  autoComplete="off"
                  autoCapitalize="words"
                  value={bookingLocation}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-haspopup="listbox"
                  aria-expanded={locationSuggestions.length > 0}
                  aria-controls={locationQuery.trim().length >= 3 ? "month-location-suggestions" : undefined}
                  aria-activedescendant={locationActiveIndex >= 0 ? `month-location-suggestions-${locationActiveIndex}` : undefined}
                  onChange={(event) => {
                    setBookingLocation(event.target.value);
                    setLocationQuery(event.target.value);
                    setLocationCoords(null);
                    if (bookingError) setBookingError(null);
                  }}
                  onFocus={() => {
                    const isDesktop = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
                    setTimeout(() => {
                      mapsLinkRef.current?.scrollIntoView({
                        block: isDesktop ? 'end' : 'nearest',
                        behavior: 'auto',
                      });
                    }, 100);
                    setTimeout(() => {
                      if (isDesktop) {
                        const form = mapsLinkRef.current?.closest('.month-booking-form') as HTMLElement | null;
                        form?.scrollTo({ top: form.scrollHeight, behavior: 'auto' });
                      } else {
                        mapsLinkRef.current?.scrollIntoView({
                          block: 'end',
                          behavior: 'auto',
                        });
                      }
                    }, 350);
                  }}
                  onBlur={() => {
                    setTimeout(() => { setLocationQuery(""); }, 200);
                  }}
                  onKeyDown={(e) => {
                    if (locationSuggestions.length > 0 || isLocationLoading) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setLocationActiveIndex((i) => Math.min(i + 1, locationSuggestions.length - 1));
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setLocationActiveIndex((i) => Math.max(i - 1, -1));
                      } else if (e.key === "Enter" && locationActiveIndex >= 0 && locationSuggestions[locationActiveIndex]) {
                        e.preventDefault();
                        handleSuggestionSelect(locationSuggestions[locationActiveIndex]);
                      } else if (e.key === "Escape") {
                        setLocationQuery("");
                      }
                    }
                  }}
                  placeholder="Venue name or address"
                  maxLength={500}
                  disabled={bookingModalIsLocked}
                />
                <LocationSuggestions
                  listboxId="month-location-suggestions"
                  query={locationQuery}
                  suggestions={locationSuggestions}
                  isLoading={isLocationLoading}
                  activeIndex={locationActiveIndex}
                  onSelect={handleSuggestionSelect}
                />
                {bookingLocation.trim() ? (
                  <LocationMapPreview
                    location={bookingLocation}
                    debounceMs={400}
                    coords={locationCoords}
                    geocodingEnabled={locationQuery.trim().length === 0}
                  />
                ) : null}
                <a
                  ref={mapsLinkRef}
                  href={bookingLocation.trim() ? `https://maps.apple.com/?q=${encodeURIComponent(bookingLocation.trim())}` : undefined}
                  className={`board-day-modal-maps-link${bookingLocation.trim() ? "" : " board-day-modal-maps-link--hidden"}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Preview in Apple Maps
                </a>
              </div>

            </div>

            {bookingError ? (
              <p className="month-booking-error" role="alert">{bookingError}</p>
            ) : null}

            <div className="month-booking-actions">
              <button
                type="button"
                className="month-booking-button month-booking-button--secondary"
                onClick={closeBookingPanel}
                disabled={bookingModalIsLocked}
              >
                Cancel
              </button>
              <button
                type="button"
                className="month-booking-button month-booking-button--primary"
                onClick={() => { void saveBooking(); }}
                disabled={bookingModalIsLocked}
              >
                {bookingModalIsLocked ? "Saving..." : "Save"}
              </button>
            </div>
          </section>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}
