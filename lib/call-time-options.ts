export const CALL_TIME_OPTIONS = [
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
] as const;

export type CallTimeOption = (typeof CALL_TIME_OPTIONS)[number];

export function isCallTimeOption(value: string): value is CallTimeOption {
  return (CALL_TIME_OPTIONS as readonly string[]).includes(value);
}

export const DAY_NOTE_CHIPS = [
  "Load In",
  "Rehearsal",
  "Show",
  "Load In & Show",
  "Show & Out",
  "Load Out",
  "Travel",
  "Strike",
] as const;

function normalizeDayNoteSegment(segment: string): string {
  return segment.replace(/\s+/g, " ").trim();
}

function tokenizeDayNotes(current: string): string[] {
  return current
    .split(/\s*\/\s*/g)
    .map(normalizeDayNoteSegment)
    .filter((segment) => segment.length > 0);
}

const NORMALIZED_DAY_NOTE_CHIPS = DAY_NOTE_CHIPS.map((chip) =>
  normalizeDayNoteSegment(chip).toLowerCase());

function startsWithSegmentLabel(segment: string, label: string): boolean {
  if (!segment.startsWith(label)) return false;
  if (segment.length === label.length) return true;
  const nextChar = segment.charAt(label.length);
  return /[\s.,;:!?()[\]{}'"&/+\\|-]/.test(nextChar);
}

function segmentContainsChip(segment: string, chip: string): boolean {
  const normalizedSegment = normalizeDayNoteSegment(segment).toLowerCase();
  const normalizedChip = normalizeDayNoteSegment(chip).toLowerCase();
  if (!normalizedSegment || !normalizedChip) return false;
  if (!startsWithSegmentLabel(normalizedSegment, normalizedChip)) return false;
  if (normalizedSegment === normalizedChip) return true;

  // Avoid false positives where a longer exact preset label should win.
  const hasLongerPresetMatch = NORMALIZED_DAY_NOTE_CHIPS.some((otherChip) =>
    otherChip !== normalizedChip
      && otherChip.startsWith(normalizedChip)
      && startsWithSegmentLabel(normalizedSegment, otherChip));
  if (hasLongerPresetMatch) return false;

  return true;
}

export function isDayNoteChipActive(current: string, chip: string): boolean {
  return tokenizeDayNotes(current).some((segment) => segmentContainsChip(segment, chip));
}

export function applyDayNoteChip(current: string, chip: string): string {
  const normalizedChip = normalizeDayNoteSegment(chip);
  if (!normalizedChip) return current;
  const parts = tokenizeDayNotes(current);
  if (parts.length === 0) return normalizedChip;
  const idx = parts.findIndex((segment) => segmentContainsChip(segment, normalizedChip));
  if (idx !== -1) {
    return parts
      .filter((_, i) => i !== idx)
      .map(normalizeDayNoteSegment)
      .filter((segment) => segment.length > 0)
      .join(" / ");
  }
  return [...parts, normalizedChip].join(" / ");
}
