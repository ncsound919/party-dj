/** Beat-index <-> seconds, linear between beats, extrapolated past both ends. */
export function beatToTime(beats: number[], b: number): number {
  const n = beats.length;
  if (n < 2) throw new Error("grid needs at least 2 beats");
  if (b <= 0) return beats[0] + b * (beats[1] - beats[0]);
  if (b >= n - 1) return beats[n - 1] + (b - (n - 1)) * (beats[n - 1] - beats[n - 2]);
  const i = Math.floor(b);
  return beats[i] + (b - i) * (beats[i + 1] - beats[i]);
}

export function timeToBeat(beats: number[], t: number): number {
  const n = beats.length;
  if (t <= beats[0]) return (t - beats[0]) / (beats[1] - beats[0]);
  if (t >= beats[n - 1]) return n - 1 + (t - beats[n - 1]) / (beats[n - 1] - beats[n - 2]);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - beats[lo]) / (beats[hi] - beats[lo]);
}

/** Position (in beats) of the k-th grid point. Off-16ths get swung; swing is a fraction of one step. */
export function gridPoint(k: number, subdiv: number, swing: number): number {
  const swung = subdiv === 4 && Math.abs(k) % 2 === 1 ? swing / subdiv : 0;
  return k / subdiv + swung;
}

export function quantizeBeat(b: number, subdiv: number, swing: number): number {
  return gridPoint(Math.round(b * subdiv), subdiv, swing);
}

/** Distance in seconds from t to the nearest grid point (swing included). */
export function gridErrorSec(beats: number[], t: number, subdiv: number, swing: number): number {
  const b = timeToBeat(beats, t);
  const k = Math.round(b * subdiv);
  let best = Infinity;
  for (const kk of [k - 1, k, k + 1]) {
    best = Math.min(best, Math.abs(beatToTime(beats, gridPoint(kk, subdiv, swing)) - t));
  }
  return best;
}

export function vocalGaps(onsets: number[], minGap = 0.08): [number, number][] {
  const gaps: [number, number][] = [];
  for (let i = 0; i < onsets.length - 1; i++) {
    if (onsets[i + 1] - onsets[i] >= minGap) gaps.push([onsets[i], onsets[i + 1]]);
  }
  return gaps;
}

/**
 * Answer mode: the attack of an event (its first `checkLen` seconds) must sit inside a vocal gap,
 * at least `margin` after the gap's opening onset. Open-ended gaps before the first and after the
 * last onset are included.
 */
export function fitsGap(
  t0: number,
  onsets: number[],
  minGap: number,
  margin: number,
  checkLen: number,
): boolean {
  if (!onsets.length) return true;
  const gaps: [number, number][] = [
    [-Infinity, onsets[0]],
    ...vocalGaps(onsets, minGap),
    [onsets[onsets.length - 1], Infinity],
  ];
  return gaps.some(([a, b]) => t0 >= a + (a === -Infinity ? 0 : margin) && t0 + checkLen <= b);
}
