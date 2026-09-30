import type { ScratchConfig } from "../config";
import { gridErrorSec } from "../composer/placement";
import type { RenderedEvent } from "../scratch/render";
import type { Grid, ScratchEvent, Style } from "../schemas";

export type CheckAction = "raise" | "reroll" | "drop" | "report";

export interface CriticCheck {
  name: string;
  value: number | null; // null = NOT MEASURED
  threshold: number | null;
  passed: boolean;
  action: CheckAction;
  note?: string;
}

export interface CriticReport {
  passed: boolean; // no failing check with action other than "report"
  fatal: string[]; // invariants that must throw, never be papered over
  checks: CriticCheck[];
}

export class CriticError extends Error {
  constructor(public fatal: string[]) {
    super(`Critic invariant failed: ${fatal.join(", ")}`);
  }
}

export interface CriticInput {
  events: ScratchEvent[];
  audio: Float64Array; // pre-limiter mix
  rendered: RenderedEvent[]; // same order as events
  grid: Grid;
  style: Style;
  srcLenSamples: number;
  srcDuration: number;
  phraseStartTime: number; // seconds
  cfg: ScratchConfig;
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function evaluate(inp: CriticInput): CriticReport {
  const { events, audio, rendered, grid, cfg } = inp;
  const checks: CriticCheck[] = [];
  const add = (c: CriticCheck) => checks.push(c);

  // finite audio
  let finite = true;
  let peak = 0;
  for (let i = 0; i < audio.length; i++) {
    const v = audio[i];
    if (!Number.isFinite(v)) {
      finite = false;
      break;
    }
    peak = Math.max(peak, Math.abs(v));
  }
  add({ name: "finite_audio", value: finite ? 1 : 0, threshold: 1, passed: finite, action: "raise" });

  // clipping (pre-limiter, 0 dBFS = 1.0)
  add({ name: "clipping", value: peak, threshold: 1, passed: peak <= 1, action: "reroll", note: "peak, linear" });

  // silence: RMS over the samples the events actually cover
  const n = rendered.reduce((s, r) => s + r.n, 0);
  const rms = n ? Math.sqrt(rendered.reduce((s, r) => s + r.sumSq, 0) / n) : 0;
  add({ name: "silence", value: rms, threshold: cfg.silence_rms_floor, passed: rms >= cfg.silence_rms_floor, action: "reroll" });

  // grid adherence: median |onset - nearest grid point| in ms
  const errs = events.map((e) => gridErrorSec(grid.beats, e.t0, cfg.subdiv, grid.swing) * 1000);
  const gridErr = median(errs);
  add({ name: "grid_adherence", value: gridErr, threshold: cfg.grid_median_err_ms, passed: gridErr <= cfg.grid_median_err_ms, action: "reroll", note: "median ms" });

  // density: events per bar under the style cap
  const barSec = (60 / grid.bpm) * cfg.beats_per_bar;
  const counts = new Map<number, number>();
  for (const e of events) {
    const bar = Math.floor((e.t0 - inp.phraseStartTime + 0.05) / barSec);
    counts.set(bar, (counts.get(bar) ?? 0) + 1);
  }
  const maxPerBar = Math.max(0, ...counts.values());
  const cap = cfg.density_cap[inp.style];
  add({ name: "density", value: maxPerBar, threshold: cap, passed: maxPerBar <= cap, action: "drop" });

  // source range: planned and rendered positions stay inside the source
  const posMin = Math.min(Infinity, ...rendered.map((r) => r.posMin));
  const posMax = Math.max(-Infinity, ...rendered.map((r) => r.posMax));
  const inRange = rendered.length === 0 || (posMin >= 0 && posMax <= inp.srcLenSamples - 1);
  add({ name: "source_range", value: inRange ? 1 : 0, threshold: 1, passed: inRange, action: "raise", note: `pos ${posMin.toFixed(0)}..${posMax.toFixed(0)} of ${inp.srcLenSamples}` });

  // gate clicks
  const jump = Math.max(0, ...rendered.map((r) => r.maxEdgeJump));
  add({ name: "gate_clicks", value: jump, threshold: cfg.gate_click_max, passed: jump <= cfg.gate_click_max, action: "reroll", note: "max jump at gate edges" });

  // diversity: no identical consecutive events
  let repeats = 0;
  for (let i = 1; i < events.length; i++) {
    const a = events[i - 1];
    const b = events[i];
    if (a.slice_id === b.slice_id && a.primitive === b.primitive && a.n_strokes === b.n_strokes && Math.abs(a.stroke_T - b.stroke_T) < 1e-6) repeats++;
  }
  add({ name: "diversity", value: repeats, threshold: 0, passed: repeats === 0, action: "reroll" });

  // intelligibility: needs re-running alignment on the rendered audio
  add({ name: "intelligibility", value: null, threshold: null, passed: true, action: "report", note: "NOT MEASURED" });

  const fatal = checks.filter((c) => !c.passed && c.action === "raise").map((c) => c.name);
  const passed = checks.every((c) => c.passed || c.action === "report");
  return { passed, fatal, checks };
}
