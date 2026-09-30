function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 60; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-14) break;
  }
  return sum;
}

const TABLE_N = 4096;
const tableCache = new Map<number, Float64Array>();

/** Kaiser window sampled on u = |d|/half in [0, 1]. Cached per beta. */
function kaiserTable(beta: number): Float64Array {
  let t = tableCache.get(beta);
  if (!t) {
    t = new Float64Array(TABLE_N + 1);
    const norm = besselI0(beta);
    for (let i = 0; i <= TABLE_N; i++) {
      const u = i / TABLE_N;
      t[i] = besselI0(beta * Math.sqrt(Math.max(0, 1 - u * u))) / norm;
    }
    tableCache.set(beta, t);
  }
  return t;
}

/**
 * Variable-rate read at fractional positions (in source samples).
 * Kaiser-windowed sinc; cutoff scaled down when |rate| > 1 to limit aliasing.
 * With a fixed tap count alias suppression degrades at high |rate|: clamp rates or
 * raise `half` if you hear it. [verify by ear]
 */
export function readSinc(
  x: ArrayLike<number>,
  pos: Float64Array,
  rate: Float64Array,
  half = 16,
  beta = 9,
): Float64Array {
  const win = kaiserTable(beta);
  const out = new Float64Array(pos.length);
  const len = x.length;
  for (let n = 0; n < pos.length; n++) {
    const p = pos[n];
    const i0 = Math.floor(p);
    const frac = p - i0;
    const c = Math.min(1, 1 / Math.max(Math.abs(rate[n]), 1e-3));
    let acc = 0;
    for (let off = -half + 1; off <= half; off++) {
      const idx = i0 + off;
      if (idx < 0 || idx >= len) continue; // zero outside the source
      const d = off - frac;
      const u = Math.abs(d) / half;
      if (u >= 1) continue;
      const wf = u * TABLE_N;
      const wi = Math.floor(wf);
      const w = win[wi] + (win[wi + 1] - win[wi]) * (wf - wi);
      const cd = c * d;
      const s = Math.abs(cd) < 1e-12 ? 1 : Math.sin(Math.PI * cd) / (Math.PI * cd);
      acc += x[idx] * c * s * w;
    }
    out[n] = acc;
  }
  return out;
}
