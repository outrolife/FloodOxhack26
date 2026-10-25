// Motion helpers for the Explore UI: respect prefers-reduced-motion everywhere.
import { useEffect, useRef, useState } from "react";

/** True when the person asked the system for less motion (or there is no window, e.g. in tests). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Ease-out cubic: fast start, gentle landing. */
export const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(Math.max(x, 0), 1), 3);

/** The value shown at progress p (0..1) when counting from `from` to `to`. */
export function countAt(from: number, to: number, p: number): number {
  return Math.round(from + (to - from) * easeOut(p));
}

/**
 * Count up (or down) to `target` over `ms` with requestAnimationFrame.
 * Reduced motion, or no rAF: shows the target at once.
 */
export function useCountUp(target: number, ms = 600): number {
  // The first time it counts up from 0, then from whatever is shown.
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? target : 0));
  const shownRef = useRef(shown);
  useEffect(() => {
    const from = shownRef.current;
    if (from === target) return;
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      shownRef.current = target;
      setShown(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = (now - start) / ms;
      const v = countAt(from, target, p);
      shownRef.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return shown;
}
