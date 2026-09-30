import type {
  BattleSampleId,
  ScratchCutMode,
  ScratchPattern,
  ScratchPatternId,
} from "./types";

export const SCRATCH_PATTERNS: ScratchPattern[] = [
  {
    id: "baby",
    name: "Baby Scratch",
    subtitle: "Open Fader / 2 Beats",
    beats: 2,
    clicksPerBeat: 0,
    description: "Foundational forward-and-reverse vinyl oscillation with direct-drive wrist-whip turnaround.",
  },
  {
    id: "flare",
    name: "2-Click Orbit Flare",
    subtitle: "6 Notes/Cycle / 2 Beats",
    beats: 2,
    clicksPerBeat: 4,
    description: "Starts open, slices both forward and reverse strokes with two rapid Mag-Four optical clicks.",
  },
  {
    id: "transformer",
    name: "Transformer",
    subtitle: "1/16 Gate Stabs / 2 Beats",
    beats: 2,
    clicksPerBeat: 8,
    description: "Long pitched vinyl sweep chopped rhythmically by staccato crossfader punches.",
  },
  {
    id: "chirp",
    name: "Chirp Scratch",
    subtitle: "Edge Cut / 2 Beats",
    beats: 2,
    clicksPerBeat: 2,
    description: "Sharp fader closure at peak platter turnaround produces a rising/falling chirp transient.",
  },
  {
    id: "crab",
    name: "4-Finger Crab",
    subtitle: "Quadruplet Roll / 2 Beats",
    beats: 2,
    clicksPerBeat: 12,
    description: "High-speed spring-loaded 4-finger crossfader bounces across a reverse vinyl pull.",
  },
  {
    id: "tear",
    name: "Tear Scratch",
    subtitle: "Split Reverse / 2 Beats",
    beats: 2,
    clicksPerBeat: 0,
    description: "Smooth forward push followed by a two-step paused reverse pull for 3 distinct notes.",
  },
  {
    id: "backspin",
    name: "Vinyl Backspin",
    subtitle: "Whipped Rewind / 4 Beats",
    beats: 4,
    clicksPerBeat: 0,
    description: "High-velocity reverse platter whip (-3.6x) decaying exponentially to a dead stop.",
  },
  {
    id: "uzis",
    name: "Laser Stutter",
    subtitle: "Micro-Gate / 2 Beats",
    beats: 2,
    clicksPerBeat: 16,
    description: "Accelerating 1/16 to 1/32 beat-locked forward stutter roll that drops on the downbeat.",
  },
];

/** Sub-millisecond raised-cosine optical crossfader edge to eliminate digital clicks while keeping razor-sharp transient snap. */
function smoothEdge(x: number, edgeWidth = 0.035): number {
  if (x <= 0) return 0;
  if (x >= edgeWidth) return 1;
  return 0.5 - 0.5 * Math.cos((Math.PI * x) / edgeWidth);
}

/**
 * Evaluates instantaneous platter velocity (-3.6 .. +2.6, where +1.0 = normal forward speed
 * and negative values = true reverse vinyl playback), crossfader VCA gate (0..1), and
 * phase-locked groove displacement (`posBeats`, in beat-normalized source excursion)
 * at normalized beat phase `beatPos` in `[0, totalBeats]`.
 *
 * All periodic trajectories use exact analytical integrals of their Fourier wrist-whip
 * harmonic series so `posBeats === 0` at every cycle boundary (< 0.01 ms zero-drift lock).
 */
