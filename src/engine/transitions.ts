import type { TransitionPreset } from "./types";
import type { Deck } from "./deck";

/** Schedules gain/filter/EQ automation. Returns the transition end time (ctx seconds). */
export function runTransition(from: Deck, to: Deck, p: TransitionPreset, startAt: number, secPerBar: number) {
  const dur = p.bars * secPerBar;
  const fromVol = from.channelVolume;
  const toVol = to.channelVolume;
  if (p.curve === "cut" || dur <= 0) {
    from.out.gain.setValueAtTime(0, startAt);
    to.out.gain.setValueAtTime(toVol, startAt);
    return startAt;
  }
  const end = startAt + dur, N = 64;
  const fadeOut = new Float32Array(N), fadeIn = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    fadeOut[i] = (p.curve === "equal-power" ? Math.cos((t * Math.PI) / 2) : 1 - t) * fromVol;
    fadeIn[i]  = (p.curve === "equal-power" ? Math.sin((t * Math.PI) / 2) : t) * toVol;
  }
  from.out.gain.setValueCurveAtTime(fadeOut, startAt, dur);
  to.out.gain.setValueCurveAtTime(fadeIn, startAt, dur);

  if (p.filterSweep) {
    from.filter.frequency.setValueAtTime(10, startAt);
    from.filter.frequency.exponentialRampToValueAtTime(4000, end);
    from.filter.frequency.setValueAtTime(10, end + 0.12);
  }

  // Clean low-end bass swap at the midpoint of the phrase so two kicks never clash
  if (p.bassSwap) {
    const midTime = startAt + dur * 0.5;
    const toTargetLow = to.lowKill ? -48 : to.lowDb;
    const fromStartLow = from.lowKill ? -48 : from.lowDb;
    to.lowEq.gain.cancelScheduledValues(startAt);
    from.lowEq.gain.cancelScheduledValues(startAt);
    to.lowEq.gain.setValueAtTime(-18, startAt);
    to.lowEq.gain.linearRampToValueAtTime(toTargetLow, midTime);
    from.lowEq.gain.setValueAtTime(fromStartLow, startAt);
    from.lowEq.gain.linearRampToValueAtTime(-18, end);
    // Restore outgoing deck's low EQ setting after it stops
    from.lowEq.gain.setValueAtTime(fromStartLow, end + 0.15);
  }

  return end;
}
