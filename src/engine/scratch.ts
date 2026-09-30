import type { ScratchPattern, ScratchPatternId } from "./types";

export const SCRATCH_PATTERNS: ScratchPattern[] = [
  {
    id: "baby",
    name: "Baby Scratch",
    subtitle: "Open Fader / 2 Beats",
    beats: 2,
    clicksPerBeat: 0,
    description: "Foundational forward-and-reverse vinyl oscillation with crossfader wide open.",
  },
  {
    id: "flare",
    name: "2-Click Orbit Flare",
    subtitle: "6 Notes/Cycle / 2 Beats",
    beats: 2,
    clicksPerBeat: 4,
    description: "Starts open, slices both forward and reverse strokes with two rapid crossfader clicks.",
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
    description: "High-velocity reverse platter whip (-3.4x) decaying exponentially to a dead stop.",
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

/** Smooth raised-cosine step to eliminate digital clicks on rapid crossfader cuts. */
function smoothEdge(x: number, edgeWidth = 0.06): number {
  if (x <= 0) return 0;
  if (x >= edgeWidth) return 1;
  return 0.5 - 0.5 * Math.cos((Math.PI * x) / edgeWidth);
}

/**
 * Evaluates instantaneous platter velocity (-3.5 .. +2.5, where +1.0 = normal forward speed
 * and negative values = true reverse vinyl playback) and crossfader VCA gate (0..1)
 * at normalized beat phase `beatPos` in `[0, totalBeats]`.
 */
export function evaluateScratchTrajectory(
  patternId: ScratchPatternId,
  beatPos: number,
  totalBeats: number,
  intensity = 1.0
): { velocity: number; faderGain: number } {
  const scale = 0.75 + 0.45 * intensity;

  switch (patternId) {
    case "baby": {
      const cycle = (beatPos * 2) % 1;
      const velocity = Math.cos(cycle * 2 * Math.PI) * 1.45 * scale;
      return { velocity, faderGain: 1.0 };
    }

    case "flare": {
      const cycle = (beatPos * 1.5) % 1;
      const velocity = Math.cos(cycle * 2 * Math.PI) * 1.65 * scale;
      const clickCenters = [0.16, 0.33, 0.66, 0.83];
      const clickHalfWidth = 0.038;
      let faderGain = 1.0;
      for (const c of clickCenters) {
        const dist = Math.abs(cycle - c);
        if (dist < clickHalfWidth) {
          faderGain = Math.min(faderGain, smoothEdge(dist / clickHalfWidth, 0.7));
        }
      }
      return { velocity, faderGain };
    }

    case "transformer": {
      const slowCycle = (beatPos * 0.5) % 1;
      const velocity = (slowCycle < 0.5 ? 1.15 : -1.25) * scale * (0.7 + 0.3 * Math.sin(slowCycle * Math.PI * 2));
      const chopPhase = (beatPos * 8) % 1;
      const gateWindow = 0.52;
      const faderGain =
        chopPhase < gateWindow
          ? smoothEdge(chopPhase, 0.12) * smoothEdge(gateWindow - chopPhase, 0.12)
          : 0;
      return { velocity, faderGain };
    }

    case "chirp": {
      const cycle = (beatPos * 2) % 1;
      const velocity = Math.sin(cycle * 2 * Math.PI) * 1.85 * scale;
      const halfCycle = cycle % 0.5;
      const openLen = 0.24;
      const faderGain =
        halfCycle < openLen
          ? smoothEdge(halfCycle, 0.08) * smoothEdge(openLen - halfCycle, 0.1)
          : 0;
      return { velocity, faderGain };
    }

    case "crab": {
      const cycle = (beatPos * 1.5) % 1;
      if (cycle < 0.32) {
        const velocity = 1.6 * scale * Math.sin((cycle / 0.32) * Math.PI);
        const faderGain = smoothEdge(cycle, 0.05) * smoothEdge(0.32 - cycle, 0.05);
        return { velocity, faderGain };
      }
      const crabNorm = (cycle - 0.32) / 0.68;
      const velocity = -1.45 * scale * (0.8 + 0.4 * Math.sin(crabNorm * Math.PI));
      const fingerPhase = (crabNorm * 4) % 1;
      const faderGain =
        fingerPhase < 0.58
          ? smoothEdge(fingerPhase, 0.15) * smoothEdge(0.58 - fingerPhase, 0.15)
          : 0;
      return { velocity, faderGain };
    }

    case "tear": {
      const cycle = (beatPos * 1.5) % 1;
      let velocity = 0;
      if (cycle < 0.42) {
        velocity = 1.55 * scale * Math.sin((cycle / 0.42) * Math.PI);
      } else if (cycle < 0.68) {
        velocity = -1.75 * scale * Math.sin(((cycle - 0.42) / 0.26) * Math.PI);
      } else if (cycle < 0.74) {
        velocity = 0;
      } else {
        velocity = -1.45 * scale * Math.sin(((cycle - 0.74) / 0.26) * Math.PI);
      }
      return { velocity, faderGain: 1.0 };
    }

    case "backspin": {
      const norm = Math.max(0, Math.min(1, beatPos / totalBeats));
      if (norm < 0.08) {
        return { velocity: 1.0 - (norm / 0.08) * 4.4 * scale, faderGain: 1.0 };
      }
      const decayT = (norm - 0.08) / 0.92;
      const velocity = -3.4 * scale * Math.pow(1 - decayT, 1.85);
      const faderGain = decayT > 0.85 ? Math.max(0, (1 - decayT) / 0.15) : 1.0;
      return { velocity, faderGain };
    }

    case "uzis": {
      const norm = Math.max(0, Math.min(1, beatPos / totalBeats));
      const subdiv = norm < 0.5 ? 8 : 16;
      const subPhase = (beatPos * subdiv) % 1;
      const velocity = (1.0 + norm * 0.55 * scale) * (subPhase < 0.72 ? 1.05 : -1.8);
      const faderGain =
        subPhase < 0.65
          ? smoothEdge(subPhase, 0.12) * smoothEdge(0.65 - subPhase, 0.12)
          : 0;
      return { velocity, faderGain };
    }
  }
}

/**
 * 4-point cubic Hermite interpolation for smooth, alias-reduced varispeed vinyl resampling.
 */
function sampleHermite(chan: Float32Array, exactIdx: number): number {
  const len = chan.length;
  if (len === 0) return 0;
  const i1 = Math.floor(exactIdx);
  const frac = exactIdx - i1;
  const clamp = (k: number) => (k < 0 ? 0 : k >= len ? len - 1 : k);
  const y0 = chan[clamp(i1 - 1)];
  const y1 = chan[clamp(i1)];
  const y2 = chan[clamp(i1 + 1)];
  const y3 = chan[clamp(i1 + 2)];

  const c0 = y1;
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * frac + c2) * frac + c1) * frac + c0;
}

