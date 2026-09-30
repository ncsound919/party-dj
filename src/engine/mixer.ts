import { Deck } from "./deck";
import { analyze } from "./analysis";
import { runTransition } from "./transitions";
import { evaluateHarmonicMatch, nextBarTime, nextBeatTime, pickRate } from "./sync";
import {
  createTurntablistCutBuffer,
  evaluateScratchTrajectory,
  renderScratchBuffer,
  SCRATCH_PATTERNS,
} from "./scratch";
import type {
  ScratchPatternId,
  ScratchSourceMode,
  ScratchTelemetry,
  TrackAnalysis,
  TransitionPreset,
} from "./types";

export type NextResult =
  | { ok: true; rate: number; clamped: boolean; harmonicLabel: string }
  | { ok: false; reason: string };

/** Two pro decks + Smart Transition Engine + Bidirectional Turntable Autoscratch. */
export class Mixer {
  ctx = new AudioContext();
  masterGain = this.ctx.createGain();
  decks = [new Deck(this.ctx), new Deck(this.ctx)];
  active = 0;
  playing = false;

  private anchor = 0;       // ctx time of a beat on the active deck (bar grid anchor)
  private effBpm = 124;     // tempo actually heard on the active deck (bpm * playbackRate)
  private busyUntil = 0;    // ctx time the running transition ends
  private fadeStart = 0;    // ctx time the running transition begins (bar-aligned)
  private prev = { deck: 0, anchor: 0, eff: 124 }; // outgoing deck, audible until fadeStart

  // Crossfader (-1 = Deck A, 0 = Center, +1 = Deck B)
  crossfader = -1;

  // Autoscratch state
  scratchSourceMode: ScratchSourceMode = "slip";
  scratchIntensity = 1.0; // 0.5 (Subtle), 1.0 (Club), 1.35 (Turntablist)
  private cutSampleBuffer?: AudioBuffer;
  private scratchNode?: AudioBufferSourceNode;
  private scratchGain: GainNode;
  private activeScratch: {
    patternId: ScratchPatternId;
    patternName: string;
    deck: 0 | 1;
    startAt: number;
    endAt: number;
    totalBeats: number;
    secPerBeat: number;
    curveSamples: Float32Array;
    gateSamples: Float32Array;
  } | null = null;

  // Manual platter drag scratch state
  private manualScratch: {
    deck: 0 | 1;
    velocity: number;
    displacement: number;
    lastGrainAt: number;
    playheadSec: number;
    curveSamples: Float32Array;
    gateSamples: Float32Array;
  } | null = null;

  constructor() {
    this.masterGain.gain.value = 0.92;
    this.masterGain.connect(this.ctx.destination);

    this.decks.forEach(d => d.out.connect(this.masterGain));
    this.decks[1].out.gain.value = 0;

    this.scratchGain = this.ctx.createGain();
    this.scratchGain.gain.value = 1.0;
    this.scratchGain.connect(this.masterGain);
  }

  get idle() {
    return (1 - this.active) as 0 | 1;
  }

  /** True from pressing Next until the outgoing deck has fully faded out. */
  get busy() {
    return this.ctx.currentTime < this.busyUntil;
  }

  /** Live playback info for the UI (null before Start). */
  info() {
    if (!this.playing) return null;
    const now = this.ctx.currentTime;
    const queued = now < this.fadeStart;
    const deck = (queued ? this.prev.deck : this.active) as 0 | 1;
    const d = this.decks[deck];
    if (!d.buffer || !d.analysis) return null;

    const anchor = queued ? this.prev.anchor : this.anchor;
    const effBpm = queued ? this.prev.eff : this.effBpm;
    const speed = effBpm / d.analysis.bpm;
    const elapsed = d.currentOffset(now);
    const fade =
      !queued && now < this.busyUntil
        ? Math.max(0, Math.min(1, (now - this.fadeStart) / Math.max(0.01, this.busyUntil - this.fadeStart)))
        : 0;

    const secPerBeat = 60 / effBpm;
    const secPerBar = secPerBeat * 4;
    const beatFloat = Math.max(0, (now - anchor) / secPerBeat);
    const beatInBar = Math.floor(beatFloat) % 4;
    const nextBarIn = Math.max(0, nextBarTime(now, anchor, secPerBar, 0.02) - now);

    // Update automated crossfader position during transitions
    if (now >= this.fadeStart && now < this.busyUntil) {
      const targetPos = this.active === 0 ? -1 : 1;
      const startPos = -targetPos;
      this.crossfader = startPos + (targetPos - startPos) * fade;
    } else if (!queued) {
      this.crossfader = this.active === 0 ? -1 : 1;
    }

    return {
      deck,
      elapsed,
      duration: d.buffer.duration,
      remaining: Math.max(0, (d.buffer.duration - elapsed) / speed),
      effBpm,
      speed,
      queued,
      fade,
      beatInBar,
      beatPhase: beatFloat % 1,
      nextBarIn,
    };
  }

