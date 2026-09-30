import type { TransitionPreset } from "./types";
import type { Deck } from "./deck";

/** Schedules gain/filter automation. Returns the transition end time (ctx seconds). */
export function runTransition(from: Deck, to: Deck, p: TransitionPreset, startAt: number, secPerBar: number) {
  const dur = p.bars * secPerBar;
  if (p.curve === "cut" || dur <= 0) {
    from.out.gain.setValueAtTime(0, startAt);
    to.out.gain.setValueAtTime(1, startAt);
    return startAt;
  }
  const end = startAt + dur, N = 64;
  const fadeOut = new Float32Array(N), fadeIn = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    fadeOut[i] = p.curve === "equal-power" ? Math.cos(t * Math.PI / 2) : 1 - t;
    fadeIn[i]  = p.curve === "equal-power" ? Math.sin(t * Math.PI / 2) : t;
  }
  from.out.gain.setValueCurveAtTime(fadeOut, startAt, dur);
  to.out.gain.setValueCurveAtTime(fadeIn, startAt, dur);
  if (p.filterSweep) {
    from.filter.frequency.setValueAtTime(10, startAt);
    from.filter.frequency.exponentialRampToValueAtTime(4000, end);
  }
  return end;
}
