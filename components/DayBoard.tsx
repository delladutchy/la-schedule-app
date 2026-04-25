import type { WeekGroup } from "@/lib/view";

interface Props {
  weeks: WeekGroup[];
  weekendTodayLabel?: string;
}

/**
 * Employer-facing day board.
 *
 * Each weekday renders as a single row: date on the left, status badge
 * on the right. No times, no slots, no grid. Just "Available" / "Booked".
 */
export function DayBoard({ weeks, weekendTodayLabel }: Props) {
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
      {weeks.map((wk) => (
        <section key={wk.weekOf} className="board-week" aria-label={wk.label}>
          <h2 className="board-week-label">{wk.label}</h2>
          <ul className="board-days">
            {wk.days.map((d) => {
              const todayDayNumber = String(Number(d.date.slice(8, 10)));
              const todayLabelPrefix =
                d.isToday && d.label.endsWith(todayDayNumber)
                  ? d.label.slice(0, -todayDayNumber.length)
                  : null;

              return (
                <li key={d.date} className={`board-day ${d.status}${d.isToday ? " today" : ""}`}>
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
                  <span className={`board-day-badge ${d.status}`}>
                    {d.status === "available" ? "Available" : "Booked"}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
