export interface TrackAnalysis {
  bpm: number;
  firstBeat: number;      // seconds; beat grid = firstBeat + n * 60/bpm
  key?: string;           // Camelot, e.g. "8A" (TODO)
  energy?: number;        // 0..1 (TODO)
  cuePoints?: { intro?: number; drop?: number; outro?: number }; // seconds (TODO)
}

export interface TransitionPreset {
  id: string;
  name: string;
  bars: number;           // length in bars (phrase-aligned: 8/16/32)
  curve: "equal-power" | "linear" | "cut";
  filterSweep?: boolean;  // high-pass the outgoing deck during the blend
}
