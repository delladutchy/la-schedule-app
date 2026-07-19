/**
 * Tests for invoice recipient presets and the canSend logic.
 *
 * Verifies:
 *   - All production presets are fully configured (no TODO_ addresses).
 *   - Exact To addresses for each preset match the user-facing requirement.
 *   - Send Invoice enables immediately after selecting a configured preset.
 *   - Send Invoice stays disabled until a valid recipient is chosen.
 *   - Custom preset requires @ in address before enabling.
 *   - The "Light Action — Milos Only" preset sends to milos@lightaction.com only,
 *     and leaves the original "Light Action — Milos" preset (milos+hr+ap) untouched.
 *   - The Review & Draft "To" field is editable after selecting a preset, and
 *     editing it never mutates the underlying preset (lib/invoice-recipients.ts).
 */
import { describe, it, expect } from "vitest";
import {
  RECIPIENT_PRESETS,
  findPreset,
  isPresetConfigured,
  type RecipientPreset,
} from "@/lib/invoice-recipients";
import { parseRecipientList, seedEditableTo } from "@/components/InvoiceSection";

// ---------------------------------------------------------------------------
// canSend / preview logic — mirrors EmailDialog in InvoiceSection.tsx
// ---------------------------------------------------------------------------
//
// Real flow: selecting a preset seeds the editable "To" field via
// seedEditableTo(presetId); the user may then edit it freely before sending.
// What actually gets sent is always parseRecipientList(editableTo).

function resolvePreviewAddresses(
  presetId: string,
  editableTo: string,
): { to: string[]; cc: string[]; unconfigured: boolean } {
  let cc: string[] = [];
  let unconfigured = false;

  if (presetId && presetId !== "custom") {
    const preset = findPreset(presetId);
    if (preset) {
      if (!isPresetConfigured(preset)) unconfigured = true;
      else cc = preset.cc;
    }
  }

  const to = unconfigured ? [] : parseRecipientList(editableTo);
  return { to, cc, unconfigured };
}

function canSend(presetId: string, editableTo = seedEditableTo(presetId)): boolean {
  const { to, unconfigured } = resolvePreviewAddresses(presetId, editableTo);
  return !unconfigured && to.length > 0;
}

// ---------------------------------------------------------------------------
// isPresetConfigured
// ---------------------------------------------------------------------------

