import type { PrimitiveName, Style } from "./schemas";

// Every tunable lives here. Tags follow PLAN §0: [decided] design choice,
// [tune] starting value to adjust by ear, [verify] check against your own measurements.
// None of the [tune] values are measured results.

export interface ScratchConfig {
  // --- renderer (PLAN §5) ---
  max_slew: number; // [tune] rate-units/s, plan range 80-200
  f0: number; // [tune] smoothing Hz, plan range 15-25
  zeta: number; // [tune] plan range 0.7-0.9
  ramp_ms: number; // [tune] gate ramp, plan range 1-3
  max_rate: number; // [tune] peak source-sec/sec the resampler is asked for
  sinc_half: number; // [verify by ear] taps per side; raise if aliasing at high |rate|
  sinc_beta: number; // [decided] Kaiser beta
  source_guard_s: number; // [tune] keep strokes this far inside the source edges
  ring_off_s: number; // [decided] silent tail after the last stroke

  // --- composer (PLAN §7) ---
  placement_mode: "answer" | "hook" | "sentence"; // [decided] sentence: ordered words, no dropping/shifting
  beats_per_bar: number; // [decided]
  subdiv: number; // [decided] 4 = 16ths; 3/6/12 for triplets
  density_cap: Record<Style, number>; // [tune] events per bar
  fill_intensity: number; // [tune] last-beat events need at least this intensity to count as a deliberate fill
  micro_offset_ms: Record<PrimitiveName, number>; // [tune] cuts slightly behind the grid
  jitter_ms: number; // [tune] seeded jitter, keep well below flam territory
  stroke_beats: number; // [tune] beats per stroke for baby / cut_forward
  transform_duty: number; // [tune]
  vocal_gap_min_s: number; // [tune]
  onset_margin_s: number; // [tune] keep attacks this far from a vocal onset (answer mode)
  attack_check_s: number; // [tune] only the first N seconds of an event must avoid onsets
  max_shift_beats: number; // [tune] how far answer mode may move a colliding item
  sentence_target_rate: number; // [tune] ideal average playback rate per word (1 = natural speed); lengths round UP to the grid, so real rates land at or below this
  sentence_gap_steps: number; // [tune] empty grid steps between words

  // --- critic (PLAN §8) ---
  silence_rms_floor: number; // [tune]
  grid_median_err_ms: number; // [tune]
  gate_click_max: number; // [tune] max |sample jump| at gate edges, source normalized to peak 1
  max_tries: number; // [decided]
  intensity_backoff: number; // [tune] gain multiplier applied after a clipping fail
  ramp_growth: number; // [tune] ramp multiplier applied after a gate-click fail

  // --- pipeline ---
  headroom_db: number; // [decided] export limiter target
  tail_s: number;
}

export const DEFAULT_CONFIG: ScratchConfig = {
  max_slew: 120,
  f0: 20,
  zeta: 0.8,
  ramp_ms: 2,
  max_rate: 4,
  sinc_half: 16,
  sinc_beta: 9,
  source_guard_s: 0.01,
  ring_off_s: 0.05,

  placement_mode: "answer",
  beats_per_bar: 4,
  subdiv: 4,
  density_cap: { sparse: 2, medium: 4, busy: 8 },
  fill_intensity: 0.8,
  micro_offset_ms: {
    baby: 0,
    stab: 8,
    cut_forward: 10,
    transform: 6,
    flare: 4,
    chirp: 5,
    tear: 2,
    crab: 4,
    rest: 0,
  },
  jitter_ms: 3,
  stroke_beats: 0.5,
  transform_duty: 0.5,
  vocal_gap_min_s: 0.08,
  onset_margin_s: 0.03,
  attack_check_s: 0.12,
  max_shift_beats: 1,
  sentence_target_rate: 1,
  sentence_gap_steps: 0,

  silence_rms_floor: 0.002,
  grid_median_err_ms: 20,
  gate_click_max: 0.1,
  max_tries: 6,
  intensity_backoff: 0.85,
  ramp_growth: 1.5,

  headroom_db: -1,
  tail_s: 0.3,
};

/** Seeded PRNG (mulberry32). Every stochastic step takes one of these. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
