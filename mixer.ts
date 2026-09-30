import { Deck } from "./deck";
import { analyze } from "./analysis";
import { runTransition } from "./transitions";
import { nextBarTime, pickRate } from "./sync";
import type { TransitionPreset } from "./types";

export type NextResult = { ok: true; rate: number; clamped: boolean } | { ok: false; reason: string };

/** Two decks hidden behind a single "Next" concept. */
export class Mixer {
  ctx = new AudioContext();
  decks = [new Deck(this.ctx), new Deck(this.ctx)];
  active = 0;
  playing = false;
  private anchor = 0;       // ctx time of a beat on the active deck (bar grid anchor)
  private effBpm = 0;       // tempo actually heard on the active deck (bpm * playbackRate)
  private busyUntil = 0;    // ctx time the running transition ends
  private fadeStart = 0;    // ctx time the running transition begins (bar-aligned)
  private prev = { deck: 0, anchor: 0, eff: 0 }; // outgoing deck, audible until fadeStart

  constructor() { this.decks.forEach(d => d.out.connect(this.ctx.destination)); this.decks[1].out.gain.value = 0; }

  get idle() { return (1 - this.active) as 0 | 1; }
  /** True from pressing Next until the outgoing deck has fully faded out. */
  get busy() { return this.ctx.currentTime < this.busyUntil; }

  /** Live playback info for the UI (null before Start). */
  info() {
    if (!this.playing) return null;
    const now = this.ctx.currentTime, queued = now < this.fadeStart;
    const deck = queued ? this.prev.deck : this.active;
    const d = this.decks[deck];
    if (!d.buffer || !d.analysis) return null;
    const anchor = queued ? this.prev.anchor : this.anchor;
    const effBpm = queued ? this.prev.eff : this.effBpm;
    const speed = effBpm / d.analysis.bpm;
    const elapsed = Math.min(d.buffer.duration, d.analysis.firstBeat + Math.max(0, now - anchor) * speed);
    const fade = !queued && now < this.busyUntil ? (now - this.fadeStart) / (this.busyUntil - this.fadeStart) : 0;
    return { deck, elapsed, duration: d.buffer.duration, remaining: (d.buffer.duration - elapsed) / speed, effBpm, queued, fade };
  }

  async loadFile(slot: 0 | 1, file: File) {
    if (this.playing && slot === this.active) throw new Error("Deck is playing");
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    this.decks[slot].load(buf, analyze(buf));
    return this.decks[slot].analysis!;
  }

  play() {
    const d = this.decks[this.active];
    if (!d.analysis) return false;
    const when = this.ctx.currentTime + 0.05;
    d.out.gain.value = 1;
    d.start(when, d.analysis.firstBeat);
    this.anchor = when;
    this.effBpm = d.analysis.bpm;
    this.playing = true;
    return true;
  }

  /** Beat-matched, bar-aligned transition to the other deck. */
  next(preset: TransitionPreset): NextResult {
    const from = this.decks[this.active], to = this.decks[this.idle];
    if (!this.playing) return { ok: false, reason: "Press Start first" };
    if (!to.analysis) return { ok: false, reason: "Add another track first" };
    if (this.ctx.currentTime < this.busyUntil) return { ok: false, reason: "Transition in progress" };

    const { rate, effBpm, clamped } = pickRate(this.effBpm, to.analysis.bpm);
    const secPerBar = (60 / this.effBpm) * 4;      // bar length as *heard* on the outgoing deck
    const startAt = nextBarTime(this.ctx.currentTime, this.anchor, secPerBar);

    // clear stale automation from earlier transitions before scheduling new ones
    for (const p of [from.out.gain, to.out.gain, from.filter.frequency, to.filter.frequency]) p.cancelScheduledValues(0);
    to.out.gain.setValueAtTime(0, this.ctx.currentTime);
    to.filter.frequency.setValueAtTime(10, this.ctx.currentTime);
    from.out.gain.setValueAtTime(1, this.ctx.currentTime);

    to.start(startAt, to.analysis.firstBeat, rate);
    const end = runTransition(from, to, preset, startAt, secPerBar);
    from.stop(end + 0.1);

    this.prev = { deck: this.active, anchor: this.anchor, eff: this.effBpm };
    this.fadeStart = startAt;
    this.busyUntil = end;
    this.active = this.idle;
    this.anchor = startAt;
    this.effBpm = effBpm;
    return { ok: true, rate, clamped };
  }
}
