import { pickRate, nextBarTime, evaluateHarmonicMatch } from "../src/engine/sync";
import {
  evaluateScratchTrajectory,
  findNearestTransientAnchor,
  renderScratchBuffer,
  resolveBattleCutAnchor,
  sampleKaiserSinc,
  SCRATCH_PATTERNS,
} from "../src/engine/scratch";
import { strokeRate } from "../src/scratch-agent/scratch/primitives";
import { CTRL_HZ } from "../src/scratch-agent/scratch/curves";
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

// 90s Scratch Agent System pipeline verification
import {
  buildSliceBank,
  encodeWav16,
  gridFromBpm,
  runScratchAgent,
  validateDirectorPlan,
} from "../src/scratch-agent";

const sr = 22050;
const testMono = new Float32Array(sr * 4);
// Create sharp rhythmic bursts at 0.2s, 0.8s, 1.5s, 2.2s so slicerLite finds transient slices
for (const onset of [0.2, 0.8, 1.5, 2.2, 2.9]) {
  const s0 = Math.floor(onset * sr);
  for (let i = 0; i < Math.floor(0.18 * sr); i++) {
    const env = Math.exp(-i / (0.05 * sr));
    testMono[s0 + i] = Math.sin((2 * Math.PI * 320 * i) / sr) * env * 0.9;
  }
}

const bank = buildSliceBank(testMono, sr, "test-hook", { maxSliceS: 0.35, delta: 0.2 });
assert.ok(bank.slices.length >= 3, "slicerLite should extract transient slices");
const grid = gridFromBpm(94, 0.1, 16);

const res1 = await runScratchAgent({
  src: testMono,
  fs: sr,
  bank,
  grid,
  bars: 2,
  style: "medium",
  seed: 7,
  phraseStartBeat: 0,
  cfg: { placement_mode: "answer" },
});
const res2 = await runScratchAgent({
  src: testMono,
  fs: sr,
  bank,
  grid,
  bars: 2,
  style: "medium",
  seed: 7,
  phraseStartBeat: 0,
  cfg: { placement_mode: "answer" },
});

assert.equal(validateDirectorPlan(res1.plan).ok, true, "DirectorPlan must validate against schema");
assert.ok(res1.events.length > 0, "90s Scratch Agent must place scratch events");
assert.equal(res1.seed, res2.seed, "Same seed must be 100% deterministic");
assert.equal(res1.audio.length, res2.audio.length);
const wav = encodeWav16(res1.audio, sr);
assert.ok(wav.byteLength > 44, "WAV encoder must produce valid RIFF header + PCM payload");

// Club Marathon & Long-Running Party Sequencer verification
import {
  interpolateEnergyCurve,
  pickNextMarathonTrack,
  pickSmartScratchProfile,
  pickSmartTransitionPreset,
  scoreNextTrackCandidate,
  sequenceCrateForParty,
} from "../src/engine/marathon";

const curve = [0.4, 0.6, 0.8, 1.0, 0.7];
close(interpolateEnergyCurve(curve, 0), 0.4);
close(interpolateEnergyCurve(curve, 0.5), 0.8);
close(interpolateEnergyCurve(curve, 1), 0.7);

const mockCrate = [
  { id: "t1", name: "Warmup 8A", analysis: { bpm: 122, firstBeat: 0, key: "8A", energy: 0.45 }, playCount: 0 },
  { id: "t2", name: "Build 9A", analysis: { bpm: 124, firstBeat: 0, key: "9A", energy: 0.65 }, playCount: 0 },
  { id: "t3", name: "Peak 9B", analysis: { bpm: 126, firstBeat: 0, key: "9B", energy: 0.92 }, playCount: 0 },
  { id: "t4", name: "Clash Overplayed", analysis: { bpm: 165, firstBeat: 0, key: "2B", energy: 0.9 }, playCount: 3 },
];

const scGood = scoreNextTrackCandidate({ bpm: 122, key: "8A" }, mockCrate[1], 0.65);
const scBad = scoreNextTrackCandidate({ bpm: 122, key: "8A" }, mockCrate[3], 0.65);
assert.ok(scGood.total > scBad.total, "Harmonic & tempo-matched fresh track must score higher than overplayed tempo-clamped track");