  async loadFile(slot: 0 | 1, file: File): Promise<TrackAnalysis> {
    if (this.playing && slot === this.active && !this.busy) {
      throw new Error("Deck is currently playing live");
    }
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    return this.loadBuffer(slot, buf);
  }

  loadBuffer(slot: 0 | 1, buf: AudioBuffer, overrideAnalysis?: Partial<TrackAnalysis>): TrackAnalysis {
    const analyzed = { ...analyze(buf), ...overrideAnalysis };
    this.decks[slot].load(buf, analyzed);
    return analyzed;
  }

  play() {
    const d = this.decks[this.active];
    if (!d.analysis || !d.buffer) return false;
    const when = this.ctx.currentTime + 0.04;
    d.out.gain.cancelScheduledValues(0);
    d.out.gain.setValueAtTime(1, when);
    this.decks[this.idle].out.gain.cancelScheduledValues(0);
    this.decks[this.idle].out.gain.setValueAtTime(0, when);

    d.start(when, d.analysis.firstBeat, 1);
    this.anchor = when;
    this.effBpm = d.analysis.bpm;
    this.playing = true;
    this.crossfader = this.active === 0 ? -1 : 1;
    return true;
  }

  pause() {
    if (!this.playing) return;
    this.decks[0].stop();
    this.decks[1].stop();
    this.stopScratch();
    this.playing = false;
  }

  /** Manual crossfader override (-1 = Deck A, +1 = Deck B). */
  setCrossfader(pos: number) {
    this.crossfader = Math.max(-1, Math.min(1, pos));
    if (!this.playing || this.busy) return;
    const now = this.ctx.currentTime;
    // Equal-power crossfade law
    const norm = (this.crossfader + 1) * 0.5; // 0 (Deck A) .. 1 (Deck B)
    const gainA = Math.cos((norm * Math.PI) / 2);
    const gainB = Math.sin((norm * Math.PI) / 2);
    this.decks[0].out.gain.setTargetAtTime(gainA, now, 0.015);
    this.decks[1].out.gain.setTargetAtTime(gainB, now, 0.015);
  }

  /** Quantized jump to a structural cue point or arbitrary time on a deck. */
  seekDeck(slot: 0 | 1, targetSeconds: number) {
    const d = this.decks[slot];
    if (!d.buffer || !d.analysis) return;
    const clamped = Math.max(0, Math.min(d.buffer.duration - 0.2, targetSeconds));
    const secPerBeat = 60 / d.analysis.bpm;
    // Snap to nearest beat on the track's own grid
    const beatIdx = Math.round((clamped - d.analysis.firstBeat) / secPerBeat);
    const snappedOffset = Math.max(0, d.analysis.firstBeat + beatIdx * secPerBeat);

    if (this.playing && slot === this.active) {
      const now = this.ctx.currentTime;
      const rate = this.effBpm / d.analysis.bpm;
      const when = now + 0.02;
      d.start(when, snappedOffset, rate);
      this.anchor = when;
    } else {
      d.start(this.ctx.currentTime + 0.01, snappedOffset, 1);
      if (!this.playing || slot !== this.active) {
        d.stop();
      }
    }
  }

  /** Adjusts master tempo BPM directly (shifts active deck rate proportionally). */
  setMasterBpm(targetBpm: number) {
    const clampedBpm = Math.max(70, Math.min(175, targetBpm));
    this.effBpm = clampedBpm;
    const d = this.decks[this.active];
    if (d.analysis && this.playing) {
      const rate = clampedBpm / d.analysis.bpm;
      d.setRate(rate);
      this.anchor = this.ctx.currentTime;
    }
  }

