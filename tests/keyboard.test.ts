import { describe, expect, it } from "vitest";
import { isEditableKeyboardTarget, shouldHandleKeyboardShortcut } from "@/lib/keyboard";

function fakeTarget(opts: {
  tagName?: string;
  role?: string | null;
  contenteditable?: string | null;
  isContentEditable?: boolean;
  closest?: EventTarget | null;
}): EventTarget {
  return {
    tagName: opts.tagName,
    isContentEditable: opts.isContentEditable ?? false,
    getAttribute(name: string) {
      if (name === "role") return opts.role ?? null;
      if (name === "contenteditable") return opts.contenteditable ?? null;
      return null;
    },
    closest() {
      return opts.closest ?? null;
    },
  } as unknown as EventTarget;
}

describe("keyboard shortcut target guards", () => {
  it("does not handle shortcuts from input fields", () => {
    const target = fakeTarget({ tagName: "INPUT" });
    expect(isEditableKeyboardTarget(target)).toBe(true);
    expect(shouldHandleKeyboardShortcut(target)).toBe(false);
  });

  it("does not handle shortcuts from textarea fields", () => {
    const target = fakeTarget({ tagName: "TEXTAREA" });
    expect(isEditableKeyboardTarget(target)).toBe(true);
    expect(shouldHandleKeyboardShortcut(target)).toBe(false);
  });

  it("does not handle shortcuts from selects or contenteditable text", () => {
    expect(shouldHandleKeyboardShortcut(fakeTarget({ tagName: "SELECT" }))).toBe(false);
    expect(shouldHandleKeyboardShortcut(fakeTarget({ tagName: "DIV", contenteditable: "true" }))).toBe(false);
    expect(shouldHandleKeyboardShortcut(fakeTarget({ tagName: "DIV", role: "textbox" }))).toBe(false);
  });

  it("still handles shortcuts outside editable controls", () => {
    const target = fakeTarget({ tagName: "DIV" });
    expect(isEditableKeyboardTarget(target)).toBe(false);
    expect(shouldHandleKeyboardShortcut(target)).toBe(true);
  });

  it("treats descendants inside editable controls as editable", () => {
    const closest = fakeTarget({ tagName: "TEXTAREA" });
    const target = fakeTarget({ tagName: "SPAN", closest });
    expect(isEditableKeyboardTarget(target)).toBe(true);
    expect(shouldHandleKeyboardShortcut(target)).toBe(false);
  });
});
