import { CTRL_HZ } from "./curves";

export interface Primitive {
  rate: Float64Array; // control-rate target rate curve (source-sec per sec)
  gate: [number, number][]; // open intervals in seconds, relative to event start
}

/** Asymmetric wrist-whip velocity stroke lasting T s that covers exact `span` source-seconds. */
export function strokeRate(T: number, span: number, direction: 1 | -1 = 1): Float64Array {
  const n = Math.max(2, Math.floor(T * CTRL_HZ));
  const peak = (Math.PI * span) / (2 * T); // integral of peak*(sin(pi*t/T) + 0.16*sin(2*pi*t/T)) over [0,T] = span
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const whip = Math.sin(Math.PI * u) + 0.16 * Math.sin(2 * Math.PI * u);
    out[i] = direction * peak * whip;
  }
  return out;
}

function strokes(T: number, span: number, n: number): Float64Array {
  const parts = Array.from({ length: n }, (_, i) => strokeRate(T, span, i % 2 === 0 ? 1 : -1));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const rate = new Float64Array(total);
  let o = 0;
  for (const p of parts) {
    rate.set(p, o);
    o += p.length;
  }
  return rate;
}

export function baby(T: number, span: number, nStrokes: number): Primitive {
  const rate = strokes(T, span, nStrokes);
  return { rate, gate: [[0, rate.length / CTRL_HZ]] };
}

/**
 * Sound only on forward strokes; return strokes are cut. Naming varies between DJs:
 * map your names to TTM terms in docs/vocabulary.md.
 */
export function cutForward(T: number, span: number, nStrokes: number): Primitive {
  const rate = strokes(T, span, nStrokes);
  const gate: [number, number][] = [];
  for (let i = 0; i < nStrokes; i += 2) gate.push([i * T, (i + 1) * T]);
  return { rate, gate };
}

/** One short forward stroke with the gate open for the middle of it. */
export function stab(T: number, span: number): Primitive {
  return { rate: strokeRate(T, span, 1), gate: [[0.15 * T, 0.85 * T]] };
}

/** One sustained forward stroke with the gate chopped nChops times. */
export function transform(T: number, span: number, nChops: number, duty = 0.5): Primitive {
  const step = T / nChops;
  const gate: [number, number][] = [];
  for (let i = 0; i < nChops; i++) gate.push([i * step, i * step + duty * step]);
  return { rate: strokeRate(T, span, 1), gate };
}

/**
 * 1-Click or 2-Click Orbit Flare: Starts with the crossfader OPEN, slices the mid-stroke
 * with razor optical cuts while leaving the stroke turnaround open (turning 1 stroke into 2 or 3 notes).
 */
export function flare(T: number, span: number, nStrokes: number, clicks = 1): Primitive {
  const rate = strokes(T, span, nStrokes);
  const gate: [number, number][] = [];
  for (let i = 0; i < nStrokes; i++) {
    const t0 = i * T;
    if (clicks >= 2) {
      gate.push([t0, t0 + 0.28 * T]);
      gate.push([t0 + 0.37 * T, t0 + 0.63 * T]);
      gate.push([t0 + 0.72 * T, t0 + T]);
    } else {
      gate.push([t0, t0 + 0.44 * T]);
      gate.push([t0 + 0.56 * T, t0 + T]);
    }
  }
  return { rate, gate };
}

/**
 * 90s Chirp Scratch: Gate starts open at stroke onset, cuts right as forward pitch peaks at the apex,
 * and re-opens as the reverse pull accelerates back to origin.
 */
export function chirp(T: number, span: number, nStrokes: number): Primitive {
  const rate = strokes(T, span, nStrokes);
  const gate: [number, number][] = [];
  for (let i = 0; i < nStrokes; i++) {
    const t0 = i * T;
    if (i % 2 === 0) {
      gate.push([t0, t0 + 0.64 * T]);
    } else {
      gate.push([t0 + 0.36 * T, t0 + T]);
    }
  }
  return { rate, gate };
}

/**
 * Vinyl Tear Scratch: Open-fader articulation where each forward stroke is smooth and each
 * reverse stroke is split into two distinct wrist pulls separated by a brief vinyl dead-stop.
 */
export function tear(T: number, span: number, nStrokes: number): Primitive {
  const parts: Float64Array[] = [];
  for (let i = 0; i < nStrokes; i++) {
    if (i % 2 === 0) {
      parts.push(strokeRate(T, span, 1));
    } else {
      const nTotal = Math.max(4, Math.floor(T * CTRL_HZ));
      const nPull1 = Math.max(2, Math.floor(nTotal * 0.44));
      const nPause = Math.max(0, Math.floor(nTotal * 0.12));
      const nPull2 = Math.max(2, nTotal - nPull1 - nPause);
      const rev = new Float64Array(nPull1 + nPause + nPull2);
      const p1 = strokeRate(nPull1 / CTRL_HZ, span * 0.48, -1);
      const p2 = strokeRate(nPull2 / CTRL_HZ, span * 0.48, -1);
      rev.set(p1, 0);
      rev.set(p2, nPull1 + nPause);
      parts.push(rev);
    }
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const rate = new Float64Array(total);
  let o = 0;
  for (const p of parts) {
    rate.set(p, o);
    o += p.length;
  }
  return { rate, gate: [[0, rate.length / CTRL_HZ]] };
}

/**
 * 4-Finger Crab Scratch: Rapid optical fader bounces (4 micro-cuts per stroke) across alternating strokes.
 */
export function crab(T: number, span: number, nStrokes: number, fingers = 4): Primitive {
  const rate = strokes(T, span, nStrokes);
  const gate: [number, number][] = [];
  const step = T / fingers;
  for (let i = 0; i < nStrokes; i++) {
    const t0 = i * T;
    for (let f = 0; f < fingers; f++) {
      gate.push([t0 + f * step, t0 + f * step + 0.56 * step]);
    }
  }
  return { rate, gate };
}

