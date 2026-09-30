import { extractWaveformAndCues } from "./analysis";
import type { TrackAnalysis } from "./types";

export class Deck {
  readonly out: GainNode;
  readonly dryGate: GainNode;
  readonly scratchIn: GainNode;
  readonly trimGain: GainNode;
  readonly pflTap: GainNode;
  readonly filter: BiquadFilterNode;
  readonly colorFilter: BiquadFilterNode;
  readonly lowEq: BiquadFilterNode;
  readonly midEq: BiquadFilterNode;
  readonly highEq: BiquadFilterNode;
  readonly analyser: AnalyserNode;

  buffer?: AudioBuffer;
  analysis?: TrackAnalysis;
  private originalChannels?: Float32Array[];
  modCount = 0;
  modRegions: Array<{ startSec: number; endSec: number; label: string }> = [];
  scratchOverrideOffset: number | null = null;
  private src?: AudioBufferSourceNode;

  // Live playback tracking so we can pause/resume, pitch-shift, loop, and beat-jump seamlessly
  private startedAtCtx = 0;
  private startedOffset = 0;
  private currentRate = 1;
  private isPlaying = false;

  // Per-deck channel volume & pitch slider state
  channelVolume = 1.0; // 0..1 channel fader level
  pitchPct = 0;        // -8..+8 manual pitch slider %

  // EQ, Kill switches, Trim & Color Filter state
  lowDb = 0;
  midDb = 0;
  highDb = 0;
  lowKill = false;
  midKill = false;
  highKill = false;
  autoGainDb = 0;
  manualTrimDb = 0;
  colorValue = 0; // -1 (Low-Pass) .. 0 (Flat) .. +1 (High-Pass)
  loopBars = 0;   // 0 = off, 0.25, 0.5, 1, 2, 4, 8, 16
  lastLoopBars = 4;

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

    this.dryGate = ctx.createGain();
    this.dryGate.gain.value = 1;

    this.scratchIn = ctx.createGain();
    this.scratchIn.gain.value = 1;

    this.trimGain = ctx.createGain();
    this.trimGain.gain.value = 1;

    this.pflTap = ctx.createGain();
    this.pflTap.gain.value = 0.85;

    this.out = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.72;

    this.dryGate.connect(this.trimGain);
    this.scratchIn.connect(this.trimGain);
    this.trimGain.connect(this.lowEq);
    this.lowEq.connect(this.midEq);
    this.midEq.connect(this.highEq);
    this.highEq.connect(this.colorFilter);
    this.colorFilter.connect(this.filter);
    this.filter.connect(this.pflTap);
    this.filter.connect(this.out);
    this.out.connect(this.analyser);
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  get rate(): number {
    return this.currentRate;
  }

