import assert from "node:assert/strict";
import { gridFromBpm, mergeBanks, runScratchAgent, sentenceDirectorFn, sentencePlan, DEFAULT_CONFIG } from "../src/scratch-agent";
import type { Slice, SliceBank } from "../src/scratch-agent";

const sr = 22050;
// main source: silence. If any event wrongly reads it, the window RMS below collapses.
const main = new Float32Array(sr * 2);
// cut source: four "words" (tone bursts) with known times, 1 s apart
const cut = new Float32Array(sr * 6);
const words = [
  { text: "Hello,", at: 0.5, len: 0.28, hz: 500 },
  { text: "world", at: 1.5, len: 0.35, hz: 700 },
  { text: "world", at: 2.5, len: 0.35, hz: 700 }, // repeated word must survive
  { text: "yo!", at: 3.5, len: 0.22, hz: 900 },
];
for (const w of words) {
  const a = Math.floor(w.at * sr);
  const n = Math.floor(w.len * sr);
  for (let i = 0; i < n; i++) cut[a + i] = 0.6 * Math.sin((2 * Math.PI * w.hz * i) / sr) * Math.sin((Math.PI * i) / n);
}
const mk = (start: number, end: number, text: string | null, energy: number): Slice => ({ id: 0, start, end, kind: "word", text, energy });
const mainBank: SliceBank = { source_path: "main", sr, slices: [mk(0.1, 0.3, null, 0.2)], vocal_onsets: [0.1] };
const cutBank: SliceBank = { source_path: "cut", sr, slices: words.map((w) => mk(w.at, w.at + w.len, w.text, 0.7)), vocal_onsets: [] };
const bank = mergeBanks([["main", mainBank], ["cut", cutBank]]);

// mergeBanks: unique ids, source tags, onsets from main
assert.deepEqual(bank.slices.map((s) => s.id), [0, 1, 2, 3, 4]);
assert.deepEqual(bank.slices.map((s) => s.src_id), ["main", "cut", "cut", "cut", "cut"]);
assert.deepEqual(bank.vocal_onsets, [0.1]);
assert.throws(() => mergeBanks([["a", mainBank], ["a", cutBank]]), /duplicate/);
assert.throws(() => mergeBanks([["a", mainBank], ["b", { ...cutBank, sr: 44100 }]]), /resample/);

const bpm = 90;
const grid = gridFromBpm(bpm, 0.1, 16);
const cfg = { ...DEFAULT_CONFIG, placement_mode: "sentence" as const };
const spec = { words: ["hello", "World", "world", "YO"], srcId: "cut" };

// plan: order preserved, on the grid, lengths round up, non-overlapping
const plan = sentencePlan(spec, bank, bpm, 2, cfg);
// "world" twice resolves to the same take (loudest, lowest id), so the repeat is an identical event
assert.deepEqual(plan.items.map((i) => i.slice_id), [1, 2, 2, 4]);
const step = 1 / cfg.subdiv;
plan.items.forEach((it, k) => {
  assert.ok(Math.abs(it.beat / step - Math.round(it.beat / step)) < 1e-9, "beat on grid");
  assert.ok(Math.abs(it.length_beats / step - Math.round(it.length_beats / step)) < 1e-9, "length on grid");
  if (k) assert.ok(it.beat >= plan.items[k - 1].beat + plan.items[k - 1].length_beats - 1e-9, "no overlap");
});
// energy tie-break: two takes of one word -> loudest wins
const dup: SliceBank = { ...cutBank, slices: [ { ...mk(0, 0.2, "hey", 0.3), id: 7, src_id: "cut" }, { ...mk(1, 1.2, "hey", 0.9), id: 8, src_id: "cut" } ] };
assert.equal(sentencePlan({ words: ["hey"] }, dup, bpm, 2, cfg).items[0].slice_id, 8);
// explicit ids work; missing words and overflow throw instead of dropping words
assert.equal(sentencePlan({ words: [3] }, bank, bpm, 2, cfg).items[0].slice_id, 3);
assert.throws(() => sentencePlan({ words: ["nope"] }, bank, bpm, 2, cfg), /not found/);
assert.throws(() => sentencePlan({ words: ["hello"], srcId: "main" }, bank, bpm, 2, cfg), /not found/);
assert.throws(() => sentencePlan({ words: Array(12).fill("world") }, bank, bpm, 2, cfg), /plan has 8 beats/);

// full pipeline
const run = () =>
  runScratchAgent({
    src: main, sources: { cut }, fs: sr, bank, grid, bars: 2, style: "sparse", seed: 3, phraseStartBeat: 0,
    director: sentenceDirectorFn(spec, bank), cfg: { placement_mode: "sentence" },
  });
const r = await run();
assert.equal(r.passed, true, JSON.stringify(r.attempts.at(-1)?.failing));
assert.equal(r.attempts.length, 1, "no rerolls: diversity/density are report-only in sentence mode");
assert.equal(r.events.length, 4, "every word survives (no density drop, repeated word kept)");
assert.deepEqual(r.events.map((e) => e.slice_id), [1, 2, 2, 4]);
r.events.forEach((e, k) => {
  assert.equal(e.n_strokes, 1);
  assert.ok(e.params.avg_rate > 0.5 && e.params.avg_rate <= 1.05, `avg_rate ${e.params.avg_rate}`);
  if (k) assert.ok(e.t0 >= r.events[k - 1].t0 + r.events[k - 1].stroke_T - 0.01, "events do not overlap");
  // audio comes from the cut source: window is loud, though main is silent
  const a = Math.floor(e.t0 * sr), b = a + Math.floor(e.stroke_T * sr);
  let ss = 0; for (let i = a; i < b; i++) ss += r.audio[i] ** 2;
  assert.ok(Math.sqrt(ss / (b - a)) > 0.05, `event ${k} is silent`);
});
// determinism
const r2 = await run();
assert.deepEqual(r2.events, r.events);
assert.equal(r.audio.length, r2.audio.length);
assert.ok(r.audio.every((v, i) => v === r2.audio[i]), "same seed, same audio");

// a slice pointing at an unregistered source is an error, not silence
await assert.rejects(
  runScratchAgent({ src: main, fs: sr, bank, grid, bars: 2, style: "sparse", seed: 3, phraseStartBeat: 0,
    director: sentenceDirectorFn(spec, bank), cfg: { placement_mode: "sentence" } }),
  /needs source "cut"/,
);
console.log("PASS sentence mode + multi-source");
