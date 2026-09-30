import { compose, sourceStart } from "./composer/compose";
import { beatToTime } from "./composer/placement";
import type { ScratchConfig } from "./config";
import { DEFAULT_CONFIG } from "./config";
import type { CriticReport } from "./critic/rules";
import { CriticError, evaluate } from "./critic/rules";
import type { DirectorContext } from "./director/rulesDirector";
import { buildContext, rulesDirector } from "./director/rulesDirector";
import { eventToPrimitive, renderTimeline } from "./scratch/render";
import type { Placed } from "./scratch/render";
import { MAIN_SRC } from "./schemas";
import type { DirectorPlan, Grid, ScratchEvent, Slice, SliceBank, Style } from "./schemas";

/** Return null to fall back to the rules director. */
export type DirectorFn = (ctx: DirectorContext, seed: number, cfg: ScratchConfig) => Promise<DirectorPlan | null>;

export const rulesDirectorFn: DirectorFn = async (ctx, seed, cfg) => rulesDirector(ctx, seed, cfg);

export interface RunOpts {
  src: Float32Array; // mono; the source for slices without a src_id
  /** Extra sources by slice `src_id` (e.g. words cut from other records). Must already be mono at `fs`. */
  sources?: Record<string, Float32Array>;
  fs: number;
  bank: SliceBank;
  grid: Grid;
  bars: 2 | 4;
  style: Style;
  seed: number;
  phraseStartBeat: number; // fractional index into grid.beats
  director?: DirectorFn;
  cfg?: Partial<ScratchConfig>;
}

export interface Attempt {
  seed: number;
  director: "given" | "rules-fallback";
  report: CriticReport;
  failing: string[];
  cfgChanges: string[];
}

export interface RunResult {
  audio: Float64Array; // pre-limiter mix of the scratch only
  rateTimeline: Float32Array; // instantaneous platter velocity across timeline
  dispTimeline: Float32Array; // platter groove displacement across timeline
  gateTimeline: Float32Array; // optical crossfader gate (0..1) across timeline
  posSecTimeline: Float32Array; // source groove position in seconds across timeline
  events: ScratchEvent[];
  plan: DirectorPlan;
  passed: boolean;
  attempts: Attempt[];
  seed: number; // seed of the returned attempt
  cfg: ScratchConfig;
}

/**
 * Deterministic given the starting seed: attempt k uses seed + k, and reroll adjustments
 * (lower gain after clipping, longer gate ramp after clicks) depend only on earlier results.
 * Fatal invariants (NaN, source range) throw instead of being retried.
 */
export async function runScratchAgent(o: RunOpts): Promise<RunResult> {
  let cfg: ScratchConfig = { ...DEFAULT_CONFIG, ...o.cfg };
  const director = o.director ?? rulesDirectorFn;
  const srcDuration = o.src.length / o.fs;
  const bufferFor = (sl: Slice): Float32Array => {
    const id = sl.src_id ?? MAIN_SRC;
    if (id === MAIN_SRC) return o.src;
    const b = o.sources?.[id];
    if (!b) throw new Error(`slice ${sl.id} needs source "${id}" but it was not passed in sources`);
    return b;
  };
  const srcDurations: Record<string, number> = { [MAIN_SRC]: srcDuration };
  for (const [id, b] of Object.entries(o.sources ?? {})) srcDurations[id] = b.length / o.fs;
  const phraseStartTime = beatToTime(o.grid.beats, o.phraseStartBeat);
  const phraseSec = (60 / o.grid.bpm) * cfg.beats_per_bar * o.bars;
  const totalSec = phraseStartTime + phraseSec + cfg.tail_s;

  const attempts: Attempt[] = [];
  let scale = 1;
  let last: RunResult | null = null;

  for (let k = 0; k < cfg.max_tries; k++) {
    const seed = o.seed + k;
    const ctx = buildContext(o.bank, o.grid, o.bars, o.style);
    let plan = await director(ctx, seed, cfg);
    let used: Attempt["director"] = "given";
    if (!plan) {
      plan = rulesDirector(ctx, seed, cfg);
      used = "rules-fallback";
    }

    const events = compose(plan, o.bank, o.grid, cfg, {
      seed,
      phraseStartBeat: o.phraseStartBeat,
      srcDuration,
      srcDurations,
      intensityScale: scale,
    });
    const byId = new Map(o.bank.slices.map((s) => [s.id, s]));
    const bufs = events.map((e) => bufferFor(byId.get(e.slice_id)!));
    const placed: Placed[] = events.map((e, i) => ({
      t0: e.t0,
      prim: eventToPrimitive(e),
      s0: sourceStart(byId.get(e.slice_id)!, cfg),
      gain: e.params.gain ?? 1,
      src: bufs[i],
    }));
    const { audio, rateTimeline, dispTimeline, gateTimeline, posSecTimeline, rendered } = renderTimeline(
      o.src,
      o.fs,
      placed,
      totalSec,
      cfg
    );

    const report = evaluate({
      events,
      audio,
      rendered,
      grid: o.grid,
      style: o.style,
      srcLenSamples: o.src.length,
      srcLenByEvent: bufs.map((b) => b.length),
      srcDuration,
      phraseStartTime,
      cfg,
    });
    if (report.fatal.length) throw new CriticError(report.fatal);

    const failing = report.checks.filter((c) => !c.passed && c.action !== "report").map((c) => c.name);
    const cfgChanges: string[] = [];
    attempts.push({ seed, director: used, report, failing, cfgChanges });
    last = {
      audio,
      rateTimeline,
      dispTimeline,
      gateTimeline,
      posSecTimeline,
      events,
      plan,
      passed: report.passed,
      attempts,
      seed,
      cfg,
    };
    if (report.passed) return last;

    // adjust for the next try, based only on what just failed
    if (failing.includes("clipping")) {
      scale *= cfg.intensity_backoff;
      cfgChanges.push(`gain scale -> ${scale.toFixed(3)}`);
    }
    if (failing.includes("gate_clicks")) {
      cfg = { ...cfg, ramp_ms: cfg.ramp_ms * cfg.ramp_growth };
      cfgChanges.push(`ramp_ms -> ${cfg.ramp_ms.toFixed(2)}`);
    }
  }
  return last!; // out of tries: caller sees passed=false and the per-attempt reports
}
