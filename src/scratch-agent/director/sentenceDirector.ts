import type { ScratchConfig } from "../config";
import type { DirectorFn } from "../pipeline";
import type { DirectorItem, DirectorPlan, PrimitiveName, Slice, SliceBank } from "../schemas";

/**
 * Sentence mode (Premier-style hooks): arrange word slices, cut from another record, into an
 * ordered phrase. Deterministic; no model involved. Use with cfg.placement_mode = "sentence".
 */
export interface SentenceSpec {
  /** Text to look up in slice `text` (case/punctuation ignored), or explicit slice ids. In reading order. */
  words: (string | number)[];
  /** Restrict text lookups to one source (e.g. the cut source). */
  srcId?: string;
  /** Beat (from phrase start) where the first word lands. Default 0. */
  startBeat?: number;
  /** One forward stroke per word by default. */
  primitive?: Extract<PrimitiveName, "baby" | "stab">;
  intensity?: number;
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9']/g, "");

function pick(word: string | number, bank: SliceBank, srcId?: string): Slice {
  if (typeof word === "number") {
    const s = bank.slices.find((x) => x.id === word);
    if (!s) throw new Error(`sentence: no slice with id ${word}`);
    return s;
  }
  const want = norm(word);
  const hits = bank.slices.filter((s) => s.text && norm(s.text) === want && (srcId === undefined || s.src_id === srcId));
  if (!hits.length) throw new Error(`sentence: word "${word}" not found in bank${srcId ? ` (source "${srcId}")` : ""}`);
  // several takes of the same word: loudest wins, lowest id breaks ties
  return hits.reduce((a, b) => (b.energy > a.energy || (b.energy === a.energy && b.id < a.id) ? b : a));
}

/**
 * Words are laid end to end on the grid. Each word's length in beats is its duration at
 * `sentence_target_rate`, rounded UP to the next grid step (slower is safer for legibility than faster).
 * Throws if the phrase does not fit the plan (silently dropping a word would change the sentence).
 */
export function sentencePlan(
  spec: SentenceSpec,
  bank: SliceBank,
  bpm: number,
  bars: 2 | 4,
  cfg: ScratchConfig,
): DirectorPlan {
  const beatSec = 60 / bpm;
  const totalBeats = bars * cfg.beats_per_bar;
  const step = 1 / cfg.subdiv;
  const gap = cfg.sentence_gap_steps * step;
  const primitive = spec.primitive ?? "baby";
  const items: DirectorItem[] = [];
  let cursor = spec.startBeat ?? 0;

  for (const w of spec.words) {
    const s = pick(w, bank, spec.srcId);
    const rawBeats = (s.end - s.start) / (beatSec * cfg.sentence_target_rate);
    const len = Math.min(4, Math.max(step, Math.ceil(rawBeats * cfg.subdiv - 1e-9) * step));
    if (cursor + len > totalBeats + 1e-9)
      throw new Error(`sentence: "${typeof w === "string" ? w : s.text ?? w}" ends at beat ${(cursor + len).toFixed(2)} but the plan has ${totalBeats} beats`);
    items.push({ slice_id: s.id, primitive, beat: cursor, length_beats: len, intensity: spec.intensity ?? 0.8 });
    cursor += len + gap;
  }
  if (items.length > 16) throw new Error(`sentence: ${items.length} words exceeds the 16-item plan limit`);
  return { bars, style: "sparse", items };
}

/** Wrap a spec as a DirectorFn for runScratchAgent. Throws (never falls back to rulesDirector). */
export function sentenceDirectorFn(spec: SentenceSpec, bank: SliceBank): DirectorFn {
  return async (ctx, _seed, cfg) => sentencePlan(spec, bank, ctx.bpm, ctx.bars, cfg);
}
