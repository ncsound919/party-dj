import type { Grid, Slice, SliceBank } from "../schemas";

// Browser stand-in for PLAN §6. No stem separation, no ASR, no dual beat trackers:
// transient slices only (PLAN keeps these as a first-class fallback) and a manual grid.
// Run the Python analysis for word-level slices and a checked beat grid.

export interface OnsetOpts {
  frame?: number; // samples
  hop?: number;
  minGapS?: number; // [tune] minimum spacing between onsets
  delta?: number; // [tune] flux threshold over the local median
  medianS?: number; // [tune] half-width of the adaptive threshold window
}

/** Log-energy flux onset detector with an adaptive median threshold. */
export function detectOnsets(x: ArrayLike<number>, sr: number, o: OnsetOpts = {}): number[] {
  const frame = o.frame ?? 512;
  const hop = o.hop ?? 256;
  const minGap = o.minGapS ?? 0.06;
  const delta = o.delta ?? 0.35;
  const halfWin = Math.max(1, Math.round(((o.medianS ?? 0.1) * sr) / hop));

  const nFrames = Math.max(0, Math.floor((x.length - frame) / hop));
  const logE = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0;
    for (let i = 0; i < frame; i++) {
      const v = x[f * hop + i];
      s += v * v;
    }
    logE[f] = Math.log(s / frame + 1e-9);
  }
  const flux = new Float64Array(nFrames);
  for (let f = 1; f < nFrames; f++) flux[f] = Math.max(0, logE[f] - logE[f - 1]);

  const onsets: number[] = [];
  let last = -Infinity;
  for (let f = 1; f < nFrames - 1; f++) {
    if (!(flux[f] >= flux[f - 1] && flux[f] > flux[f + 1])) continue;
    const win: number[] = [];
    for (let k = Math.max(0, f - halfWin); k <= Math.min(nFrames - 1, f + halfWin); k++) win.push(flux[k]);
    win.sort((a, b) => a - b);
    if (flux[f] < win[win.length >> 1] + delta) continue;
    const t = (f * hop) / sr;
    if (t - last < minGap) continue;
    onsets.push(t);
    last = t;
  }
  return onsets;
}

/** Nudge a boundary to the nearest zero crossing within ±2 ms to avoid clicks. */
function snapZero(x: ArrayLike<number>, sr: number, t: number): number {
  const c = Math.round(t * sr);
  const w = Math.round(0.002 * sr);
  let best = c;
  let bestAbs = Math.abs(x[Math.min(Math.max(c, 0), x.length - 1)] ?? 0);
  for (let i = Math.max(1, c - w); i <= Math.min(x.length - 1, c + w); i++) {
    if (x[i - 1] * x[i] <= 0 && Math.abs(x[i]) < bestAbs) {
      best = i;
      bestAbs = Math.abs(x[i]);
    }
  }
  return best / sr;
}

export function buildSliceBank(
  x: Float32Array,
  sr: number,
  sourcePath = "in-memory",
  o: OnsetOpts & { maxSliceS?: number } = {},
): SliceBank {
  const onsets = detectOnsets(x, sr, o);
  const maxLen = o.maxSliceS ?? 0.5;
  const dur = x.length / sr;
  const raw: { start: number; end: number; rms: number }[] = [];
  onsets.forEach((t, i) => {
    const end = Math.min(onsets[i + 1] ?? dur, t + maxLen, dur);
    if (end - t < 0.05) return;
    const s = snapZero(x, sr, t);
    const e = snapZero(x, sr, end);
    let sum = 0;
    const a = Math.floor(s * sr);
    const b = Math.floor(e * sr);
    for (let k = a; k < b; k++) sum += x[k] * x[k];
    raw.push({ start: s, end: e, rms: Math.sqrt(sum / Math.max(1, b - a)) });
  });
  const maxRms = Math.max(1e-9, ...raw.map((r) => r.rms));
  const slices: Slice[] = raw.map((r, id) => ({
    id,
    start: r.start,
    end: r.end,
    kind: "transient",
    text: null,
    energy: r.rms / maxRms,
  }));
  return { source_path: sourcePath, sr, slices, vocal_onsets: onsets };
}

/** Manual grid (PLAN §6 says to enter bpm/offset by hand when tracker agreement is low). */
export function gridFromBpm(bpm: number, offsetS: number, durationS: number, swing = 0): Grid {
  const period = 60 / bpm;
  const n = Math.max(2, Math.ceil((durationS - offsetS) / period) + 1);
  const beats = Array.from({ length: n }, (_, i) => offsetS + i * period);
  return {
    bpm,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    swing,
    agreement: 1, // manual entry: tracker agreement was not computed
  };
}
