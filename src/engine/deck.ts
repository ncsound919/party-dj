import type { TrackAnalysis } from "./types";

export class Deck {
  readonly out: GainNode;
  readonly filter: BiquadFilterNode;
  readonly colorFilter: BiquadFilterNode;
  readonly lowEq: BiquadFilterNode;
  readonly midEq: BiquadFilterNode;
  readonly highEq: BiquadFilterNode;
  readonly analyser: AnalyserNode;

  buffer?: AudioBuffer;
  analysis?: TrackAnalysis;
  private src?: AudioBufferSourceNode;

  // Live playback tracking so we can pitch-shift, loop, and hot-cue seamlessly
  private startedAtCtx = 0;
  private startedOffset = 0;
  private currentRate = 1;
  private isPlaying = false;

  // EQ & Color Filter state
  lowDb = 0;
  midDb = 0;
  highDb = 0;
  colorValue = 0; // -1 (Low-Pass) .. 0 (Flat) .. +1 (High-Pass)
  loopBars = 0;   // 0 = off, 0.5, 1, 2, 4, 8

  constructor(private ctx: AudioContext) {
    // 3-Band Isolator EQ chain
    this.lowEq = ctx.createBiquadFilter();
    this.lowEq.type = "lowshelf";
    this.lowEq.frequency.value = 250;
    this.lowEq.gain.value = 0;

    this.midEq = ctx.createBiquadFilter();
    this.midEq.type = "peaking";
    this.midEq.frequency.value = 1100;
    this.midEq.Q.value = 0.9;
    this.midEq.gain.value = 0;

    this.highEq = ctx.createBiquadFilter();
    this.highEq.type = "highshelf";
    this.highEq.frequency.value = 3800;
    this.highEq.gain.value = 0;

    // User bipolar Color Filter (LP / HP)
    this.colorFilter = ctx.createBiquadFilter();
    this.colorFilter.type = "lowpass";
    this.colorFilter.frequency.value = 20000;
    this.colorFilter.Q.value = 0.707;

    // Transition automation high-pass filter (used by runTransition)
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "highpass";
    this.filter.frequency.value = 10;

    this.out = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.72;

    this.lowEq.connect(this.midEq);
    this.midEq.connect(this.highEq);
    this.highEq.connect(this.colorFilter);
    this.colorFilter.connect(this.filter);
    this.filter.connect(this.out);
    this.out.connect(this.analyser);
  }

  load(buffer: AudioBuffer, analysis: TrackAnalysis) {
    this.buffer = buffer;
    this.analysis = analysis;
    this.loopBars = 0;
  }

  /** Computes current track playback position in seconds. */
  currentOffset(now = this.ctx.currentTime): number {
    if (!this.buffer) return 0;
    if (!this.isPlaying) return this.startedOffset;
    const elapsedWall = Math.max(0, now - this.startedAtCtx);
    let pos = this.startedOffset + elapsedWall * this.currentRate;
    if (this.loopBars > 0 && this.analysis) {
      const secPerBar = (60 / this.analysis.bpm) * 4;
      const loopLen = this.loopBars * secPerBar;
      if (pos >= this.startedOffset + loopLen) {
        pos = this.startedOffset + ((pos - this.startedOffset) % loopLen);
      }
    }
    return Math.min(this.buffer.duration, Math.max(0, pos));
  }

  /** Start at `when` (ctx time), from `offset` seconds, at a tempo ratio. */
  start(when: number, offset: number, rate = 1) {
    if (!this.buffer) return;
    this.stop();
    const safeOffset = Math.max(0, Math.min(this.buffer.duration - 0.05, offset));
    this.src = this.ctx.createBufferSource();
    this.src.buffer = this.buffer;
    this.src.playbackRate.value = rate;

    if (this.loopBars > 0 && this.analysis) {
      const secPerBar = (60 / this.analysis.bpm) * 4;
      const loopLen = this.loopBars * secPerBar;
      this.src.loop = true;
      this.src.loopStart = safeOffset;
      this.src.loopEnd = Math.min(this.buffer.duration, safeOffset + loopLen);
    }

    this.src.connect(this.lowEq);
    this.src.start(when, safeOffset);
    this.startedAtCtx = when;
    this.startedOffset = safeOffset;
    this.currentRate = rate;
    this.isPlaying = true;
  }

