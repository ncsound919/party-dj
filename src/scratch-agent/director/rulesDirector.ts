import type { ScratchConfig } from "../config";
import { mulberry32 } from "../config";
import type { DirectorItem, DirectorPlan, Grid, PrimitiveName, SliceBank, Style } from "../schemas";

export interface DirectorContext {
  bpm: number;
  bars: 2 | 4;
  style: Style;
  slices: { id: number; duration: number; energy: number; text?: string | null }[];
}

/** Compact JSON context handed to any director (PLAN §9): up to ~24 candidate slices. */
export function buildContext(bank: SliceBank, grid: Grid, bars: 2 | 4, style: Style, maxSlices = 24): DirectorContext {
  const slices = bank.slices
    .map((s) => ({ id: s.id, duration: +(s.end - s.start).toFixed(3), energy: +s.energy.toFixed(3), text: s.text ?? null }))
    .filter((s) => s.duration >= 0.08 && s.duration <= 0.4)
    .sort((a, b) => b.energy - a.energy || a.id - b.id)
    .slice(0, maxSlices);
  return { bpm: grid.bpm, bars, style, slices };
}

// One-bar beat patterns per style (beats from bar start). [tune]
// Counts match the density caps: sparse 2, medium 4, busy 8.
const PATTERNS: Record<Style, number[][]> = {
  sparse: [[0.5, 2.5], [1, 3], [1.5, 2.5], [0, 2]],
  medium: [[0, 1, 2.5, 3], [0.5, 1.5, 2, 3], [0, 1.5, 2, 2.5], [1, 1.5, 2.5, 3]],
  busy: [[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], [0, 0.5, 1.5, 2, 2.5, 3, 3.25, 3.5]],
};

// Per-style primitive templates, cycled in order. [tune]
const TEMPLATES: Record<Style, PrimitiveName[]> = {
  sparse: ["stab", "baby", "stab", "cut_forward"],
  medium: ["stab", "baby", "cut_forward", "stab", "transform"],
  busy: ["baby", "stab", "cut_forward", "baby", "transform", "stab"],
};

const LENGTHS: Record<PrimitiveName, number> = { stab: 0.5, baby: 1, cut_forward: 1, transform: 1, rest: 0.5 };

/**
 * Deterministic baseline director: highest-energy slices in the 80-400 ms range, primitives from a
 * per-style table, beats from a seeded pattern list. This is what the LLM director has to beat.
 */
export function rulesDirector(ctx: DirectorContext, seed: number, cfg: ScratchConfig): DirectorPlan {
  const rng = mulberry32(seed);
  const pool = ctx.slices.filter((s) => s.duration >= 0.08 && s.duration <= 0.4);
  const items: DirectorItem[] = [];
  if (!pool.length) return { bars: ctx.bars, style: ctx.style, items };

  let si = Math.floor(rng() * Math.min(pool.length, 4));
  let ti = Math.floor(rng() * TEMPLATES[ctx.style].length);
  for (let bar = 0; bar < ctx.bars && items.length < 16; bar++) {
    const pats = PATTERNS[ctx.style];
    const pat = pats[Math.floor(rng() * pats.length)];
    for (const b of pat) {
      const beat = bar * cfg.beats_per_bar + b;
      if (beat >= ctx.bars * cfg.beats_per_bar - 1) continue; // keep the last beat clear
      if (items.length >= 16) break;
      const prim = TEMPLATES[ctx.style][ti++ % TEMPLATES[ctx.style].length];
      const slice = pool[si++ % pool.length]; // rotate so consecutive events differ
      items.push({
        slice_id: slice.id,
        primitive: prim,
        beat,
        length_beats: Math.min(LENGTHS[prim], 4),
        intensity: +(0.5 + 0.4 * rng()).toFixed(2),
      });
    }
  }
  return { bars: ctx.bars, style: ctx.style, items };
}
