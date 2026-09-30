import type { ScratchPattern, ScratchPatternId } from "./types";

export const SCRATCH_PATTERNS: ScratchPattern[] = [
  {
    id: "baby",
    name: "Baby Scratch",
    subtitle: "Open Fader · 2 Beats",
    beats: 2,
    clicksPerBeat: 0,
    description: "Foundational forward-and-reverse vinyl oscillation with crossfader wide open.",
  },
  {
    id: "flare",
    name: "2-Click Orbit Flare",
    subtitle: "6 Notes/Cycle · 2 Beats",
    beats: 2,
    clicksPerBeat: 4,
    description: "Starts open, slices both forward and reverse strokes with two rapid crossfader clicks.",
  },
  {
    id: "transformer",
    name: "Transformer",
    subtitle: "1/16 Gate Stabs · 2 Beats",
    beats: 2,
    clicksPerBeat: 8,
    description: "Long pitched vinyl sweep chopped rhythmically by staccato crossfader punches.",
  },
  {
    id: "chirp",
    name: "Chirp Scratch",
    subtitle: "Edge Cut · 2 Beats",
    beats: 2,
    clicksPerBeat: 2,
    description: "Sharp fader closure at peak platter turnaround produces a rising/falling chirp transient.",
  },
  {
    id: "crab",
    name: "4-Finger Crab",
    subtitle: "Quadruplet Roll · 2 Beats",
    beats: 2,
    clicksPerBeat: 12,
    description: "High-speed spring-loaded 4-finger crossfader bounces across a reverse vinyl pull.",
  },
  {
    id: "tear",
    name: "Tear Scratch",
    subtitle: "Split Reverse · 2 Beats",
    beats: 2,
    clicksPerBeat: 0,
    description: "Smooth forward push followed by a two-step paused reverse pull for 3 distinct notes.",
  },
  {
    id: "backspin",
    name: "Vinyl Backspin",
    subtitle: "Whipped Rewind · 4 Beats",
    beats: 4,
    clicksPerBeat: 0,
    description: "High-velocity reverse platter whip (-3.4x) decaying exponentially to a dead stop.",
  },
  {
    id: "uzis",
    name: "Laser Stutter",
    subtitle: "Micro-Gate · 2 Beats",
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
  const scale = 0.75 + 0.45 * intensity; // 0.75x (Subtle) .. 1.2x (Turntablist)

  switch (patternId) {
    case "baby": {
      // 2 cycles per beat (1/8th note forward + 1/8th note backward)
      const cycle = (beatPos * 2) % 1;
      const velocity = Math.cos(cycle * 2 * Math.PI) * 1.45 * scale;
      return { velocity, faderGain: 1.0 };
    }

    case "flare": {
      // 2-Click Orbit: 1 full forward-backward orbit per beat, with 2 clicks on forward (t=0.16, 0.33)
      // and 2 clicks on reverse (t=0.66, 0.83)
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
      // Slow 1-beat forward, 1-beat reverse sweep chopped by 8 crossfader stabs per beat
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
      // Fast forward/reverse where fader snaps shut right as platter decelerates to turnaround
      const cycle = (beatPos * 2) % 1;
      const velocity = Math.sin(cycle * 2 * Math.PI) * 1.85 * scale;
      // Open near zero-crossings of displacement (0..0.22 and 0.5..0.72), closed at turnarounds
      const halfCycle = cycle % 0.5;
      const openLen = 0.24;
      const faderGain =
        halfCycle < openLen
          ? smoothEdge(halfCycle, 0.08) * smoothEdge(openLen - halfCycle, 0.1)
          : 0;
      return { velocity, faderGain };
    }

    case "crab": {
      // Rapid 4-finger quadruplet fader bounces on reverse stroke + clean forward release
      const cycle = (beatPos * 1.5) % 1;
      if (cycle < 0.32) {
        // Quick forward release
        const velocity = 1.6 * scale * Math.sin((cycle / 0.32) * Math.PI);
        const faderGain = smoothEdge(cycle, 0.05) * smoothEdge(0.32 - cycle, 0.05);
        return { velocity, faderGain };
      }
      // 4-finger crab over reverse pull (0.32 .. 1.0)
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
      // 1 smooth forward push (0..0.42), then 2 distinct backward pulls separated by a brief dead-stop pause
      const cycle = (beatPos * 1.5) % 1;
      let velocity = 0;
      if (cycle < 0.42) {
        velocity = 1.55 * scale * Math.sin((cycle / 0.42) * Math.PI);
      } else if (cycle < 0.68) {
        velocity = -1.75 * scale * Math.sin(((cycle - 0.42) / 0.26) * Math.PI);
      } else if (cycle < 0.74) {
        velocity = 0; // tactile vinyl pause between reverse tears
      } else {
        velocity = -1.45 * scale * Math.sin(((cycle - 0.74) / 0.26) * Math.PI);
      }
      return { velocity, faderGain: 1.0 };
    }

    case "backspin": {
      // Initial forward catch then high-speed reverse spin decaying exponentially
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
      // Accelerating forward stutter roll with rising pitch
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
 * Also returns 128-point curve & gate telemetry arrays for real-time visualization.
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

  // Start slightly ahead in the sample if backspinning so reverse travel has rich audio material
  const startOffsetSec =
    patternId === "backspin"
      ? Math.min(sourceBuf.duration - 0.1, Math.max(2.5, anchorSec))
      : Math.min(sourceBuf.duration - 0.25, Math.max(0.25, anchorSec));

  let headSample = startOffsetSec * sr;
  const minSample = 0.05 * sr;
  const maxSample = Math.max(minSample + sr * 0.2, (sourceBuf.duration - 0.05) * sr);

  // Subtle resonant DJ mixer emphasis at turnaround transients
  let lpL = 0, lpR = 0;

  for (let i = 0; i < totalSamples; i++) {
    const tSec = i / sr;
    const beatPos = tSec / secPerBeat;
    const { velocity, faderGain } = evaluateScratchTrajectory(patternId, beatPos, totalBeats, intensity);

    headSample += velocity;
    // Wrap softly within valid region so even extreme scratches never run into silence
    if (headSample < minSample) {
      headSample = minSample + (minSample - headSample) * 0.5;
    } else if (headSample > maxSample) {
      headSample = maxSample - (headSample - maxSample) * 0.5;
    }

    // For uzi stutter roll, re-trigger anchor on every 1/8 or 1/16 note boundary
    if (patternId === "uzis") {
      const subdiv = beatPos / totalBeats < 0.5 ? 0.25 : 0.125;
      const localBeat = beatPos % subdiv;
      if (localBeat < 1 / (sr * secPerBeat)) {
        headSample = startOffsetSec * sr;
      }
    }

    const rawL = sampleHermite(srcL, headSample);
    const rawR = sampleHermite(srcR, headSample);

    // Slight high-frequency presence boost when platter moves fast (>1.2x) like a real stylus
    const speedAbs = Math.abs(velocity);
    const alpha = Math.min(0.85, 0.15 + speedAbs * 0.25);
    lpL += alpha * (rawL - lpL);
    lpR += alpha * (rawR - lpR);

    // Master envelope fade-in/out (3ms) to prevent boundary click
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
 * Synthesizes a classic turntablist battle-record scratch sample ("Ahhh / Fresh" formant vocal + brass hit)
 * so the user can scratch an authentic DJ lead cut over any playing track.
 */
export function createTurntablistCutBuffer(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const dur = 2.4;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);

  // Classic "Ahhh" formant vowel frequencies (F1=730Hz, F2=1090Hz, F3=2440Hz) over a 130.81Hz (C3) sawtooth carrier
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    // 0.0 .. 1.1s: "Ahhh" vocal synth cut + crisp transient attack
    // 1.1 .. 2.4s: "Fresh" high-harmonic stab + sub punch
    const f0 = t < 1.1 ? 146.83 * (1 - 0.03 * t) : 196.0 * (1 + 0.08 * Math.sin(t * 18));
    let sig = 0;

    // Rich harmonic series shaped by vocal formants
    for (let h = 1; h <= 18; h++) {
      const fh = f0 * h;
      const f1 = Math.exp(-Math.pow((fh - 730) / 180, 2));
      const f2 = 0.75 * Math.exp(-Math.pow((fh - 1150) / 220, 2));
      const f3 = 0.45 * Math.exp(-Math.pow((fh - 2550) / 320, 2));
      const weight = (f1 + f2 + f3 + 0.12 / h);
      sig += weight * Math.sin(2 * Math.PI * fh * t + h * 0.3);
    }

    // Add initial breath/consonant transient ("Frrr-esh")
    const noise = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    const attackNoise = t < 0.09 ? noise * Math.exp(-t * 35) * 0.45 : 0;
    const secondTransient = t >= 1.1 && t < 1.22 ? noise * Math.exp(-(t - 1.1) * 28) * 0.55 : 0;

    const env =
      t < 1.1
        ? Math.min(1, t / 0.012) * Math.exp(-Math.max(0, t - 0.15) * 0.8)
        : Math.min(1, (t - 1.1) / 0.01) * Math.exp(-Math.max(0, t - 1.2) * 1.1);

    const sample = Math.tanh((sig * 0.42 + attackNoise + secondTransient) * env * 1.6) * 0.85;
    L[i] = sample;
    R[i] = sample * 0.98;
  }

  return buf;
}