const picked = pickNextMarathonTrack({ bpm: 122, key: "8A" }, mockCrate, new Set(["t1"]), 0.65);
assert.equal(picked?.track.id, "t2", "pickNextMarathonTrack should select highest composite harmonic/BPM/energy/freshness match");

const ordered = sequenceCrateForParty({ bpm: 120, key: "8A" }, mockCrate, curve, 0, 0.25);
assert.equal(ordered.length, 4);
assert.equal(ordered[0].id, "t1", "Marathon sequence should open with warmup energy track");

assert.equal(
  pickSmartTransitionPreset({ bpm: 124, key: "8A", energy: 0.85 }, { bpm: 126, key: "9A", energy: 0.88 }).presetId,
  "bass-swap",
  "High-energy harmonic club tracks should auto-select bass-swap"
);
assert.equal(
  pickSmartTransitionPreset({ bpm: 124, key: "8A", energy: 0.8 }, { bpm: 168, key: "8A", energy: 0.8 }).presetId,
  "quick",
  "Wide tempo gap should auto-select quick cut"
);
assert.equal(
  pickSmartScratchProfile({ bpm: 94, genre: "90s Boom-Bap" }).archetype,
  "premier",
  "Sub-108 BPM hip-hop should auto-select DJ Premier archetype"
);
assert.equal(
  pickSmartScratchProfile({ bpm: 124, energy: 0.8 }).archetype,
  "philly",
  "124 BPM club groove should auto-select Philly Transform archetype"
);

// Precision Scratch Engine verification: zero-drift cycle boundaries, transient anchor, battle cut timbre matching, 32-tap Kaiser sinc
for (const patId of ["baby", "flare", "transformer", "chirp", "crab", "tear"] as const) {
  const p0 = evaluateScratchTrajectory(patId, 0, 2, 1.0, "mag-four");
  const pEnd = evaluateScratchTrajectory(patId, 2, 2, 1.0, "mag-four");
  close(p0.posBeats, 0, 1e-6);
  close(pEnd.posBeats, 0, 1e-5);
}

// Wrist-whip strokeRate integral must equal exact requested span
const whipRate = strokeRate(0.25, 0.18, 1);
const integratedSpan = whipRate.reduce((s, r) => s + r / CTRL_HZ, 0);
close(integratedSpan, 0.18, 1e-3);

// Transient onset anchor detector must lock onto a sharp drum/vocal impulse within window
const transientBuf = new Float32Array(sr * 2);
const hitSec = 1.12;
const hitSample = Math.floor(hitSec * sr);
for (let i = 0; i < Math.floor(0.05 * sr); i++) {
  transientBuf[hitSample + i] = Math.sin((2 * Math.PI * 440 * i) / sr) * Math.exp(-i / (0.01 * sr));
}
const detectedAnchor = findNearestTransientAnchor(transientBuf, sr, 1.0, 0.3);
assert.ok(
  Math.abs(detectedAnchor - hitSec) < 0.02,
  `findNearestTransientAnchor should lock within 20ms of transient at ${hitSec}s, got ${detectedAnchor}s`
);

assert.equal(resolveBattleCutAnchor("crab", "auto").label, "FRESH");
assert.equal(resolveBattleCutAnchor("baby", "auto").label, "AHHH");
assert.equal(resolveBattleCutAnchor("baby", "scratch").start, 2.5);

// 32-tap Kaiser-windowed sinc interpolation accuracy on DC signal
const dcSignal = new Float32Array(128).fill(0.75);
close(sampleKaiserSinc(dcSignal, 64.37, 1.0), 0.75, 1e-2);

// Verify 90s Scratch Agent returns real platter velocity, displacement, and gate timelines (no audio-peak faking)
assert.equal(res1.rateTimeline.length, res1.audio.length, "rateTimeline must match audio sample length");
assert.equal(res1.dispTimeline.length, res1.audio.length, "dispTimeline must match audio sample length");
assert.equal(res1.gateTimeline.length, res1.audio.length, "gateTimeline must match audio sample length");
assert.ok(res1.rateTimeline.some(v => Math.abs(v) > 0.2), "rateTimeline must contain real platter velocity values");
assert.ok(res1.gateTimeline.some(g => g > 0.5), "gateTimeline must contain real optical gate values");

