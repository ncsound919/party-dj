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
  cuePoints?: CuePoints;  // bar-aligned structural markers in seconds
  waveform?: WaveformBands;
}

export interface TransitionPreset {
  id: string;
  name: string;
  bars: number;           // length in bars (phrase-aligned: 0/4/8/16/32)
  curve: "equal-power" | "linear" | "cut";
  filterSweep?: boolean;  // high-pass the outgoing deck during the blend
  bassSwap?: boolean;     // swap low-end EQ cleanly at the midpoint of the transition
  backspinExit?: boolean; // trigger a vinyl backspin on the outgoing deck at the end
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

export type ScratchSourceMode = "slip" | "cut" | "incoming";

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
  curveSamples: Float32Array; // 128 samples of platter displacement for scope
  gateSamples: Float32Array;  // 128 samples of crossfader gate (0..1) for scope
}

export interface PartyTemplate {
  id: string;
  name: string;
  energyCurve: number[];
  transition: string;
}
