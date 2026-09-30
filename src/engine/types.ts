export interface CuePoints {
  intro: number;
  drop: number;
  breakdown: number;
  outro: number;
}

export interface WaveformBands {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  peaks: Float32Array;
  energyCurve: Float32Array;
}

export interface TrackAnalysis {
  bpm: number;
  firstBeat: number;      // seconds; beat grid = firstBeat + n * 60/bpm
  key?: string;           // Camelot, e.g. "8A"
  keyName?: string;       // e.g. "A Minor"
  energy?: number;        // 0..1 normalized dancefloor energy
  rmsDb?: number;         // integrated active RMS in dBFS
  autoGainDb?: number;    // recommended club normalization trim in dB (-6 .. +6)
  cuePoints?: CuePoints;  // bar-aligned structural markers in seconds
  waveform?: WaveformBands;
}

export interface SetlistEntry {
  index: number;
  playedAtIso: string;
  elapsedSessionMin: number;
  title: string;
  artist: string;
  fileName: string;
  bpm: number;
  key: string;
  energy: number;
  transitionPreset: string;
  harmonicMatch: string;
}

export type CrossfaderCurve = "blend" | "dip" | "cut";

export interface MasterBusTelemetry {
  masterPeakDb: number;
  limiterReductionDb: number;
  autoGainEnabled: boolean;
  splitCueEnabled: boolean;
  micActive: boolean;
  recordingActive: boolean;
  recordingElapsedSec: number;
}

export interface TransitionPreset {
  id: string;
  name: string;
  bars: number;           // length in bars (phrase-aligned: 0/4/8/16/32)
  curve: "equal-power" | "linear" | "cut";
  filterSweep?: boolean;  // high-pass the outgoing deck during the blend
  bassSwap?: boolean;     // swap low-end EQ cleanly at the midpoint of the transition
}

export type ScratchPatternId =
  | "baby"
  | "flare"
  | "transformer"
  | "chirp"
  | "crab"
  | "tear"
  | "backspin"
  | "uzis";

export type ScratchSourceMode = "vinyl" | "slip" | "incoming" | "cut";
export type ScratchQuantizeMode = "1/16" | "1/8" | "instant";
export type ScratchCutMode = "mag-four" | "smooth";
export type BattleSampleId = "auto" | "fresh" | "ahhh" | "cut" | "scratch" | "drop";

export interface ScratchPattern {
  id: ScratchPatternId;
  name: string;
  subtitle: string;
  beats: number;
  clicksPerBeat: number;
  description: string;
}

export interface ScratchTelemetry {
  active: boolean;
  patternId: ScratchPatternId | "manual" | "agent" | null;
  patternName: string;
  deck: 0 | 1;
  progress: number;       // 0..1
  velocity: number;       // instantaneous platter speed (-3.5 .. +3.5)
  displacement: number;   // platter angle offset in rotations
  faderOpen: boolean;     // true when VCA scratch gate is open
  faderGain: number;      // 0..1
  anchorSec?: number;     // transient-locked source anchor in seconds
  headSec?: number;       // instantaneous scratched groove position in seconds
  cutSampleLabel?: string; // active battle cut or transient slice label
  trackModCount?: number; // number of scratches permanently spliced into active deck AudioBuffer
  curveSamples: Float32Array; // 128 samples of platter displacement for scope
  gateSamples: Float32Array;  // 128 samples of crossfader gate (0..1) for scope
}

export interface PartyTemplate {
  id: string;
  name: string;
  energyCurve: number[];
  transition: string;
}
