/**
 * Invoice email recipient presets.
 *
 * To configure TODO_ presets: replace placeholder strings with real addresses.
 * Any preset whose `to` or `cc` arrays contain a "TODO_" string is treated as
 * unconfigured and cannot be selected for sending.
 *
 * The LA_HR_EMAIL and LA_AP_EMAIL shared inboxes only need to be filled in once.
 */

export interface RecipientPreset {
  id: string;
  label: string;
  /** Primary recipient(s). Must contain at least one non-TODO address to be enabled. */
  to: string[];
  /** CC recipients (shown to the user, sent in the CC field). */
  cc: string[];
}

export const RECIPIENT_PRESETS: RecipientPreset[] = [
  {
    id:    "test-jeff",
    label: "Test — Jeff Gmail",
    to:    ["jeffulsh@gmail.com"],
    cc:    [],
  },
  {
    id:    "light-action-dave",
    label: "Light Action — Dave",
    to:    ["dave.harris@lightaction.com", "hr@lightaction.com", "ap@lightaction.com"],
    cc:    [],
  },
  {
    id:    "light-action-milos",
    label: "Light Action — Milos",
    to:    ["milos@lightaction.com", "hr@lightaction.com", "ap@lightaction.com"],
    cc:    [],
  },
  {
    id:    "light-action-milos-only",
    label: "Light Action — Milos Only",
    to:    ["milos@lightaction.com"],
    cc:    [],
  },
  {
    id:    "overture-mike",
    label: "Overture — Mike",
    to:    ["Mpatille@overtureav.com"],
    cc:    [],
  },
];

/** Returns true when every address in the preset is a real address (no TODO_ placeholders). */
export function isPresetConfigured(preset: RecipientPreset): boolean {
  const all = [...preset.to, ...preset.cc];
  return all.length > 0 && all.every((addr) => !addr.startsWith("TODO_"));
}

/** Returns the preset with `id`, or undefined. */
export function findPreset(id: string): RecipientPreset | undefined {
  return RECIPIENT_PRESETS.find((p) => p.id === id);
}