  load(buffer: AudioBuffer, analysis: TrackAnalysis, autoGainEnabled = true) {
    this.stop();
    this.buffer = buffer;
    this.originalChannels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
      new Float32Array(buffer.getChannelData(c))
    );
    this.modCount = 0;
    this.modRegions = [];
    this.scratchOverrideOffset = null;
    this.analysis = analysis;
    this.loopBars = 0;
    this.startedOffset = analysis.firstBeat ?? 0;
    this.currentRate = 1;
    this.pitchPct = 0;
    this.autoGainDb = analysis.autoGainDb ?? 0;
    this.dryGate.gain.setValueAtTime(1, this.ctx.currentTime);
    this.applyTrimGain(autoGainEnabled);
  }

  /**
   * Permanently splices/modifies a rendered scratch buffer directly into this Deck's loaded
   * AudioBuffer starting at `anchorSec` (with 4ms raised-cosine boundary crossfades),
   * recomputes the 3-band waveform so the modification is visible on the waveform display.
   */
  spliceScratchIntoTrack(
    anchorSec: number,
    scratchBuf: AudioBuffer,
    gateTimeline?: Float32Array,
    label = "SCRATCH"
  ): boolean {
    if (!this.buffer || !this.analysis) return false;
    const sr = this.buffer.sampleRate;
    const startSample = Math.max(0, Math.min(this.buffer.length - 1, Math.floor(anchorSec * sr)));
    const writeLen = Math.min(scratchBuf.length, this.buffer.length - startSample);
    if (writeLen <= 64) return false;

    const fadeSamples = Math.min(Math.floor(0.004 * sr), Math.floor(writeLen * 0.2));
    const numCh = this.buffer.numberOfChannels;

    for (let c = 0; c < numCh; c++) {
      const dst = this.buffer.getChannelData(c);
      const src = scratchBuf.getChannelData(Math.min(c, scratchBuf.numberOfChannels - 1));
      for (let i = 0; i < writeLen; i++) {
        let edgeWin = 1.0;
        if (i < fadeSamples) {
          edgeWin = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeSamples);
        } else if (i >= writeLen - fadeSamples) {
          edgeWin = 0.5 - 0.5 * Math.cos((Math.PI * (writeLen - 1 - i)) / fadeSamples);
        }
        // If a gateTimeline is provided (e.g. Answer-pocket 90s Agent), replace dry audio whenever scratch gate is active
        const gateWeight =
          gateTimeline && i < gateTimeline.length
            ? Math.min(1, Math.max(0, gateTimeline[i] * 1.25))
            : 1.0;
        const wet = edgeWin * gateWeight;
        dst[startSample + i] = dst[startSample + i] * (1 - wet) + src[i] * wet;
      }
    }

    this.modCount++;
    const actualStartSec = startSample / sr;
    const actualEndSec = (startSample + writeLen) / sr;
    this.modRegions.push({
      startSec: actualStartSec,
      endSec: actualEndSec,
      label,
    });
    const refreshed = extractWaveformAndCues(
      this.buffer,
      this.analysis.bpm,
      this.analysis.firstBeat
    );
    this.analysis.waveform = refreshed.waveform;
    return true;
  }

  /** Restores the deck's AudioBuffer back to its unmodified original PCM samples. */
  restoreOriginalBuffer(): boolean {
    if (!this.buffer || !this.originalChannels || !this.analysis) return false;
    for (let c = 0; c < this.buffer.numberOfChannels; c++) {
      const orig = this.originalChannels[c];
      if (orig) {
        this.buffer.getChannelData(c).set(orig);
      }
    }
    this.modCount = 0;
    this.modRegions = [];
    const refreshed = extractWaveformAndCues(
      this.buffer,
      this.analysis.bpm,
      this.analysis.firstBeat
    );
    this.analysis.waveform = refreshed.waveform;
    if (this.isPlaying) {
      const now = this.ctx.currentTime;
      this.start(now + 0.006, this.rawOffset(now), this.currentRate);
    }
    return true;
  }

  applyTrimGain(autoGainEnabled = true) {
    const totalDb = (autoGainEnabled ? this.autoGainDb : 0) + this.manualTrimDb;
    const linear = Math.pow(10, Math.max(-18, Math.min(9, totalDb)) / 20);
    this.trimGain.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.015);
  }

  setManualTrim(db: number, autoGainEnabled = true) {
    this.manualTrimDb = Math.max(-12, Math.min(6, db));
    this.applyTrimGain(autoGainEnabled);
  }

  /** Computes current track playback position in seconds (reflects live vinyl scratch groove position when scratching). */
  currentOffset(now = this.ctx.currentTime): number {
    if (!this.buffer) return 0;
    if (this.scratchOverrideOffset !== null) {
      return Math.min(this.buffer.duration, Math.max(0, this.scratchOverrideOffset));
    }
    return this.rawOffset(now);
  }

  /** Computes underlying unscratched slip-mat playback position in seconds. */
  rawOffset(now = this.ctx.currentTime): number {
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
  start(when: number, offset: number, rate = this.currentRate || 1) {
    if (!this.buffer) return;
    this.stopNodeOnly();
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

    this.src.connect(this.dryGate);
    this.src.start(when, safeOffset);
    this.startedAtCtx = when;
    this.startedOffset = safeOffset;
    this.currentRate = rate;
    this.isPlaying = true;
  }

  /** Pauses deck playback while preserving exact playhead offset for instant resume. */
  pause(now = this.ctx.currentTime) {
    if (this.isPlaying) {
      this.startedOffset = this.currentOffset(now);
    }
    this.stopNodeOnly();
    this.isPlaying = false;
  }

  /** Seeks to an exact offset (in seconds) whether the deck is playing or paused/cued. */
  seek(offsetSec: number, now = this.ctx.currentTime) {
    if (!this.buffer) return;
    const clamped = Math.max(0, Math.min(this.buffer.duration - 0.05, offsetSec));
    if (this.isPlaying) {
      this.start(now + 0.01, clamped, this.currentRate);
    } else {
      this.startedOffset = clamped;
    }
  }

  /** Adjusts playbackRate smoothly without restarting the buffer. */
  setRate(rate: number) {
    const safeRate = Math.max(0.25, Math.min(3.0, rate));
    const now = this.ctx.currentTime;
    if (this.isPlaying) {
      this.startedOffset = this.currentOffset(now);
      this.startedAtCtx = now;
    }
    this.currentRate = safeRate;
    this.pitchPct = +((safeRate - 1) * 100).toFixed(2);
    if (this.src) {
      this.src.playbackRate.setTargetAtTime(safeRate, now, 0.015);
    }
  }

  /**
   * Executes a sample-accurate turntable motor power-down spindown followed by high-torque
   * direct-drive spin-up recovery on the active AudioBufferSourceNode.
   */
  vinylBrake(now = this.ctx.currentTime, brakeSec = 0.45, recoverSec = 0.22) {
    if (!this.src || !this.isPlaying) return;
    const baseRate = this.currentRate;
    const minRate = 0.035;
    this.src.playbackRate.cancelScheduledValues(now);
    this.src.playbackRate.setValueAtTime(baseRate, now);
    this.src.playbackRate.exponentialRampToValueAtTime(minRate, now + brakeSec);
    this.src.playbackRate.linearRampToValueAtTime(baseRate, now + brakeSec + recoverSec);
    // Analytical integral of exponential spindown + linear recovery to keep playhead offset accurate
    const lostWallSec =
      brakeSec * (1 - (1 - minRate / baseRate) / Math.log(baseRate / minRate)) +
      recoverSec * 0.48;
    this.startedAtCtx += lostWallSec;
  }

  /** Toggles or sets quantized beat loop (0 = off, 0.125 .. 16 bars). */
  setLoop(bars: number, forceEnable = false) {
    if (!this.buffer || !this.analysis) return;
    if (!forceEnable && this.loopBars === bars) {
      this.loopBars = 0;
    } else {
      this.loopBars = bars;
      if (bars > 0) this.lastLoopBars = bars;
    }
    this.applyLoopState();
  }

  /** Halves active loop length (down to 1/8 bar stutter roll). */
  halveLoop() {
    if (!this.buffer || !this.analysis) return;
    const base = this.loopBars > 0 ? this.loopBars : this.lastLoopBars;
    this.loopBars = Math.max(0.125, base * 0.5);
    this.lastLoopBars = this.loopBars;
    this.applyLoopState();
  }

  /** Doubles active loop length (up to 16 bars). */
  doubleLoop() {
    if (!this.buffer || !this.analysis) return;
    const base = this.loopBars > 0 ? this.loopBars : this.lastLoopBars;
    this.loopBars = Math.min(16, base * 2);
    this.lastLoopBars = this.loopBars;
    this.applyLoopState();
  }

  private applyLoopState() {
    if (!this.buffer || !this.analysis) return;
    const now = this.ctx.currentTime;
    if (this.isPlaying && this.src) {
      const cur = this.currentOffset(now);
      const secPerBeat = 60 / this.analysis.bpm;
      const beatIdx = Math.round((cur - this.analysis.firstBeat) / secPerBeat);
      const snappedStart = Math.max(0, this.analysis.firstBeat + beatIdx * secPerBeat);
      this.start(now + 0.01, snappedStart, this.currentRate);
    }
  }

  /** Sets 3-band EQ gains in dB (-24 .. +6) and respects isolator Kill switches. */
  setEq(band: "low" | "mid" | "high", db: number) {
    const clamped = Math.max(-24, Math.min(6, db));
    if (band === "low") this.lowDb = clamped;
    else if (band === "mid") this.midDb = clamped;
    else this.highDb = clamped;
    this.applyEqBand(band);
  }

  /** Toggles isolator Kill (-48 dB cut) on Low, Mid, or High EQ band. */
  toggleEqKill(band: "low" | "mid" | "high"): boolean {
    if (band === "low") this.lowKill = !this.lowKill;
    else if (band === "mid") this.midKill = !this.midKill;
    else this.highKill = !this.highKill;
    this.applyEqBand(band);
    return band === "low" ? this.lowKill : band === "mid" ? this.midKill : this.highKill;
  }

  private applyEqBand(band: "low" | "mid" | "high") {
    const now = this.ctx.currentTime;
    if (band === "low") {
      this.lowEq.gain.setTargetAtTime(this.lowKill ? -48 : this.lowDb, now, 0.012);
    } else if (band === "mid") {
      this.midEq.gain.setTargetAtTime(this.midKill ? -48 : this.midDb, now, 0.012);
    } else {
      this.highEq.gain.setTargetAtTime(this.highKill ? -48 : this.highDb, now, 0.012);
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
      const norm = 1 + this.colorValue; // 0..1
      const freq = 140 * Math.pow(18000 / 140, norm);
      this.colorFilter.type = "lowpass";
      this.colorFilter.frequency.setTargetAtTime(freq, now, 0.02);
      this.colorFilter.Q.setTargetAtTime(2.4, now, 0.02);
    } else {
      const norm = this.colorValue; // 0..1
      const freq = 25 * Math.pow(3600 / 25, norm);
      this.colorFilter.type = "highpass";
      this.colorFilter.frequency.setTargetAtTime(freq, now, 0.02);
      this.colorFilter.Q.setTargetAtTime(2.4, now, 0.02);
    }
  }

  /** Reads instantaneous RMS level (0..1) from the deck's analyser node (including live vinyl scratch signal). */
  getLevel(): number {
    if (!this.isPlaying && this.scratchOverrideOffset === null) return 0;
    const arr = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(arr);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = (arr[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / arr.length) * 2.6);
  }

  private stopNodeOnly() {
    try {
      this.src?.stop();
    } catch {
      // ignore if already stopped
    }
    this.src = undefined;
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
