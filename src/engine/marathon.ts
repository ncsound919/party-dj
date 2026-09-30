import { evaluateHarmonicMatch, pickRate } from "./sync";
import type { TrackAnalysis } from "./types";

export interface MarathonCandidate {
  id: string;
  name: string;
  analysis: TrackAnalysis;
  playCount?: number;
  lastPlayedAtMs?: number;
}

export interface TrackTransitionScore {
  total: number;          // 0..1 composite score
  harmonicScore: number;  // 0..1 Camelot compatibility
  tempoScore: number;     // 0..1 BPM proximity (including half/double time)
  energyScore: number;    // 0..1 closeness to PartyTemplate energyCurve target
  freshnessScore: number; // 0..1 anti-repeat penalty
  harmonicLabel: string;
}

/**
 * Piecewise-linear interpolation along a PartyTemplate energyCurve (e.g. [0.4, 0.6, 0.8, 0.9, 0.7])
 * for normalized party progress `progress01` in [0, 1].
 */
export function interpolateEnergyCurve(curve: number[], progress01: number): number {
  if (!curve.length) return 0.75;
  if (curve.length === 1) return curve[0];
  const p = Math.max(0, Math.min(1, progress01));
  const scaled = p * (curve.length - 1);
  const idx = Math.min(curve.length - 2, Math.floor(scaled));
  const frac = scaled - idx;
  return curve[idx] + (curve[idx + 1] - curve[idx]) * frac;
}

/**
 * Scores a candidate track for transitioning from `current` at `targetEnergy`.
 * Combines real Camelot harmonic distance, tempo lock range, energy curve tracking,
 * and marathon play-history freshness.
 */
export function scoreNextTrackCandidate(
  current: { bpm: number; key?: string },
  cand: MarathonCandidate,
  targetEnergy: number,
  nowMs = Date.now(),
  minPlayCount = 0
): TrackTransitionScore {
  // 1. Camelot wheel harmonic score
  const harm = evaluateHarmonicMatch(current.key, cand.analysis.key);
  const harmonicScore = harm.score;

  // 2. Tempo score via pickRate (handles 1x, 0.5x half-time, 2x double-time)
  const rateRes = pickRate(current.bpm, cand.analysis.bpm);
  const stretch = Math.abs(rateRes.rate - 1);
  const tempoScore = rateRes.clamped
    ? 0.35
    : Math.max(0.5, 1 - (stretch / 0.08) * 0.45);

  // 3. Energy curve proximity score
  const candEnergy = cand.analysis.energy ?? 0.75;
  const energyDiff = Math.abs(candEnergy - targetEnergy);
  const energyScore = Math.max(0.1, 1 - energyDiff * 1.15);

  // 4. Marathon anti-repeat / cooldown freshness score
  const playsAboveMin = Math.max(0, (cand.playCount ?? 0) - minPlayCount);
  let freshnessScore = Math.pow(0.45, playsAboveMin);
  if (cand.lastPlayedAtMs && nowMs > cand.lastPlayedAtMs) {
    const minsAgo = (nowMs - cand.lastPlayedAtMs) / 60000;
    // Penalize tracks played within the last 25 minutes
    if (minsAgo < 25) {
      freshnessScore *= Math.max(0.15, minsAgo / 25);
    }
  }

  const total =
    0.34 * harmonicScore +
    0.26 * tempoScore +
    0.22 * energyScore +
    0.18 * freshnessScore;

  return {
    total: +total.toFixed(4),
    harmonicScore: +harmonicScore.toFixed(3),
    tempoScore: +tempoScore.toFixed(3),
    energyScore: +energyScore.toFixed(3),
    freshnessScore: +freshnessScore.toFixed(3),
    harmonicLabel: harm.label,
  };
}

/**
 * Selects the best next track from `crate` (excluding `excludeIds`) for an unattended
 * marathon party, rotating evenly through the entire crate before repeating tracks.
 */
export function pickNextMarathonTrack<T extends MarathonCandidate>(
  anchor: { bpm: number; key?: string },
  crate: T[],
  excludeIds: Set<string>,
  targetEnergy: number,
  nowMs = Date.now()
): { track: T; score: TrackTransitionScore } | null {
  const pool = crate.filter(c => !excludeIds.has(c.id));
  const candidates = pool.length > 0 ? pool : crate;
  if (!candidates.length) return null;

  const minPlayCount = Math.min(...candidates.map(c => c.playCount ?? 0));
  let bestTrack = candidates[0];
  let bestScore = scoreNextTrackCandidate(anchor, bestTrack, targetEnergy, nowMs, minPlayCount);

  for (let i = 1; i < candidates.length; i++) {
    const sc = scoreNextTrackCandidate(anchor, candidates[i], targetEnergy, nowMs, minPlayCount);
    if (sc.total > bestScore.total) {
      bestScore = sc;
      bestTrack = candidates[i];
    }
  }
  return { track: bestTrack, score: bestScore };
}