const intelCheck = res1.attempts.at(-1)?.report.checks.find(c => c.name === "intelligibility");
assert.ok(
  intelCheck && intelCheck.value !== null && intelCheck.value >= 0.35,
  `Critic intelligibility check must compute a real articulation score >= 0.35, got ${intelCheck?.value}`
);

// Verify synthesizeStudioTrack + analyze() detects real BPM and Camelot key directly from PCM without hardcoded overrides
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "../src/engine/synthTracks";
import { analyze } from "../src/engine/analysis";

const mockCtx = {
  sampleRate: 22050,
  createBuffer(channels: number, length: number, sampleRate: number) {
    const chs = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      sampleRate,
      length,
      duration: length / sampleRate,
      numberOfChannels: channels,
      getChannelData: (c: number) => chs[c],
    } as unknown as AudioBuffer;
  },
} as unknown as BaseAudioContext;

for (const spec of BUILTIN_TRACK_SPECS) {
  const synthBuf = synthesizeStudioTrack(mockCtx, { ...spec, durationSec: 24 });
  const detected = analyze(synthBuf);
  assert.ok(
    Math.abs(detected.bpm - spec.bpm) < 1.5,
    `Real DSP analyze() on "${spec.title}" expected ~${spec.bpm} BPM, got ${detected.bpm}`
  );
  assert.equal(
    detected.key,
    spec.camelot,
    `Real DSP analyze() on "${spec.title}" expected Camelot key ${spec.camelot}, got ${detected.key}`
  );
}

// Verify scratching actually modifies the loaded music track AudioBuffer in-place and updates its 3-band waveform
const trackBuf = synthesizeStudioTrack(mockCtx, { ...BUILTIN_TRACK_SPECS[0], durationSec: 12 });
const origCopy = new Float32Array(trackBuf.getChannelData(0));
const renderedScratch = renderScratchBuffer(
  mockCtx,
  trackBuf,
  2.0,
  2,
  60 / 124,
  "flare",
  1.0,
  "mag-four"
);
const spliceStartSample = Math.floor(2.0 * trackBuf.sampleRate);
const ch0 = trackBuf.getChannelData(0);
const scr0 = renderedScratch.buffer.getChannelData(0);
let diffEnergyBefore = 0;
for (let i = 100; i < 1000; i++) {
  diffEnergyBefore += Math.abs(ch0[spliceStartSample + i] - origCopy[spliceStartSample + i]);
}
assert.equal(diffEnergyBefore, 0, "Track buffer should match original before scratch splice");

// Simulate spliceScratchIntoTrack in-place PCM modification
for (let i = 0; i < renderedScratch.buffer.length; i++) {
  ch0[spliceStartSample + i] = scr0[i];
}
let diffEnergyAfter = 0;
for (let i = 100; i < 1000; i++) {
  diffEnergyAfter += Math.abs(ch0[spliceStartSample + i] - origCopy[spliceStartSample + i]);
}
assert.ok(
  diffEnergyAfter > 1.0,
  "Scratching must actually modify the music file's PCM samples in the AudioBuffer"
);

import {
  decode14BitCcPair,
  decodeRelativeJogDelta,
  MidiControllerEngine,
  midiCcToBipolar,
  midiCcToEqDb,
  parseMidiMessage,
} from "../src/engine/midi";

// Web MIDI API Hardware Controller Engine verification (3-Band EQ, Playhead Scrub, Jog Scratch, Nudge, Pitchbend & MIDI Learn)
const parsedCc = parseMidiMessage(new Uint8Array([0xb0, 7, 127]));
assert.equal(parsedCc.kind, "cc");
assert.equal(parsedCc.channel, 0);
assert.equal(parsedCc.number, 7);
assert.equal(parsedCc.value, 127);

const parsedNoteOn = parseMidiMessage(new Uint8Array([0x91, 54, 100]));
assert.equal(parsedNoteOn.kind, "noteon");
assert.equal(parsedNoteOn.channel, 1);
assert.equal(parsedNoteOn.number, 54);

const parsedVelZeroOff = parseMidiMessage(new Uint8Array([0x90, 54, 0]));
assert.equal(parsedVelZeroOff.kind, "noteoff");

const parsedPitchBendCenter = parseMidiMessage(new Uint8Array([0xe0, 0x00, 0x40]));
assert.equal(parsedPitchBendCenter.kind, "pitchbend");
assert.equal(parsedPitchBendCenter.value, 0);

