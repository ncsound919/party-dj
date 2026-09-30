import type { ScratchConfig } from "../config";
import { CTRL_HZ, gateCurve, slewLimit, underdampedSmooth } from "./curves";
import type { Primitive } from "./primitives";
import { baby, chirp, crab, cutForward, flare, stab, tear, transform } from "./primitives";
import { readSinc } from "./resample";
import type { ScratchEvent } from "../schemas";

export interface RenderedEvent {
  audio: Float64Array;
  rate: Float64Array;      // instantaneous platter velocity (source-sec / sec)
  dispSec: Float64Array;   // groove displacement relative to startSec (seconds)
  gate: Float64Array;      // optical VCA gate envelope (0..1)
  posMin: number;          // source samples
  posMax: number;
  maxEdgeJump: number;     // max |sample-to-sample jump| where the gate changes
  sumSq: number;
  n: number;
}

export interface Placed {
  t0: number; // output seconds
  prim: Primitive;
  s0: number; // source start, seconds
  gain: number;
  src?: ArrayLike<number>; // overrides the timeline's default source (multi-source hooks)
}

export type RenderCfg = Pick<
  ScratchConfig,
  "max_slew" | "f0" | "zeta" | "ramp_ms" | "sinc_half" | "sinc_beta" | "ring_off_s"
>;

export function renderEvent(
  src: ArrayLike<number>,
  fs: number,
  prim: Primitive,
  startSec: number,
  cfg: RenderCfg,
  gain = 1,
): RenderedEvent {
  const tail = Math.floor(cfg.ring_off_s * CTRL_HZ);
  const raw = new Float64Array(prim.rate.length + tail);
  raw.set(prim.rate);
  const rate = underdampedSmooth(slewLimit(raw, cfg.max_slew / CTRL_HZ), CTRL_HZ, cfg.f0, cfg.zeta);

  const n = Math.floor((rate.length / CTRL_HZ) * fs);
  // linear interpolation of the control-rate curve up to audio rate
  const rA = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = (i / fs) * CTRL_HZ;
    const k = Math.min(Math.floor(c), rate.length - 1);
    const k1 = Math.min(k + 1, rate.length - 1);
    rA[i] = rate[k] + (rate[k1] - rate[k]) * (c - k);
  }
  // rate is source-sec per output-sec; source sr == fs, so one unit = one source sample per output sample
  const pos = new Float64Array(n);
  const dispSec = new Float64Array(n);
  const startSample = startSec * fs;
  let acc = startSample;
  let posMin = Infinity;
  let posMax = -Infinity;
  for (let i = 0; i < n; i++) {
    acc += rA[i];
    pos[i] = acc;
    dispSec[i] = (acc - startSample) / fs;
    if (acc < posMin) posMin = acc;
    if (acc > posMax) posMax = acc;
  }

  const y = readSinc(src, pos, rA, cfg.sinc_half, cfg.sinc_beta);
  const g = gateCurve(prim.gate, n, fs, cfg.ramp_ms);

  // 2-pole Shure M44-7 moving-magnet stylus presence resonator (~2.85 kHz vinyl groove bite)
  const styR = Math.exp((-Math.PI * 920) / fs);
  const styC1 = 2 * styR * Math.cos((2 * Math.PI * 2850) / fs);
  const styC2 = -(styR * styR);
  const styA0 = 1 - styR;
  let styY1 = 0;
  let styY2 = 0;

  let maxEdgeJump = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const raw = y[i];
    const sOut = styA0 * raw + styC1 * styY1 + styC2 * styY2;
    styY2 = styY1;
    styY1 = sOut;
    const speedAbs = Math.abs(rA[i]);
    const presence = Math.min(0.68, speedAbs * 0.24);
    const voiced = Math.tanh((raw + sOut * presence) * 1.18) * 0.88;

    y[i] = voiced * g[i] * gain;
    sumSq += y[i] * y[i];
    if (i > 0 && Math.abs(g[i] - g[i - 1]) > 1e-4) {
      const j = Math.abs(y[i] - y[i - 1]);
      if (j > maxEdgeJump) maxEdgeJump = j;
    }
  }
  return { audio: y, rate: rA, dispSec, gate: g, posMin, posMax, maxEdgeJump, sumSq, n };
}

/** Sum rendered events onto a timeline. Returns the mix plus real platter telemetry timelines and each event's stats. */
export function renderTimeline(
  src: ArrayLike<number>,
  fs: number,
  placed: Placed[],
  totalSec: number,
  cfg: RenderCfg,
): {
  audio: Float64Array;
  rateTimeline: Float32Array;
  dispTimeline: Float32Array;
  gateTimeline: Float32Array;
  posSecTimeline: Float32Array;
  rendered: RenderedEvent[];
} {
  const totalSamples = Math.floor(totalSec * fs);
  const out = new Float64Array(totalSamples);
  const rateTimeline = new Float32Array(totalSamples);
  const dispTimeline = new Float32Array(totalSamples);
  const gateTimeline = new Float32Array(totalSamples);
  const posSecTimeline = new Float32Array(totalSamples);
  const rendered: RenderedEvent[] = [];
  for (const p of placed) {
    const r = renderEvent(p.src ?? src, fs, p.prim, p.s0, cfg, p.gain);
    rendered.push(r);
    const a = Math.max(0, Math.floor(p.t0 * fs));
    const b = Math.min(out.length, a + r.audio.length);
    for (let i = a; i < b; i++) {
      const k = i - a;
      out[i] += r.audio[k];
      rateTimeline[i] = r.rate[k];
      dispTimeline[i] = r.dispSec[k] * 4; // normalized for scope display
      gateTimeline[i] = Math.max(gateTimeline[i], r.gate[k]);
      posSecTimeline[i] = p.s0 + r.dispSec[k];
    }
  }
  return { audio: out, rateTimeline, dispTimeline, gateTimeline, posSecTimeline, rendered };
}

/** Build the primitive that a composed ScratchEvent describes. */
export function eventToPrimitive(ev: ScratchEvent): Primitive {
  switch (ev.primitive) {
    case "baby":
      return baby(ev.stroke_T, ev.span, ev.n_strokes);
    case "cut_forward":
      return cutForward(ev.stroke_T, ev.span, ev.n_strokes);
    case "stab":
      return stab(ev.stroke_T, ev.span);
    case "transform":
      return transform(ev.stroke_T, ev.span, ev.params.n_chops ?? 4, ev.params.duty ?? 0.5);
    case "flare":
      return flare(ev.stroke_T, ev.span, ev.n_strokes, ev.params.clicks ?? 1);
    case "chirp":
      return chirp(ev.stroke_T, ev.span, ev.n_strokes);
    case "tear":
      return tear(ev.stroke_T, ev.span, ev.n_strokes);
    case "crab":
      return crab(ev.stroke_T, ev.span, ev.n_strokes, ev.params.fingers ?? 4);
    default:
      throw new Error(`cannot render primitive "${ev.primitive}"`);
  }
}

/** Peak-normalize headroom, applied at export only. Never hides a Critic failure. */
export function applyHeadroom(y: Float64Array, headroomDb: number) {
  let peak = 0;
  for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
  const target = Math.pow(10, headroomDb / 20);
  const k = peak > target ? target / peak : 1;
  const out = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) out[i] = y[i] * k;
  return out;
}

/** Encodes mono float samples [-1, 1] into a standard 44-byte header 16-bit PCM WAV buffer. */
export function encodeWav16(samples: ArrayLike<number>, sampleRate: number): Uint8Array {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const writeAscii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 1 channel
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeAscii(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buf);
}
