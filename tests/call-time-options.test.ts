import { describe, expect, it } from "vitest";
import { CALL_TIME_OPTIONS } from "@/lib/call-time-options";

describe("CALL_TIME_OPTIONS", () => {
  it("includes the expected 30-minute call-time values from 5:00 AM through 12:00 AM", () => {
    expect(CALL_TIME_OPTIONS).toEqual([
      "TBD",
      "5:00 AM",
      "5:30 AM",
      "6:00 AM",
      "6:30 AM",
      "7:00 AM",
      "7:30 AM",
      "8:00 AM",
      "8:30 AM",
      "9:00 AM",
      "9:30 AM",
      "10:00 AM",
      "10:30 AM",
      "11:00 AM",
      "11:30 AM",
      "12:00 PM",
      "12:30 PM",
      "1:00 PM",
      "1:30 PM",
      "2:00 PM",
      "2:30 PM",
      "3:00 PM",
      "3:30 PM",
      "4:00 PM",
      "4:30 PM",
      "5:00 PM",
      "5:30 PM",
      "6:00 PM",
      "6:30 PM",
      "7:00 PM",
      "7:30 PM",
      "8:00 PM",
      "8:30 PM",
      "9:00 PM",
      "9:30 PM",
      "10:00 PM",
      "10:30 PM",
      "11:00 PM",
      "11:30 PM",
      "12:00 AM",
    ]);
  });

  it("does not contain duplicate values", () => {
    expect(new Set(CALL_TIME_OPTIONS).size).toBe(CALL_TIME_OPTIONS.length);
  });
});
