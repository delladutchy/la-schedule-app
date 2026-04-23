import type { MonthBoardData } from "@/lib/view";

interface Props {
  month: MonthBoardData;
  todayKey: string;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/**
 * Monthly day-status board.
 *
 * Each day shows only date + Booked/Available status.
 */
export function MonthBoard({ month, todayKey }: Props) {
  const todayMonthKey = todayKey.slice(0, 7);
  const monthIsPast = month.monthKey < todayMonthKey;
  const flatDays = month.weeks.flatMap((w) => w.days.filter((d) => !d.isWeekend));

  return (
    <section className="month-board" aria-label={month.label}>
      <h2 className="month-label">{month.label}</h2>

      <div className="month-weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="month-weekday">
            {label}
          </div>
        ))}
      </div>

      <div className="month-grid" role="grid" aria-label={`${month.label} availability`}>
        {flatDays.map((d) => {
          const isPastCurrentMonthDay = d.isCurrentMonth && (monthIsPast || d.date < todayKey);

          return (
          <article
            key={d.date}
            role="gridcell"
            aria-label={`${d.date}: ${d.status === "booked" ? "Booked" : "Available"}`}
            className={[
              "month-day",
              d.status === "booked" ? "month-day--booked" : "month-day--available",
              isPastCurrentMonthDay ? "month-day--past" : "",
              d.isToday ? "today" : "",
              d.isCurrentMonth ? "current" : "outside",
            ].filter(Boolean).join(" ")}
          >
            <div className={`month-day-num${d.isToday ? " month-day-num--today" : ""}`}>
              {d.dayOfMonth}
            </div>
            {d.isCurrentMonth && !isPastCurrentMonthDay ? (
              <div
                className={`month-day-chip ${
                  d.status === "booked" ? "month-day-chip--booked" : "month-day-chip--available"
                }`}
                aria-hidden="true"
              >
                {d.status === "booked" ? "Booked" : "Available"}
              </div>
            ) : (
              <div className="month-day-placeholder" aria-hidden="true" />
            )}
          </article>
          );
        })}
      </div>
    </section>
  );
}
