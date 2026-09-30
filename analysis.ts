import type { TrackAnalysis } from "./types";

const ENV_HZ = 200;            // target envelope rate (~5 ms); the real rate is sr/hop, see below
const MAX_SECONDS = 90;        // analyze the first 90 s (grid is re-anchored per track)

/** Onset-strength envelope (positive RMS flux). */
function onsetFlux(buf: AudioBuffer): { flux: Float32Array; hz: number } {
  const data = buf.getChannelData(0);
  const hop = Math.floor(buf.sampleRate / ENV_HZ);
  const hz = buf.sampleRate / hop;   // actual envelope rate (hop is an integer)
  const n = Math.min(Math.floor(data.length / hop), Math.floor(MAX_SECONDS * hz));
  const flux = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < hop; j++) { const v = data[i * hop + j]; s += v * v; }
    const rms = Math.sqrt(s / hop);
    flux[i] = Math.max(0, rms - prev);
    prev = rms;
  }
  return { flux, hz };
}

/** Mean autocorrelation at a fractional lag (linear interpolation). */
function acf(flux: Float32Array, lag: number): number {
  let s = 0, c = 0;
  for (let i = Math.ceil(lag) + 1; i < flux.length; i++) {
    const f = i - lag, j = Math.floor(f), t = f - j;
    s += flux[i] * (flux[j] * (1 - t) + flux[j + 1] * t);
    c++;
  }
  return c ? s / c : 0;
}

const lagOf = (bpm: number, hz: number) => (60 / bpm) * hz;

/** Least-squares fit of beat positions (k -> flux peak) over the first `endSec`. */
function fitBeats(flux: Float32Array, hz: number, P: number, a: number, endSec: number) {
  const w = Math.max(2, Math.round(0.25 * P));
  const end = Math.min(flux.length - 2 - w, endSec * hz);
  const ks: number[] = [], ys: number[] = [];
  for (let k = 0; ; k++) {
    const t = a + k * P;
    if (t > end) break;
    if (t < w + 1) continue;
    const c = Math.round(t);
    let bi = c, bv = -1;
    for (let i = c - w; i <= c + w; i++) if (flux[i] > bv) { bv = flux[i]; bi = i; }
    if (bv <= 0) continue;
    const y0 = flux[bi - 1], y1 = flux[bi], y2 = flux[bi + 1], den = y0 - 2 * y1 + y2;
    ks.push(k); ys.push(bi + (den !== 0 ? (0.5 * (y0 - y2)) / den : 0)); // parabolic sub-sample peak
  }
  if (ks.length < 4) return { P, a };
  const n = ks.length, mk = ks.reduce((x, y) => x + y) / n, my = ys.reduce((x, y) => x + y) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (ks[i] - mk) * (ys[i] - my); den += (ks[i] - mk) ** 2; }
  const slope = num / den;
  return { P: slope, a: my - slope * mk };
}

export function analyze(buf: AudioBuffer): TrackAnalysis {
  const { flux, hz } = onsetFlux(buf);
  // 1) coarse tempo from autocorrelation
  let bpm = 120, bestScore = -1;
  for (let b = 70; b <= 180; b += 0.05) {
    const sc = acf(flux, lagOf(b, hz));
    if (sc > bestScore) { bestScore = sc; bpm = b; }
  }
  let P = lagOf(bpm, hz);
  // 2) rough beat phase from the first ~4 s using a smoothed comb
  const sm = new Float32Array(flux.length);
  for (let i = 3; i < flux.length - 3; i++) { let s = 0; for (let j = -3; j <= 3; j++) s += flux[i + j]; sm[i] = s; }
  let a = 0, phaseScore = -1;
  for (let ph = 4; ph < P + 4; ph += 0.5) {
    let s = 0;
    for (let t = ph; t < 4 * hz; t += P) s += sm[Math.round(t)];
    if (s > phaseScore) { phaseScore = s; a = ph; }
  }
  // 3) refine tempo + phase over a widening window (drift stays inside the search window)
  for (const sec of [8, 20, 45, MAX_SECONDS, MAX_SECONDS]) ({ P, a } = fitBeats(flux, hz, P, a, sec));
  return { bpm: (60 * hz) / P, firstBeat: (((a % P) + P) % P) / hz };
}
