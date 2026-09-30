import type { TrackAnalysis } from "./types";

export class Deck {
  readonly out: GainNode;
  readonly filter: BiquadFilterNode;
  buffer?: AudioBuffer;
  analysis?: TrackAnalysis;
  private src?: AudioBufferSourceNode;

  constructor(private ctx: AudioContext) {
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "highpass";
    this.filter.frequency.value = 10;
    this.out = ctx.createGain();
    this.filter.connect(this.out);
  }

  load(buffer: AudioBuffer, analysis: TrackAnalysis) { this.buffer = buffer; this.analysis = analysis; }

  /** Start at `when` (ctx time), from `offset` seconds, at a tempo ratio. */
  start(when: number, offset: number, rate = 1) {
    if (!this.buffer) return;
    this.stop();
    this.src = this.ctx.createBufferSource();
    this.src.buffer = this.buffer;
    this.src.playbackRate.value = rate;   // NOTE: shifts pitch too. TODO: real time-stretch (SoundTouch/Rubber Band WASM)
    this.src.connect(this.filter);
    this.src.start(when, offset);
  }

  /** Stop at ctx time `when` (default now). */
  stop(when = 0) { try { this.src?.stop(when); } catch {} if (!when) this.src = undefined; }
}