describe("isPresetConfigured", () => {
  it("returns true when all addresses are real (no TODO_)", () => {
    const preset: RecipientPreset = { id: "x", label: "X", to: ["a@example.com"], cc: [] };
    expect(isPresetConfigured(preset)).toBe(true);
  });

  it("returns false when any to address is a TODO_ placeholder", () => {
    const preset: RecipientPreset = { id: "x", label: "X", to: ["TODO_EMAIL"], cc: [] };
    expect(isPresetConfigured(preset)).toBe(false);
  });

  it("returns false when any cc address is a TODO_ placeholder", () => {
    const preset: RecipientPreset = { id: "x", label: "X", to: ["a@example.com"], cc: ["TODO_CC"] };
    expect(isPresetConfigured(preset)).toBe(false);
  });

  it("returns false for empty to array", () => {
    const preset: RecipientPreset = { id: "x", label: "X", to: [], cc: [] };
    expect(isPresetConfigured(preset)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RECIPIENT_PRESETS — all production presets must be configured
// ---------------------------------------------------------------------------

describe("RECIPIENT_PRESETS — all configured", () => {
  it("every preset has at least one to address", () => {
    for (const preset of RECIPIENT_PRESETS) {
      expect(preset.to.length).toBeGreaterThan(0);
    }
  });

  it("no preset contains TODO_ placeholders", () => {
    for (const preset of RECIPIENT_PRESETS) {
      const allAddresses = [...preset.to, ...preset.cc];
      for (const addr of allAddresses) {
        expect(addr).not.toMatch(/^TODO_/);
      }
    }
  });

  it("isPresetConfigured returns true for every production preset", () => {
    for (const preset of RECIPIENT_PRESETS) {
      expect(isPresetConfigured(preset)).toBe(true);
    }
  });

  it("has no duplicate preset ids", () => {
    const ids = RECIPIENT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no duplicate preset labels (dropdown entries must be distinguishable)", () => {
    const labels = RECIPIENT_PRESETS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

// ---------------------------------------------------------------------------
// Exact preset addresses
// ---------------------------------------------------------------------------

describe("Test — Jeff Gmail preset", () => {
  const preset = findPreset("test-jeff");

  it("exists", () => expect(preset).toBeDefined());

  it("sends to jeffulsh@gmail.com only", () => {
    expect(preset!.to).toEqual(["jeffulsh@gmail.com"]);
  });

  it("has no CC addresses", () => {
    expect(preset!.cc).toEqual([]);
  });
});

describe("Light Action — Dave preset", () => {
  const preset = findPreset("light-action-dave");

  it("exists", () => expect(preset).toBeDefined());

  it("sends to dave.harris, hr, and ap", () => {
    expect(preset!.to).toContain("dave.harris@lightaction.com");
    expect(preset!.to).toContain("hr@lightaction.com");
    expect(preset!.to).toContain("ap@lightaction.com");
  });

  it("has no CC addresses (all recipients are in To)", () => {
    expect(preset!.cc).toEqual([]);
  });

  it("is configured", () => expect(isPresetConfigured(preset!)).toBe(true));
});

describe("Light Action — Milos preset (unchanged)", () => {
  const preset = findPreset("light-action-milos");

  it("exists", () => expect(preset).toBeDefined());

  it("still sends to milos, hr, and ap — unaffected by the new Milos Only preset", () => {
    expect(preset!.to).toEqual([
      "milos@lightaction.com",
      "hr@lightaction.com",
      "ap@lightaction.com",
    ]);
  });

  it("has no CC addresses (all recipients are in To)", () => {
    expect(preset!.cc).toEqual([]);
  });

  it("is configured", () => expect(isPresetConfigured(preset!)).toBe(true));
});

describe("Light Action — Milos Only preset (new)", () => {
  const preset = findPreset("light-action-milos-only");

  it("exists", () => expect(preset).toBeDefined());

  it("sends to milos@lightaction.com only — no hr or ap", () => {
    expect(preset!.to).toEqual(["milos@lightaction.com"]);
  });

  it("has no CC addresses", () => {
    expect(preset!.cc).toEqual([]);
  });

  it("is configured", () => expect(isPresetConfigured(preset!)).toBe(true));

  it("has a distinct id and label from the original Light Action — Milos preset", () => {
    const original = findPreset("light-action-milos")!;
    expect(preset!.id).not.toBe(original.id);
    expect(preset!.label).not.toBe(original.label);
  });
});

describe("Overture — Mike preset", () => {
  const preset = findPreset("overture-mike");

  it("exists", () => expect(preset).toBeDefined());

  it("sends to Mpatille@overtureav.com", () => {
    expect(preset!.to).toEqual(["Mpatille@overtureav.com"]);
  });

  it("has no CC addresses", () => {
    expect(preset!.cc).toEqual([]);
  });

  it("is configured", () => expect(isPresetConfigured(preset!)).toBe(true));
});

// ---------------------------------------------------------------------------
// canSend logic — Send Invoice button enable/disable
// ---------------------------------------------------------------------------

describe("canSend — Send Invoice button enable/disable", () => {
  it("disabled when no preset selected", () => {
    expect(canSend("")).toBe(false);
  });

  it("enabled immediately after selecting Test — Jeff Gmail", () => {
    expect(canSend("test-jeff")).toBe(true);
  });

  it("enabled after selecting Light Action — Dave", () => {
    expect(canSend("light-action-dave")).toBe(true);
  });

  it("enabled after selecting Light Action — Milos", () => {
    expect(canSend("light-action-milos")).toBe(true);
  });

  it("enabled after selecting Light Action — Milos Only", () => {
    expect(canSend("light-action-milos-only")).toBe(true);
  });

  it("enabled after selecting Overture — Mike", () => {
    expect(canSend("overture-mike")).toBe(true);
  });

  it("disabled for Custom with empty input", () => {
    expect(canSend("custom", "")).toBe(false);
  });

  it("disabled for Custom with text but no @ sign", () => {
    expect(canSend("custom", "notanemail")).toBe(false);
  });

  it("enabled for Custom with valid email", () => {
    expect(canSend("custom", "client@example.com")).toBe(true);
  });

  it("enabled for Custom with complex valid email", () => {
    expect(canSend("custom", "jeff.ulsh+test@gmail.com")).toBe(true);
  });

  it("disabled after selecting a preset then clearing the To field", () => {
    expect(canSend("light-action-dave", "")).toBe(false);
  });

  it("findPreset returns undefined for unknown id", () => {
    expect(findPreset("unknown-id")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Preview To line — what the review panel shows
// ---------------------------------------------------------------------------

describe("resolvePreviewAddresses — review panel To display", () => {
  it("Test — Jeff Gmail shows jeffulsh@gmail.com", () => {
    const { to } = resolvePreviewAddresses("test-jeff", seedEditableTo("test-jeff"));
    expect(to.join(", ")).toBe("jeffulsh@gmail.com");
  });

  it("Light Action — Dave shows all three To addresses", () => {
    const { to } = resolvePreviewAddresses("light-action-dave", seedEditableTo("light-action-dave"));
    expect(to).toHaveLength(3);
    expect(to.join(", ")).toBe("dave.harris@lightaction.com, hr@lightaction.com, ap@lightaction.com");
  });

  it("Light Action — Milos Only shows exactly milos@lightaction.com", () => {
    const { to, cc } = resolvePreviewAddresses(
      "light-action-milos-only",
      seedEditableTo("light-action-milos-only"),
    );
    expect(to).toEqual(["milos@lightaction.com"]);
    expect(cc).toEqual([]);
  });

  it("Overture — Mike shows Mpatille@overtureav.com", () => {
    const { to } = resolvePreviewAddresses("overture-mike", seedEditableTo("overture-mike"));
    expect(to.join(", ")).toBe("Mpatille@overtureav.com");
  });

  it("Custom shows the typed address when valid", () => {
    const { to } = resolvePreviewAddresses("custom", "someone@example.com");
    expect(to).toEqual(["someone@example.com"]);
  });

  it("Custom shows empty when no @ in address", () => {
    const { to } = resolvePreviewAddresses("custom", "notanemail");
    expect(to).toHaveLength(0);
  });

  it("no preset selected shows empty To", () => {
    const { to } = resolvePreviewAddresses("", "");
    expect(to).toHaveLength(0);
  });

  it("no CC for any preset (all addresses are To)", () => {
    for (const preset of RECIPIENT_PRESETS) {
      const { cc } = resolvePreviewAddresses(preset.id, seedEditableTo(preset.id));
      expect(cc).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// seedEditableTo — what the "To" field is pre-filled with on preset select
// ---------------------------------------------------------------------------

describe("seedEditableTo", () => {
  it("seeds Light Action — Milos Only with just milos@lightaction.com", () => {
    expect(seedEditableTo("light-action-milos-only")).toBe("milos@lightaction.com");
  });

  it("seeds Light Action — Milos (original) with all three addresses", () => {
    expect(seedEditableTo("light-action-milos")).toBe(
      "milos@lightaction.com, hr@lightaction.com, ap@lightaction.com",
    );
  });

  it("seeds Light Action — Dave with all three addresses (unchanged existing behavior)", () => {
    expect(seedEditableTo("light-action-dave")).toBe(
      "dave.harris@lightaction.com, hr@lightaction.com, ap@lightaction.com",
    );
  });

  it("seeds nothing for custom", () => {
    expect(seedEditableTo("custom")).toBe("");
  });

  it("seeds nothing when no preset selected", () => {
    expect(seedEditableTo("")).toBe("");
  });

  it("seeds nothing for an unknown preset id", () => {
    expect(seedEditableTo("does-not-exist")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Editing recipients before draft creation — req: TO field stays editable,
// edits are used for the draft, and the saved preset is never mutated.
// ---------------------------------------------------------------------------

describe("editing recipients before draft creation", () => {
  it("removing an address from the seeded To list drops it from what gets sent", () => {
    const seeded = seedEditableTo("light-action-dave"); // "dave.harris@..., hr@..., ap@..."
    const edited = seeded.replace(", hr@lightaction.com", ""); // user deletes hr@
    const { to } = resolvePreviewAddresses("light-action-dave", edited);
    expect(to).toEqual(["dave.harris@lightaction.com", "ap@lightaction.com"]);
  });

  it("adding an address to the seeded To list includes it in what gets sent", () => {
    const seeded = seedEditableTo("light-action-milos-only"); // "milos@lightaction.com"
    const edited = `${seeded}, extra@example.com`;
    const { to } = resolvePreviewAddresses("light-action-milos-only", edited);
    expect(to).toEqual(["milos@lightaction.com", "extra@example.com"]);
  });

  it("editing the To field never mutates the underlying preset object", () => {
    const before = JSON.parse(JSON.stringify(findPreset("light-action-dave")));
    const seeded = seedEditableTo("light-action-dave");
    const edited = seeded.replace(", hr@lightaction.com", "").concat(", newperson@example.com");
    resolvePreviewAddresses("light-action-dave", edited); // simulates user editing + previewing
    const after = findPreset("light-action-dave");
    expect(after).toEqual(before);
  });

  it("clearing the seeded To field entirely disables sending", () => {
    expect(canSend("light-action-milos-only", "")).toBe(false);
  });

  it("selecting Milos Only then editing to a different single address still sends only that address", () => {
    const { to, cc } = resolvePreviewAddresses("light-action-milos-only", "someoneelse@lightaction.com");
    expect(to).toEqual(["someoneelse@lightaction.com"]);
    expect(cc).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseRecipientList — raw "To" text -> address array
// ---------------------------------------------------------------------------

describe("parseRecipientList", () => {
  it("splits comma-separated addresses and trims whitespace", () => {
    expect(parseRecipientList("a@example.com,  b@example.com")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("splits semicolon-separated addresses", () => {
    expect(parseRecipientList("a@example.com; b@example.com")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("drops entries without an @ sign (mid-typing / stray text)", () => {
    expect(parseRecipientList("a@example.com, notanemail")).toEqual(["a@example.com"]);
  });

  it("returns an empty array for blank input", () => {
    expect(parseRecipientList("")).toEqual([]);
  });

  it("returns a single-element array for one address", () => {
    expect(parseRecipientList("milos@lightaction.com")).toEqual(["milos@lightaction.com"]);
  });
});