  /** Beat-matched, bar-aligned transition to the other deck. */
  next(preset: TransitionPreset): NextResult {
    const from = this.decks[this.active];
    const to = this.decks[this.idle];
    if (!this.playing) return { ok: false, reason: "Press Start first" };
    if (!to.analysis || !to.buffer) return { ok: false, reason: "Load a track into the next deck first" };
    if (this.ctx.currentTime < this.busyUntil) return { ok: false, reason: "Transition already in progress" };

    const { rate, effBpm, clamped } = pickRate(this.effBpm, to.analysis.bpm);
    const secPerBar = (60 / this.effBpm) * 4; // bar length as heard on the outgoing deck
    const startAt = nextBarTime(this.ctx.currentTime, this.anchor, secPerBar);

    // Clear stale automation from earlier transitions before scheduling new ones
    for (const p of [from.out.gain, to.out.gain, from.filter.frequency, to.filter.frequency]) {
      p.cancelScheduledValues(0);
    }
    to.out.gain.setValueAtTime(0, this.ctx.currentTime);
    to.filter.frequency.setValueAtTime(10, this.ctx.currentTime);
    from.out.gain.setValueAtTime(1, this.ctx.currentTime);

    // Start incoming track at its Intro or firstBeat
    const startOffset = to.analysis.cuePoints?.intro ?? to.analysis.firstBeat;
    to.start(startAt, startOffset, rate);
    const end = runTransition(from, to, preset, startAt, secPerBar);
    from.stop(end + 0.1);

    const match = evaluateHarmonicMatch(from.analysis?.key, to.analysis.key);

    this.prev = { deck: this.active, anchor: this.anchor, eff: this.effBpm };
    this.fadeStart = startAt;
    this.busyUntil = end;
    this.active = this.idle;
    this.anchor = startAt;
    this.effBpm = effBpm;
    return { ok: true, rate, clamped, harmonicLabel: match.label };
  }

  /**
   * Triggers a beat-quantized bidirectional Autoscratch routine.
   * Supports Slip-Mode (scratches the active deck's live audio and drops back onto the beat grid)
   * or Cut-Over Mode (scratches a classic turntablist cut or incoming deck over the beat).
   */
  triggerAutoscratch(patternId: ScratchPatternId): { ok: boolean; message: string } {
    const activeDeckIdx = this.active as 0 | 1;
    const activeDeck = this.decks[activeDeckIdx];
    const idleDeck = this.decks[this.idle];

    if (!this.cutSampleBuffer) {
      this.cutSampleBuffer = createTurntablistCutBuffer(this.ctx);
    }

    // Auto-start playback if not yet playing and Deck A is loaded
    if (!this.playing && activeDeck.buffer) {
      this.play();
    }

    const now = this.ctx.currentTime;
    const effBpm = this.playing ? this.effBpm : activeDeck.analysis?.bpm ?? 124;
    const secPerBeat = 60 / effBpm;
    const pattern = SCRATCH_PATTERNS.find(p => p.id === patternId) ?? SCRATCH_PATTERNS[0];

    // Quantize scratch start to nearest 1/2 beat (within ~40ms..220ms) for immediate tactile response
    const startAt = this.playing
      ? nextBeatTime(now, this.anchor, secPerBeat * 0.5, 0.025)
      : now + 0.02;

    // Choose source audio buffer & anchor offset
    let sourceBuf: AudioBuffer = this.cutSampleBuffer;
    let sourceAnchorSec = 0.12;
    let targetDeckIdx: 0 | 1 = activeDeckIdx;

    if (this.scratchSourceMode === "slip" && activeDeck.buffer) {
      sourceBuf = activeDeck.buffer;
      sourceAnchorSec = activeDeck.currentOffset(startAt);
      targetDeckIdx = activeDeckIdx;
    } else if (this.scratchSourceMode === "incoming" && idleDeck.buffer) {
      sourceBuf = idleDeck.buffer;
      sourceAnchorSec = idleDeck.analysis?.cuePoints?.drop ?? idleDeck.analysis?.firstBeat ?? 1.0;
      targetDeckIdx = this.idle;
    } else {
      sourceBuf = this.cutSampleBuffer;
      sourceAnchorSec = 0.12;
      targetDeckIdx = activeDeckIdx;
    }

    this.stopScratch();

    const rendered = renderScratchBuffer(
      this.ctx,
      sourceBuf,
      sourceAnchorSec,
      pattern.beats,
      secPerBeat,
      patternId,
      this.scratchIntensity
    );

    const endAt = startAt + rendered.duration;

    // In Slip Mode on the active deck, duck the straight playback while the scratch head takes over,
    // then seamlessly restore straight playback on the exact beat grid when the scratch finishes!
    if (this.playing && this.scratchSourceMode === "slip" && activeDeck.buffer && !this.busy) {
      activeDeck.out.gain.cancelScheduledValues(startAt);
      activeDeck.out.gain.setValueAtTime(1, Math.max(now, startAt - 0.005));
      activeDeck.out.gain.linearRampToValueAtTime(0.08, startAt + 0.008);
      activeDeck.out.gain.setValueAtTime(0.08, endAt - 0.01);
      activeDeck.out.gain.linearRampToValueAtTime(1.0, endAt + 0.006);
    }

    const src = this.ctx.createBufferSource();
    src.buffer = rendered.buffer;
    src.connect(this.scratchGain);
    src.start(startAt);
    src.stop(endAt + 0.01);
    this.scratchNode = src;

    this.activeScratch = {
      patternId,
      patternName: pattern.name,
      deck: targetDeckIdx,
      startAt,
      endAt,
      totalBeats: pattern.beats,
      secPerBeat,
      curveSamples: rendered.curveSamples,
      gateSamples: rendered.gateSamples,
    };

    return {
      ok: true,
      message: `${pattern.name} (${pattern.beats} beats @ ${effBpm.toFixed(0)} BPM)`,
    };
  }