export function evaluateScratchTrajectory(
  patternId: ScratchPatternId,
  beatPos: number,
  totalBeats: number,
  intensity = 1.0,
  cutMode: ScratchCutMode = "mag-four"
): { velocity: number; faderGain: number; posBeats: number } {
  const scale = 0.78 + 0.42 * intensity;
  const edgeMult = cutMode === "mag-four" ? 0.58 : 1.18;

  switch (patternId) {
    case "baby": {
      // 2 full forward-reverse cycles per beat with Technics SL-1200 wrist-whip harmonic contour
      const cycle = (beatPos * 2) % 1;
      const theta = cycle * 2 * Math.PI;
      const velocity =
        (Math.sin(theta) + 0.26 * Math.sin(2 * theta) - 0.07 * Math.sin(3 * theta)) * 1.54 * scale;
      // Exact analytical integral over [0, cycle], guaranteed 0 at cycle=0 and cycle=1
      const posBeats =
        ((1 - Math.cos(theta)) / (2 * Math.PI) +
          (0.13 * (1 - Math.cos(2 * theta))) / (2 * Math.PI) -
          (0.07 * (1 - Math.cos(3 * theta))) / (6 * Math.PI)) *
        0.54 *
        scale;
      return { velocity, faderGain: 1.0, posBeats };
    }

    case "flare": {
      // 2-Click Orbit Flare: 1.5 cycles per beat, 2 optical fader clicks on forward & 2 on reverse
      const cycle = (beatPos * 1.5) % 1;
      const theta = cycle * 2 * Math.PI;
      const velocity =
        (Math.sin(theta) + 0.22 * Math.sin(2 * theta) - 0.06 * Math.sin(3 * theta)) * 1.74 * scale;
      const posBeats =
        ((1 - Math.cos(theta)) / (2 * Math.PI) +
          (0.11 * (1 - Math.cos(2 * theta))) / (2 * Math.PI) -
          (0.06 * (1 - Math.cos(3 * theta))) / (6 * Math.PI)) *
        0.66 *
        scale;
      const clickCenters = [0.165, 0.335, 0.665, 0.835];
      const clickHalfWidth = cutMode === "mag-four" ? 0.028 : 0.036;
      let faderGain = 1.0;
      for (const c of clickCenters) {
        const dist = Math.abs(cycle - c);
        if (dist < clickHalfWidth) {
          faderGain = Math.min(faderGain, smoothEdge(dist / clickHalfWidth, 0.55 * edgeMult));
        }
      }
      return { velocity, faderGain, posBeats };
    }

    case "transformer": {
      // Slow pitched sweep across the syllable chopped by 1/16th optical crossfader gates
      const slowCycle = (beatPos * 0.5) % 1;
      const isForward = slowCycle < 0.5;
      const local = isForward ? slowCycle * 2 : (slowCycle - 0.5) * 2;
      const velocity =
        (isForward ? 1.15 : -1.18) * scale * (0.76 + 0.36 * Math.sin(local * Math.PI));
      const posBeats = (isForward ? local : 1 - local) * 0.7 * scale;
      const chopPhase = (beatPos * 8) % 1;
      const gateWindow = cutMode === "mag-four" ? 0.48 : 0.52;
      const faderGain =
        chopPhase < gateWindow
          ? smoothEdge(chopPhase, 0.065 * edgeMult) *
            smoothEdge(gateWindow - chopPhase, 0.065 * edgeMult)
          : 0;
      return { velocity, faderGain, posBeats };
    }

    case "chirp": {
      // Chirp: fader starts open on transient attack, snaps shut at peak velocity, opens as reverse pulls back to 0
      const cycle = (beatPos * 2) % 1;
      const theta = cycle * 2 * Math.PI;
      const velocity = (Math.sin(theta) + 0.16 * Math.sin(2 * theta)) * 1.92 * scale;
      const posBeats =
        ((1 - Math.cos(theta)) / (2 * Math.PI) + (0.08 * (1 - Math.cos(2 * theta))) / (2 * Math.PI)) *
        0.58 *
        scale;
      const faderGain =
        cycle < 0.23
          ? smoothEdge(cycle, 0.03 * edgeMult) * smoothEdge(0.23 - cycle, 0.045 * edgeMult)
          : cycle > 0.77
            ? smoothEdge(cycle - 0.77, 0.045 * edgeMult) * smoothEdge(1.0 - cycle, 0.03 * edgeMult)
            : 0;
      return { velocity, faderGain, posBeats };
    }

    case "crab": {
      // 4-Finger Crab: punchy forward stab followed by 4 rapid spring-loaded fader bounces over reverse pull
      const cycle = (beatPos * 1.5) % 1;
      if (cycle < 0.32) {
        const u = cycle / 0.32;
        const velocity = 1.72 * scale * Math.sin(u * Math.PI);
        const posBeats = (1 - Math.cos(u * Math.PI)) * 0.5 * 0.48 * scale;
        const faderGain = smoothEdge(u, 0.06 * edgeMult) * smoothEdge(1 - u, 0.06 * edgeMult);
        return { velocity, faderGain, posBeats };
      }
      const crabNorm = (cycle - 0.32) / 0.68;
      const velocity = -1.54 * scale * Math.sin(crabNorm * Math.PI);
      const posBeats = (1 + Math.cos(crabNorm * Math.PI)) * 0.5 * 0.48 * scale;
      const fingerPhase = (crabNorm * 4) % 1;
      const openDuty = cutMode === "mag-four" ? 0.52 : 0.58;
      const faderGain =
        fingerPhase < openDuty
          ? smoothEdge(fingerPhase, 0.085 * edgeMult) *
            smoothEdge(openDuty - fingerPhase, 0.085 * edgeMult)
          : 0;
      return { velocity, faderGain, posBeats };
    }

    case "tear": {
      // Tear: 1 forward stroke + 2 distinct reverse pulls separated by a crisp finger stop on the record
      const cycle = (beatPos * 1.5) % 1;
      let velocity = 0;
      let posNorm = 0;
      if (cycle < 0.42) {
        const u = cycle / 0.42;
        velocity = 1.65 * scale * Math.sin(u * Math.PI);
        posNorm = 0.5 * (1 - Math.cos(u * Math.PI));
      } else if (cycle < 0.68) {
        const u = (cycle - 0.42) / 0.26;
        velocity = -1.82 * scale * Math.sin(u * Math.PI);
        posNorm = 1.0 - 0.52 * 0.5 * (1 - Math.cos(u * Math.PI));
      } else if (cycle < 0.74) {
        velocity = 0;
        posNorm = 0.48;
      } else {
        const u = (cycle - 0.74) / 0.26;
        velocity = -1.55 * scale * Math.sin(u * Math.PI);
        posNorm = 0.48 * (1 - 0.5 * (1 - Math.cos(u * Math.PI)));
      }
      return { velocity, faderGain: 1.0, posBeats: posNorm * 0.54 * scale };
    }

    case "backspin": {
      const norm = Math.max(0, Math.min(1, beatPos / totalBeats));
      if (norm < 0.065) {
        const u = norm / 0.065;
        const velocity = 1.0 - u * 4.6 * scale;
        return { velocity, faderGain: 1.0, posBeats: u * 0.08 };
      }
      const decayT = (norm - 0.065) / 0.935;
      const velocity = -3.55 * scale * Math.pow(1 - decayT, 1.82);
      const posBeats = -1.32 * scale * (1 - Math.pow(1 - decayT, 2.82));
      const faderGain = decayT > 0.86 ? Math.max(0, (1 - decayT) / 0.14) : 1.0;
      return { velocity, faderGain, posBeats };
    }

    case "uzis": {
      // Laser Stutter: accelerating 1/16 -> 1/32 micro-cuts locked to the transient attack
      const norm = Math.max(0, Math.min(1, beatPos / totalBeats));
      const subdiv = norm < 0.5 ? 8 : 16;
      const subPhase = (beatPos * subdiv) % 1;
      const isFwd = subPhase < 0.68;
      const u = isFwd ? subPhase / 0.68 : (subPhase - 0.68) / 0.32;
      const velocity =
        (1.08 + norm * 0.48 * scale) *
        (isFwd ? Math.sin(u * Math.PI) * 1.42 : -Math.sin(u * Math.PI) * 2.2);
      const posBeats =
        (isFwd ? 0.5 * (1 - Math.cos(u * Math.PI)) : 0.5 * (1 + Math.cos(u * Math.PI))) *
        (norm < 0.5 ? 0.24 : 0.14) *
        scale;
      const openDuty = cutMode === "mag-four" ? 0.62 : 0.68;
      const faderGain =
        subPhase < openDuty
          ? smoothEdge(subPhase, 0.065 * edgeMult) *
            smoothEdge(openDuty - subPhase, 0.065 * edgeMult)
          : 0;
      return { velocity, faderGain, posBeats };
    }
  }
}

