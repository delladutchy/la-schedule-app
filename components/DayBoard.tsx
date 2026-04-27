"use client";

import { useEffect, useState } from "react";
import {
  buildWeekConnectorParts,
  connectorKeyForDay,
  summarizeBookedDayLabel,
  type DayConnectorPart,
  type WeekGroup,
} from "@/lib/view";

interface Props {
  weeks: WeekGroup[];
  weekendTodayLabel?: string;
}

type BookedLabel = ReturnType<typeof summarizeBookedDayLabel>;

interface ActiveDetailPanel {
  rowKey: string;
  header: string;
  headerJobNumber?: string;
  details: BookedLabel["details"];
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

/**
 * Employer-facing day board.
 *
 * Each weekday renders as a single row: date on the left, status badge
 * on the right. No times, no slots, no grid. Just "Available" / "Booked".
 */
export function DayBoard({ weeks, weekendTodayLabel }: Props) {
  const [activeDetailPanel, setActiveDetailPanel] = useState<ActiveDetailPanel | null>(null);

  useEffect(() => {
    if (!activeDetailPanel) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveDetailPanel(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDetailPanel]);

  const closeDetailPanel = () => setActiveDetailPanel(null);

  const weekendMarkerDayNumber = weekendTodayLabel?.match(/(\d{1,2})$/)?.[1] ?? null;
  const weekendMarkerLabelPrefix =
    weekendTodayLabel && weekendMarkerDayNumber
      ? weekendTodayLabel.slice(0, -weekendMarkerDayNumber.length)
      : weekendTodayLabel;
  const weekendMarker = weekendTodayLabel ? (
    <div className="board-weekend-marker" aria-label={`Today: ${weekendTodayLabel}`}>
      {weekendMarkerDayNumber && weekendMarkerLabelPrefix ? (
        <span className="board-day-label-today">
          <span>{weekendMarkerLabelPrefix}</span>
          <span className="board-day-today" aria-label="Today">
            {weekendMarkerDayNumber}
          </span>
        </span>
      ) : (
        weekendTodayLabel
      )}
    </div>
  ) : null;
  const hasRows = weeks.some((wk) => wk.days.length > 0);
  const weekRows = weeks.map((wk) => {
    const dayRows = wk.days.map((d) => {
      const bookedLabel = d.status === "booked"
        ? summarizeBookedDayLabel(d.eventNames, d.eventDetails, d.bookedDisplay)
        : null;
      const connectorKey = connectorKeyForDay(d);
      return { day: d, bookedLabel, connectorKey };
    });
    const connectorKeys = dayRows.map((row) => row.connectorKey);
    return {
      wk,
      dayRows,
      connectorKeys,
    };
  });
  const weekConnectorParts = buildWeekConnectorParts(weekRows.map((week) => week.connectorKeys));

  if (!hasRows) {
    return (
      <div className="board">
        {weekendMarker}
        <div className="board-empty" role="status">
          No availability rows for this range.
        </div>
      </div>
    );
  }

  return (
    <div className="board">
      {weekendMarker}
      {weekRows.map((week, weekIndex) => (
        <section
          key={week.wk.weekOf}
          className="board-week"
          aria-label={week.wk.label}
        >
          <h2 className="board-week-label">{week.wk.label}</h2>
          <ul className="board-days">
            {week.dayRows.map((row, idx) => {
              const d = row.day;
              const rowKey = `${week.wk.weekOf}-${d.date}`;
              const todayDayNumber = String(Number(d.date.slice(8, 10)));
              const todayLabelPrefix =
                d.isToday && d.label.endsWith(todayDayNumber)
                  ? d.label.slice(0, -todayDayNumber.length)
                  : null;
              const connectorPart: DayConnectorPart = weekConnectorParts[weekIndex]?.[idx] ?? "none";
              return (
                <li
                  key={d.date}
                  className={`board-day ${d.status}${row.bookedLabel?.isPrivateUnavailable ? " booked-private" : ""}${d.isToday ? " today" : ""}`}
                >
                  <span className="board-day-label">
                    {todayLabelPrefix ? (
                      <span className="board-day-label-today">
                        <span>{todayLabelPrefix}</span>
                        <span className="board-day-today" aria-label="Today">
                          {todayDayNumber}
                        </span>
                      </span>
                    ) : (
                      d.label
                    )}
                  </span>
                  <span className="board-day-right">
                    {d.status === "available" ? (
                      <span className="board-day-badge available">Available</span>
                    ) : row.bookedLabel?.isPrivateUnavailable ? (
                      <span className="board-day-unavailable-text">Unavailable</span>
                    ) : (
                      <button
                        type="button"
                        className="board-day-badge booked board-day-pill-button"
                        title={row.bookedLabel?.title}
                        onClick={() => {
                          if (activeDetailPanel?.rowKey === rowKey) {
                            setActiveDetailPanel(null);
                            return;
                          }

                          const header = row.bookedLabel?.jobNumber
                            ?? row.bookedLabel?.details[0]?.summary
                            ?? row.bookedLabel?.label
                            ?? "Busy";

                          setActiveDetailPanel({
                            rowKey,
                            header,
                            ...(row.bookedLabel?.jobNumber
                              ? { headerJobNumber: row.bookedLabel.jobNumber }
                              : {}),
                            details: row.bookedLabel?.details ?? [],
                          });
                        }}
                        aria-haspopup="dialog"
                        aria-expanded={activeDetailPanel?.rowKey === rowKey}
                        aria-controls="week-job-detail-modal"
                      >
                        {row.bookedLabel?.label ?? "Busy"}
                      </button>
                    )}
                  </span>
                  <span
                    className={`board-day-connector board-day-connector--${connectorPart}`}
                    aria-hidden="true"
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {activeDetailPanel ? (
        <div
          className="board-day-modal-backdrop"
          role="presentation"
          onClick={closeDetailPanel}
        >
          <section
            id="week-job-detail-modal"
            className="board-day-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="week-job-detail-title"
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

            <h3 id="week-job-detail-title" className="board-day-modal-title">
              {activeDetailPanel.header}
            </h3>

            {activeDetailPanel.details.length > 0 ? (
              <ul className="board-day-modal-events">
                {activeDetailPanel.details.map((detail, index) => (
                  <li
                    key={`${detail.summary}-${detail.dateRangeLabel ?? ""}-${detail.timeRangeLabel ?? ""}-${index}`}
                  >
                    {(() => {
                      const detailTitle = stripJobPrefix(detail.summary, activeDetailPanel.headerJobNumber);
                      const hideTitle = !activeDetailPanel.headerJobNumber
                        && (
                          detail.summary === "Unavailable"
                          || (activeDetailPanel.details.length === 1
                            && detail.summary === activeDetailPanel.header)
                        );

                      return !hideTitle ? (
                        <p className="board-day-modal-event-title">{detailTitle}</p>
                      ) : null;
                    })()}
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
                ))}
              </ul>
            ) : (
              <p className="board-day-modal-empty">No event details available.</p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
