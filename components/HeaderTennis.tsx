"use client";

import { useEffect, useRef } from "react";

/**
 * Decorative animated tennis scene shown beside the header title.
 *
 * The artwork and every motion are inline SVG + CSS keyframes (see the
 * `.hdr-tennis-*` rules in app/globals.css) — there is no JS animation
 * loop. The ball's flight, both rackets' swings, and the players' weight
 * shifts all read `animation-duration: var(--hdr-tennis-duration)` and are
 * keyed off the same 0%-100% keyframe timeline, so they stay phase-locked
 * for as long as the tab stays open: the browser's compositor drives the
 * clock, not a JS timer, so there is nothing here that can drift.
 *
 * The only JS is a Page Visibility listener that freezes/thaws the CSS
 * animations in place via `animation-play-state` (a class toggle on the
 * root element). It never calls setState, so this component cannot cause
 * a re-render of itself or its parent after mount.
 */
export function HeaderTennis() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const syncPausedState = () => {
      el.classList.toggle("hdr-tennis--paused", document.hidden);
    };
    syncPausedState();
    document.addEventListener("visibilitychange", syncPausedState);
    return () => document.removeEventListener("visibilitychange", syncPausedState);
  }, []);

  return (
    <div ref={rootRef} className="hdr-tennis" aria-hidden="true">
      <svg
        className="hdr-tennis-svg"
        viewBox="0 0 120 34"
        xmlns="http://www.w3.org/2000/svg"
        focusable="false"
      >
        <line x1="4" y1="30.5" x2="116" y2="30.5" className="hdr-tennis-ground" />

        <g className="hdr-tennis-net">
          <rect x="57" y="17" width="6" height="13" className="hdr-tennis-net-panel" />
          <line x1="57" y1="30" x2="63" y2="17" className="hdr-tennis-net-mesh" />
          <line x1="63" y1="30" x2="57" y2="17" className="hdr-tennis-net-mesh" />
          <line x1="57" y1="17" x2="57" y2="30" />
          <line x1="63" y1="17" x2="63" y2="30" />
          <line x1="57" y1="17" x2="63" y2="17" />
        </g>

        {/* Left player, facing right toward the net. */}
        <g className="hdr-tennis-player">
          <path d="M22,20.5 L19,30 M22,20.5 L25,30" className="hdr-tennis-limb" />
          <g className="hdr-tennis-body hdr-tennis-body--left">
            <rect x="20.5" y="9.5" width="3" height="11" rx="1.5" className="hdr-tennis-torso" />
            <circle cx="22" cy="7" r="2.4" className="hdr-tennis-head" />
            <g className="hdr-tennis-arm hdr-tennis-arm--left">
              <path d="M22,12 L26,13" className="hdr-tennis-limb" />
              <g transform="translate(29,12) rotate(-12)">
                <ellipse cx="0" cy="0" rx="1.6" ry="3" className="hdr-tennis-racket" />
                <line x1="0" y1="-3" x2="0" y2="3" className="hdr-tennis-racket-string" />
                <line x1="-1.6" y1="0" x2="1.6" y2="0" className="hdr-tennis-racket-string" />
              </g>
            </g>
          </g>
        </g>

        {/* Right player, facing left toward the net. */}
        <g className="hdr-tennis-player">
          <path d="M98,20.5 L95,30 M98,20.5 L101,30" className="hdr-tennis-limb" />
          <g className="hdr-tennis-body hdr-tennis-body--right">
            <rect x="96.5" y="9.5" width="3" height="11" rx="1.5" className="hdr-tennis-torso" />
            <circle cx="98" cy="7" r="2.4" className="hdr-tennis-head" />
            <g className="hdr-tennis-arm hdr-tennis-arm--right">
              <path d="M98,12 L94,13" className="hdr-tennis-limb" />
              <g transform="translate(91,12) rotate(12)">
                <ellipse cx="0" cy="0" rx="1.6" ry="3" className="hdr-tennis-racket" />
                <line x1="0" y1="-3" x2="0" y2="3" className="hdr-tennis-racket-string" />
                <line x1="-1.6" y1="0" x2="1.6" y2="0" className="hdr-tennis-racket-string" />
              </g>
            </g>
          </g>
        </g>

        {/* Ball — last in document order so it always paints on top. */}
        <circle cx="60" cy="6" r="1.5" className="hdr-tennis-ball" />
      </svg>
    </div>
  );
}