// Precomputed 4096-point Kaiser window table (beta = 9.2) for alias-free varispeed vinyl resampling
const KAISER_N = 4096;
const KAISER_HALF = 16;
const KAISER_TABLE = (() => {
  const besselI0 = (x: number) => {
    let sum = 1,
      term = 1;
    const q = (x * x) / 4;
    for (let k = 1; k < 55; k++) {
      term *= q / (k * k);
      sum += term;
      if (term < sum * 1e-13) break;
    }
    return sum;
  };
  const beta = 9.2;
  const norm = besselI0(beta);
  const t = new Float32Array(KAISER_N + 1);
  for (let i = 0; i <= KAISER_N; i++) {
    const u = i / KAISER_N;
    t[i] = besselI0(beta * Math.sqrt(Math.max(0, 1 - u * u))) / norm;
  }
  return t;
})();

/**
 * 32-tap Bandlimited Kaiser-windowed sinc interpolation (beta = 9.2) with dynamic anti-aliasing
 * cutoff scaling (`cutoff = min(1, 1 / |velocity|)`), eliminating metallic high-speed aliasing
 * on 2-click flares, 4-finger crabs, and high-speed backspins.
 */
export function sampleKaiserSinc(chan: Float32Array, exactIdx: number, absRate = 1.0): number {
  const len = chan.length;
  if (len === 0) return 0;
  const i0 = Math.floor(exactIdx);
  const frac = exactIdx - i0;
  const cutoff = Math.min(1, 1 / Math.max(absRate, 1e-3));
  let acc = 0;

  for (let off = -KAISER_HALF + 1; off <= KAISER_HALF; off++) {
    const idx = i0 + off;
    if (idx < 0 || idx >= len) continue;
    const d = off - frac;
    const u = Math.abs(d) / KAISER_HALF;
    if (u >= 1) continue;
    const wf = u * KAISER_N;
    const wi = Math.floor(wf);
    const w = KAISER_TABLE[wi] + (KAISER_TABLE[wi + 1] - KAISER_TABLE[wi]) * (wf - wi);
    const cd = cutoff * d;
    const s = Math.abs(cd) < 1e-9 ? 1 : Math.sin(Math.PI * cd) / (Math.PI * cd);
    acc += chan[idx] * cutoff * s * w;
  }
  return acc;
}

