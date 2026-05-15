import { describe, expect, it } from "vitest";
import { CALL_TIME_OPTIONS, applyDayNoteChip, isDayNoteChipActive } from "@/lib/call-time-options";

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

describe("day note chip helpers", () => {
  it("does not activate shorter chips when a longer exact preset is present", () => {
    expect(isDayNoteChipActive("Show & Out", "Show & Out")).toBe(true);
    expect(isDayNoteChipActive("Show & Out", "Show")).toBe(false);

    expect(isDayNoteChipActive("Load In & Show", "Load In & Show")).toBe(true);
    expect(isDayNoteChipActive("Load In & Show", "Load In")).toBe(false);
    expect(isDayNoteChipActive("Load In & Show", "Show")).toBe(false);
  });

  it("keeps a chip active when the chip label still exists in a note segment with additional text", () => {
    expect(isDayNoteChipActive("Rehearsal add mic checks / Travel", "Rehearsal")).toBe(true);
  });

  it("appends and removes chips without duplicate separators", () => {
    expect(applyDayNoteChip("Load In/Travel", "Rehearsal")).toBe("Load In / Travel / Rehearsal");
    expect(applyDayNoteChip("Load In / Travel / Rehearsal", "Rehearsal")).toBe("Load In / Travel");
  });

  it("removes an active chip segment even when that segment has extra typed text", () => {
    expect(applyDayNoteChip("Load In / Rehearsal add mic checks / Travel", "Rehearsal")).toBe("Load In / Travel");
  });

  it("deactivates a chip on second tap and keeps it active while extra typed text remains", () => {
    const once = applyDayNoteChip("", "Rehearsal");
    expect(once).toBe("Rehearsal");
    const withText = `${once} / Stage A`;
    expect(isDayNoteChipActive(withText, "Rehearsal")).toBe(true);
    const twice = applyDayNoteChip(withText, "Rehearsal");
    expect(twice).toBe("Stage A");
    expect(isDayNoteChipActive(twice, "Rehearsal")).toBe(false);
  });

  it("supports multiple chips in slash-separated segments without cross-activating", () => {
    expect(isDayNoteChipActive("Load In / Load Out", "Load In")).toBe(true);
    expect(isDayNoteChipActive("Load In / Load Out", "Load Out")).toBe(true);
    expect(isDayNoteChipActive("Load In / Load Out", "Show")).toBe(false);

    expect(isDayNoteChipActive("Show / Show & Out", "Show")).toBe(true);
    expect(isDayNoteChipActive("Show / Show & Out", "Show & Out")).toBe(true);
  });
});