/**
 * Reorders a queue of tracks using greedy trajectory optimization so each transition
 * maximizes Camelot key lock, BPM proximity, and adherence to `energyCurve`.
 */
export function sequenceCrateForParty<T extends MarathonCandidate>(
  anchor: { bpm: number; key?: string },
  items: T[],
  energyCurve: number[],
  startProgress01 = 0,
  stepProgress = 0.12
): T[] {
  const remaining = [...items];
  const ordered: T[] = [];
  let curBpm = anchor.bpm;
  let curKey = anchor.key;
  let prog = startProgress01;
  const nowMs = Date.now();

  while (remaining.length > 0) {
    const targetE = interpolateEnergyCurve(energyCurve, prog);
    const minPlays = Math.min(...remaining.map(r => r.playCount ?? 0));
    let bestIdx = 0;
    let bestVal = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const sc = scoreNextTrackCandidate(
        { bpm: curBpm, key: curKey },
        remaining[i],
        targetE,
        nowMs,
        minPlays
      );
      if (sc.total > bestVal) {
        bestVal = sc.total;
        bestIdx = i;
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0];
    ordered.push(chosen);
    curBpm = chosen.analysis.bpm;
    curKey = chosen.analysis.key;
    prog = Math.min(1, prog + stepProgress);
  }

  return ordered;
}

/**
 * Automatically selects the best TransitionPreset ID ("bass-swap", "smooth", "filter", "quick", "long")
 * based on BPM stretch, Camelot harmonic score, and incoming track energy.
 */
export function pickSmartTransitionPreset(
  from: { bpm: number; key?: string; energy?: number },
  to: { bpm: number; key?: string; energy?: number }
): { presetId: string; reason: string } {
  const rateRes = pickRate(from.bpm, to.bpm);
  const harm = evaluateHarmonicMatch(from.key, to.key);
  const stretch = Math.abs(rateRes.rate - 1);
  const toEnergy = to.energy ?? 0.78;
  const fromEnergy = from.energy ?? 0.78;

  // 1. Wide BPM gap or clamped tempo -> Quick Cut so beats never drift
  if (rateRes.clamped || stretch > 0.065) {
    return { presetId: "quick", reason: "Wide tempo gap -> Quick Cut" };
  }
  // 2. Non-harmonic key jump -> High-Pass Filter Sweep to mask tonal clash
  if (harm.score < 0.75) {
    return { presetId: "filter", reason: "Tonal contrast -> Filter Sweep" };
  }
  // 3. High-energy club/bass tracks -> 8-Bar Bass Swap so two kicks never clash
  if (toEnergy >= 0.8 && fromEnergy >= 0.75) {
    return { presetId: "bass-swap", reason: "High-energy club kicks -> Bass Swap" };
  }
  // 4. Deep/warmup harmonic match -> 16-Bar Long Blend
  if (toEnergy < 0.68 && harm.score >= 0.9) {
    return { presetId: "long", reason: "Deep harmonic lock -> Long Blend" };
  }
  // 5. Standard balanced transition -> 8-Bar Smooth Equal-Power
  return { presetId: "smooth", reason: "Balanced groove -> Smooth Blend" };
}

/**
 * Automatically configures the 90s Scratch Agent archetype, style, bars, and pocket mode
 * from the active track's BPM and energy so no manual setup is needed.
 */
export function pickSmartScratchProfile(track: {
  bpm: number;
  energy?: number;
  genre?: string;
}): {
  archetype: "premier" | "philly" | "bombsquad";
  bars: 2 | 4;
  style: "sparse" | "medium" | "busy";
  placementMode: "hook" | "answer" | "sentence";
} {
  const genreLower = (track.genre ?? "").toLowerCase();
  if (track.bpm < 108 || genreLower.includes("hip") || genreLower.includes("boom") || genreLower.includes("break")) {
    return {
      archetype: "premier",
      bars: 2,
      style: "sparse",
      placementMode: "sentence",
    };
  }
  if (track.bpm >= 132 || (track.energy ?? 0.75) >= 0.9) {
    return {
      archetype: "bombsquad",
      bars: 4,
      style: "busy",
      placementMode: "hook",
    };
  }
  return {
    archetype: "philly",
    bars: 2,
    style: "medium",
    placementMode: "answer",
  };
}