/**
 * High-precision transient attack finder: scans `[targetSec - windowSec, targetSec + windowSec]`
 * using 4ms pre-emphasized energy envelopes (`x[n] - 0.85*x[n-1]`) to locate the sharpest
 * drum/vocal transient onset and anchors 6ms before the peak derivative so scratch strokes
 * bite directly into the transient edge instead of scrubbing dead air.
 */
export function findNearestTransientAnchor(
  chan: Float32Array,
  sr: number,
  targetSec: number,
  windowSec = 0.36
): number {
  const len = chan.length;
  if (len === 0 || sr <= 0) return Math.max(0, targetSec);
  const frameLen = Math.max(16, Math.floor(0.004 * sr)); // 4ms frame
  const startSample = Math.max(frameLen, Math.floor((targetSec - windowSec) * sr));
  const endSample = Math.min(len - frameLen * 4, Math.floor((targetSec + windowSec) * sr));
  if (endSample <= startSample + frameLen * 2) {
    return Math.max(0.04, Math.min(len / sr - 0.1, targetSec));
  }

  let prevEnergy = 0;
  let bestScore = -1;
  let bestSample = Math.floor(targetSec * sr);

  for (let s = startSample; s < endSample; s += frameLen) {
    let e = 0;
    for (let k = 0; k < frameLen; k++) {
      const idx = s + k;
      const pre = chan[idx] - 0.82 * chan[idx - 1];
      e += pre * pre + 0.35 * chan[idx] * chan[idx];
    }
    e = Math.sqrt(e / frameLen);
    const flux = Math.max(0, e - prevEnergy);
    // Slight proximity weighting so we prefer transients near the current beat
    const distSec = Math.abs(s / sr - targetSec);
    const proxWeight = 1 - 0.35 * (distSec / Math.max(0.05, windowSec));
    const score = (flux * 2.4 + e * 0.45) * proxWeight;
    if (score > bestScore && e > 0.015) {
      bestScore = score;
      bestSample = s;
    }
    prevEnergy = e;
  }

  // Anchor 6ms before the peak flux frame to catch the full consonant/drum attack
  const preRollSec = 0.006;
  return Math.max(0.02, Math.min(len / sr - 0.15, bestSample / sr - preRollSec));
}