  stopScratch() {
    try {
      this.scratchNode?.stop();
    } catch {
      // ignore
    }
    this.scratchNode = undefined;
    if (this.activeScratch && this.playing && !this.busy) {
      const d = this.decks[this.active];
      d.out.gain.cancelScheduledValues(this.ctx.currentTime);
      d.out.gain.setTargetAtTime(1, this.ctx.currentTime, 0.015);
    }
    this.activeScratch = null;
  }

  /** Interactive manual vinyl scratching when the user drags the turntable platter. */
  startManualScratch(deckIdx: 0 | 1) {
    const d = this.decks[deckIdx];
    const playheadSec = d.buffer ? d.currentOffset() : 0.4;
    if (this.playing && deckIdx === this.active && !this.busy) {
      d.out.gain.setTargetAtTime(0.12, this.ctx.currentTime, 0.01);
    }
    this.manualScratch = {
      deck: deckIdx,
      velocity: 0,
      displacement: 0,
      lastGrainAt: 0,
      playheadSec,
      curveSamples: new Float32Array(128),
      gateSamples: new Float32Array(128).fill(1),
    };
  }

  moveManualScratch(velocity: number) {
    if (!this.manualScratch) return;
    const clampedVel = Math.max(-3.2, Math.min(3.2, velocity));
    this.manualScratch.velocity = clampedVel;
    this.manualScratch.displacement += clampedVel * 0.016;
    this.manualScratch.playheadSec = Math.max(
      0.1,
      this.manualScratch.playheadSec + clampedVel * 0.018
    );

    // Shift scope history
    this.manualScratch.curveSamples.copyWithin(0, 1);
    this.manualScratch.curveSamples[127] = Math.max(-1.5, Math.min(1.5, this.manualScratch.displacement));

    const now = this.ctx.currentTime;
    if (now - this.manualScratch.lastGrainAt > 0.045 && Math.abs(clampedVel) > 0.08) {
      this.manualScratch.lastGrainAt = now;
      if (!this.cutSampleBuffer) {
        this.cutSampleBuffer = createTurntablistCutBuffer(this.ctx);
      }
      const d = this.decks[this.manualScratch.deck];
      const srcBuf = d.buffer ?? this.cutSampleBuffer;
      const sr = srcBuf.sampleRate;
      const grainDur = 0.065;
      const samples = Math.floor(grainDur * sr);
      const grain = this.ctx.createBuffer(1, samples, sr);
      const out = grain.getChannelData(0);
      const inp = srcBuf.getChannelData(0);
      let pos = Math.min(srcBuf.duration - 0.1, Math.max(0.1, this.manualScratch.playheadSec)) * sr;
      for (let i = 0; i < samples; i++) {
        pos += clampedVel;
        const idx = Math.max(0, Math.min(inp.length - 1, Math.floor(pos)));
        const win = Math.sin((Math.PI * i) / samples);
        out[i] = inp[idx] * win * 0.9;
      }
      const node = this.ctx.createBufferSource();
      node.buffer = grain;
      node.connect(this.scratchGain);
      node.start(now);
    }
  }

