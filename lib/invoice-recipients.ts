/**
 * Invoice email recipient presets.
 *
 * To configure Dave/Milos presets: replace the TODO_ placeholder strings
 * with real email addresses. Any preset whose `to` array contains a string
 * starting with "TODO_" is automatically treated as unconfigured and cannot
 * be selected for sending.
 *
 * The HR and AP shared inboxes only need to be filled in once.
 */

export interface RecipientPreset {
  id: string;
  label: string;
  /** Primary recipient(s). Must contain at least one non-TODO address to be enabled. */
  to: string[];
  /** CC recipients (shown to the user, sent in the CC field). */
  cc: string[];
}

// ---------------------------------------------------------------------------
// Shared addresses — fill these in once
// ---------------------------------------------------------------------------

const LA_HR_EMAIL = "TODO_HR_EMAIL";   // e.g. "hr@lightaction.com"
const LA_AP_EMAIL = "TODO_AP_EMAIL";   // e.g. "ap@lightaction.com"

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

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
    to:    ["TODO_DAVE_EMAIL"],   // e.g. "dave@lightaction.com"
    cc:    [LA_HR_EMAIL, LA_AP_EMAIL],
  },
  {
    id:    "light-action-milos",
    label: "Light Action — Milos",
    to:    ["TODO_MILOS_EMAIL"],  // e.g. "milos@lightaction.com"
    cc:    [LA_HR_EMAIL, LA_AP_EMAIL],
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
