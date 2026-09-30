import { analyze } from "../src/engine/analysis";
const SR = 44100;
function track(bpm: number, first = 0.37, dense = false, secs = 60) {
  const d = new Float32Array(SR * secs), p = 60 / bpm;
  let seed = 1; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  const hit = (t: number, amp: number) => { const s = Math.round(t * SR); for (let k = 0; k < 400 && s + k < d.length; k++) d[s + k] += amp * Math.sin(k * 0.3) * Math.exp(-k / 80); };
  for (let t = first; t < secs - 0.1; t += p) { hit(t, 1); if (dense) hit(t + p / 2, 0.35); }
  if (dense) for (let i = 0; i < d.length; i++) d[i] += rnd() * 0.05;
  return { sampleRate: SR, getChannelData: () => d } as unknown as AudioBuffer;
}
// half/double-time is an accepted ambiguity (mixer folds octaves via pickRate)
const octaveErr = (got: number, t: number) => Math.min(...[1, 2, 0.5].map(m => Math.abs(got - t * m) / m));
let fail = 0;
for (const dense of [false, true]) for (const bpm of [100, 123.4, 128, 125.3, 140, 174]) {
  const a = analyze(track(bpm, 0.37, dense));
  const err = octaveErr(a.bpm, bpm);
  const period = 60 / a.bpm;
  const phaseErr = Math.min((a.firstBeat - 0.37 % period + period) % period, period - ((a.firstBeat - 0.37 % period + period) % period));
  const ok = err < 0.15 && phaseErr < 0.02;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${dense ? "dense" : "clean"} true=${bpm} got=${a.bpm.toFixed(2)} phaseErr=${(phaseErr * 1000).toFixed(0)}ms`);
}
process.exit(fail ? 1 : 0);