/**
 * Renders a sample-accurate stereo AudioBuffer performing bidirectional vinyl scratching
 * over `sourceBuf` anchored at `anchorSec` for `totalBeats` at `secPerBeat`.
 */
export function renderScratchBuffer(
  ctx: BaseAudioContext,
  sourceBuf: AudioBuffer,
  anchorSec: number,
  totalBeats: number,
  secPerBeat: number,
  patternId: ScratchPatternId,
  intensity = 1.0
): {
  buffer: AudioBuffer;
  duration: number;
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

  const curveSamples = new Float32Array(128);
  const gateSamples = new Float32Array(128);

  const startOffsetSec =
    patternId === "backspin"
      ? Math.min(sourceBuf.duration - 0.1, Math.max(2.5, anchorSec))
      : Math.min(sourceBuf.duration - 0.25, Math.max(0.25, anchorSec));

  let headSample = startOffsetSec * sr;
  const minSample = 0.05 * sr;
  const maxSample = Math.max(minSample + sr * 0.2, (sourceBuf.duration - 0.05) * sr);

  let lpL = 0, lpR = 0;

  for (let i = 0; i < totalSamples; i++) {
    const tSec = i / sr;
    const beatPos = tSec / secPerBeat;
    const { velocity, faderGain } = evaluateScratchTrajectory(patternId, beatPos, totalBeats, intensity);

    headSample += velocity;
    if (headSample < minSample) {
      headSample = minSample + (minSample - headSample) * 0.5;
    } else if (headSample > maxSample) {
      headSample = maxSample - (headSample - maxSample) * 0.5;
    }

    if (patternId === "uzis") {
      const subdiv = beatPos / totalBeats < 0.5 ? 0.25 : 0.125;
      const localBeat = beatPos % subdiv;
      if (localBeat < 1 / (sr * secPerBeat)) {
        headSample = startOffsetSec * sr;
      }
    }

    const rawL = sampleHermite(srcL, headSample);
    const rawR = sampleHermite(srcR, headSample);

    const speedAbs = Math.abs(velocity);
    const alpha = Math.min(0.85, 0.15 + speedAbs * 0.25);
    lpL += alpha * (rawL - lpL);
    lpR += alpha * (rawR - lpR);

    const envEdge = Math.min(1, i / (0.003 * sr), (totalSamples - 1 - i) / (0.004 * sr));
    const gain = faderGain * envEdge;

    outL[i] = (rawL * 0.7 + lpL * 0.35) * gain;
    outR[i] = (rawR * 0.7 + lpR * 0.35) * gain;

    const scopeIdx = Math.min(127, Math.floor((i / totalSamples) * 128));
    curveSamples[scopeIdx] = (headSample / sr - startOffsetSec) / Math.max(0.15, secPerBeat);
    gateSamples[scopeIdx] = faderGain;
  }

  return { buffer: outBuf, duration, curveSamples, gateSamples };
}

