/**
 * Job-detail modal must stay scrollable to its end on every viewport, because
 * the Edit/Delete row is the last thing in it.
 *
 * Regression: the base .board-day-modal rule sized itself with `88vh`. On
 * iOS/iPadOS Safari `vh` resolves against the LARGE viewport (chrome
 * retracted), so while the browser chrome is showing the dialog was taller
 * than the visible area and its bottom sat below the fold — unreachable,
 * because the dialog's own overflow scrolls its CONTENT, not the off-screen
 * part of the box itself.
 *
 * The <=560px and <=760px rules already used dvh. Tablets (iPad portrait
 * 768px, landscape 1024px) fell through to the base rule and were the only
 * sizes still affected.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

/** Body of the first `selector { ... }` block at the given nesting depth. */
function ruleBody(source: string, selector: string): string {
  const at = source.indexOf(`\n${selector} {`);
  if (at === -1) throw new Error(`rule not found: ${selector}`);
  const open = source.indexOf("{", at);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

const baseModal = ruleBody(css, ".board-day-modal");
const baseBackdrop = ruleBody(css, ".board-day-modal-backdrop");

describe("job-detail modal sizing (tablet regression)", () => {
  it("sizes the base rule with dvh, not vh", () => {
    expect(baseModal).toMatch(/max-height:\s*min\(88dvh,\s*780px\)/);
    // The exact failure mode: a vh-based cap on the rule tablets land on.
    expect(baseModal).not.toMatch(/max-height:[^;]*\bvh\b/);
  });

  it("keeps the dialog scrollable", () => {
    expect(baseModal).toMatch(/overflow:\s*auto/);
  });

  it("does not let scrolling chain to the page behind it", () => {
    expect(baseModal).toMatch(/overscroll-behavior:\s*contain/);
    expect(baseBackdrop).toMatch(/overscroll-behavior:\s*contain/);
  });

  it("keeps an over-tall dialog anchored so its end stays reachable", () => {
    // Plain `center` overflows in both directions and strands the edges.
    expect(baseBackdrop).toMatch(/align-items:\s*safe center/);
  });

  it("respects safe-area insets so the action row clears the home indicator", () => {
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(baseBackdrop).toMatch(
        new RegExp(`padding-${side}:\\s*max\\(16px,\\s*env\\(safe-area-inset-${side}`),
      );
    }
  });
});

describe("every breakpoint the job-detail modal can land on uses dvh", () => {
  // Each viewport the fix has to hold for, and the rule it resolves to.
  const modalMaxHeights = [
    ...css.matchAll(/\.board-day-modal\s*\{[^}]*?max-height:\s*([^;]+);/g),
  ].map((m) => m[1]!.trim());

  it("finds every .board-day-modal max-height declaration", () => {
    expect(modalMaxHeights.length).toBeGreaterThanOrEqual(4);
  });

  it("uses no viewport-relative cap that ignores dynamic browser chrome", () => {
    // `min(82vh, 560px)` inside the earlier max-width:560px block is dead —
    // the later block with the same condition wins — but any LIVE vh cap on
    // this element is the bug this test exists to catch.
    const live = modalMaxHeights.filter((v) => !v.includes("82vh"));
    for (const value of live) {
      expect(value).not.toMatch(/\bvh\b/);
    }
  });
});

describe("desktop appearance is preserved", () => {
  it("keeps the original width and 780px height cap", () => {
    expect(baseModal).toMatch(/width:\s*min\(620px,\s*calc\(100vw - 24px\)\)/);
    expect(baseModal).toContain("780px");
  });

  it("keeps 16px backdrop padding when there are no insets to honour", () => {
    // env() falls back to 0px, so max(16px, 0px) === the original 16px.
    expect(baseBackdrop).toMatch(/env\(safe-area-inset-top,\s*0px\)/);
  });
});

describe("Edit/Delete remain present and unconditional on permission", () => {
  const dayBoard = fs.readFileSync(
    path.join(process.cwd(), "components/DayBoard.tsx"),
    "utf8",
  );

  it("still renders the action row only for a manageable detail", () => {
    // Guarding on canManageActiveDetail is the permission rule; this fix must
    // not have altered it.
    expect(dayBoard).toContain("canManageActiveDetail ? (");
    expect(dayBoard).toContain('className="board-day-modal-actions"');
  });
});