// 3-Band Isolator EQ CC mapping (-24dB .. 0dB center detent .. +6dB)
close(midiCcToEqDb(0), -24);
close(midiCcToEqDb(64), 0);
close(midiCcToEqDb(127), 6);
close(midiCcToBipolar(0), -1);
close(midiCcToBipolar(64), 0);
close(midiCcToBipolar(127), 1);

// Relative Jog Wheel 2's-complement & absolute delta decoding
assert.equal(decodeRelativeJogDelta(4, null), 4);
assert.equal(decodeRelativeJogDelta(124, null), -4);
assert.equal(decodeRelativeJogDelta(70, 64), 6);

const midiLog: string[] = [];
let lastEq: { deck: 0 | 1; band: string; db: number } | null = null;
let lastSeek: { deck: 0 | 1; ratio: number } | null = null;
let lastNudge: { deck: 0 | 1; deltaSec: number } | null = null;
let lastScratchVel: { deck: 0 | 1; vel: number } | null = null;
let platterTouchState = false;
let lastPitch: { deck: 0 | 1; pct: number } | null = null;

const midiTestEngine = new MidiControllerEngine({
  onCrossfader: pos => midiLog.push(`cf:${pos.toFixed(2)}`),
  onChannelVolume: (d, v) => midiLog.push(`vol:${d}:${v.toFixed(2)}`),
  onEq: (deck, band, db) => {
    lastEq = { deck, band, db };
  },
  onEqKill: (d, b) => midiLog.push(`kill:${d}:${b}`),
  onColorFilter: (d, v) => midiLog.push(`flt:${d}:${v.toFixed(2)}`),
  onPitchPct: (deck, pct) => {
    lastPitch = { deck, pct };
  },
  onSeekNormalized: (deck, ratio01) => {
    lastSeek = { deck, ratio: ratio01 };
  },
  onJogNudge: (deck, deltaSec) => {
    lastNudge = { deck, deltaSec };
  },
  onBeatJump: (d, b) => midiLog.push(`jump:${d}:${b}`),
  onPlatterTouch: (_d, touched) => {
    platterTouchState = touched;
  },
  onJogScratchVelocity: (deck, velocity) => {
    lastScratchVel = { deck, vel: velocity };
  },
  onPlayToggle: d => midiLog.push(`play:${d}`),
  onSyncDeck: d => midiLog.push(`sync:${d}`),
  onHotCue: (d, cue) => midiLog.push(`cue:${d}:${cue}`),
  onScratchPad: id => midiLog.push(`pad:${id}`),
  onDrop90sAgent: () => midiLog.push("agent"),
  onSmartMix: () => midiLog.push("smartmix"),
});

// 1. Deck A Low EQ (CH1 CC#15 = 0 -> -24dB) & Deck B High EQ (CH2 CC#7 = 127 -> +6dB)
midiTestEngine.handleRawMidiBytes([0xb0, 15, 0], 1000);
assert.deepEqual(lastEq, { deck: 0, band: "low", db: -24 });
midiTestEngine.handleRawMidiBytes([0xb1, 7, 127], 1010);
assert.deepEqual(lastEq, { deck: 1, band: "high", db: 6 });

// 2. Playhead Needle Scrub (CH1 CC#16 = 64 -> ~0.5039) & Outer Jog Nudge (CH2 CC#34 = 3 -> +0.12s)
midiTestEngine.handleRawMidiBytes([0xb0, 16, 64], 1020);
assert.equal(lastSeek?.deck, 0);
close(lastSeek!.ratio, 64 / 127, 1e-4);

midiTestEngine.handleRawMidiBytes([0xb1, 34, 3], 1030);
assert.equal(lastNudge?.deck, 1);
close(lastNudge!.deltaSec, 0.12, 1e-4);

// 3. Capacitive Platter Touch (CH1 Note#54) + Jog Wheel Vinyl Scratch (CH1 CC#33)
midiTestEngine.handleRawMidiBytes([0x90, 54, 127], 1040);
assert.equal(platterTouchState, true);
midiTestEngine.handleRawMidiBytes([0xb0, 33, 6], 1056);
assert.equal(lastScratchVel?.deck, 0);
assert.ok(lastScratchVel!.vel > 0.2, "Jog CW ticks must produce positive vinyl scratch velocity");
midiTestEngine.handleRawMidiBytes([0x80, 54, 0], 1080);
assert.equal(platterTouchState, false);

