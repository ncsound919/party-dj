import { CTRL_HZ } from "./curves";

export interface Primitive {
  rate: Float64Array; // control-rate target rate curve (source-sec per sec)
  gate: [number, number][]; // open intervals in seconds, relative to event start
}

/** Half-sine velocity stroke lasting T s that covers `span` source-seconds. */
export function strokeRate(T: number, span: number, direction: 1 | -1 = 1): Float64Array {
  const n = Math.max(2, Math.floor(T * CTRL_HZ));
  const peak = (Math.PI * span) / (2 * T); // integral of peak*sin(pi t/T) over [0,T] = span
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = direction * peak * Math.sin((Math.PI * (i + 0.5)) / n);
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
