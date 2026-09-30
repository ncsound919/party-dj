/** Pure sync & Camelot harmonic math (unit-tested; no Web Audio here). */
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

/** Earliest beat line at or after now+lead, on a beat grid anchored at `anchor`. */
export function nextBeatTime(now: number, anchor: number, secPerBeat: number, lead = 0.04) {
  const k = Math.ceil(Math.max(0, now + lead - anchor) / secPerBeat - 1e-9);
  return anchor + k * secPerBeat;
}

export interface HarmonicMatch {
  tier: "perfect" | "harmonic" | "energy-boost" | "wide";
  score: number; // 0..100
  label: string;
}

/**
 * Evaluates Camelot wheel harmonic distance between two tracks (e.g., "8A" and "9A").
 */
export function evaluateHarmonicMatch(fromKey?: string, toKey?: string): HarmonicMatch {
  if (!fromKey || !toKey) {
    return { tier: "harmonic", score: 80, label: "Harmonic Ready" };
  }
  const m1 = /^(\d{1,2})([AB])$/.exec(fromKey.trim());
  const m2 = /^(\d{1,2})([AB])$/.exec(toKey.trim());
  if (!m1 || !m2) {
    return { tier: "harmonic", score: 80, label: "Harmonic Ready" };
  }
  const n1 = parseInt(m1[1], 10);
  const l1 = m1[2];
  const n2 = parseInt(m2[1], 10);
  const l2 = m2[2];

  if (n1 === n2 && l1 === l2) {
    return { tier: "perfect", score: 100, label: `Same Key (${fromKey})` };
  }
  if (n1 === n2 && l1 !== l2) {
    return { tier: "perfect", score: 96, label: `Relative Maj/Min (${fromKey} → ${toKey})` };
  }
  const diff = Math.min((n2 - n1 + 12) % 12, (n1 - n2 + 12) % 12);
  if (diff === 1 && l1 === l2) {
    return { tier: "harmonic", score: 92, label: `Adjacent Fifth (${fromKey} → ${toKey})` };
  }
  // +2 or +7 on Camelot wheel = +1 or +2 semitone energy lift
  const cw = (n2 - n1 + 12) % 12;
  if ((cw === 2 || cw === 7) && l1 === l2) {
    return { tier: "energy-boost", score: 84, label: `Energy Lift (${fromKey} → ${toKey})` };
  }
  return { tier: "wide", score: 62, label: `Cross-Key Contrast (${fromKey} → ${toKey})` };
}
