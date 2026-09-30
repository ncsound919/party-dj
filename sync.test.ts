import { pickRate, nextBarTime } from "../src/engine/sync";
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
console.log("PASS sync");