/**
 * 90s Boom-Bap Turntablist Battle Record Bank (4.0s) with 11 classic vocal/horn/percussion
 * cuts ("ahhh", "fresh", "hit", "cut", "drop", "check", "yeah", "scratch", "rock", "now", "one").
 */
export const BATTLE_CUT_SLICES: Array<{
  text: string;
  start: number;
  len: number;
  f0: number;
  f1: number;
  f2: number;
  noiseAmt: number;
  energy: number;
  timbre?: "vocal" | "sibilant" | "horn";
}> = [
  { text: "ahhh", start: 0.08, len: 0.26, f0: 138.6, f1: 740, f2: 1190, noiseAmt: 0.28, energy: 0.94, timbre: "vocal" },
  { text: "fresh", start: 0.42, len: 0.24, f0: 174.6, f1: 540, f2: 1890, noiseAmt: 0.84, energy: 0.98, timbre: "sibilant" },
  { text: "hit", start: 0.76, len: 0.21, f0: 164.8, f1: 680, f2: 1420, noiseAmt: 0.48, energy: 0.92, timbre: "horn" },
  { text: "cut", start: 1.08, len: 0.25, f0: 196.0, f1: 660, f2: 1350, noiseAmt: 0.64, energy: 0.95, timbre: "sibilant" },
  { text: "drop", start: 1.46, len: 0.24, f0: 116.5, f1: 620, f2: 1080, noiseAmt: 0.45, energy: 0.93, timbre: "horn" },
  { text: "check", start: 1.80, len: 0.25, f0: 164.8, f1: 580, f2: 1760, noiseAmt: 0.72, energy: 0.95, timbre: "sibilant" },
  { text: "yeah", start: 2.16, len: 0.23, f0: 155.6, f1: 710, f2: 1520, noiseAmt: 0.35, energy: 0.90, timbre: "vocal" },
  { text: "scratch", start: 2.50, len: 0.27, f0: 146.8, f1: 560, f2: 1840, noiseAmt: 0.82, energy: 0.96, timbre: "sibilant" },
  { text: "rock", start: 2.88, len: 0.22, f0: 220.0, f1: 780, f2: 1480, noiseAmt: 0.46, energy: 0.91, timbre: "horn" },
  { text: "now", start: 3.22, len: 0.24, f0: 138.6, f1: 690, f2: 1220, noiseAmt: 0.38, energy: 0.89, timbre: "vocal" },
  { text: "one", start: 3.58, len: 0.28, f0: 155.6, f1: 640, f2: 1360, noiseAmt: 0.40, energy: 0.93, timbre: "vocal" },
];

/**
 * Selects the optimal 90s Battle Record cut anchor & label for a given scratch pattern and user selection.
 */
export function resolveBattleCutAnchor(
  patternId: ScratchPatternId,
  sampleId: BattleSampleId = "auto"
): { start: number; label: string } {
  if (sampleId !== "auto") {
    const found = BATTLE_CUT_SLICES.find(s => s.text === sampleId);
    if (found) return { start: found.start, label: found.text.toUpperCase() };
  }
  // Auto-match iconic turntablist syllable timbres to the pattern kinematics
  const preferredByPattern: Record<ScratchPatternId, string> = {
    baby: "ahhh",
    flare: "fresh",
    transformer: "ahhh",
    chirp: "cut",
    crab: "fresh",
    tear: "scratch",
    backspin: "drop",
    uzis: "hit",
  };
  const targetText = preferredByPattern[patternId] ?? "fresh";
  const slice = BATTLE_CUT_SLICES.find(s => s.text === targetText) ?? BATTLE_CUT_SLICES[1];
  return { start: slice.start, label: slice.text.toUpperCase() };
}

/**
 * Renders a sample-accurate stereo AudioBuffer performing phase-locked bidirectional vinyl scratching
 * over `sourceBuf` anchored at `anchorSec` for `totalBeats` at `secPerBeat`.
 *
 * Includes a 2-pole Shure M44-7 moving-magnet stylus presence filter (2.85 kHz bite scaled by platter
 * velocity), 95 Hz tonearm turnaround resonance on rapid direction reversals, and sub-millisecond
 * Mag-Four optical crossfader smoothing.
 */