  endManualScratch() {
    if (!this.manualScratch) return;
    if (this.playing && this.manualScratch.deck === this.active && !this.busy) {
      this.decks[this.active].out.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.02);
    }
    this.manualScratch = null;
  }

  /** Returns live 60fps scratch telemetry for platter rotation & oscilloscope rendering. */
  scratchTelemetry(): ScratchTelemetry {
    if (this.manualScratch) {
      return {
        active: true,
        patternId: "manual",
        patternName: "Manual Vinyl Scrub",
        deck: this.manualScratch.deck,
        progress: 0.5,
        velocity: this.manualScratch.velocity,
        displacement: this.manualScratch.displacement,
        faderOpen: Math.abs(this.manualScratch.velocity) > 0.05,
        faderGain: 1,
        curveSamples: this.manualScratch.curveSamples,
        gateSamples: this.manualScratch.gateSamples,
      };
    }

    const s = this.activeScratch;
    const now = this.ctx.currentTime;
    if (!s || now > s.endAt) {
      if (s && now > s.endAt) {
        this.activeScratch = null;
      }
      return {
        active: false,
        patternId: null,
        patternName: "Ready",
        deck: this.active as 0 | 1,
        progress: 0,
        velocity: this.playing ? 1 : 0,
        displacement: 0,
        faderOpen: true,
        faderGain: 1,
        curveSamples: new Float32Array(128),
        gateSamples: new Float32Array(128).fill(1),
      };
    }

    if (now < s.startAt) {
      return {
        active: true,
        patternId: s.patternId,
        patternName: `${s.patternName} (Quantizing…)`,
        deck: s.deck,
        progress: 0,
        velocity: 1,
        displacement: 0,
        faderOpen: true,
        faderGain: 1,
        curveSamples: s.curveSamples,
        gateSamples: s.gateSamples,
      };
    }

    const elapsed = now - s.startAt;
    const duration = Math.max(0.01, s.endAt - s.startAt);
    const progress = Math.max(0, Math.min(1, elapsed / duration));
    const beatPos = elapsed / s.secPerBeat;
    const { velocity, faderGain } = evaluateScratchTrajectory(
      s.patternId,
      beatPos,
      s.totalBeats,
      this.scratchIntensity
    );
    const scopeIdx = Math.min(127, Math.floor(progress * 128));
    const displacement = s.curveSamples[scopeIdx] ?? 0;

    return {
      active: true,
      patternId: s.patternId,
      patternName: s.patternName,
      deck: s.deck,
      progress,
      velocity,
      displacement,
      faderOpen: faderGain > 0.25,
      faderGain,
      curveSamples: s.curveSamples,
      gateSamples: s.gateSamples,
    };
  }

  /** Synthesizes club FX one-shots synced to the master BPM. */
  triggerClubFX(fxId: "dub-siren" | "sub-drop" | "laser-riser" | "vinyl-brake") {
    const now = this.ctx.currentTime;
    const secPerBeat = 60 / this.effBpm;

    if (fxId === "vinyl-brake" && this.playing) {
      const d = this.decks[this.active];
      const curRate = this.effBpm / (d.analysis?.bpm ?? this.effBpm);
      d.setRate(0.15);
      setTimeout(() => {
        if (this.playing) d.setRate(curRate);
      }, secPerBeat * 1000);
      return;
    }

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.masterGain);

    if (fxId === "dub-siren") {
      osc.type = "sawtooth";
      const dur = secPerBeat * 2;
      for (let i = 0; i < 8; i++) {
        const t = now + (i * dur) / 8;
        osc.frequency.setValueAtTime(i % 2 === 0 ? 580 : 880, t);
      }
      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.start(now);
      osc.stop(now + dur);
    } else if (fxId === "sub-drop") {
      osc.type = "sine";
      const dur = secPerBeat * 3;
      osc.frequency.setValueAtTime(130, now);
      osc.frequency.exponentialRampToValueAtTime(32, now + dur);
      gain.gain.setValueAtTime(0.55, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.start(now);
      osc.stop(now + dur);
    } else if (fxId === "laser-riser") {
      osc.type = "triangle";
      const dur = secPerBeat * 2;
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(2400, now + dur);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.linearRampToValueAtTime(0.28, now + dur * 0.85);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.start(now);
      osc.stop(now + dur);
    }
  }
}
