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

  it("never derives a height from the viewport MINUS an assumed inset", () => {
    // The defect was arithmetic like `calc(100dvh - 8px)` / `min(88dvh, ...)`:
    // a cap measured against the viewport cannot know what the backdrop
    // already subtracted, so the two drift apart and strand the footer.
    // Only two forms are safe: `100%` (bounded by the container) and a bare
    // `100dvh` used where the backdrop has NO padding at all.
    for (const block of allModalBlocks()) {
      const caps = [...block.matchAll(/max-height:\s*([^;]+);/g)].map((m) => m[1]!.trim());
      for (const cap of caps) {
        if (!/vh/.test(cap)) continue;
        expect(cap).toBe("100dvh");
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
    expect(footer).toMatch(/z-index:\s*2/);
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

/**
 * The X stopped responding after scrolling because it was absolutely
 * positioned with z-index:auto while later-in-DOM content inside the scroll
 * body painted over it. elementFromPoint at the X's centre returned
 * `h3.board-day-modal-title` on every phone, and
 * `div.location-map-preview__map.leaflet-container` once scrolled to the
 * bottom on iPad landscape and desktop — .location-map-preview declares
 * `position: relative; z-index: 0`.
 *
 * Fix: the close control is a real child of a non-scrolling header that is
 * layered above the body, not an absolutely positioned overlay.
 */
describe("the close control cannot be covered by scrolled content", () => {
  const header = ruleBody(".board-day-modal-header");
  const headerClose = ruleBody(".board-day-modal-header .board-day-modal-close-icon");

  it("puts the header above the body in the same stacking context", () => {
    expect(header).toMatch(/z-index:\s*2/);
    expect(header).toMatch(/position:\s*relative/);
    expect(header).toMatch(/flex:\s*0 0 auto/);
    expect(header).toMatch(/background:/);
  });

  it("keeps the body explicitly below header and footer", () => {
    expect(baseBody).toMatch(/z-index:\s*0/);
    expect(baseBody).toMatch(/position:\s*relative/);
  });

  it("takes the close control out of absolute positioning", () => {
    expect(headerClose).toMatch(/position:\s*static/);
  });

  it("gives the close control a 44x44 touch target", () => {
    expect(headerClose).toMatch(/width:\s*44px/);
    expect(headerClose).toMatch(/height:\s*44px/);
  });

  it("renders the close control inside the header in both boards", () => {
    for (const src of [dayBoard, monthBoard]) {
      const header = src.indexOf('<div className="board-day-modal-header">');
      const close = src.indexOf('className="board-day-modal-close-icon"');
      const body = src.indexOf('<div className="board-day-modal-body">');
      expect(header).toBeGreaterThan(-1);
      expect(close).toBeGreaterThan(header);
      expect(close).toBeLessThan(body);
    }
  });

  it("keeps the title in the header, not in the scroll body", () => {
    for (const src of [dayBoard, monthBoard]) {
      const title = src.indexOf('className="board-day-modal-title"');
      const body = src.indexOf('<div className="board-day-modal-body">');
      expect(title).toBeLessThan(body);
    }
  });
});

describe("phones get a true full-screen view", () => {
  /**
   * The full-screen phone rules. Anchored on the marker comment rather than a
   * media-query index, because several `@media (max-width: ...)` blocks also
   * contain `.board-day-modal-backdrop` rules and an index-based slice picks
   * up the wrong one.
   */
  function phoneBlock(): string {
    const at = css.indexOf("Phones get a true full-screen view");
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, at + 2600);
  }
  const phone = phoneBlock();

  it("removes external backdrop padding rather than fighting it", () => {
    // Padding the backdrop AND sizing the dialog against the viewport is the
    // contradiction that stranded the footer.
    expect(phone).toMatch(/\.board-day-modal-backdrop\s*\{[^}]*padding:\s*0/);
  });

  it("fills the viewport edge to edge", () => {
    expect(phone).toMatch(/width:\s*100%/);
    expect(phone).toMatch(/height:\s*100dvh/);
    expect(phone).toMatch(/max-height:\s*100dvh/);
    expect(phone).toMatch(/border-radius:\s*0/);
  });

  it("applies the safe-area insets inside the header and footer", () => {
    expect(phone).toMatch(/\.board-day-modal-header\s*\{[^}]*env\(safe-area-inset-top/);
    expect(phone).toMatch(/\.board-day-modal-actions\s*\{[^}]*env\(safe-area-inset-bottom/);
  });
});

describe("no later media query silently overrides the architecture", () => {
  it("every .board-day-modal block keeps the box from scrolling", () => {
    for (const block of allModalBlocks()) {
      if (/overflow/.test(block)) {
        expect(block).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
      }
    }
  });

  it("the short-landscape block restates the full-screen rules", () => {
    const at = css.indexOf("@media (max-height: 520px) and (orientation: landscape)");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, at + 3000);
    expect(block).toMatch(/\.board-day-modal-backdrop\s*\{[^}]*padding:\s*0/);
    expect(block).toMatch(/height:\s*100dvh/);
  });
});
