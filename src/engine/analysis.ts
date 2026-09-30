import type { CuePoints, TrackAnalysis, WaveformBands } from "./types";

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

// Krumhansl-Kessler key profiles (C .. B)
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const PITCH_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
// Camelot wheel lookup indexed by pitch class 0..11 (C..B)
const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

/**
 * Real pitch-class chromagram + Krumhansl-Schmuckler key correlation.
 * Evaluates Goertzel resonators across 3 musical octaves (C2..B4) on downsampled frames.
 */
function detectCamelotKey(buf: AudioBuffer): { key: string; keyName: string } {
  const data = buf.getChannelData(0);
  const sr = buf.sampleRate;
  const chroma = new Float64Array(12);
  const windowSize = 2048;
  // Sample up to 24 evenly spaced windows across the track body
  const totalWindows = Math.min(24, Math.max(1, Math.floor(data.length / windowSize)));
  const step = Math.max(windowSize, Math.floor((data.length - windowSize) / totalWindows));

  for (let pc = 0; pc < 12; pc++) {
    let pcEnergy = 0;
    for (let oct = 2; oct <= 4; oct++) {
      const midi = 12 * (oct + 1) + pc;
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const omega = (2 * Math.PI * freq) / sr;
      const coeff = 2 * Math.cos(omega);
      for (let w = 0; w < totalWindows; w++) {
        const start = w * step;
        let s1 = 0, s2 = 0;
        // 1024-sample Goertzel block for fast pitch-class energy
        const len = Math.min(1024, data.length - start);
        for (let i = 0; i < len; i++) {
          const s0 = data[start + i] + coeff * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
        pcEnergy += Math.max(0, power);
      }
    }
    chroma[pc] = Math.sqrt(pcEnergy);
  }

  let bestScore = -Infinity;
  let bestKey = "8A";
  let bestName = "A Minor";

  for (let root = 0; root < 12; root++) {
    let majScore = 0, minScore = 0;
    for (let i = 0; i < 12; i++) {
      const c = chroma[(root + i) % 12];
      majScore += c * MAJOR_PROFILE[i];
      minScore += c * MINOR_PROFILE[i];
    }
    if (majScore > bestScore) {
      bestScore = majScore;
      bestKey = CAMELOT_MAJOR[root];
      bestName = `${PITCH_NAMES[root]} Major`;
    }
    if (minScore > bestScore) {
      bestScore = minScore;
      bestKey = CAMELOT_MINOR[root];
      bestName = `${PITCH_NAMES[root]} Minor`;
    }
  }

  return { key: bestKey, keyName: bestName };
}

/**
 * Extracts 3-band RGB waveform envelopes (Low <250Hz, Mid 250Hz-3kHz, High >3kHz),
 * normalized dancefloor energy, and bar-aligned structural cue points.
 */
export function extractWaveformAndCues(
  buf: AudioBuffer,
  bpm: number,
  firstBeat: number
): {
  energy: number;
  rmsDb: number;
  autoGainDb: number;
  cuePoints: CuePoints;
  waveform: WaveformBands;
} {
  const data = buf.getChannelData(0);
  const sr = buf.sampleRate;
  const duration = data.length / sr;
  const buckets = 480;
  const samplesPerBucket = Math.max(1, Math.floor(data.length / buckets));

  const low = new Float32Array(buckets);
  const mid = new Float32Array(buckets);
  const high = new Float32Array(buckets);
  const peaks = new Float32Array(buckets);

  // 1-pole filter coefficients at sr
  const aLow = Math.min(0.99, (2 * Math.PI * 250) / sr);
  const aHigh = Math.min(0.99, (2 * Math.PI * 3000) / sr);

  let lp250 = 0;
  let lp3000 = 0;
  let maxPeak = 1e-6;
  let totalRmsSq = 0;

  // Sub-step within each bucket for speed on long tracks while maintaining real filter response
  const stride = Math.max(1, Math.floor(samplesPerBucket / 256));
  const effectiveAlow = Math.min(0.95, aLow * stride);
  const effectiveAhigh = Math.min(0.95, aHigh * stride);

  for (let b = 0; b < buckets; b++) {
    const start = b * samplesPerBucket;
    const end = Math.min(data.length, start + samplesPerBucket);
    let sumLow = 0, sumMid = 0, sumHigh = 0, sumAll = 0, count = 0, pk = 0;

    for (let i = start; i < end; i += stride) {
      const x = data[i];
      lp250 += effectiveAlow * (x - lp250);
      lp3000 += effectiveAhigh * (x - lp3000);
      const l = lp250;
      const m = lp3000 - lp250;
      const h = x - lp3000;

      sumLow += l * l;
      sumMid += m * m;
      sumHigh += h * h;
      sumAll += x * x;
      const abs = Math.abs(x);
      if (abs > pk) pk = abs;
      count++;
    }

    if (count > 0) {
      low[b] = Math.sqrt(sumLow / count);
      mid[b] = Math.sqrt(sumMid / count);
      high[b] = Math.sqrt(sumHigh / count);
      peaks[b] = pk;
      totalRmsSq += sumAll / count;
      if (pk > maxPeak) maxPeak = pk;
    }
  }

  // Normalize waveform arrays to 0..1 for crisp canvas rendering
  let maxLow = 1e-6, maxMid = 1e-6, maxHigh = 1e-6;
  for (let b = 0; b < buckets; b++) {
    if (low[b] > maxLow) maxLow = low[b];
    if (mid[b] > maxMid) maxMid = mid[b];
    if (high[b] > maxHigh) maxHigh = high[b];
  }
  const energyCurve = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    low[b] /= maxLow;
    mid[b] /= maxMid;
    high[b] /= maxHigh;
    peaks[b] /= maxPeak;
    energyCurve[b] = 0.5 * low[b] + 0.35 * mid[b] + 0.15 * high[b];
  }

  const meanRms = Math.sqrt(totalRmsSq / buckets);
  const rmsDb = +(20 * Math.log10(Math.max(1e-4, meanRms))).toFixed(2);
  // Target -11.5 dBFS club RMS, clamped to [-6.0 dB, +6.0 dB] so quiet intros are not over-boosted
  const autoGainDb = +Math.max(-6, Math.min(6, -11.5 - rmsDb)).toFixed(2);
  const energy = Math.min(1, Math.max(0.15, meanRms * 3.2));

  // Bar-aligned cue point detection
  const secPerBar = (60 / bpm) * 4;
  const totalBars = Math.max(4, Math.floor((duration - firstBeat) / secPerBar));
  const barEnergy = new Float32Array(totalBars);
  for (let bar = 0; bar < totalBars; bar++) {
    const t0 = firstBeat + bar * secPerBar;
    const t1 = t0 + secPerBar;
    const b0 = Math.max(0, Math.min(buckets - 1, Math.floor((t0 / duration) * buckets)));
    const b1 = Math.max(b0 + 1, Math.min(buckets, Math.ceil((t1 / duration) * buckets)));
    let s = 0;
    for (let b = b0; b < b1; b++) s += energyCurve[b];
    barEnergy[bar] = s / (b1 - b0);
  }

  const introBar = Math.min(totalBars - 1, Math.max(0, Math.min(4, Math.floor(totalBars * 0.08))));

  // Find Drop: largest energy surge or peak energy in first 60% of bars
  let dropBar = Math.min(totalBars - 1, Math.max(introBar + 2, Math.floor(totalBars * 0.25)));
  let bestSurge = -Infinity;
  const searchEnd = Math.max(dropBar + 1, Math.floor(totalBars * 0.65));
  for (let bar = Math.max(2, introBar + 1); bar < searchEnd; bar++) {
    const prevE = (barEnergy[bar - 1] + barEnergy[Math.max(0, bar - 2)]) * 0.5;
    const nextE = (barEnergy[bar] + barEnergy[Math.min(totalBars - 1, bar + 1)]) * 0.5;
    const score = (nextE - prevE) * 1.6 + nextE;
    if (score > bestSurge) {
      bestSurge = score;
      dropBar = bar;
    }
  }

  // Find Breakdown: lowest energy valley after drop in middle of track
  let breakBar = Math.min(totalBars - 2, Math.max(dropBar + 2, Math.floor(totalBars * 0.55)));
  let minValley = Infinity;
  for (let bar = dropBar + 2; bar < Math.floor(totalBars * 0.78); bar++) {
    if (barEnergy[bar] < minValley) {
      minValley = barEnergy[bar];
      breakBar = bar;
    }
  }

  // Find Outro: phrase-aligned (last 8 or 4 bars)
  const outroBar = Math.max(breakBar + 1, Math.max(totalBars - 8, Math.floor(totalBars * 0.8)));

  const cuePoints: CuePoints = {
    intro: firstBeat + introBar * secPerBar,
    drop: firstBeat + dropBar * secPerBar,
    breakdown: firstBeat + breakBar * secPerBar,
    outro: firstBeat + outroBar * secPerBar,
  };

  return {
    energy,
    rmsDb,
    autoGainDb,
    cuePoints,
    waveform: { low, mid, high, peaks, energyCurve },
  };
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

  const finalBpm = (60 * hz) / P;
  const firstBeat = (((a % P) + P) % P) / hz;
  const { key, keyName } = detectCamelotKey(buf);
  const { energy, rmsDb, autoGainDb, cuePoints, waveform } = extractWaveformAndCues(buf, finalBpm, firstBeat);

  return {
    bpm: finalBpm,
    firstBeat,
    key,
    keyName,
    energy,
    rmsDb,
    autoGainDb,
    cuePoints,
    waveform,
  };
}
