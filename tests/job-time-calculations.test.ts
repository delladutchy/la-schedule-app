import { describe, expect, it } from "vitest";
import {
  calculateTimeHours,
  formatHoursDisplay,
  formatElapsed,
} from "@/lib/job-time-calculations";

describe("calculateTimeHours", () => {
  it("computes 8 hours for an 8-hour shift", () => {
    const { totalHours, regularHours, overtimeHours } = calculateTimeHours(
      "2026-05-18T09:00:00Z",
      "2026-05-18T17:00:00Z",
    );
    expect(totalHours).toBeCloseTo(8, 5);
    expect(regularHours).toBeCloseTo(8, 5);
    expect(overtimeHours).toBe(0);
  });

  it("caps regular at 10 and computes overtime for a 12-hour shift", () => {
    const { totalHours, regularHours, overtimeHours } = calculateTimeHours(
      "2026-05-18T06:00:00Z",
      "2026-05-18T18:00:00Z",
    );
    expect(totalHours).toBeCloseTo(12, 5);
    expect(regularHours).toBeCloseTo(10, 5);
    expect(overtimeHours).toBeCloseTo(2, 5);
  });

  it("uses nowIso when clock_out_at is null (running clock)", () => {
    const clockIn = "2026-05-18T09:00:00Z";
    const now = "2026-05-18T12:30:00Z"; // 3.5h later
    const { totalHours } = calculateTimeHours(clockIn, null, now);
    expect(totalHours).toBeCloseTo(3.5, 5);
  });

  it("returns 0 hours when clock-in equals clock-out", () => {
    const ts = "2026-05-18T09:00:00Z";
    const { totalHours, regularHours, overtimeHours } = calculateTimeHours(ts, ts);
    expect(totalHours).toBe(0);
    expect(regularHours).toBe(0);
    expect(overtimeHours).toBe(0);
  });

  it("clamps to 0 if clock-out somehow predates clock-in", () => {
    const { totalHours } = calculateTimeHours(
      "2026-05-18T10:00:00Z",
      "2026-05-18T09:00:00Z",
    );
    expect(totalHours).toBe(0);
  });

  it("correctly handles exactly 10 hours (no OT)", () => {
    const { regularHours, overtimeHours } = calculateTimeHours(
      "2026-05-18T08:00:00Z",
      "2026-05-18T18:00:00Z",
    );
    expect(regularHours).toBeCloseTo(10, 5);
    expect(overtimeHours).toBe(0);
  });
});

describe("formatHoursDisplay", () => {
  it("rounds to nearest 0.25h", () => {
    expect(formatHoursDisplay(8.1)).toBe("8.00");   // rounds down
    expect(formatHoursDisplay(8.2)).toBe("8.25");   // rounds to 0.25
    expect(formatHoursDisplay(8.4)).toBe("8.50");   // rounds to 0.5
    expect(formatHoursDisplay(8.6)).toBe("8.50");   // rounds to 0.5 (not 0.75 since 0.6*4=2.4, rounds to 2)
    expect(formatHoursDisplay(8.63)).toBe("8.75");  // rounds to 0.75
    expect(formatHoursDisplay(10.9)).toBe("11.00"); // rounds up
  });

  it("always returns two decimal places", () => {
    expect(formatHoursDisplay(8)).toBe("8.00");
    expect(formatHoursDisplay(0.25)).toBe("0.25");
  });
});

describe("formatElapsed", () => {
  it("formats 1.5 hours as 1:30:00", () => {
    expect(formatElapsed(1.5)).toBe("1:30:00");
  });

  it("formats 0 hours as 0:00:00", () => {
    expect(formatElapsed(0)).toBe("0:00:00");
  });

  it("pads minutes and seconds with leading zeros", () => {
    expect(formatElapsed(1 / 60)).toBe("0:01:00");     // 1 min
    expect(formatElapsed(1 / 3600)).toBe("0:00:01");   // 1 sec
    expect(formatElapsed(10 + 5 / 60 + 3 / 3600)).toBe("10:05:03");
  });
});
