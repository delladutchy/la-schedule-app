"use client";

import { useEffect, useState } from "react";

const TARGET = "Jeff Ulsh";
const DECODE_DURATION_MS = 320;
const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function pickRandomChar(): string {
  return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)] ?? "·";
}

function scrambledTextAtProgress(progress: number, target: string): string {
  // Reveal characters left-to-right; everything not yet revealed cycles.
  // Spaces are preserved verbatim so the wordmark's silhouette is stable.
  const revealed = Math.floor(progress * target.length);
  let out = "";
  for (let i = 0; i < target.length; i += 1) {
    const ch = target[i];
    if (i < revealed || ch === " ") {
      out += ch;
    } else {
      out += pickRandomChar();
    }
  }
  return out;
}

interface Props {
  className?: string;
}

/**
 * Renders the page header h1 with a one-shot "data decode" scramble on
 * mount. The animation is bounded to ~320ms total via requestAnimationFrame,
 * never loops, and is skipped entirely under prefers-reduced-motion.
 *
 * SSR renders the resolved "Jeff Ulsh" so JS-disabled and slow-network
 * users see the correct text immediately. The scramble overlays after
 * hydration via useEffect, then settles back to the same final state.
 *
 * Accessibility: aria-label on the h1 fixes the heading's accessible
 * name to "Jeff Ulsh"; the visible (changing) text is aria-hidden so a
 * screen reader doesn't re-announce each scramble frame.
 */
export function HeaderTitle({ className }: Props) {
  const [text, setText] = useState(TARGET);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const startTime = performance.now();
    let rafId = 0;

    const tick = () => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(1, elapsed / DECODE_DURATION_MS);
      setText(scrambledTextAtProgress(progress, TARGET));
      if (progress < 1) {
        rafId = window.requestAnimationFrame(tick);
      } else {
        setText(TARGET);
      }
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, []);

  return (
    <h1 className={className} aria-label={TARGET}>
      <span aria-hidden="true">{text}</span>
    </h1>
  );
}
