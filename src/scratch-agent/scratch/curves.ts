export const CTRL_HZ = 1000;

/** Limit per-tick change of the rate. maxDelta = max_slew / CTRL_HZ. */
export function slewLimit(target: Float64Array, maxDelta: number): Float64Array {
  const out = new Float64Array(target.length);
  let cur = target.length ? target[0] : 0;
  for (let i = 0; i < target.length; i++) {
    const d = target[i] - cur;
    cur += Math.max(-maxDelta, Math.min(maxDelta, d));
    out[i] = cur;
  }
  return out;
}

/**
 * Second-order low-pass H(s) = w0^2 / (s^2 + 2*zeta*w0*s + w0^2), bilinear-discretized
 * (no prewarp, same as scipy.signal.bilinear). Initial state = steady state for x[0],
 * matching lfilter_zi * x[0] in the Python version.
 */
export function underdampedSmooth(x: Float64Array, fs: number, f0 = 20, zeta = 0.8): Float64Array {
  const w0 = 2 * Math.PI * f0;
  const K = 2 * fs;
  const a0 = K * K + 2 * zeta * w0 * K + w0 * w0;
  const b0 = (w0 * w0) / a0;
  const b1 = (2 * w0 * w0) / a0;
  const b2 = b0;
  const a1 = (2 * w0 * w0 - 2 * K * K) / a0;
  const a2 = (K * K - 2 * zeta * w0 * K + w0 * w0) / a0;

  const y = new Float64Array(x.length);
  if (!x.length) return y;
  const x0 = x[0];
  // steady state of direct form II transposed for constant input x0 (DC gain is 1)
  let z2 = (b2 - a2) * x0;
  let z1 = (b1 - a1) * x0 + z2;
  for (let i = 0; i < x.length; i++) {
    const yi = b0 * x[i] + z1;
    z1 = b1 * x[i] - a1 * yi + z2;
    z2 = b2 * x[i] - a2 * yi;
    y[i] = yi;
  }
  return y;
}

/** intervals: [t_open, t_close] seconds relative to event start. Hann-smoothed edges. */
export function gateCurve(intervals: [number, number][], n: number, fs: number, rampMs = 2): Float64Array {
  const g = new Float64Array(n);
  for (const [a, b] of intervals) {
    const lo = Math.max(0, Math.floor(a * fs));
    const hi = Math.min(n, Math.floor(b * fs));
    for (let i = lo; i < hi; i++) g[i] = 1;
  }
  const r = Math.max(2, Math.floor((fs * rampMs) / 1000));
  const w = new Float64Array(r);
  let sum = 0;
  for (let k = 0; k < r; k++) {
    w[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (r - 1));
    sum += w[k];
  }
  if (sum === 0) return g;
  for (let k = 0; k < r; k++) w[k] /= sum;

  // np.convolve(g, w, mode="same"): central slice of the full convolution
  const start = (r - 1) >> 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const c = i + start;
    const jLo = Math.max(0, c - (n - 1));
    const jHi = Math.min(r - 1, c);
    for (let j = jLo; j <= jHi; j++) acc += w[j] * g[c - j];
    out[i] = acc;
  }
  return out;
}