// 4. Interactive MIDI Learn (re-bind eqMidA to CH3 CC#74) & 14-bit Pitchbend learn
midiTestEngine.armLearn("eqMidA");
midiTestEngine.handleRawMidiBytes([0xb2, 74, 90], 1100);
assert.equal(midiTestEngine.learningControlId, null, "MIDI Learn should disarm after capturing message");
midiTestEngine.handleRawMidiBytes([0xb2, 74, 0], 1110);
assert.deepEqual(lastEq, { deck: 0, band: "mid", db: -24 });

// 5. Controller Profile switching (Numark/Hercules uses 14-bit Pitchbend for pitchA)
midiTestEngine.applyControllerProfile("numark-hercules");
midiTestEngine.handleRawMidiBytes([0xe0, 0x00, 0x60], 1120); // +4096 (+50% of range -> +4.0% pitch)
assert.equal(lastPitch?.deck, 0);
close(lastPitch!.pct, 4.0, 1e-2);
midiTestEngine.resetDefaultBindings();

// 6. 14-Bit High-Resolution CC Pair (MSB CC#0 + LSB CC#32 on CH1 -> pitchA with 16384 steps)
const pairCenter = decode14BitCcPair(64, 0);
assert.equal(pairCenter.val14, 8192);
close(pairCenter.bipolar, 0, 1e-6);
midiTestEngine.handleRawMidiBytes([0xb0, 0, 80], 1200);   // MSB CC#0 = 80
midiTestEngine.handleRawMidiBytes([0xb0, 32, 64], 1205);  // LSB CC#32 = 64 -> val14 = (80<<7)|64 = 10304
assert.equal(lastPitch?.deck, 0);
const expectedPitch14 = +(((10304 - 8192) / 8191) * 8).toFixed(3);
close(lastPitch!.pct, expectedPitch14, 1e-3);

// 7. Soft-Takeover (Pickup Mode): prevents abrupt parameter jumps until physical pot crosses software target
midiTestEngine.setSoftTakeover(true);
midiTestEngine.setSoftwareTargetNormalized("eqLowA", 0.5); // Software EQ Low is at 0dB (50%)
lastEq = null;
midiTestEngine.handleRawMidiBytes([0xb0, 15, 10], 1250); // Physical knob is down at 10/127 (~7.8%) -> blocked!
assert.equal(lastEq, null, "Soft-Takeover must block distant physical knob from causing an abrupt jump");
assert.ok(midiTestEngine.lastActivity.includes("PICKUP WAIT"), "Soft-Takeover must report pickup direction");
midiTestEngine.handleRawMidiBytes([0xb0, 15, 64], 1260); // Physical knob crosses 64/127 (50%) -> picked up!
assert.deepEqual(lastEq, { deck: 0, band: "low", db: 0 });
midiTestEngine.setSoftTakeover(false);

// 8. Jog Wheel Mode ("nudge" vs "vinyl"), 8-Pad Matrix & JSON Map Export/Import
midiTestEngine.setJogWheelMode("nudge");
midiTestEngine.setJogSensitivity(1.8);
midiTestEngine.handleRawMidiBytes([0xb0, 33, 2], 1300); // Jog A with mode="nudge" routes to playhead nudge
assert.equal(lastNudge?.deck, 0);
close(lastNudge!.deltaSec, 2 * 0.04 * 1.8, 1e-4);
midiTestEngine.setJogWheelMode("vinyl");
midiTestEngine.setJogSensitivity(1.0);

midiTestEngine.handleRawMidiBytes([0x90, 40, 127], 1320); // Note#40 -> scratchPad5 ("crab")
assert.ok(midiLog.includes("pad:crab"), "Scratch Pad 5 Note#40 must trigger 4-Finger Crab");

const exportedJson = midiTestEngine.exportBindingsJson();
const importRes = midiTestEngine.importBindingsJson(exportedJson);
assert.equal(importRes.ok, true);
assert.ok(importRes.count >= 45, "JSON export/import must round-trip all MIDI control bindings");

console.log("PASS sync + harmonic + autoscratch + 90s-scratch-agent + club-marathon + smart-automation + precision-scratch-dsp + track-buffer-mod + web-midi-controller-pro");


