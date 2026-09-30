import type { CuePoints, ScratchPatternId } from "./types";

export type MidiControllerProfileId = "pioneer-ddj" | "numark-hercules" | "generic-cc";
export type MidiJogMode = "vinyl" | "nudge";

export type MidiControlId =
  | "crossfader"
  | "volA"
  | "volB"
  | "eqHighA"
  | "eqMidA"
  | "eqLowA"
  | "filterA"
  | "eqHighB"
  | "eqMidB"
  | "eqLowB"
  | "filterB"
  | "pitchA"
  | "pitchB"
  | "jogScratchA"
  | "jogScratchB"
  | "jogNudgeA"
  | "jogNudgeB"
  | "seekA"
  | "seekB"
  | "beatJumpBackA"
  | "beatJumpFwdA"
  | "beatJumpBackB"
  | "beatJumpFwdB"
  | "platterTouchA"
  | "platterTouchB"
  | "playA"
  | "playB"
  | "syncA"
  | "syncB"
  | "pflA"
  | "pflB"
  | "loopToggleA"
  | "loopHalveA"
  | "loopDoubleA"
  | "loopToggleB"
  | "loopHalveB"
  | "loopDoubleB"
  | "killHighA"
  | "killMidA"
  | "killLowA"
  | "killHighB"
  | "killMidB"
  | "killLowB"
  | "cueIntroA"
  | "cueDropA"
  | "cueBreakA"
  | "cueOutroA"
  | "cueIntroB"
  | "cueDropB"
  | "cueBreakB"
  | "cueOutroB"
  | "scratchPad1"
  | "scratchPad2"
  | "scratchPad3"
  | "scratchPad4"
  | "scratchPad5"
  | "scratchPad6"
  | "scratchPad7"
  | "scratchPad8"
  | "fxSiren"
  | "fxDrop"
  | "fxLaser"
  | "fxBrake"
  | "drop90sAgent"
  | "smartMixNext";

export interface MidiBinding {
  controlId: MidiControlId;
  label: string;
  category:
    | "Jog & Playhead"
    | "EQ & Filter"
    | "Mixer & Faders"
    | "Transport & Loops"
    | "Pads & FX";
  kind: "cc" | "note" | "pitchbend";
  channel: number; // 0..15 (-1 = any channel)
  number: number;  // CC number or Note number (0..127)
}

export interface ParsedMidiMessage {
  kind: "cc" | "noteon" | "noteoff" | "pitchbend" | "other";
  channel: number; // 0..15
  number: number;  // CC or Note (0..127)
  value: number;   // 0..127 (or -8192..+8191 for pitchbend)
  rawHex: string;
}

/**
 * Parses a raw 3-byte Web MIDI API `MIDIMessageEvent.data` packet into a structured message.
 */