/**
 * Synthesizes a 90s boom-bap turntablist battle hook buffer (4.0s) with 12 distinct
 * syllable/horn/vocal stabs spaced 240ms-340ms apart so both transient slice detection
 * (`buildSliceBank`) and manual/pattern scratching have rich 80-400ms slices.
 */
export function createTurntablistCutBuffer(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const dur = 4.0;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);

  // 12 classic 90s battle-record vocal/brass syllables (each 180ms-280ms long with clear gaps)
  const syllables: Array<{ start: number; len: number; f0: number; f1: number; f2: number; noiseAmt: number }> = [
    { start: 0.08, len: 0.24, f0: 146.8, f1: 730, f2: 1090, noiseAmt: 0.45 }, // "Ahhh"
    { start: 0.42, len: 0.20, f0: 196.0, f1: 520, f2: 1850, noiseAmt: 0.65 }, // "Fresh"
    { start: 0.76, len: 0.22, f0: 164.8, f1: 680, f2: 1200, noiseAmt: 0.35 }, // "Hit"
    { start: 1.08, len: 0.26, f0: 220.0, f1: 800, f2: 1450, noiseAmt: 0.50 }, // "Cut"
    { start: 1.46, len: 0.22, f0: 130.8, f1: 710, f2: 1100, noiseAmt: 0.40 }, // "Drop"
    { start: 1.80, len: 0.25, f0: 174.6, f1: 600, f2: 1650, noiseAmt: 0.55 }, // "Check"
    { start: 2.16, len: 0.21, f0: 196.0, f1: 750, f2: 1300, noiseAmt: 0.45 }, // "Yeah"
    { start: 2.50, len: 0.26, f0: 155.6, f1: 540, f2: 1780, noiseAmt: 0.60 }, // "Scratch"
    { start: 2.88, len: 0.22, f0: 233.1, f1: 820, f2: 1520, noiseAmt: 0.40 }, // "Rock"
    { start: 3.22, len: 0.24, f0: 146.8, f1: 700, f2: 1180, noiseAmt: 0.50 }, // "Now"
    { start: 3.58, len: 0.28, f0: 196.0, f1: 650, f2: 1400, noiseAmt: 0.45 }, // "One"
  ];

  for (const syl of syllables) {
    const iStart = Math.floor(syl.start * sr);
    const iEnd = Math.min(len, Math.floor((syl.start + syl.len) * sr));
    for (let i = iStart; i < iEnd; i++) {
      const localT = (i - iStart) / sr;
      const normT = localT / syl.len;
      const pitchBend = 1 - 0.06 * normT + 0.02 * Math.sin(localT * 32);
      const f0 = syl.f0 * pitchBend;

      let sig = 0;
      for (let h = 1; h <= 16; h++) {
        const fh = f0 * h;
        const w1 = Math.exp(-Math.pow((fh - syl.f1) / 190, 2));
        const w2 = 0.8 * Math.exp(-Math.pow((fh - syl.f2) / 240, 2));
        const w3 = 0.4 * Math.exp(-Math.pow((fh - 2600) / 350, 2));
        sig += (w1 + w2 + w3 + 0.1 / h) * Math.sin(2 * Math.PI * fh * localT + h * 0.25);
      }

      const noise = ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 2 - 1;
      const consonant = localT < 0.035 ? noise * Math.exp(-localT * 65) * syl.noiseAmt : 0;
      const env =
        Math.min(1, localT / 0.006) *
        Math.min(1, (syl.len - localT) / 0.015) *
        Math.exp(-localT * 2.2);

      const sample = Math.tanh((sig * 0.44 + consonant) * env * 1.7) * 0.85;
      L[i] = sample;
      R[i] = sample * 0.98;
    }
  }

  return buf;
}