  /** Adjusts playbackRate smoothly without restarting the buffer. */
  setRate(rate: number) {
    const now = this.ctx.currentTime;
    if (this.isPlaying) {
      this.startedOffset = this.currentOffset(now);
      this.startedAtCtx = now;
    }
    this.currentRate = rate;
    if (this.src) {
      this.src.playbackRate.setTargetAtTime(rate, now, 0.015);
    }
  }

  /** Toggles or sets quantized beat loop (0 = off, 0.5, 1, 2, 4, 8 bars). */
  setLoop(bars: number) {
    if (!this.buffer || !this.analysis) return;
    this.loopBars = this.loopBars === bars ? 0 : bars;
    const now = this.ctx.currentTime;
    if (this.isPlaying && this.src) {
      // Snap loop start to nearest beat
      const cur = this.currentOffset(now);
      const secPerBeat = 60 / this.analysis.bpm;
      const beatIdx = Math.round((cur - this.analysis.firstBeat) / secPerBeat);
      const snappedStart = Math.max(0, this.analysis.firstBeat + beatIdx * secPerBeat);
      this.start(now + 0.01, snappedStart, this.currentRate);
    }
  }

  /** Sets 3-band EQ gains in dB (-24 .. +6). */
  setEq(band: "low" | "mid" | "high", db: number) {
    const clamped = Math.max(-24, Math.min(6, db));
    const now = this.ctx.currentTime;
    if (band === "low") {
      this.lowDb = clamped;
      this.lowEq.gain.setTargetAtTime(clamped, now, 0.015);
    } else if (band === "mid") {
      this.midDb = clamped;
      this.midEq.gain.setTargetAtTime(clamped, now, 0.015);
    } else {
      this.highDb = clamped;
      this.highEq.gain.setTargetAtTime(clamped, now, 0.015);
    }
  }

  /** Sets bipolar Pioneer-style DJ Sound Color Filter (-1 = Low Pass, 0 = Bypass, +1 = High Pass). */
  setColorFilter(val: number) {
    this.colorValue = Math.max(-1, Math.min(1, val));
    const now = this.ctx.currentTime;
    if (Math.abs(this.colorValue) < 0.04) {
      this.colorFilter.type = "lowpass";
      this.colorFilter.frequency.setTargetAtTime(20000, now, 0.02);
      this.colorFilter.Q.setTargetAtTime(0.707, now, 0.02);
    } else if (this.colorValue < 0) {
      // -1 .. 0 maps exponentially from 140Hz to 18000Hz
      const norm = 1 + this.colorValue; // 0..1
      const freq = 140 * Math.pow(18000 / 140, norm);
      this.colorFilter.type = "lowpass";
      this.colorFilter.frequency.setTargetAtTime(freq, now, 0.02);
      this.colorFilter.Q.setTargetAtTime(2.4, now, 0.02);
    } else {
      // 0 .. +1 maps exponentially from 25Hz to 3600Hz
      const norm = this.colorValue; // 0..1
      const freq = 25 * Math.pow(3600 / 25, norm);
      this.colorFilter.type = "highpass";
      this.colorFilter.frequency.setTargetAtTime(freq, now, 0.02);
      this.colorFilter.Q.setTargetAtTime(2.4, now, 0.02);
    }
  }

  /** Reads instantaneous RMS level (0..1) from the deck's analyser node. */
  getLevel(): number {
    if (!this.isPlaying) return 0;
    const arr = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(arr);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = (arr[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / arr.length) * 2.6);
  }

  stop(when = 0) {
    try {
      this.src?.stop(when);
    } catch {
      // ignore if already stopped
    }
    if (when <= this.ctx.currentTime + 0.02) {
      this.src = undefined;
      this.isPlaying = false;
    }
  }
}