export function parseMidiMessage(data: ArrayLike<number>): ParsedMidiMessage {
  const b0 = data[0] ?? 0;
  const b1 = data[1] ?? 0;
  const b2 = data[2] ?? 0;
  const statusType = b0 & 0xf0;
  const channel = b0 & 0x0f;
  const rawHex = [b0, b1, b2]
    .slice(0, Math.min(3, data.length))
    .map(x => x.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");

  if (statusType === 0xb0) {
    return { kind: "cc", channel, number: b1 & 0x7f, value: b2 & 0x7f, rawHex };
  }
  if (statusType === 0x90) {
    const val = b2 & 0x7f;
    return {
      kind: val > 0 ? "noteon" : "noteoff",
      channel,
      number: b1 & 0x7f,
      value: val,
      rawHex,
    };
  }
  if (statusType === 0x80) {
    return { kind: "noteoff", channel, number: b1 & 0x7f, value: b2 & 0x7f, rawHex };
  }
  if (statusType === 0xe0) {
    const val14 = ((b2 & 0x7f) << 7) | (b1 & 0x7f);
    return {
      kind: "pitchbend",
      channel,
      number: 0,
      value: val14 - 8192,
      rawHex,
    };
  }
  return { kind: "other", channel, number: b1 & 0x7f, value: b2 & 0x7f, rawHex };
}

/**
 * Converts a 7-bit MIDI CC value (0..127) to a 3-band Isolator EQ gain in dB (-24 dB .. +6 dB)
 * with a true center detent at CC=64 (0.0 dB).
 */
export function midiCcToEqDb(ccVal: number): number {
  const v = Math.max(0, Math.min(127, ccVal));
  if (v === 64) return 0;
  if (v < 64) {
    return +(((v - 64) / 64) * 24).toFixed(1); // -24.0 .. 0.0 dB
  }
  return +(((v - 64) / 63) * 6).toFixed(1); // 0.0 .. +6.0 dB
}

/**
 * Converts a normalized 0..1 value (from 7-bit CC or 14-bit MSB/LSB CC) to a 3-band EQ gain in dB (-24..+6 dB)
 * with a center detent at 0.5 (0.0 dB).
 */
export function normalizedToEqDb(norm01: number): number {
  const n = Math.max(0, Math.min(1, norm01));
  if (Math.abs(n - 0.5) < 0.004) return 0;
  if (n < 0.5) {
    return +(((n - 0.5) / 0.5) * 24).toFixed(2);
  }
  return +(((n - 0.5) / 0.5) * 6).toFixed(2);
}

/**
 * Converts a 7-bit MIDI CC value (0..127) to a bipolar value (-1 .. +1) with center detent at 64 -> 0.
 */
export function midiCcToBipolar(ccVal: number): number {
  const v = Math.max(0, Math.min(127, ccVal));
  if (v === 64) return 0;
  if (v < 64) return (v - 64) / 64;
  return (v - 64) / 63;
}

/**
 * Converts a 7-bit MIDI CC value (0..127) to a normalized 0..1 value with exact 0.5 center at CC=64.
 */
export function midiCcToNormalized01(ccVal: number): number {
  return (midiCcToBipolar(ccVal) + 1) * 0.5;
}

/**
 * Decodes a 14-bit MIDI CC MSB (0..127) + LSB (0..127) pair into a 14-bit integer (0..16383)
 * and a normalized 0..1 float with exact 0.5 center at 8192 (MSB=64, LSB=0).
 */
export function decode14BitCcPair(msb: number, lsb: number): { val14: number; norm01: number; bipolar: number } {
  const m = Math.max(0, Math.min(127, msb));
  const l = Math.max(0, Math.min(127, lsb));
  const val14 = (m << 7) | l;
  let bipolar = 0;
  if (val14 < 8192) {
    bipolar = (val14 - 8192) / 8192;
  } else if (val14 > 8192) {
    bipolar = (val14 - 8192) / 8191;
  }
  const norm01 = (bipolar + 1) * 0.5;
  return { val14, norm01, bipolar };
}

/**
 * Decodes a 7-bit MIDI Jog Wheel CC value into signed relative encoder ticks.
 * Supports both 2's-complement relative mode (1..63 = CW, 65..127 = CCW as value-128)
 * and absolute wrap-around fallback when a standard rotary knob is spun.
 */
export function decodeRelativeJogDelta(ccVal: number, prevAbsoluteVal: number | null = null): number {
  const v = Math.max(0, Math.min(127, ccVal));
  if (prevAbsoluteVal === null) {
    if (v >= 1 && v <= 63) return v;
    if (v >= 65 && v <= 127) return v - 128;
    return 0;
  }
  if ((v >= 1 && v <= 20 && Math.abs(v - prevAbsoluteVal) > 25) || (v >= 108 && v <= 127 && Math.abs(v - prevAbsoluteVal) > 25)) {
    return v <= 63 ? v : v - 128;
  }
  const diff = v - prevAbsoluteVal;
  if (diff === 0) {
    if (v === 1) return 1;
    if (v === 127) return -1;
    return 0;
  }
  return Math.max(-24, Math.min(24, diff));
}

export const DEFAULT_MIDI_BINDINGS: MidiBinding[] = [
  // Jog Wheels & Playheads
  { controlId: "jogScratchA", label: "Deck A Jog Wheel / Vinyl Scratch", category: "Jog & Playhead", kind: "cc", channel: 0, number: 33 },
  { controlId: "jogScratchB", label: "Deck B Jog Wheel / Vinyl Scratch", category: "Jog & Playhead", kind: "cc", channel: 1, number: 33 },
  { controlId: "jogNudgeA", label: "Deck A Outer Jog / Playhead Nudge", category: "Jog & Playhead", kind: "cc", channel: 0, number: 34 },
  { controlId: "jogNudgeB", label: "Deck B Outer Jog / Playhead Nudge", category: "Jog & Playhead", kind: "cc", channel: 1, number: 34 },
  { controlId: "platterTouchA", label: "Deck A Platter Touch Sensor", category: "Jog & Playhead", kind: "note", channel: 0, number: 54 },
  { controlId: "platterTouchB", label: "Deck B Platter Touch Sensor", category: "Jog & Playhead", kind: "note", channel: 1, number: 54 },
  { controlId: "seekA", label: "Deck A Playhead Needle Scrub", category: "Jog & Playhead", kind: "cc", channel: 0, number: 16 },
  { controlId: "seekB", label: "Deck B Playhead Needle Scrub", category: "Jog & Playhead", kind: "cc", channel: 1, number: 16 },
  { controlId: "beatJumpBackA", label: "Deck A Beatjump -1 Bar (-4B)", category: "Jog & Playhead", kind: "note", channel: 0, number: 32 },
  { controlId: "beatJumpFwdA", label: "Deck A Beatjump +1 Bar (+4B)", category: "Jog & Playhead", kind: "note", channel: 0, number: 33 },
  { controlId: "beatJumpBackB", label: "Deck B Beatjump -1 Bar (-4B)", category: "Jog & Playhead", kind: "note", channel: 1, number: 32 },
  { controlId: "beatJumpFwdB", label: "Deck B Beatjump +1 Bar (+4B)", category: "Jog & Playhead", kind: "note", channel: 1, number: 33 },

  // 3-Band Isolator EQ & Color Filter
  { controlId: "eqHighA", label: "Deck A High EQ (-24..+6dB)", category: "EQ & Filter", kind: "cc", channel: 0, number: 7 },
  { controlId: "eqMidA", label: "Deck A Mid EQ (-24..+6dB)", category: "EQ & Filter", kind: "cc", channel: 0, number: 11 },
  { controlId: "eqLowA", label: "Deck A Low EQ (-24..+6dB)", category: "EQ & Filter", kind: "cc", channel: 0, number: 15 },
  { controlId: "filterA", label: "Deck A Color Filter (LP/HP)", category: "EQ & Filter", kind: "cc", channel: 0, number: 23 },
  { controlId: "eqHighB", label: "Deck B High EQ (-24..+6dB)", category: "EQ & Filter", kind: "cc", channel: 1, number: 7 },
  { controlId: "eqMidB", label: "Deck B Mid EQ (-24..+6dB)", category: "EQ & Filter", kind: "cc", channel: 1, number: 11 },
  { controlId: "eqLowB", label: "Deck B Low EQ (-24..+6dB)", category: "EQ & Filter", kind: "cc", channel: 1, number: 15 },
  { controlId: "filterB", label: "Deck B Color Filter (LP/HP)", category: "EQ & Filter", kind: "cc", channel: 1, number: 23 },
  { controlId: "killHighA", label: "Deck A High EQ Kill (-48dB)", category: "EQ & Filter", kind: "note", channel: 0, number: 24 },
  { controlId: "killMidA", label: "Deck A Mid EQ Kill (-48dB)", category: "EQ & Filter", kind: "note", channel: 0, number: 25 },
  { controlId: "killLowA", label: "Deck A Low EQ Kill (-48dB)", category: "EQ & Filter", kind: "note", channel: 0, number: 26 },
  { controlId: "killHighB", label: "Deck B High EQ Kill (-48dB)", category: "EQ & Filter", kind: "note", channel: 1, number: 24 },
  { controlId: "killMidB", label: "Deck B Mid EQ Kill (-48dB)", category: "EQ & Filter", kind: "note", channel: 1, number: 25 },
  { controlId: "killLowB", label: "Deck B Low EQ Kill (-48dB)", category: "EQ & Filter", kind: "note", channel: 1, number: 26 },

  // Mixer & Faders (Supports 7-bit CC and 14-bit MSB+LSB CC pairs)
  { controlId: "crossfader", label: "Master Crossfader (A <-> B)", category: "Mixer & Faders", kind: "cc", channel: -1, number: 31 },
  { controlId: "volA", label: "Deck A Channel Fader", category: "Mixer & Faders", kind: "cc", channel: 0, number: 19 },
  { controlId: "volB", label: "Deck B Channel Fader", category: "Mixer & Faders", kind: "cc", channel: 1, number: 19 },
  { controlId: "pitchA", label: "Deck A Tempo Pitch (14-Bit / CC#0)", category: "Mixer & Faders", kind: "cc", channel: 0, number: 0 },
  { controlId: "pitchB", label: "Deck B Tempo Pitch (14-Bit / CC#0)", category: "Mixer & Faders", kind: "cc", channel: 1, number: 0 },

  // Transport, Sync, PFL & Auto-Loops
  { controlId: "playA", label: "Deck A Play / Pause", category: "Transport & Loops", kind: "note", channel: 0, number: 11 },
  { controlId: "playB", label: "Deck B Play / Pause", category: "Transport & Loops", kind: "note", channel: 1, number: 11 },
  { controlId: "syncA", label: "Deck A Beat Sync", category: "Transport & Loops", kind: "note", channel: 0, number: 88 },
  { controlId: "syncB", label: "Deck B Beat Sync", category: "Transport & Loops", kind: "note", channel: 1, number: 88 },
  { controlId: "pflA", label: "Deck A Headphone Cue (PFL)", category: "Transport & Loops", kind: "note", channel: 0, number: 84 },
  { controlId: "pflB", label: "Deck B Headphone Cue (PFL)", category: "Transport & Loops", kind: "note", channel: 1, number: 84 },
  { controlId: "loopToggleA", label: "Deck A 4-Bar Auto-Loop Toggle", category: "Transport & Loops", kind: "note", channel: 0, number: 16 },
  { controlId: "loopHalveA", label: "Deck A Loop Halve (1/2x)", category: "Transport & Loops", kind: "note", channel: 0, number: 18 },
  { controlId: "loopDoubleA", label: "Deck A Loop Double (2x)", category: "Transport & Loops", kind: "note", channel: 0, number: 19 },
  { controlId: "loopToggleB", label: "Deck B 4-Bar Auto-Loop Toggle", category: "Transport & Loops", kind: "note", channel: 1, number: 16 },
  { controlId: "loopHalveB", label: "Deck B Loop Halve (1/2x)", category: "Transport & Loops", kind: "note", channel: 1, number: 18 },
  { controlId: "loopDoubleB", label: "Deck B Loop Double (2x)", category: "Transport & Loops", kind: "note", channel: 1, number: 19 },
  { controlId: "cueIntroA", label: "Deck A Hot Cue INTRO", category: "Transport & Loops", kind: "note", channel: 0, number: 0 },
  { controlId: "cueDropA", label: "Deck A Hot Cue DROP", category: "Transport & Loops", kind: "note", channel: 0, number: 1 },
  { controlId: "cueBreakA", label: "Deck A Hot Cue BREAK", category: "Transport & Loops", kind: "note", channel: 0, number: 2 },
  { controlId: "cueOutroA", label: "Deck A Hot Cue OUTRO", category: "Transport & Loops", kind: "note", channel: 0, number: 3 },
  { controlId: "cueIntroB", label: "Deck B Hot Cue INTRO", category: "Transport & Loops", kind: "note", channel: 1, number: 0 },
  { controlId: "cueDropB", label: "Deck B Hot Cue DROP", category: "Transport & Loops", kind: "note", channel: 1, number: 1 },
  { controlId: "cueBreakB", label: "Deck B Hot Cue BREAK", category: "Transport & Loops", kind: "note", channel: 1, number: 2 },
  { controlId: "cueOutroB", label: "Deck B Hot Cue OUTRO", category: "Transport & Loops", kind: "note", channel: 1, number: 3 },

  // 8 Autoscratch Performance Pads, Club FX & Agent Triggers
  { controlId: "scratchPad1", label: "Scratch Pad 1 (Baby Scratch)", category: "Pads & FX", kind: "note", channel: -1, number: 36 },
  { controlId: "scratchPad2", label: "Scratch Pad 2 (Orbit Flare)", category: "Pads & FX", kind: "note", channel: -1, number: 37 },
  { controlId: "scratchPad3", label: "Scratch Pad 3 (Transformer)", category: "Pads & FX", kind: "note", channel: -1, number: 38 },
  { controlId: "scratchPad4", label: "Scratch Pad 4 (Chirp Cut)", category: "Pads & FX", kind: "note", channel: -1, number: 39 },
  { controlId: "scratchPad5", label: "Scratch Pad 5 (4-Finger Crab)", category: "Pads & FX", kind: "note", channel: -1, number: 40 },
  { controlId: "scratchPad6", label: "Scratch Pad 6 (Tear Scratch)", category: "Pads & FX", kind: "note", channel: -1, number: 41 },
  { controlId: "scratchPad7", label: "Scratch Pad 7 (Backspin)", category: "Pads & FX", kind: "note", channel: -1, number: 42 },
  { controlId: "scratchPad8", label: "Scratch Pad 8 (Laser Stutter)", category: "Pads & FX", kind: "note", channel: -1, number: 43 },
  { controlId: "drop90sAgent", label: "Drop 90s Scratch Agent Cut", category: "Pads & FX", kind: "note", channel: -1, number: 44 },
  { controlId: "smartMixNext", label: "Trigger Smart Mix Transition", category: "Pads & FX", kind: "note", channel: -1, number: 45 },
  { controlId: "fxSiren", label: "Club FX: Dub Siren", category: "Pads & FX", kind: "note", channel: -1, number: 46 },
  { controlId: "fxDrop", label: "Club FX: 808 Sub Drop", category: "Pads & FX", kind: "note", channel: -1, number: 47 },
  { controlId: "fxLaser", label: "Club FX: Laser Riser", category: "Pads & FX", kind: "note", channel: -1, number: 48 },
  { controlId: "fxBrake", label: "Club FX: Vinyl Brake", category: "Pads & FX", kind: "note", channel: -1, number: 49 },
];

const PROFILE_OVERRIDES: Record<
  MidiControllerProfileId,
  Partial<Record<MidiControlId, { kind: "cc" | "note" | "pitchbend"; channel: number; number: number }>>
> = {
  "pioneer-ddj": {}, // Uses DEFAULT_MIDI_BINDINGS (Pioneer DDJ-400 / FLX4 / SB3 layout)
  "numark-hercules": {
    jogScratchA: { kind: "cc", channel: 0, number: 16 },
    jogScratchB: { kind: "cc", channel: 1, number: 16 },
    jogNudgeA: { kind: "cc", channel: 0, number: 17 },
    jogNudgeB: { kind: "cc", channel: 1, number: 17 },
    platterTouchA: { kind: "note", channel: 0, number: 48 },
    platterTouchB: { kind: "note", channel: 1, number: 48 },
    seekA: { kind: "cc", channel: 0, number: 18 },
    seekB: { kind: "cc", channel: 1, number: 18 },
    eqHighA: { kind: "cc", channel: 0, number: 20 },
    eqMidA: { kind: "cc", channel: 0, number: 21 },
    eqLowA: { kind: "cc", channel: 0, number: 22 },
    filterA: { kind: "cc", channel: 0, number: 23 },
    eqHighB: { kind: "cc", channel: 1, number: 20 },
    eqMidB: { kind: "cc", channel: 1, number: 21 },
    eqLowB: { kind: "cc", channel: 1, number: 22 },
    filterB: { kind: "cc", channel: 1, number: 23 },
    crossfader: { kind: "cc", channel: -1, number: 8 },
    volA: { kind: "cc", channel: 0, number: 10 },
    volB: { kind: "cc", channel: 1, number: 10 },
    pitchA: { kind: "pitchbend", channel: 0, number: 0 },
    pitchB: { kind: "pitchbend", channel: 1, number: 0 },
  },
  "generic-cc": {
    jogScratchA: { kind: "cc", channel: -1, number: 1 },
    jogScratchB: { kind: "cc", channel: -1, number: 2 },
    jogNudgeA: { kind: "cc", channel: -1, number: 3 },
    jogNudgeB: { kind: "cc", channel: -1, number: 4 },
    seekA: { kind: "cc", channel: -1, number: 5 },
    seekB: { kind: "cc", channel: -1, number: 6 },
    eqHighA: { kind: "cc", channel: -1, number: 14 },
    eqMidA: { kind: "cc", channel: -1, number: 15 },
    eqLowA: { kind: "cc", channel: -1, number: 16 },
    filterA: { kind: "cc", channel: -1, number: 17 },
    eqHighB: { kind: "cc", channel: -1, number: 18 },
    eqMidB: { kind: "cc", channel: -1, number: 19 },
    eqLowB: { kind: "cc", channel: -1, number: 20 },
    filterB: { kind: "cc", channel: -1, number: 21 },
    crossfader: { kind: "cc", channel: -1, number: 7 },
    volA: { kind: "cc", channel: -1, number: 8 },
    volB: { kind: "cc", channel: -1, number: 9 },
    pitchA: { kind: "cc", channel: -1, number: 10 },
    pitchB: { kind: "cc", channel: -1, number: 11 },
  },
};

export interface MidiActionCallbacks {
  onCrossfader: (pos: number) => void;
  onChannelVolume: (deck: 0 | 1, val01: number) => void;
  onEq: (deck: 0 | 1, band: "low" | "mid" | "high", db: number) => void;
  onEqKill: (deck: 0 | 1, band: "low" | "mid" | "high") => void;
  onColorFilter: (deck: 0 | 1, val: number) => void;
  onPitchPct: (deck: 0 | 1, pct: number) => void;
  onSeekNormalized: (deck: 0 | 1, ratio01: number) => void;
  onJogNudge: (deck: 0 | 1, deltaSec: number, deltaDeg: number) => void;
  onBeatJump: (deck: 0 | 1, deltaBeats: number) => void;
  onPlatterTouch: (deck: 0 | 1, touched: boolean) => void;
  onJogScratchVelocity: (deck: 0 | 1, velocity: number, deltaDeg: number) => void;
  onPlayToggle: (deck: 0 | 1) => void;
  onSyncDeck: (deck: 0 | 1) => void;
  onPflToggle?: (deck: 0 | 1) => void;
  onLoopAction?: (deck: 0 | 1, action: "toggle" | "halve" | "double") => void;
  onClubFx?: (fx: "dub-siren" | "sub-drop" | "laser-riser" | "vinyl-brake") => void;
  onHotCue: (deck: 0 | 1, cue: keyof CuePoints) => void;
  onScratchPad: (patternId: ScratchPatternId) => void;
  onDrop90sAgent: () => void;
  onSmartMix: () => void;
  onStateChange?: () => void;
  onLearned?: (binding: MidiBinding) => void;
  onMidiActivity?: (summary: string) => void;
}

const STORAGE_KEY = "party_dj_midi_bindings_v1";
const PROFILE_STORAGE_KEY = "party_dj_midi_profile_v1";

const SOFT_TAKEOVER_CONTROLS = new Set<MidiControlId>([
  "crossfader",
  "volA",
  "volB",
  "eqHighA",
  "eqMidA",
  "eqLowA",
  "filterA",
  "eqHighB",
  "eqMidB",
  "eqLowB",
  "filterB",
  "pitchA",
  "pitchB",
]);

export class MidiControllerEngine {
  bindings: MidiBinding[];
  activeProfile: MidiControllerProfileId = "pioneer-ddj";
  learningControlId: MidiControlId | null = null;
  connectedInputs: string[] = [];
  connectedOutputs: string[] = [];
  supported = typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";
  accessGranted = false;
  lastActivity = "NO MIDI INPUT YET";

  /** When true, physical pots must pass through the current software value before taking control (prevents jumps). */
  softTakeoverEnabled = false;
  /** Multiplier for Jog Wheel vinyl scratch & playhead nudge sensitivity (0.5 = Fine, 1.0 = Club, 1.8 = Battle). */
  jogSensitivity = 1.0;
  /** Primary jog wheel mode when platterTouch Note-On is not held ("vinyl" scratch vs "nudge" playhead bend). */
  jogWheelMode: MidiJogMode = "vinyl";
  /** When true, transmits 24 PPQN MIDI Timing Clock (0xF8) + Start (0xFA) / Stop (0xFC) to connected MIDI outputs. */
  midiClockOutEnabled = false;

  private midiAccess: MIDIAccess | null = null;
  private prevJogCcVal: [number | null, number | null] = [null, null];
  private prevNudgeCcVal: [number | null, number | null] = [null, null];
  private prevJogTimeMs: [number, number] = [0, 0];
  private platterTouched: [boolean, boolean] = [false, false];
  private jogReleaseTimers: [ReturnType<typeof setTimeout> | null, ReturnType<typeof setTimeout> | null] = [null, null];

  // 14-bit CC MSB (CC 0..31) state cache per MIDI channel (0..15)
  private ccMsbValue: number[][] = Array.from({ length: 16 }, () => new Array(32).fill(-1));
  private ccMsbTimeMs: number[][] = Array.from({ length: 16 }, () => new Array(32).fill(0));

  // Soft-takeover (Pickup mode) state per continuous control
  private softwareTargets01 = new Map<MidiControlId, number>();
  private lastHardware01 = new Map<MidiControlId, number>();
  private pickedUpControls = new Set<MidiControlId>();

  // 24 PPQN MIDI Timing Clock output state
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private clockBpm = 124;
  private clockRunning = false;

  constructor(private callbacks: MidiActionCallbacks) {
    this.activeProfile = this.loadProfile();
    this.bindings = this.loadBindings();
  }

  private loadProfile(): MidiControllerProfileId {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(PROFILE_STORAGE_KEY) : null;
      if (raw === "pioneer-ddj" || raw === "numark-hercules" || raw === "generic-cc") {
        return raw;
      }
    } catch {
      // ignore
    }
    return "pioneer-ddj";
  }

  private loadBindings(): MidiBinding[] {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
      if (!raw) return DEFAULT_MIDI_BINDINGS.map(b => ({ ...b }));
      const parsed = JSON.parse(raw) as Array<Partial<MidiBinding>>;
      if (!Array.isArray(parsed)) return DEFAULT_MIDI_BINDINGS.map(b => ({ ...b }));
      return DEFAULT_MIDI_BINDINGS.map(def => {
        const found = parsed.find(p => p.controlId === def.controlId);
        if (!found) return { ...def };
        return {
          ...def,
          kind: found.kind ?? def.kind,
          channel: typeof found.channel === "number" ? found.channel : def.channel,
          number: typeof found.number === "number" ? found.number : def.number,
        };
      });
    } catch {
      return DEFAULT_MIDI_BINDINGS.map(b => ({ ...b }));
    }
  }

  saveBindings() {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
        localStorage.setItem(PROFILE_STORAGE_KEY, this.activeProfile);
      }
    } catch {
      // ignore storage errors
    }
  }

  /** Exports current controller profile & MIDI bindings as a formatted JSON string. */
  exportBindingsJson(): string {
    return JSON.stringify(
      {
        version: 1,
        profile: this.activeProfile,
        jogSensitivity: this.jogSensitivity,
        jogWheelMode: this.jogWheelMode,
        softTakeoverEnabled: this.softTakeoverEnabled,
        bindings: this.bindings.map(b => ({
          controlId: b.controlId,
          kind: b.kind,
          channel: b.channel,
          number: b.number,
        })),
      },
      null,
      2
    );
  }

  /** Imports and validates a JSON MIDI controller mapping string. */
  importBindingsJson(jsonText: string): { ok: boolean; count: number; message: string } {
    try {
      const data = JSON.parse(jsonText);
      const list: Array<Partial<MidiBinding>> = Array.isArray(data)
        ? data
        : Array.isArray(data?.bindings)
          ? data.bindings
          : [];
      if (list.length === 0) {
        return { ok: false, count: 0, message: "Invalid MIDI map JSON: no bindings array found" };
      }
      let updated = 0;
      this.bindings = DEFAULT_MIDI_BINDINGS.map(def => {
        const found = list.find(p => p.controlId === def.controlId);
        if (!found) return { ...def };
        const kind =
          found.kind === "cc" || found.kind === "note" || found.kind === "pitchbend"
            ? found.kind
            : def.kind;
        const channel =
          typeof found.channel === "number" && found.channel >= -1 && found.channel <= 15
            ? Math.trunc(found.channel)
            : def.channel;
        const number =
          typeof found.number === "number" && found.number >= 0 && found.number <= 127
            ? Math.trunc(found.number)
            : def.number;
        updated++;
        return { ...def, kind, channel, number };
      });
      if (
        data?.profile === "pioneer-ddj" ||
        data?.profile === "numark-hercules" ||
        data?.profile === "generic-cc"
      ) {
        this.activeProfile = data.profile;
      }
      if (typeof data?.jogSensitivity === "number") {
        this.jogSensitivity = Math.max(0.25, Math.min(3.0, data.jogSensitivity));
      }
      if (data?.jogWheelMode === "vinyl" || data?.jogWheelMode === "nudge") {
        this.jogWheelMode = data.jogWheelMode;
      }
      if (typeof data?.softTakeoverEnabled === "boolean") {
        this.softTakeoverEnabled = data.softTakeoverEnabled;
      }
      this.saveBindings();
      this.callbacks.onStateChange?.();
      return { ok: true, count: updated, message: `Imported ${updated} MIDI control bindings` };
    } catch (err) {
      return {
        ok: false,
        count: 0,
        message: `Failed to parse MIDI JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Updates the software's current normalized position (0..1) for a control so Soft Takeover
   * (Pickup Mode) knows the target position when the software changes a parameter (e.g. via SYNC or Auto-DJ).
   */
  setSoftwareTargetNormalized(controlId: MidiControlId, target01: number) {
    const clamped = Math.max(0, Math.min(1, target01));
    const prevTarget = this.softwareTargets01.get(controlId);
    this.softwareTargets01.set(controlId, clamped);
    if (prevTarget === undefined || Math.abs(prevTarget - clamped) > 0.03) {
      // Disarm pickup lock when software moves the parameter away from physical pot
      this.pickedUpControls.delete(controlId);
    }
  }

  setSoftTakeover(enabled: boolean) {
    this.softTakeoverEnabled = enabled;
    if (!enabled) {
      this.pickedUpControls.clear();
    }
    this.callbacks.onStateChange?.();
  }

  setJogSensitivity(mult: number) {
    this.jogSensitivity = Math.max(0.25, Math.min(3.0, mult));
    this.callbacks.onStateChange?.();
  }

  setJogWheelMode(mode: MidiJogMode) {
    this.jogWheelMode = mode;
    this.callbacks.onStateChange?.();
  }

  applyControllerProfile(profileId: MidiControllerProfileId) {
    this.activeProfile = profileId;
    const overrides = PROFILE_OVERRIDES[profileId] ?? {};
    this.bindings = DEFAULT_MIDI_BINDINGS.map(def => {
      const ov = overrides[def.controlId];
      return ov ? { ...def, ...ov } : { ...def };
    });
    this.learningControlId = null;
    this.pickedUpControls.clear();
    this.saveBindings();
    this.callbacks.onStateChange?.();
  }

  resetDefaultBindings() {
    this.applyControllerProfile("pioneer-ddj");
  }

  armLearn(controlId: MidiControlId | null) {
    this.learningControlId = this.learningControlId === controlId ? null : controlId;
    this.callbacks.onStateChange?.();
  }

  /** Requests Web MIDI API access and attaches listeners to all connected hardware DJ controllers. */
  async connect(): Promise<{ ok: boolean; inputs: string[]; message: string }> {
    if (!this.supported) {
      return {
        ok: false,
        inputs: [],
        message: "Web MIDI API is not supported in this browser (use Chrome, Edge, or Opera)",
      };
    }
    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      this.accessGranted = true;
      this.bindPorts();
      this.midiAccess.onstatechange = () => {
        this.bindPorts();
        this.callbacks.onStateChange?.();
      };
      this.callbacks.onStateChange?.();
      const count = this.connectedInputs.length;
      return {
        ok: true,
        inputs: this.connectedInputs,
        message:
          count > 0
            ? `Connected ${count} MIDI controller(s): ${this.connectedInputs.join(", ")}`
            : "Web MIDI armed (0 hardware controllers currently plugged in — plug in any USB MIDI deck)",
      };
    } catch (err) {
      return {
        ok: false,
        inputs: [],
        message: `Web MIDI access declined or blocked: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private bindPorts() {
    if (!this.midiAccess) return;
    const inNames: string[] = [];
    this.midiAccess.inputs.forEach(input => {
      inNames.push(input.name || input.manufacturer || `MIDI Input ${input.id}`);
      input.onmidimessage = (ev: MIDIMessageEvent) => {
        if (ev.data) {
          this.handleRawMidiBytes(ev.data, performance.now());
        }
      };
    });
    this.connectedInputs = inNames;

    const outNames: string[] = [];
    this.midiAccess.outputs.forEach(output => {
      outNames.push(output.name || output.manufacturer || `MIDI Output ${output.id}`);
    });
    this.connectedOutputs = outNames;
  }

  /** Sends raw MIDI bytes to all connected Web MIDI output ports. */
  private sendRawToOutputs(bytes: number[]) {
    if (!this.midiAccess) return;
    this.midiAccess.outputs.forEach(output => {
      try {
        output.send(bytes);
      } catch {
        // ignore output send error
      }
    });
  }

  /** Sends bidirectional LED feedback (Note On 127 / Off 0) to connected hardware DJ controller outputs. */
  sendControlLed(controlId: MidiControlId, active: boolean) {
    const binding = this.bindings.find(b => b.controlId === controlId);
    if (!binding || binding.kind !== "note") return;
    const ch = binding.channel < 0 ? 0 : binding.channel & 0x0f;
    const status = 0x90 | ch;
    const velocity = active ? 127 : 0;
    this.sendRawToOutputs([status, binding.number & 0x7f, velocity]);
  }

  /** Controls 24 PPQN Real-Time MIDI Clock (0xF8) + Start (0xFA) / Stop (0xFC) output synced to master BPM. */
  syncMidiClockOutput(playing: boolean, bpm: number) {
    const clampedBpm = Math.max(60, Math.min(200, bpm || 124));
    if (!this.midiClockOutEnabled || !playing) {
      if (this.clockRunning) {
        this.clockRunning = false;
        if (this.clockTimer) {
          clearInterval(this.clockTimer);
          this.clockTimer = null;
        }
        this.sendRawToOutputs([0xfc]); // MIDI Real-Time STOP
      }
      return;
    }

    const bpmChanged = Math.abs(this.clockBpm - clampedBpm) > 0.15;
    if (!this.clockRunning) {
      this.clockRunning = true;
      this.clockBpm = clampedBpm;
      this.sendRawToOutputs([0xfa]); // MIDI Real-Time START
      this.restartClockInterval();
    } else if (bpmChanged) {
      this.clockBpm = clampedBpm;
      this.restartClockInterval();
    }
  }

  private restartClockInterval() {
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    const intervalMs = 60000 / (this.clockBpm * 24); // 24 PPQN
    this.clockTimer = setInterval(() => {
      if (this.midiClockOutEnabled && this.clockRunning) {
        this.sendRawToOutputs([0xf8]); // MIDI Timing Clock tick
      }
    }, intervalMs);
  }

  /** Evaluates Soft Takeover (Pickup Mode) for a continuous control. Returns true if allowed to pass through. */
  private checkSoftTakeover(id: MidiControlId, hw01: number): boolean {
    if (!this.softTakeoverEnabled || !SOFT_TAKEOVER_CONTROLS.has(id)) {
      this.lastHardware01.set(id, hw01);
      this.softwareTargets01.set(id, hw01);
      return true;
    }

    const target01 = this.softwareTargets01.get(id);
    if (target01 === undefined || this.pickedUpControls.has(id)) {
      this.pickedUpControls.add(id);
      this.lastHardware01.set(id, hw01);
      this.softwareTargets01.set(id, hw01);
      return true;
    }

    const prevHw01 = this.lastHardware01.get(id);
    this.lastHardware01.set(id, hw01);

    const dist = Math.abs(hw01 - target01);
    const crossed =
      prevHw01 !== undefined &&
      ((prevHw01 <= target01 && hw01 >= target01) || (prevHw01 >= target01 && hw01 <= target01));

    if (dist <= 0.045 || crossed) {
      this.pickedUpControls.add(id);
      this.softwareTargets01.set(id, hw01);
      return true;
    }

    const dirArrow = hw01 < target01 ? "TURN UP ↑" : "TURN DOWN ↓";
    this.lastActivity = `PICKUP WAIT: ${id} (${dirArrow} TO ${Math.round(target01 * 100)}%)`;
    this.callbacks.onMidiActivity?.(this.lastActivity);
    return false;
  }

  /** Processes a raw MIDI packet (from hardware `MIDIMessageEvent` or deterministic test/simulator). */
  handleRawMidiBytes(data: ArrayLike<number>, nowMs = performance.now()) {
    const msg = parseMidiMessage(data);
    if (msg.kind === "other") return;

    // 1. If MIDI Learn is armed for a control, bind this incoming message to that control
    if (
      this.learningControlId &&
      (msg.kind === "cc" || msg.kind === "noteon" || msg.kind === "pitchbend")
    ) {
      const target = this.bindings.find(b => b.controlId === this.learningControlId);
      if (target) {
        target.kind = msg.kind === "cc" ? "cc" : msg.kind === "pitchbend" ? "pitchbend" : "note";
        target.channel = msg.channel;
        target.number = msg.kind === "pitchbend" ? 0 : msg.number;
        this.learningControlId = null;
        this.pickedUpControls.add(target.controlId);
        this.saveBindings();
        const kindStr =
          target.kind === "pitchbend" ? "PITCHBEND" : `${target.kind.toUpperCase()}#${target.number}`;
        this.lastActivity = `LEARNED CH${msg.channel + 1} ${kindStr} -> ${target.label}`;
        this.callbacks.onMidiActivity?.(this.lastActivity);
        this.callbacks.onLearned?.(target);
        this.callbacks.onStateChange?.();
        return;
      }
    }

    // 2. Check for 14-Bit High-Resolution MIDI CC Pair (MSB CC 0..31 + LSB CC 32..63)
    if (msg.kind === "cc") {
      if (msg.number >= 0 && msg.number < 32) {
        this.ccMsbValue[msg.channel][msg.number] = msg.value;
        this.ccMsbTimeMs[msg.channel][msg.number] = nowMs;
      } else if (msg.number >= 32 && msg.number < 64) {
        const directLsbBinding =
          this.bindings.find(
            b => b.kind === "cc" && b.number === msg.number && (b.channel === msg.channel || b.channel === -1)
          );
        const msbNum = msg.number - 32;
        const msbVal = this.ccMsbValue[msg.channel][msbNum];
        const msbAt = this.ccMsbTimeMs[msg.channel][msbNum];
        const msbBinding =
          this.bindings.find(
            b => b.kind === "cc" && b.number === msbNum && b.channel === msg.channel
          ) ??
          this.bindings.find(
            b => b.kind === "cc" && b.number === msbNum && b.channel === -1
          );

        if (!directLsbBinding && msbBinding && msbVal >= 0 && nowMs - msbAt <= 120) {
          const { val14, norm01, bipolar } = decode14BitCcPair(msbVal, msg.value);
          this.lastActivity = `CH${msg.channel + 1} 14-BIT CC#${msbNum}/${msg.number}=${val14} -> ${msbBinding.controlId}`;
          this.callbacks.onMidiActivity?.(this.lastActivity);
          this.dispatchHighResNormalized(msbBinding.controlId, norm01, bipolar);
          return;
        }
      }
    }

    // 3. Match incoming message against active bindings (exact channel match first, then wildcard channel -1)
    const matchKind = msg.kind === "noteon" || msg.kind === "noteoff" ? "note" : msg.kind;
    const binding =
      this.bindings.find(
        b =>
          b.kind === matchKind &&
          (matchKind === "pitchbend" || b.number === msg.number) &&
          b.channel === msg.channel
      ) ??
      this.bindings.find(
        b =>
          b.kind === matchKind &&
          (matchKind === "pitchbend" || b.number === msg.number) &&
          b.channel === -1
      );

    const chTag = `CH${msg.channel + 1}`;
    const typeTag =
      msg.kind === "cc"
        ? `CC#${msg.number}`
        : msg.kind === "pitchbend"
          ? "PB"
          : `NOTE#${msg.number}`;
    this.lastActivity = `${chTag} ${typeTag}=${msg.value}${binding ? ` -> ${binding.controlId}` : ""}`;
    this.callbacks.onMidiActivity?.(this.lastActivity);

    if (!binding) return;

    if (msg.kind === "cc") {
      this.dispatchCc(binding.controlId, msg.value, nowMs);
    } else if (msg.kind === "pitchbend") {
      this.dispatchPitchBend(binding.controlId, msg.value);
    } else if (msg.kind === "noteon") {
      this.dispatchNote(binding.controlId, true);
    } else if (msg.kind === "noteoff") {
      this.dispatchNote(binding.controlId, false);
    }
  }

  private dispatchHighResNormalized(id: MidiControlId, norm01: number, bipolar: number) {
    if (!this.checkSoftTakeover(id, norm01)) return;

    switch (id) {
      case "crossfader":
        this.callbacks.onCrossfader(bipolar);
        break;
      case "volA":
        this.callbacks.onChannelVolume(0, norm01);
        break;
      case "volB":
        this.callbacks.onChannelVolume(1, norm01);
        break;
      case "eqHighA":
        this.callbacks.onEq(0, "high", normalizedToEqDb(norm01));
        break;
      case "eqMidA":
        this.callbacks.onEq(0, "mid", normalizedToEqDb(norm01));
        break;
      case "eqLowA":
        this.callbacks.onEq(0, "low", normalizedToEqDb(norm01));
        break;
      case "filterA":
        this.callbacks.onColorFilter(0, bipolar);
        break;
      case "eqHighB":
        this.callbacks.onEq(1, "high", normalizedToEqDb(norm01));
        break;
      case "eqMidB":
        this.callbacks.onEq(1, "mid", normalizedToEqDb(norm01));
        break;
      case "eqLowB":
        this.callbacks.onEq(1, "low", normalizedToEqDb(norm01));
        break;
      case "filterB":
        this.callbacks.onColorFilter(1, bipolar);
        break;
      case "pitchA":
        this.callbacks.onPitchPct(0, +(bipolar * 8).toFixed(3));
        break;
      case "pitchB":
        this.callbacks.onPitchPct(1, +(bipolar * 8).toFixed(3));
        break;
      case "seekA":
        this.callbacks.onSeekNormalized(0, norm01);
        break;
      case "seekB":
        this.callbacks.onSeekNormalized(1, norm01);
        break;
    }
  }

  private dispatchPitchBend(id: MidiControlId, bend14: number) {
    const bipolar = Math.max(-1, Math.min(1, bend14 / 8192));
    const norm01 = (bipolar + 1) * 0.5;
    this.dispatchHighResNormalized(id, norm01, bipolar);
  }

  private dispatchCc(id: MidiControlId, val: number, nowMs: number) {
    if (id === "jogScratchA") {
      this.handleJogWheel(0, val, nowMs);
      return;
    }
    if (id === "jogScratchB") {
      this.handleJogWheel(1, val, nowMs);
      return;
    }
    if (id === "jogNudgeA") {
      this.handleJogNudge(0, val);
      return;
    }
    if (id === "jogNudgeB") {
      this.handleJogNudge(1, val);
      return;
    }

    const norm01 =
      id === "volA" || id === "volB" || id === "seekA" || id === "seekB"
        ? Math.max(0, Math.min(1, val / 127))
        : midiCcToNormalized01(val);

    if (!this.checkSoftTakeover(id, norm01)) return;

    switch (id) {
      case "crossfader":
        this.callbacks.onCrossfader(midiCcToBipolar(val));
        break;
      case "volA":
        this.callbacks.onChannelVolume(0, val / 127);
        break;
      case "volB":
        this.callbacks.onChannelVolume(1, val / 127);
        break;
      case "eqHighA":
        this.callbacks.onEq(0, "high", midiCcToEqDb(val));
        break;
      case "eqMidA":
        this.callbacks.onEq(0, "mid", midiCcToEqDb(val));
        break;
      case "eqLowA":
        this.callbacks.onEq(0, "low", midiCcToEqDb(val));
        break;
      case "filterA":
        this.callbacks.onColorFilter(0, midiCcToBipolar(val));
        break;
      case "eqHighB":
        this.callbacks.onEq(1, "high", midiCcToEqDb(val));
        break;
      case "eqMidB":
        this.callbacks.onEq(1, "mid", midiCcToEqDb(val));
        break;
      case "eqLowB":
        this.callbacks.onEq(1, "low", midiCcToEqDb(val));
        break;
      case "filterB":
        this.callbacks.onColorFilter(1, midiCcToBipolar(val));
        break;
      case "pitchA":
        this.callbacks.onPitchPct(0, +(midiCcToBipolar(val) * 8).toFixed(2));
        break;
      case "pitchB":
        this.callbacks.onPitchPct(1, +(midiCcToBipolar(val) * 8).toFixed(2));
        break;
      case "seekA":
        this.callbacks.onSeekNormalized(0, val / 127);
        break;
      case "seekB":
        this.callbacks.onSeekNormalized(1, val / 127);
        break;
    }
  }

  private handleJogNudge(deck: 0 | 1, val: number) {
    const prevVal = this.prevNudgeCcVal[deck];
    this.prevNudgeCcVal[deck] = val;
    const deltaTicks = decodeRelativeJogDelta(val, prevVal);
    if (deltaTicks === 0) return;
    const deltaSec = deltaTicks * 0.04 * this.jogSensitivity; // 40ms * sensitivity fine playhead nudge per tick
    const deltaDeg = deltaTicks * 2.8 * this.jogSensitivity;
    this.callbacks.onJogNudge(deck, deltaSec, deltaDeg);
  }

  private handleJogWheel(deck: 0 | 1, val: number, nowMs: number) {
    // If Jog Mode is set to "nudge" and the DJ is not holding a capacitive platter touch Note-On, route to playhead nudge
    if (this.jogWheelMode === "nudge" && !this.platterTouched[deck]) {
      this.handleJogNudge(deck, val);
      return;
    }

    const prevVal = this.prevJogCcVal[deck];
    const dtSec = Math.max(0.004, Math.min(0.08, (nowMs - (this.prevJogTimeMs[deck] || nowMs - 16)) / 1000));
    this.prevJogCcVal[deck] = val;
    this.prevJogTimeMs[deck] = nowMs;

    const deltaTicks = decodeRelativeJogDelta(val, prevVal);
    if (deltaTicks === 0) return;

    // Engage vinyl platter scratch automatically if not already touched
    if (!this.platterTouched[deck]) {
      this.platterTouched[deck] = true;
      this.callbacks.onPlatterTouch(deck, true);
    }

    // Reset auto-release watchdog if controller doesn't send explicit Platter Touch Note-Off
    if (this.jogReleaseTimers[deck]) {
      clearTimeout(this.jogReleaseTimers[deck]!);
    }
    this.jogReleaseTimers[deck] = setTimeout(() => {
      if (this.platterTouched[deck]) {
        this.platterTouched[deck] = false;
        this.prevJogCcVal[deck] = null;
        this.callbacks.onPlatterTouch(deck, false);
      }
    }, 120);

    const velocity = Math.max(
      -3.6,
      Math.min(3.6, (deltaTicks / dtSec) * 0.022 * this.jogSensitivity)
    );
    const deltaDeg = deltaTicks * 3.2 * this.jogSensitivity;
    this.callbacks.onJogScratchVelocity(deck, velocity, deltaDeg);
  }

  private dispatchNote(id: MidiControlId, noteOn: boolean) {
    if (id === "platterTouchA" || id === "platterTouchB") {
      const deck: 0 | 1 = id === "platterTouchA" ? 0 : 1;
      if (this.jogReleaseTimers[deck]) {
        clearTimeout(this.jogReleaseTimers[deck]!);
        this.jogReleaseTimers[deck] = null;
      }
      this.platterTouched[deck] = noteOn;
      if (!noteOn) this.prevJogCcVal[deck] = null;
      this.callbacks.onPlatterTouch(deck, noteOn);
      return;
    }

    if (!noteOn) return; // Trigger actions on Note-On edge

    switch (id) {
      case "playA":
        this.callbacks.onPlayToggle(0);
        break;
      case "playB":
        this.callbacks.onPlayToggle(1);
        break;
      case "syncA":
        this.callbacks.onSyncDeck(0);
        break;
      case "syncB":
        this.callbacks.onSyncDeck(1);
        break;
      case "pflA":
        this.callbacks.onPflToggle?.(0);
        break;
      case "pflB":
        this.callbacks.onPflToggle?.(1);
        break;
      case "loopToggleA":
        this.callbacks.onLoopAction?.(0, "toggle");
        break;
      case "loopHalveA":
        this.callbacks.onLoopAction?.(0, "halve");
        break;
      case "loopDoubleA":
        this.callbacks.onLoopAction?.(0, "double");
        break;
      case "loopToggleB":
        this.callbacks.onLoopAction?.(1, "toggle");
        break;
      case "loopHalveB":
        this.callbacks.onLoopAction?.(1, "halve");
        break;
      case "loopDoubleB":
        this.callbacks.onLoopAction?.(1, "double");
        break;
      case "beatJumpBackA":
        this.callbacks.onBeatJump(0, -4);
        break;
      case "beatJumpFwdA":
        this.callbacks.onBeatJump(0, 4);
        break;
      case "beatJumpBackB":
        this.callbacks.onBeatJump(1, -4);
        break;
      case "beatJumpFwdB":
        this.callbacks.onBeatJump(1, 4);
        break;
      case "killHighA":
        this.callbacks.onEqKill(0, "high");
        break;
      case "killMidA":
        this.callbacks.onEqKill(0, "mid");
        break;
      case "killLowA":
        this.callbacks.onEqKill(0, "low");
        break;
      case "killHighB":
        this.callbacks.onEqKill(1, "high");
        break;
      case "killMidB":
        this.callbacks.onEqKill(1, "mid");
        break;
      case "killLowB":
        this.callbacks.onEqKill(1, "low");
        break;
      case "cueIntroA":
        this.callbacks.onHotCue(0, "intro");
        break;
      case "cueDropA":
        this.callbacks.onHotCue(0, "drop");
        break;
      case "cueBreakA":
        this.callbacks.onHotCue(0, "breakdown");
        break;
      case "cueOutroA":
        this.callbacks.onHotCue(0, "outro");
        break;
      case "cueIntroB":
        this.callbacks.onHotCue(1, "intro");
        break;
      case "cueDropB":
        this.callbacks.onHotCue(1, "drop");
        break;
      case "cueBreakB":
        this.callbacks.onHotCue(1, "breakdown");
        break;
      case "cueOutroB":
        this.callbacks.onHotCue(1, "outro");
        break;
      case "scratchPad1":
        this.callbacks.onScratchPad("baby");
        break;
      case "scratchPad2":
        this.callbacks.onScratchPad("flare");
        break;
      case "scratchPad3":
        this.callbacks.onScratchPad("transformer");
        break;
      case "scratchPad4":
        this.callbacks.onScratchPad("chirp");
        break;
      case "scratchPad5":
        this.callbacks.onScratchPad("crab");
        break;
      case "scratchPad6":
        this.callbacks.onScratchPad("tear");
        break;
      case "scratchPad7":
        this.callbacks.onScratchPad("backspin");
        break;
      case "scratchPad8":
        this.callbacks.onScratchPad("uzis");
        break;
      case "fxSiren":
        this.callbacks.onClubFx?.("dub-siren");
        break;
      case "fxDrop":
        this.callbacks.onClubFx?.("sub-drop");
        break;
      case "fxLaser":
        this.callbacks.onClubFx?.("laser-riser");
        break;
      case "fxBrake":
        this.callbacks.onClubFx?.("vinyl-brake");
        break;
      case "drop90sAgent":
        this.callbacks.onDrop90sAgent();
        break;
      case "smartMixNext":
        this.callbacks.onSmartMix();
        break;
    }
  }
}
