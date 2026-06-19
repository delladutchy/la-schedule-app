/**
 * Tests for invoice recipient presets and the canSend logic.
 *
 * Verifies:
 *   - All production presets are fully configured (no TODO_ addresses).
 *   - Exact To addresses for each preset match the user-facing requirement.
 *   - Send Invoice enables immediately after selecting a configured preset.
 *   - Send Invoice stays disabled until a valid recipient is chosen.
 *   - Custom preset requires @ in address before enabling.
 */
import { describe, it, expect } from "vitest";
import {
  RECIPIENT_PRESETS,
  findPreset,
  isPresetConfigured,
  type RecipientPreset,
} from "@/lib/invoice-recipients";

// ---------------------------------------------------------------------------
// canSend logic — mirrored from EmailDialog in InvoiceSection.tsx
// ---------------------------------------------------------------------------

function resolvePreviewAddresses(
  presetId: string,
  customTo: string,
): { to: string[]; cc: string[]; unconfigured: boolean } {
  if (presetId === "custom") {
    const addr = customTo.trim();
    return { to: addr.includes("@") ? [addr] : [], cc: [], unconfigured: false };
  }
  if (presetId) {
    const preset = findPreset(presetId);
    if (preset) {
      if (isPresetConfigured(preset)) return { to: preset.to, cc: preset.cc, unconfigured: false };
      return { to: [], cc: [], unconfigured: true };
    }
  }
  return { to: [], cc: [], unconfigured: false };
}

function canSend(presetId: string, customTo = ""): boolean {
  const { to, unconfigured } = resolvePreviewAddresses(presetId, customTo);
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

describe("Light Action — Milos preset", () => {
  const preset = findPreset("light-action-milos");

  it("exists", () => expect(preset).toBeDefined());

  it("sends to milos, hr, and ap", () => {
    expect(preset!.to).toContain("milos@lightaction.com");
    expect(preset!.to).toContain("hr@lightaction.com");
    expect(preset!.to).toContain("ap@lightaction.com");
  });

  it("has no CC addresses (all recipients are in To)", () => {
    expect(preset!.cc).toEqual([]);
  });

  it("is configured", () => expect(isPresetConfigured(preset!)).toBe(true));
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

  it("findPreset returns undefined for unknown id", () => {
    expect(findPreset("unknown-id")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Preview To line — what the review panel shows
// ---------------------------------------------------------------------------

describe("resolvePreviewAddresses — review panel To display", () => {
  it("Test — Jeff Gmail shows jeffulsh@gmail.com", () => {
    const { to } = resolvePreviewAddresses("test-jeff", "");
    expect(to.join(", ")).toBe("jeffulsh@gmail.com");
  });

  it("Light Action — Dave shows all three To addresses", () => {
    const { to } = resolvePreviewAddresses("light-action-dave", "");
    expect(to).toHaveLength(3);
    expect(to.join(", ")).toBe("dave.harris@lightaction.com, hr@lightaction.com, ap@lightaction.com");
  });

  it("Overture — Mike shows Mpatille@overtureav.com", () => {
    const { to } = resolvePreviewAddresses("overture-mike", "");
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
      const { cc } = resolvePreviewAddresses(preset.id, "");
      expect(cc).toHaveLength(0);
    }
  });
});
