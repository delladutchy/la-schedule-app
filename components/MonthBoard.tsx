"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DateTime } from "luxon";
import { summarizeBookedDayLabel, type MonthBoardData } from "@/lib/view";
import { EDITOR_TOKEN_SESSION_KEY, sanitizeEditorToken } from "@/lib/editor-session";

interface Props {
  month: MonthBoardData;
  todayKey: string;
  initialEditorToken?: string;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CALL_TIME_OPTIONS = [
  "TBD",
  "6:00 AM",
  "7:00 AM",
  "8:00 AM",
  "9:00 AM",
  "10:00 AM",
  "11:00 AM",
  "12:00 PM",
  "1:00 PM",
  "2:00 PM",
  "3:00 PM",
  "4:00 PM",
  "5:00 PM",
] as const;

type BookedLabel = ReturnType<typeof summarizeBookedDayLabel>;

interface ActiveDetailPanel {
  barKey: string;
  header: string;
  headerJobNumber?: string;
  details: BookedLabel["details"];
}

interface ActiveBookingPanel {
  date: string;
}

export function monthBarGridStyle(startDayIndex: number, endDayIndex: number, laneIndex: number): {
  gridColumn: string;
  gridRow: string;
} {
  return {
    gridColumn: `${startDayIndex + 1} / ${endDayIndex + 2}`,
    gridRow: String(laneIndex + 1),
  };
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

function buildLaJobSummary(laNumberRaw: string, jobNameRaw: string): string {
  const laNumber = laNumberRaw.trim();
  const jobName = jobNameRaw.trim();

  if (!/^\d+$/.test(laNumber)) {
    throw new Error("LA # is required and must be numbers only.");
  }
  if (!jobName) {
    throw new Error("Job Name is required.");
  }

  return `LA#${laNumber} — ${jobName}`;
}

/**
 * Monthly board with compact multi-day event bars.
 */
export function MonthBoard({ month, todayKey, initialEditorToken }: Props) {
  const router = useRouter();
  const [activeDetailPanel, setActiveDetailPanel] = useState<ActiveDetailPanel | null>(null);
  const [editorToken, setEditorToken] = useState<string | null>(null);
  const [activeBookingPanel, setActiveBookingPanel] = useState<ActiveBookingPanel | null>(null);
  const [bookingLaNumber, setBookingLaNumber] = useState("");
  const [bookingJobName, setBookingJobName] = useState("");
  const [bookingEndDate, setBookingEndDate] = useState("");
  const [bookingPickerMonthKey, setBookingPickerMonthKey] = useState("");
  const [bookingPickerExpanded, setBookingPickerExpanded] = useState(false);
  const [bookingCallTimeOption, setBookingCallTimeOption] = useState("TBD");
  const [bookingCallTimeOther, setBookingCallTimeOther] = useState("");
  const [bookingNotes, setBookingNotes] = useState("");
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [isBookingSavePending, setIsBookingSavePending] = useState(false);

  useEffect(() => {
    if (!activeDetailPanel && !activeBookingPanel) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveDetailPanel(null);
        closeBookingPanel();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDetailPanel, activeBookingPanel]);

  useEffect(() => {
    const fromProp = sanitizeEditorToken(initialEditorToken);
    const fromUrl = sanitizeEditorToken(
      new URLSearchParams(window.location.search).get("editor"),
    );
    const fromSession = sanitizeEditorToken(
      window.sessionStorage.getItem(EDITOR_TOKEN_SESSION_KEY),
    );
    const resolved = fromProp ?? fromUrl ?? fromSession;

    if (resolved) {
      window.sessionStorage.setItem(EDITOR_TOKEN_SESSION_KEY, resolved);
      setEditorToken(resolved);
    } else {
      setEditorToken(null);
    }

    const url = new URL(window.location.href);
    if (!url.searchParams.has("editor")) return;
    url.searchParams.delete("editor");
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", next);
  }, [initialEditorToken]);

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
    setBookingError(null);
    setIsBookingSavePending(false);
  };

  const editorModeActive = !!editorToken;
  const openBookingPanel = (date: string) => {
    const startMonthKey = DateTime.fromISO(date, { zone: "utc" }).toFormat("yyyy-LL");
    setActiveDetailPanel(null);
    setActiveBookingPanel({ date });
    setBookingLaNumber("");
    setBookingJobName("");
    setBookingEndDate(date);
    setBookingPickerMonthKey(startMonthKey);
    setBookingPickerExpanded(false);
    setBookingCallTimeOption("TBD");
    setBookingCallTimeOther("");
    setBookingNotes("");
    setBookingError(null);
  };

  async function saveBooking() {
    if (!activeBookingPanel || isBookingSavePending) return;
    if (!editorToken) {
      setBookingError("Editor token missing. Re-open the editor link.");
      return;
    }
    let summary: string;
    try {
      summary = buildLaJobSummary(bookingLaNumber, bookingJobName);
    } catch (error) {
      setBookingError(error instanceof Error ? error.message : "Invalid LA job details.");
      return;
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
    const callTime = bookingCallTimeOption === "Other"
      ? bookingCallTimeOther.trim()
      : bookingCallTimeOption.trim();
    if (bookingCallTimeOption === "Other" && !callTime) {
      setBookingError("Enter a custom Call Time or choose another option.");
      setIsBookingSavePending(false);
      return;
    }
    const notes = bookingNotes.trim();
    const description = [
      callTime ? `Call Time: ${callTime}` : "",
      notes ? `Job Notes: ${notes}` : "",
    ].filter(Boolean).join("\n");

    try {
      const response = await fetch("/api/gigs/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${editorToken}`,
        },
        body: JSON.stringify({
          summary,
          ...(description ? { description } : {}),
          startDate,
          endDate,
        }),
      });

      if (response.ok) {
        closeBookingPanel();
        router.refresh();
        window.location.reload();
        return;
      }

      if (response.status === 401) {
        window.sessionStorage.removeItem(EDITOR_TOKEN_SESSION_KEY);
        setEditorToken(null);
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
  const todayMonthKey = todayKey.slice(0, 7);
  const monthIsPast = month.monthKey < todayMonthKey;
  const allDays = month.weeks.flatMap((w) => w.days);
  const weekendToday = allDays.find((d) => d.date === todayKey && d.isWeekend);
  const bookingDateLabel = activeBookingPanel
    ? formatShortDate(activeBookingPanel.date)
    : null;
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
  const canGoToPreviousBookingMonth = bookingStartMonth && bookingViewMonth
    ? bookingViewMonth > bookingStartMonth
    : false;

  return (
    <section className="month-board" aria-label={month.label}>
      <div className="month-label-row">
        <h2 className="month-label">{month.label}</h2>
        {editorModeActive ? (
          <span className="editor-mode-active">Editor mode active</span>
        ) : null}
      </div>
      {weekendToday ? (
        <div className="month-weekend-today" aria-label={`Today: ${weekendToday.date}`}>
          <span className="month-day-num month-day-num--today">{weekendToday.dayOfMonth}</span>
          <span>Today</span>
        </div>
      ) : null}

      <div className="month-weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="month-weekday">
            {label}
          </div>
        ))}
      </div>

      <div className="month-grid" role="grid" aria-label={`${month.label} schedule`}>
        {month.weeks.map((week, weekIndex) => {
          const currentMonthIndexes = week.days
            .map((day, index) => (day.isCurrentMonth ? index : -1))
            .filter((index) => index >= 0);
          const currentMonthStartIndex = currentMonthIndexes[0] ?? -1;
          const currentMonthEndIndex = currentMonthIndexes[currentMonthIndexes.length - 1] ?? -1;
          const visibleBars = week.bars
            .filter((bar) => !bar.isPrivateUnavailable)
            .flatMap((bar) => {
              if (currentMonthStartIndex < 0 || currentMonthEndIndex < 0) {
                return [];
              }

              const clippedStartDayIndex = Math.max(bar.startDayIndex, currentMonthStartIndex);
              const clippedEndDayIndex = Math.min(bar.endDayIndex, currentMonthEndIndex);
              if (clippedStartDayIndex > clippedEndDayIndex) {
                return [];
              }

              return [{
                ...bar,
                startDayIndex: clippedStartDayIndex,
                endDayIndex: clippedEndDayIndex,
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
                  {week.days.map((d, dayIndex) => {
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
                        onClick={canBookDay ? () => openBookingPanel(d.date) : undefined}
                        onKeyDown={canBookDay
                          ? (event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
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
                                Click to book
                              </span>
                            ) : (
                              <div className="month-day-availability" aria-hidden="true">Available</div>
                            )
                          ) : bookedLabel?.isPrivateUnavailable ? (
                            <div className="month-day-unavailable-text" aria-hidden="true">Unavailable</div>
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
          onClick={closeDetailPanel}
        >
          <section
            id="month-job-detail-modal"
            className="board-day-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="month-job-detail-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="board-day-modal-close-icon"
              aria-label="Close details"
              onClick={closeDetailPanel}
            >
              ×
            </button>

            <h3 id="month-job-detail-title" className="board-day-modal-title">
              {activeDetailPanel.header}
            </h3>

            {activeDetailPanel.details.length > 0 ? (
              <ul className="board-day-modal-events">
                {activeDetailPanel.details.map((detail, index) => {
                  const detailTitle = stripJobPrefix(detail.summary, activeDetailPanel.headerJobNumber);
                  const hideTitle = !activeDetailPanel.headerJobNumber
                    && (
                      detail.summary === "Unavailable"
                      || (activeDetailPanel.details.length === 1
                        && detail.summary === activeDetailPanel.header)
                    );

                  return (
                    <li
                      key={`${detail.summary}-${detail.dateRangeLabel ?? ""}-${detail.timeRangeLabel ?? ""}-${index}`}
                    >
                      {!hideTitle ? (
                        <p className="board-day-modal-event-title">{detailTitle}</p>
                      ) : null}
                      {detail.dateRangeLabel ? (
                        <p className="board-day-modal-event-date">{detail.dateRangeLabel}</p>
                      ) : null}
                      {detail.timeRangeLabel ? (
                        <p className="board-day-modal-event-meta">
                          <span className="board-day-modal-event-label">Time</span>{" "}
                          {detail.timeRangeLabel}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="board-day-modal-empty">No event details available.</p>
            )}
          </section>
        </div>
      ) : null}

      {activeBookingPanel ? (
        <div
          className="board-day-modal-backdrop"
          role="presentation"
          onClick={closeBookingPanel}
        >
          <section
            className="board-day-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="month-booking-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="board-day-modal-close-icon"
              aria-label="Close booking editor"
              onClick={closeBookingPanel}
            >
              ×
            </button>

            <h3 id="month-booking-title" className="board-day-modal-title">
              Book Job
            </h3>
            <p className="board-day-modal-event-date">{bookingDateLabel}</p>

            <div className="month-booking-form">
              <label className="month-booking-label" htmlFor="booking-la-number">
                LA #
              </label>
              <div className="month-booking-la-field">
                <span className="month-booking-la-prefix" aria-hidden="true">LA#</span>
                <input
                  id="booking-la-number"
                  className="month-booking-input month-booking-input--la"
                  value={bookingLaNumber}
                  onChange={(event) => {
                    setBookingLaNumber(event.target.value.replace(/\D/g, ""));
                    if (bookingError) setBookingError(null);
                  }}
                  placeholder="71411"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={12}
                  autoFocus
                />
              </div>

              <label className="month-booking-label" htmlFor="booking-job-name">
                Job Name
              </label>
              <input
                id="booking-job-name"
                className="month-booking-input"
                value={bookingJobName}
                onChange={(event) => {
                  setBookingJobName(event.target.value);
                  if (bookingError) setBookingError(null);
                }}
                placeholder="Wilmington Flower Market"
                maxLength={200}
              />

              <p className="month-booking-label">Date Range</p>
              <div className="month-booking-end-date-control">
                <button
                  type="button"
                  className={`month-booking-range-toggle${bookingPickerExpanded ? " is-open" : ""}`}
                  onClick={() => setBookingPickerExpanded((prev) => !prev)}
                  aria-expanded={bookingPickerExpanded}
                  aria-controls="month-booking-calendar-panel"
                >
                  <span>{bookingRangeLabel}</span>
                  <span className="month-booking-range-toggle-caret" aria-hidden="true">▾</span>
                </button>
                {bookingCalendar && bookingViewMonth ? (
                  <div
                    id="month-booking-calendar-panel"
                    className="month-booking-calendar"
                    role="group"
                    aria-label="End date calendar"
                    hidden={!bookingPickerExpanded}
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
                        disabled={!canGoToPreviousBookingMonth}
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
                            disabled={isDisabled}
                            onClick={() => {
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
                        className="month-booking-same-day-button"
                        onClick={() => {
                          if (!bookingStartDate) return;
                          setBookingEndDate(bookingStartDate);
                          setBookingPickerExpanded(false);
                          if (bookingError) setBookingError(null);
                        }}
                      >
                        Same day
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <label className="month-booking-label" htmlFor="booking-call-time">
                Call Time
              </label>
              <select
                id="booking-call-time"
                className="month-booking-input"
                value={bookingCallTimeOption}
                onChange={(event) => {
                  setBookingCallTimeOption(event.target.value);
                  if (bookingError) setBookingError(null);
                }}
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
                  className="month-booking-input month-booking-input--small"
                  value={bookingCallTimeOther}
                  onChange={(event) => {
                    setBookingCallTimeOther(event.target.value);
                    if (bookingError) setBookingError(null);
                  }}
                  placeholder="Custom call time"
                  maxLength={120}
                />
              ) : null}

              <label className="month-booking-label" htmlFor="booking-notes">
                Job Notes
              </label>
              <textarea
                id="booking-notes"
                className="month-booking-textarea"
                value={bookingNotes}
                onChange={(event) => {
                  setBookingNotes(event.target.value);
                  if (bookingError) setBookingError(null);
                }}
                placeholder="Venue notes, contact, etc."
                maxLength={4000}
                rows={4}
              />

              {bookingError ? (
                <p className="month-booking-error" role="alert">{bookingError}</p>
              ) : null}

              <div className="month-booking-actions">
                <button
                  type="button"
                  className="month-booking-button month-booking-button--secondary"
                  onClick={closeBookingPanel}
                  disabled={isBookingSavePending}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="month-booking-button month-booking-button--primary"
                  onClick={() => { void saveBooking(); }}
                  disabled={isBookingSavePending}
                >
                  {isBookingSavePending ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
