import type { ScratchConfig } from "../config";
import { mulberry32 } from "../config";
import type { DirectorPlan, Grid, ScratchEvent, Slice, SliceBank } from "../schemas";
import { beatToTime, fitsGap, quantizeBeat } from "./placement";

export interface ComposeOpts {
  seed: number;
  /** Fractional index into grid.beats where the phrase starts (e.g. index of a downbeat). */
  phraseStartBeat: number;
  /** Total source length in seconds, used to keep strokes inside the source. */
  srcDuration: number;
  /** Multiplies event gain; the reroll loop lowers it after a clipping fail. */
  intensityScale?: number;
}

/** Peak rate of a half-sine stroke is pi*span/(2T); clamp span so it stays under max_rate. */
export function maxSpan(T: number, maxRate: number): number {
  return (2 * T * maxRate) / Math.PI;
}

/** Where in the source an event starts reading (kept off the very first samples). */
export function sourceStart(slice: Slice, cfg: Pick<ScratchConfig, "source_guard_s">): number {
  return Math.max(slice.start, cfg.source_guard_s);
}

interface Cand {
  slice: Slice;
  prim: Exclude<ScratchEvent["primitive"], "rest">;
  q: number; // quantized beats from phrase start
  len: number;
  intensity: number;
}

export function compose(plan: DirectorPlan, bank: SliceBank, grid: Grid, cfg: ScratchConfig, o: ComposeOpts): ScratchEvent[] {
  const rng = mulberry32(o.seed);
  const byId = new Map(bank.slices.map((s) => [s.id, s]));
  const beatSec = 60 / grid.bpm;
  const phraseBeats = plan.bars * cfg.beats_per_bar;
  const step = 1 / cfg.subdiv;
  const scale = o.intensityScale ?? 1;
  const timeAt = (q: number) => beatToTime(grid.beats, o.phraseStartBeat + q);

  // 1. quantize
  let cands: Cand[] = [];
  for (const it of plan.items) {
    if (it.primitive === "rest") continue;
    const slice = byId.get(it.slice_id);
    if (!slice) throw new Error(`director used unknown slice id ${it.slice_id}`);
    const q = quantizeBeat(it.beat, cfg.subdiv, grid.swing);
    if (q >= phraseBeats) continue;
    cands.push({ slice, prim: it.primitive, q, len: it.length_beats, intensity: it.intensity });
  }

  // 2. keep the last beat before the phrase boundary empty unless the item is a deliberate fill
  cands = cands.filter((c) => c.q < phraseBeats - 1 || c.intensity >= cfg.fill_intensity);

  // 3. answer mode: move colliding items to the nearest free grid slot, or drop them
  if (cfg.placement_mode === "answer" && bank.vocal_onsets.length) {
    const used = new Set<number>();
    const placed: Cand[] = [];
    for (const c of cands) {
      const shifts = [0];
      for (let s = step; s <= cfg.max_shift_beats + 1e-9; s += step) shifts.push(s, -s);
      for (const sh of shifts) {
        const q = quantizeBeat(c.q + sh, cfg.subdiv, grid.swing);
        if (q < 0 || q >= phraseBeats || used.has(q)) continue;
        const t = timeAt(q) + cfg.micro_offset_ms[c.prim] / 1000;
        if (fitsGap(t, bank.vocal_onsets, cfg.vocal_gap_min_s, cfg.onset_margin_s, cfg.attack_check_s)) {
          used.add(q);
          placed.push({ ...c, q });
          break;
        }
      }
    }
    cands = placed;
  }

  // 4. density cap per bar: keep the highest-intensity events
  const perBar = new Map<number, Cand[]>();
  for (const c of cands) {
    const bar = Math.floor(c.q / cfg.beats_per_bar);
    perBar.set(bar, [...(perBar.get(bar) ?? []), c]);
  }
  const cap = cfg.density_cap[plan.style];
  cands = [...perBar.values()].flatMap((list) =>
    list.length <= cap ? list : [...list].sort((a, b) => b.intensity - a.intensity).slice(0, cap),
  );
  cands.sort((a, b) => a.q - b.q);

  // 5. build events: micro-timing (seeded) and stroke parameters
  const events: ScratchEvent[] = cands.map((c) => {
    const dur = c.len * beatSec;
    const jitter = (rng() * 2 - 1) * cfg.jitter_ms;
    const t0 = timeAt(c.q) + (cfg.micro_offset_ms[c.prim] + jitter) / 1000;
    const sliceLen = c.slice.end - c.slice.start;
    const s0 = sourceStart(c.slice, cfg);
    const room = Math.max(0.005, o.srcDuration - cfg.source_guard_s - s0);
    const params: Record<string, number> = {
      intensity: c.intensity,
      gain: (0.4 + 0.6 * c.intensity) * scale,
    };
    let n = 1;
    if (c.prim === "baby" || c.prim === "cut_forward") {
      n = Math.max(c.prim === "cut_forward" ? 2 : 1, Math.round(c.len / cfg.stroke_beats));
    }
    const T = dur / n;
    if (c.prim === "transform") {
      params.n_chops = Math.min(8, Math.max(2, Math.round(2 + c.intensity * 6)));
      params.duty = cfg.transform_duty;
    }
    const span = Math.min(sliceLen, maxSpan(T, cfg.max_rate), room);
    return { t0, slice_id: c.slice.id, primitive: c.prim, stroke_T: T, span, n_strokes: n, params };
  });
  return events.sort((a, b) => a.t0 - b.t0);
}
