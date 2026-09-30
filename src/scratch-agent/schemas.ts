// Mirrors PLAN §3. Field names stay snake_case so JSON is interchangeable
// with the Python pipeline. Ask before changing these: everything depends on them.

export type PrimitiveName =
  | "baby"
  | "stab"
  | "cut_forward"
  | "transform"
  | "flare"
  | "chirp"
  | "tear"
  | "crab"
  | "rest";
export type Style = "sparse" | "medium" | "busy";
export const PRIMITIVES: PrimitiveName[] = [
  "baby",
  "stab",
  "cut_forward",
  "transform",
  "flare",
  "chirp",
  "tear",
  "crab",
  "rest",
];
export const STYLES: Style[] = ["sparse", "medium", "busy"];

/** Source id used when a slice carries no `src_id` (the primary `src` handed to the pipeline). */
export const MAIN_SRC = "main";

export interface Slice {
  id: number; // unique across every source in a merged bank (see mergeBanks)
  src_id?: string; // which source buffer the times below index into; undefined = MAIN_SRC
  start: number; // seconds in source
  end: number;
  kind: "word" | "syllable" | "transient";
  text?: string | null;
  energy: number; // 0..1 normalized RMS
}

export interface Grid {
  bpm: number;
  beats: number[]; // beat times (s)
  downbeats: number[];
  swing: number; // 0..0.33
  agreement: number; // 0..1 (manual grids: not computed, set to 1)
}

export interface SliceBank {
  source_path: string;
  sr: number;
  slices: Slice[];
  vocal_onsets: number[];
}

export interface DirectorItem {
  slice_id: number;
  primitive: PrimitiveName;
  beat: number; // >= 0, beats from phrase start
  length_beats: number; // (0, 4]
  intensity: number; // 0..1
}

export interface DirectorPlan {
  bars: 2 | 4;
  style: Style;
  items: DirectorItem[]; // max 16
}

export interface ScratchEvent {
  t0: number; // seconds, output timeline (after quantize + micro-timing)
  slice_id: number;
  primitive: PrimitiveName;
  stroke_T: number;
  span: number;
  n_strokes: number;
  params: Record<string, number>;
}

export type Validation = { ok: true; plan: DirectorPlan } | { ok: false; error: string };

/** Same constraints as the pydantic DirectorPlan. */
export function validateDirectorPlan(x: unknown): Validation {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return { ok: false, error: "not an object" };
  if (o.bars !== 2 && o.bars !== 4) return { ok: false, error: "bars must be 2 or 4" };
  if (!STYLES.includes(o.style as Style)) return { ok: false, error: "style must be sparse|medium|busy" };
  if (!Array.isArray(o.items)) return { ok: false, error: "items must be an array" };
  if (o.items.length > 16) return { ok: false, error: "items has more than 16 entries" };
  for (const [n, rawIt] of o.items.entries()) {
    const it = rawIt as Record<string, unknown>;
    const p = `items[${n}]`;
    if (!Number.isInteger(it?.slice_id)) return { ok: false, error: `${p}.slice_id must be an integer` };
    if (!PRIMITIVES.includes(it.primitive as PrimitiveName)) return { ok: false, error: `${p}.primitive invalid` };
    if (!(typeof it.beat === "number" && it.beat >= 0)) return { ok: false, error: `${p}.beat must be >= 0` };
    if (!(typeof it.length_beats === "number" && it.length_beats > 0 && it.length_beats <= 4))
      return { ok: false, error: `${p}.length_beats must be in (0, 4]` };
    if (!(typeof it.intensity === "number" && it.intensity >= 0 && it.intensity <= 1))
      return { ok: false, error: `${p}.intensity must be in [0, 1]` };
  }
  return { ok: true, plan: o as unknown as DirectorPlan };
}

/** Hand-written JSON schema handed to the LLM director (replaces pydantic model_json_schema). */
export const DIRECTOR_JSON_SCHEMA = {
  type: "object",
  required: ["bars", "style", "items"],
  properties: {
    bars: { enum: [2, 4] },
    style: { enum: STYLES },
    items: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        required: ["slice_id", "primitive", "beat", "length_beats", "intensity"],
        properties: {
          slice_id: { type: "integer" },
          primitive: { enum: PRIMITIVES },
          beat: { type: "number", minimum: 0 },
          length_beats: { type: "number", exclusiveMinimum: 0, maximum: 4 },
          intensity: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
};