export function renderScratchBuffer(
  ctx: BaseAudioContext,
  sourceBuf: AudioBuffer,
  anchorSec: number,
  totalBeats: number,
  secPerBeat: number,
  patternId: ScratchPatternId,
  intensity = 1.0,
  cutMode: ScratchCutMode = "mag-four"
): {
  buffer: AudioBuffer;
  duration: number;
  startOffsetSec: number;
  finalOffsetSec: number;
  headSecSamples: Float32Array;
  curveSamples: Float32Array;
  gateSamples: Float32Array;
} {
  const sr = sourceBuf.sampleRate;
  const duration = Math.max(0.15, totalBeats * secPerBeat);
  const totalSamples = Math.max(1, Math.floor(duration * sr));
  const outBuf = ctx.createBuffer(2, totalSamples, sr);

  const srcL = sourceBuf.getChannelData(0);
  const srcR = sourceBuf.numberOfChannels > 1 ? sourceBuf.getChannelData(1) : srcL;
  const outL = outBuf.getChannelData(0);
  const outR = outBuf.getChannelData(1);

  const headSecSamples = new Float32Array(128);
  const curveSamples = new Float32Array(128);
  const gateSamples = new Float32Array(128);

  const startOffsetSec =
    patternId === "backspin"
      ? Math.min(sourceBuf.duration - 0.15, Math.max(2.2, anchorSec))
      : Math.min(sourceBuf.duration - 0.28, Math.max(0.05, anchorSec));

  const minSample = 0.015 * sr;
  const maxSample = Math.max(minSample + sr * 0.15, (sourceBuf.duration - 0.015) * sr);
  const excursionSec = Math.min(0.36, Math.max(0.16, secPerBeat * 0.4));

  // 2-pole resonant moving-magnet stylus presence filter (~2.85 kHz vinyl groove bite)
  const stylusFc = 2850;
  const stylusR = Math.exp((-Math.PI * 950) / sr);
  const stylusC1 = 2 * stylusR * Math.cos((2 * Math.PI * stylusFc) / sr);
  const stylusC2 = -(stylusR * stylusR);
  const stylusA0 = 1 - stylusR;
  let styL1 = 0,
    styL2 = 0,
    styR1 = 0,
    styR2 = 0;

  // 92 Hz vinyl tonearm body resonance excited by turnaround acceleration spikes
  const armR = Math.exp((-Math.PI * 42) / sr);
  const armC1 = 2 * armR * Math.cos((2 * Math.PI * 92) / sr);
  const armC2 = -(armR * armR);
  const armA0 = 1 - armR;
  let armY1 = 0,
    armY2 = 0;
  let prevVel = 0;

  let smoothGate = 0;
  // Mag-Four optical fader = 0.55ms ultra-fast click-free edge; Smooth VCA = 1.6ms
  const gateTimeConstSec = cutMode === "mag-four" ? 0.00055 : 0.0016;
  const gateAttackAlpha = Math.min(1, 1 / (gateTimeConstSec * sr));
  let finalOffsetSec = startOffsetSec;

  for (let i = 0; i < totalSamples; i++) {
    const tSec = i / sr;
    const beatPos = tSec / secPerBeat;
    const { velocity, faderGain, posBeats } = evaluateScratchTrajectory(
      patternId,
      beatPos,
      totalBeats,
      intensity,
      cutMode
    );

    // Phase-locked platter position: every stroke returns to exact transient onset `startOffsetSec`
    const targetSec =
      patternId === "backspin"
        ? startOffsetSec + posBeats * secPerBeat
        : startOffsetSec + posBeats * excursionSec;
    const headSample = Math.max(minSample, Math.min(maxSample, targetSec * sr));
    const headSec = headSample / sr;
    finalOffsetSec = headSec;

    const speedAbs = Math.abs(velocity);
    const rawL = sampleKaiserSinc(srcL, headSample, speedAbs);
    const rawR = sampleKaiserSinc(srcR, headSample, speedAbs);

    // 2-pole Shure M44-7 stylus presence peak proportional to platter velocity
    const sOutL = stylusA0 * rawL + stylusC1 * styL1 + stylusC2 * styL2;
    styL2 = styL1;
    styL1 = sOutL;
    const sOutR = stylusA0 * rawR + stylusC1 * styR1 + stylusC2 * styR2;
    styR2 = styR1;
    styR1 = sOutR;
    const stylusPresence = Math.min(0.78, speedAbs * 0.28);

    // Tonearm turnaround sub-thump when wrist reverses platter direction rapidly
    const accel = Math.max(-1, Math.min(1, (velocity - prevVel) * 18));
    prevVel = velocity;
    const armOut = armA0 * accel + armC1 * armY1 + armC2 * armY2;
    armY2 = armY1;
    armY1 = armOut;
    const thump = armOut * 0.08;

    // Sub-millisecond optical VCA smoothing so even 1/32nd crab cuts have zero digital discontinuity
    smoothGate += gateAttackAlpha * (faderGain - smoothGate);
    const envEdge = Math.min(1, i / (0.002 * sr), (totalSamples - 1 - i) / (0.003 * sr));
    const gain = smoothGate * envEdge;

    // Asymmetric analog phono stage saturation (warm 2nd + 3rd harmonic vinyl character)
    const driveL = (rawL + sOutL * stylusPresence + thump) * 1.28;
    const driveR = (rawR + sOutR * stylusPresence + thump) * 1.28;
    const voicedL = Math.tanh(driveL + 0.04 * driveL * driveL) * 0.92;
    const voicedR = Math.tanh(driveR + 0.04 * driveR * driveR) * 0.92;

    outL[i] = voicedL * gain;
    outR[i] = voicedR * gain;

    const scopeIdx = Math.min(127, Math.floor((i / totalSamples) * 128));
    headSecSamples[scopeIdx] = headSec;
    curveSamples[scopeIdx] = posBeats;
    gateSamples[scopeIdx] = smoothGate;
  }

  return {
    buffer: outBuf,
    duration,
    startOffsetSec,
    finalOffsetSec,
    headSecSamples,
    curveSamples,
    gateSamples,
  };
}

