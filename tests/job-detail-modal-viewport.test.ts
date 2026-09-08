/**
 * The job-detail dialog must keep its Edit/Delete footer reachable on a real
 * phone, including safe-area insets.
 *
 * Regression (superseding the incomplete fix in 9c147b0): the dialog capped
 * its height against the VIEWPORT (`calc(100dvh - 8px)` on the <=760px rule
 * phones actually get) while its backdrop had already subtracted its own
 * padding plus env(safe-area-inset-top/bottom) — about 93px on an iPhone in
 * standalone PWA mode. The dialog was therefore allowed to be ~85px taller
 * than the box holding it. The overflow spilled off the bottom of the screen,
 * and because the dialog's own overflow scrolls its CONTENT rather than the
 * off-screen part of the box, no amount of scrolling could reach the footer —
 * only the tops of the buttons showed.
 *
 * The structural fix, which this test pins:
 *   - the dialog is bounded by its CONTAINER (`max-height: 100%`), never by a
 *     viewport unit, so it self-corrects for any inset on any device;
 *   - the dialog is a flex column that does NOT scroll;
 *   - `.board-day-modal-body` is the single scroll region;
 *   - `.board-day-modal-actions` is a non-scrolling, opaque, pinned footer.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const css = read("app/globals.css");
const dayBoard = read("components/DayBoard.tsx");
const monthBoard = read("components/MonthBoard.tsx");

/** Body of the first top-level `selector { ... }` block. */
function ruleBody(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at === -1) throw new Error(`rule not found: ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/** Every `.board-day-modal { ... }` block, base and inside media queries. */
function allModalBlocks(): string[] {
  return [...css.matchAll(/\.board-day-modal\s*\{([^}]*)\}/g)].map((m) => m[1]!);
}

const baseModal = ruleBody(".board-day-modal");
const baseBody = ruleBody(".board-day-modal-body");
const footer = ruleBody(".board-day-modal-actions");
const backdrop = ruleBody(".board-day-modal-backdrop");

describe("the dialog is bounded by its container, not the viewport", () => {
  it("caps the base rule with max-height: 100%", () => {
    expect(baseModal).toMatch(/max-height:\s*100%/);
  });

  it("uses no viewport-unit height cap at ANY breakpoint", () => {
    // This is the exact defect: a cap measured against the viewport cannot
    // know about the backdrop padding + safe-area insets beneath it.
    for (const block of allModalBlocks()) {
      const caps = [...block.matchAll(/max-height:\s*([^;]+);/g)].map((m) => m[1]!);
      for (const cap of caps) {
        expect(cap).not.toMatch(/\d\s*d?vh/);
      }
    }
  });

  it("also bounds the booking dialog by its container", () => {
    const booking = ruleBody(".board-day-modal--booking");
    expect(booking).toMatch(/max-height:\s*100%/);
    expect(booking).not.toMatch(/max-height:[^;]*vh/);
  });
});

describe("exactly one scroll container", () => {
  it("makes the dialog a non-scrolling flex column", () => {
    expect(baseModal).toMatch(/display:\s*flex/);
    expect(baseModal).toMatch(/flex-direction:\s*column/);
    expect(baseModal).toMatch(/overflow:\s*hidden/);
    expect(baseModal).toMatch(/min-height:\s*0/);
  });

  it("never re-enables scrolling on the dialog box at a smaller breakpoint", () => {
    // A responsive rule turning the box back into a scroller would let the
    // footer scroll away again.
    for (const block of allModalBlocks()) {
      expect(block).not.toMatch(/overflow(-y)?:\s*auto/);
    }
  });

  it("puts the scrolling on the body, which can shrink", () => {
    expect(baseBody).toMatch(/overflow-y:\s*auto/);
    // Without min-height:0 a flex item refuses to shrink below its content and
    // pushes the footer out of the box.
    expect(baseBody).toMatch(/min-height:\s*0/);
    expect(baseBody).toMatch(/flex:\s*1 1 auto/);
  });
});

describe("the footer is pinned, opaque and above the content", () => {
  it("does not shrink or scroll with the content", () => {
    expect(footer).toMatch(/flex:\s*0 0 auto/);
  });

  it("is opaque and layered above the scrolling body", () => {
    expect(footer).toMatch(/background:/);
    expect(footer).toMatch(/z-index:\s*1/);
    expect(footer).toMatch(/position:\s*relative/);
  });

  it("keeps a divider so content reads as passing underneath", () => {
    expect(footer).toMatch(/border-top:/);
  });
});

describe("safe areas are accounted for exactly once", () => {
  it("subtracts the insets on the backdrop", () => {
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(backdrop).toMatch(
        new RegExp(`padding-${side}:\\s*max\\([^)]*env\\(safe-area-inset-${side}`),
      );
    }
  });

  it("does not double-count the bottom inset on the footer", () => {
    // The dialog is sized by the padded backdrop box, so re-adding the inset
    // here would leave a dead band under the buttons.
    expect(footer).not.toMatch(/padding-bottom:[^;]*safe-area-inset/);
  });
});

describe("both boards use the header/body/footer structure", () => {
  for (const [name, src] of [["DayBoard", dayBoard], ["MonthBoard", monthBoard]] as const) {
    it(`${name} wraps detail content in the scroll body`, () => {
      expect(src).toContain('<div className="board-day-modal-body">');
    });

    it(`${name} keeps the action row OUTSIDE the scroll body`, () => {
      const bodyOpen = src.indexOf('<div className="board-day-modal-body">');
      const bodyClose = src.indexOf("</div>\n\n            {canManageActiveDetail ? (");
      const actions = src.indexOf('<div className="board-day-modal-actions">');
      expect(bodyOpen).toBeGreaterThan(-1);
      expect(bodyClose).toBeGreaterThan(bodyOpen);
      expect(actions).toBeGreaterThan(bodyClose);
    });

    it(`${name} still gates the actions on permission`, () => {
      // Presentation change only — the permission rule is untouched.
      expect(src).toContain("canManageActiveDetail ? (");
    });
  }
});
