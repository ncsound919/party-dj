/** Pure sync math (unit-tested; no Web Audio here). */
export const MAX_STRETCH = 0.08; // ±8% auto-tempo range (see outline risks)

/**
 * Pick the playback rate that locks the incoming track to the outgoing deck's
 * *effective* tempo, allowing half/double-time matches. Clamped to ±MAX_STRETCH.
 */
export function pickRate(fromEffBpm: number, toBpm: number) {
  let bestRate = 1, bestErr = Infinity;
  for (const m of [1, 2, 0.5]) {
    const rate = (fromEffBpm * m) / toBpm, err = Math.abs(Math.log(rate));
    if (err < bestErr) { bestErr = err; bestRate = rate; }
  }
  const rate = Math.min(1 + MAX_STRETCH, Math.max(1 - MAX_STRETCH, bestRate));
  return { rate, effBpm: toBpm * rate, clamped: Math.abs(bestRate - 1) > MAX_STRETCH };
}

/** Earliest bar line at or after now+lead, on a grid anchored at `anchor`. */
export function nextBarTime(now: number, anchor: number, secPerBar: number, lead = 0.1) {
  const k = Math.ceil(Math.max(0, now + lead - anchor) / secPerBar - 1e-9);
  return anchor + k * secPerBar;
}
