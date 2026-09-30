import { pickRate, nextBarTime, evaluateHarmonicMatch } from "../src/engine/sync";
import { evaluateScratchTrajectory, SCRATCH_PATTERNS } from "../src/engine/scratch";
import assert from "node:assert/strict";
const close = (a: number, b: number, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} !~ ${b}`);

let r = pickRate(128, 125); close(r.rate, 128 / 125); assert.equal(r.clamped, false);
r = pickRate(140, 70); close(r.rate, 1); assert.equal(r.clamped, false);       // half-time lock
r = pickRate(70, 140); close(r.rate, 1);                                        // double-time lock
r = pickRate(128, 174); assert.equal(r.clamped, true); close(r.rate, 0.92);     // too far apart
close(pickRate(120, 100).rate, 1.08);                                           // clamp at +8%
close(pickRate(128, 125).effBpm, 128);                                          // effective tempo tracks outgoing

// bar grid: 120 bpm => 2 s/bar, anchored at t=10
close(nextBarTime(10.5, 10, 2), 12);
close(nextBarTime(11.95, 10, 2), 14);   // <0.1 s lead => skip to following bar
close(nextBarTime(5, 10, 2), 10);       // before anchor => first bar line
close(nextBarTime(12, 10, 2), 14);      // exactly on a bar line, lead pushes to next

// Camelot wheel harmonic matching
assert.equal(evaluateHarmonicMatch("8A", "8A").tier, "perfect");
assert.equal(evaluateHarmonicMatch("8A", "8B").tier, "perfect");
assert.equal(evaluateHarmonicMatch("8A", "9A").tier, "harmonic");
assert.equal(evaluateHarmonicMatch("8A", "3A").tier, "energy-boost");

// Autoscratch trajectory verification (bidirectional velocity + VCA gate bounds)
for (const pat of SCRATCH_PATTERNS) {
  let sawForward = false, sawReverse = false;
  for (let b = 0; b <= pat.beats; b += 0.02) {
    const pt = evaluateScratchTrajectory(pat.id, b, pat.beats, 1.0);
    if (pt.velocity > 0.1) sawForward = true;
    if (pt.velocity < -0.1) sawReverse = true;
    assert.ok(pt.faderGain >= 0 && pt.faderGain <= 1.0001, `faderGain out of range for ${pat.id}`);
  }
  assert.ok(sawForward && sawReverse, `Pattern ${pat.id} must have true bidirectional platter motion`);
}
console.log("PASS sync + harmonic + autoscratch");