/**
 * Synthesizes an authentic 90s turntablist battle record buffer using a Rosenberg glottal pulse
 * source, 4-formant vocal tract cascade (F1/F2/F3 + 3.48 kHz F4 turntablist ring), true unvoiced-to-voiced
 * consonant locus bursts ("f-r-e-sh", "ch-e-ck", "s-c-r-a-tch"), and punchy brass/percussion hits.
 */
export function createTurntablistCutBuffer(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const dur = 4.0;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);

  for (const syl of BATTLE_CUT_SLICES) {
    const iStart = Math.floor(syl.start * sr);
    const iEnd = Math.min(len, Math.floor((syl.start + syl.len) * sr));
    const timbre = syl.timbre ?? "vocal";

    // Biquad bandpass resonator state for F1, F2, F3, F4 + fricative bandpass
    let f1y1 = 0,
      f1y2 = 0;
    let f2y1 = 0,
      f2y2 = 0;
    let f3y1 = 0,
      f3y2 = 0;
    let f4y1 = 0,
      f4y2 = 0;
    let fricY1 = 0,
      fricY2 = 0;
    let phase = 0;

    // Sibilant cuts ("fresh", "scratch", "check", "cut") begin with a crisp unvoiced consonant attack before glottal voicing
    const consonantLeadSec = timbre === "sibilant" ? 0.028 : 0.006;

    for (let i = iStart; i < iEnd; i++) {
      const localT = (i - iStart) / sr;
      const normT = localT / syl.len;

      // Expressive 90s vocal/horn pitch inflection (initial punch + chest inflection + subtle vibrato)
      const pitchEnv =
        timbre === "horn"
          ? 1 + 0.09 * Math.exp(-localT * 58) - 0.015 * normT
          : 1 + 0.052 * Math.exp(-localT * 38) - 0.068 * normT + 0.016 * Math.sin(localT * 38);
      const f0 = syl.f0 * pitchEnv;
      phase = (phase + f0 / sr) % 1;

      // Rosenberg glottal pulse (open quotient = 0.41, speed quotient = 0.15)
      let glottal = 0;
      if (phase < 0.41) {
        const u = phase / 0.41;
        glottal = 0.5 * (1 - Math.cos(Math.PI * u));
      } else if (phase < 0.56) {
        const u = (phase - 0.41) / 0.15;
        glottal = Math.cos((Math.PI * u) / 2);
      }
      // Differentiated glottal flow derivative gives natural -12dB/oct vocal tract excitation with sharp closure snap
      const rawGlottalDeriv =
        phase > 0.4 && phase < 0.56
          ? -1.75 * Math.sin(((phase - 0.41) / 0.15) * (Math.PI * 0.5))
          : (glottal - 0.24) * 0.92;

      const voiceGate =
        localT < consonantLeadSec
          ? Math.pow(localT / Math.max(0.001, consonantLeadSec), 1.8)
          : 1.0;
      const glottalDeriv = rawGlottalDeriv * voiceGate;

      // Dynamic formant glide (consonant locus -> vowel target)
      const glide = 1 - 0.32 * Math.exp(-localT * 28);
      const curF1 = syl.f1 * (0.84 + 0.16 * glide);
      const curF2 = syl.f2 * (timbre === "sibilant" ? 0.7 + 0.38 * normT : glide);
      const curF3 = 2620 + (syl.f2 - 1200) * 0.26;
      const curF4 = 3480; // Singer/vinyl presence formant

      // 2-pole resonator step helper
      const stepResonator = (
        inp: number,
        fc: number,
        bw: number,
        y1: number,
        y2: number
      ): [number, number, number] => {
        const r = Math.exp((-Math.PI * bw) / sr);
        const c1 = 2 * r * Math.cos((2 * Math.PI * fc) / sr);
        const c2 = -(r * r);
        const a0 = 1 - r;
        const y0 = a0 * inp + c1 * y1 + c2 * y2;
        return [y0, y0, y1];
      };

      const [out1, ny1_1, ny2_1] = stepResonator(glottalDeriv, curF1, 82, f1y1, f1y2);
      f1y1 = ny1_1;
      f1y2 = ny2_1;

      const [out2, ny1_2, ny2_2] = stepResonator(glottalDeriv, curF2, 110, f2y1, f2y2);
      f2y1 = ny1_2;
      f2y2 = ny2_2;

      const [out3, ny1_3, ny2_3] = stepResonator(glottalDeriv, curF3, 150, f3y1, f3y2);
      f3y1 = ny1_3;
      f3y2 = ny2_3;

      const [out4, ny1_4, ny2_4] = stepResonator(glottalDeriv, curF4, 210, f4y1, f4y2);
      f4y1 = ny1_4;
      f4y2 = ny2_4;

      // Deterministic white noise for plosive/fricative ("f", "sh", "ch", "k") and vinyl air
      const noise = ((Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1) * 2 - 1;
      const fricCenter = timbre === "sibilant" && normT > 0.52 ? 3850 : 2950;
      const [fricBand, nf1, nf2] = stepResonator(noise, fricCenter, 720, fricY1, fricY2);
      fricY1 = nf1;
      fricY2 = nf2;

      const attackNoiseEnv = localT < 0.048 ? Math.exp(-localT * 44) * syl.noiseAmt : 0;
      const tailSibilanceEnv =
        timbre === "sibilant" && normT > 0.54
          ? Math.sin(((normT - 0.54) / 0.46) * Math.PI) * syl.noiseAmt * 0.92
          : 0;

      // For "horn" stabs ("hit", "drop", "rock"), layer a punchy sub-octave + 5th brass chord transient
      const hornLayer =
        timbre === "horn"
          ? (Math.sin(2 * Math.PI * f0 * 0.5 * localT) * 0.48 +
              Math.sin(2 * Math.PI * f0 * 1.498 * localT) * 0.34 +
              Math.sin(2 * Math.PI * f0 * 2.0 * localT) * 0.2) *
            Math.exp(-localT * 8.0)
          : 0;

      const voiced =
        out1 * 1.18 + out2 * 0.98 + out3 * 0.56 + out4 * 0.32 + glottalDeriv * 0.24 + hornLayer;
      const consonant = fricBand * (attackNoiseEnv * 1.65 + tailSibilanceEnv * 1.45);

      const env =
        Math.min(1, localT / 0.0028) *
        Math.min(1, (syl.len - localT) / 0.012) *
        Math.exp(-localT * 1.55);

      const sample = Math.tanh((voiced * 0.96 + consonant) * env * 1.92) * 0.9;
      L[i] = sample;
      R[i] = sample * 0.988;
    }
  }

  return buf;
}
