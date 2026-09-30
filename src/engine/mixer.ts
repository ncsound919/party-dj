import { Deck } from "./deck";
import { analyze } from "./analysis";
import { runTransition } from "./transitions";
import { evaluateHarmonicMatch, nextBarTime, nextBeatTime, pickRate } from "./sync";
import {
  BATTLE_CUT_SLICES,
  createTurntablistCutBuffer,
  evaluateScratchTrajectory,
  findNearestTransientAnchor,
  renderScratchBuffer,
  resolveBattleCutAnchor,
  sampleKaiserSinc,
  SCRATCH_PATTERNS,
} from "./scratch";
import {
  applyHeadroom,
  buildSliceBank,
  evaluate,
  eventToPrimitive,
  gridFromBpm,
  llmDirector,
  MAIN_SRC,
  maxSpan,
  mergeBanks,
  renderTimeline,
  rulesDirectorFn,
  runScratchAgent,
  sentenceDirectorFn,
  sourceStart,
} from "../scratch-agent";
import type {
  DirectorFn,
  Placed,
  PrimitiveName,
  RunResult,
  ScratchConfig,
  SliceBank,
  Style,
} from "../scratch-agent";
import type {
  BattleSampleId,
  CrossfaderCurve,
  CuePoints,
  MasterBusTelemetry,
  ScratchCutMode,
  ScratchPatternId,
  ScratchQuantizeMode,
  ScratchSourceMode,
  ScratchTelemetry,
  TrackAnalysis,
  TransitionPreset,
} from "./types";

export type NextResult =
  | { ok: true; rate: number; clamped: boolean; harmonicLabel: string }
  | { ok: false; reason: string };

export type ScratchArchetypeId = "premier" | "philly" | "bombsquad" | "custom";

export interface AgentTriggerOptions {
  bars: 2 | 4;
  style: Style;
  placementMode: "hook" | "answer" | "sentence";
  seed: number;
  archetype?: ScratchArchetypeId;
  sentenceWords?: (string | number)[];
  sentencePrimitive?: "baby" | "stab";
  swing?: number;
  startBar?: number;
  withHook?: boolean;
  previewOnly?: boolean;
  useLlm?: boolean;
  llmUrl?: string;
  llmModel?: string;
}

export interface AgentTriggerOutput {
  ok: boolean;
  message: string;
  result?: RunResult;
  bank?: SliceBank;
  sourceBuffer?: AudioBuffer;
  scratchBuffer?: AudioBuffer;
}

/** Downmixes an AudioBuffer to peak-normalized mono Float32Array (gate-click threshold assumes peak 1). */
function extractNormalizedMono(b: AudioBuffer): Float32Array {
  const out = new Float32Array(b.length);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const ch = b.getChannelData(c);
    for (let i = 0; i < b.length; i++) out[i] += ch[i] / b.numberOfChannels;
  }
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const abs = Math.abs(out[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 0) {
    for (let i = 0; i < out.length; i++) out[i] /= peak;
  }
  return out;
}

/** Two pro decks + Smart Transition Engine + 90s Scratch Agent System + Turntable Autoscratch. */
export class Mixer {
  ctx = new AudioContext();
  masterGain = this.ctx.createGain();
  subsonicFilter = this.ctx.createBiquadFilter();
  masterLimiter = this.ctx.createDynamicsCompressor();
  masterAnalyser = this.ctx.createAnalyser();
  private splitMerger = this.ctx.createChannelMerger(2);
  private cueBusGain = this.ctx.createGain();

  decks = [new Deck(this.ctx), new Deck(this.ctx)];
  active = 0;
  playing = false;

  // Club & Marathon Bus Settings
  autoGainEnabled = true;
  splitCueEnabled = false;
  auditioningSlot: 0 | 1 | null = null;

  // Live Set Recorder & Mic Talkover State
  private recDest?: MediaStreamAudioDestinationNode;
  private mediaRecorder?: MediaRecorder;
  private recChunks: Blob[] = [];
  private recStartedAtMs = 0;
  recordingActive = false;

  private micStream?: MediaStream;
  private micSource?: MediaStreamAudioSourceNode;
  private micFilter?: BiquadFilterNode;
  private micGain?: GainNode;
  micActive = false;

  private anchor = 0;       // ctx time of a beat on the active deck (bar grid anchor)
  private effBpm = 124;     // tempo actually heard on the active deck (bpm * playbackRate)
  private busyUntil = 0;    // ctx time the running transition ends
  private fadeStart = 0;    // ctx time the running transition begins (bar-aligned)
  private prev = { deck: 0, anchor: 0, eff: 124 }; // outgoing deck, audible until fadeStart

  // Crossfader (-1 = Deck A, 0 = Center, +1 = Deck B) & Curve
  crossfader = -1;
  crossfaderCurve: CrossfaderCurve = "blend";
  private manualCrossfaderOverride = false;

  // Scratch state & Precision Controls
  scratchSourceMode: ScratchSourceMode = "vinyl";
  scratchIntensity = 1.0;
  scratchQuantize: ScratchQuantizeMode = "1/16";
  scratchCutMode: ScratchCutMode = "mag-four";
  battleSampleId: BattleSampleId = "auto";
  commitTrackMod = true; // When true, scratches permanently splice into the deck's AudioBuffer & update waveform
  private cutSampleBuffer?: AudioBuffer;
  private scratchNode?: AudioBufferSourceNode;
  private scratchGain: GainNode;
  private activeScratch: {
    patternId: ScratchPatternId | "agent";
    patternName: string;
    deck: 0 | 1;
    startAt: number;
    endAt: number;
    totalBeats: number;
    secPerBeat: number;
    anchorSec: number;
    deckInsertSec: number;
    cutSampleLabel: string;
    curveSamples: Float32Array;
    gateSamples: Float32Array;
    velSamples?: Float32Array;
  } | null = null;

  // Manual platter drag scratch state (Phase-coherent stereo Kaiser-sinc + M44-7 stylus state + live PCM capture)
  private manualScratch: {
    deck: 0 | 1;
    velocity: number;
    displacement: number;
    lastGrainAt: number;
    startOffsetSec: number;
    playheadSec: number;
    styL1: number;
    styL2: number;
    styR1: number;
    styR2: number;
    captureL: Float32Array;
    captureR: Float32Array;
    capturedSamples: number;
    sampleRate: number;
    curveSamples: Float32Array;
    gateSamples: Float32Array;
  } | null = null;

  constructor() {
    this.masterGain.gain.value = 0.92;

    // 26 Hz high-pass subsonic rumble filter for club PA protection
    this.subsonicFilter.type = "highpass";
    this.subsonicFilter.frequency.value = 26;
    this.subsonicFilter.Q.value = 0.707;

    // Fast club brickwall master limiter (-1.5 dBFS ceiling)
    this.masterLimiter.threshold.value = -1.5;
    this.masterLimiter.knee.value = 2.0;
    this.masterLimiter.ratio.value = 16.0;
    this.masterLimiter.attack.value = 0.002;
    this.masterLimiter.release.value = 0.09;

    this.masterAnalyser.fftSize = 256;
    this.masterAnalyser.smoothingTimeConstant = 0.75;

    this.masterGain.connect(this.subsonicFilter);
    this.subsonicFilter.connect(this.masterLimiter);
    this.masterLimiter.connect(this.masterAnalyser);
    this.masterLimiter.connect(this.ctx.destination);

    // Pre-fader Cue Bus for Split-Cue (Left = Master PA, Right = Headphone Cue)
    this.cueBusGain.gain.value = 0.9;
    this.decks[0].pflTap.connect(this.cueBusGain);
    this.decks[1].pflTap.connect(this.cueBusGain);

    this.decks.forEach(d => d.out.connect(this.masterGain));
    this.decks[1].out.gain.value = 0;

    this.scratchGain = this.ctx.createGain();
    this.scratchGain.gain.value = 1.0;
    this.scratchGain.connect(this.masterGain);
  }

  /** Recomputes beat-grid anchor from a deck's current offset so bar/beat phase never drifts. */
  private reanchorFromDeck(slot: 0 | 1, refTime = this.ctx.currentTime) {
    const d = this.decks[slot];
    if (!d.analysis) return;
    const offset = d.currentOffset(refTime);
    const nativeBeatSec = 60 / d.analysis.bpm;
    const beatsElapsed = (offset - d.analysis.firstBeat) / nativeBeatSec;
    const effBeatSec = 60 / this.effBpm;
    this.anchor = refTime - beatsElapsed * effBeatSec;
  }

  /** Evaluates crossfader gain pair [gainA, gainB] for position [-1..+1] and selected curve. */
  computeCrossfaderGains(pos = this.crossfader, curve = this.crossfaderCurve): [number, number] {
    const clamped = Math.max(-1, Math.min(1, pos));
    const norm = (clamped + 1) * 0.5; // 0 = full A, 1 = full B
    if (curve === "cut") {
      // Sharp turntablist cut: opens to 100% within 12% travel from either edge
      const gA = norm > 0.88 ? Math.max(0, (1 - norm) / 0.12) : 1;
      const gB = norm < 0.12 ? Math.max(0, norm / 0.12) : 1;
      return [gA, gB];
    }
    if (curve === "dip") {
      return [1 - norm, norm];
    }
    // Default "blend" equal-power curve
    return [Math.cos((norm * Math.PI) / 2), Math.sin((norm * Math.PI) / 2)];
  }

  /** Applies combined Channel Volume Fader * Crossfader Curve gains to both decks. */
  applyFaderGains() {
    if (this.busy) return;
    const now = this.ctx.currentTime;
    const [xfA, xfB] = this.computeCrossfaderGains();
    const gA = this.decks[0].channelVolume * xfA;
    const gB = this.decks[1].channelVolume * xfB;
    this.decks[0].out.gain.setTargetAtTime(gA, now, 0.015);
    this.decks[1].out.gain.setTargetAtTime(gB, now, 0.015);
  }

  /** Sets per-deck Channel Volume Fader (0..1). */
  setDeckChannelVolume(slot: 0 | 1, volume01: number) {
    this.decks[slot].channelVolume = Math.max(0, Math.min(1, volume01));
    this.applyFaderGains();
  }

  /** Sets Crossfader Curve ("blend" | "dip" | "cut"). */
  setCrossfaderCurve(curve: CrossfaderCurve) {
    this.crossfaderCurve = curve;
    this.applyFaderGains();
  }

  /** Toggles automatic RMS loudness matching (-11.5 dBFS club target) across both decks. */
  setAutoGain(enabled: boolean) {
    this.autoGainEnabled = enabled;
    this.decks[0].applyTrimGain(enabled);
    this.decks[1].applyTrimGain(enabled);
  }

  /**
   * Toggles Club Split-Cue Output (Left = Master PA, Right = Pre-Fader Cued Deck)
   * for DJs monitoring with a TRS Y-splitter cable.
   */
  setSplitCue(enabled: boolean) {
    if (this.splitCueEnabled === enabled) return;
    this.splitCueEnabled = enabled;
    this.masterLimiter.disconnect();
    this.cueBusGain.disconnect();
    this.splitMerger.disconnect();

    this.masterLimiter.connect(this.masterAnalyser);
    if (this.recDest) {
      this.masterLimiter.connect(this.recDest);
    }
    if (enabled) {
      this.masterLimiter.connect(this.splitMerger, 0, 0); // Left = Master
      this.cueBusGain.connect(this.splitMerger, 0, 1);    // Right = Cue PFL
      this.splitMerger.connect(this.ctx.destination);
      this.updatePflRouting();
    } else {
      this.masterLimiter.connect(this.ctx.destination);
    }
  }

  private updatePflRouting() {
    const cueSlot = this.auditioningSlot ?? this.idle;
    const now = this.ctx.currentTime;
    this.decks[0].pflTap.gain.setTargetAtTime(cueSlot === 0 ? 0.9 : 0, now, 0.015);
    this.decks[1].pflTap.gain.setTargetAtTime(cueSlot === 1 ? 0.9 : 0, now, 0.015);
  }

  /** Starts or stops pre-fader headphone auditioning on the specified deck. */
  toggleCueAudition(slot: 0 | 1): boolean {
    const d = this.decks[slot];
    if (!d.buffer || !d.analysis) return false;
    if (this.auditioningSlot === slot) {
      this.auditioningSlot = null;
      if (slot !== this.active && !this.busy && !this.manualCrossfaderOverride) {
        d.pause();
      }
      this.updatePflRouting();
      return false;
    }
    this.auditioningSlot = slot;
    if (!this.splitCueEnabled) {
      this.setSplitCue(true);
    } else {
      this.updatePflRouting();
    }
    if (!d.playing && !this.busy) {
      d.out.gain.setValueAtTime(0, this.ctx.currentTime);
      const offset =
        d.currentOffset() > 0.5
          ? d.currentOffset()
          : d.analysis.cuePoints?.drop ?? d.analysis.firstBeat;
      const rate = this.playing ? pickRate(this.effBpm, d.analysis.bpm).rate : 1;
      d.start(this.ctx.currentTime + 0.02, offset, rate);
    }
    return true;
  }

  /**
   * Toggles live microphone talkover with a 110Hz high-pass vocal filter and automatic
   * -10dB master music ducking for party announcements.
   */
  async toggleMicTalkover(): Promise<{ ok: boolean; active: boolean; message: string }> {
    if (this.micActive) {
      this.micSource?.disconnect();
      this.micFilter?.disconnect();
      this.micGain?.disconnect();
      this.micStream?.getTracks().forEach(t => t.stop());
      this.micStream = undefined;
      this.micSource = undefined;
      this.micActive = false;
      this.masterGain.gain.setTargetAtTime(0.92, this.ctx.currentTime, 0.08);
      return { ok: true, active: false, message: "Mic Talkover Off - Master PA level restored" };
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      return { ok: false, active: false, message: "Microphone API not available in this browser" };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      await this.ctx.resume();
      this.micStream = stream;
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micFilter = this.ctx.createBiquadFilter();
      this.micFilter.type = "highpass";
      this.micFilter.frequency.value = 110;
      this.micGain = this.ctx.createGain();
      this.micGain.gain.value = 1.15;

      this.micSource.connect(this.micFilter);
      this.micFilter.connect(this.micGain);
      // Connect post-masterGain into masterLimiter so music ducks while voice stays clear
      this.micGain.connect(this.masterLimiter);
      this.masterGain.gain.setTargetAtTime(0.28, this.ctx.currentTime, 0.06);
      this.micActive = true;
      return {
        ok: true,
        active: true,
        message: "Mic Talkover Live - Music ducked -10dB (110Hz Vocal HPF active)",
      };
    } catch {
      return { ok: false, active: false, message: "Microphone permission declined or unavailable" };
    }
  }

  /** Starts or stops live master bus audio recording via MediaStreamDestination + MediaRecorder. */
  async toggleRecording(): Promise<{
    ok: boolean;
    recording: boolean;
    blob?: Blob;
    ext?: string;
    message: string;
  }> {
    if (this.recordingActive && this.mediaRecorder) {
      return new Promise(resolve => {
        const rec = this.mediaRecorder!;
        const mime = rec.mimeType || "audio/webm";
        const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "webm";
        rec.onstop = () => {
          const blob = new Blob(this.recChunks, { type: mime });
          this.recChunks = [];
          this.recordingActive = false;
          this.mediaRecorder = undefined;
          resolve({
            ok: true,
            recording: false,
            blob,
            ext,
            message: `Saved live set recording (${Math.max(1, Math.round(blob.size / 1024))} KB .${ext})`,
          });
        };
        rec.stop();
      });
    }

    if (typeof MediaRecorder === "undefined") {
      return { ok: false, recording: false, message: "MediaRecorder not supported in this browser" };
    }
    await this.ctx.resume();
    if (!this.recDest) {
      this.recDest = this.ctx.createMediaStreamDestination();
      this.masterLimiter.connect(this.recDest);
    }
    this.recChunks = [];
    const preferredTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
    const mimeType = preferredTypes.find(t => MediaRecorder.isTypeSupported(t)) || "";
    const rec = mimeType
      ? new MediaRecorder(this.recDest.stream, { mimeType })
      : new MediaRecorder(this.recDest.stream);

    rec.ondataavailable = e => {
      if (e.data && e.data.size > 0) this.recChunks.push(e.data);
    };
    rec.start(500);
    this.mediaRecorder = rec;
    this.recStartedAtMs = Date.now();
    this.recordingActive = true;
    return {
      ok: true,
      recording: true,
      message: "Live Set Recording Started - Capturing Master Bus Output",
    };
  }

  /** Returns live Master Bus Peak (dBFS), Brickwall Limiter Gain Reduction (dB), and routing flags. */
  getMasterTelemetry(): MasterBusTelemetry {
    const arr = new Uint8Array(this.masterAnalyser.fftSize);
    this.masterAnalyser.getByteTimeDomainData(arr);
    let pk = 1e-4;
    for (let i = 0; i < arr.length; i++) {
      const v = Math.abs((arr[i] - 128) / 128);
      if (v > pk) pk = v;
    }
    const masterPeakDb = this.playing ? +(20 * Math.log10(pk)).toFixed(1) : -60;
    const limiterReductionDb = this.playing ? +this.masterLimiter.reduction.toFixed(1) : 0;
    const recordingElapsedSec = this.recordingActive
      ? Math.max(0, Math.floor((Date.now() - this.recStartedAtMs) / 1000))
      : 0;
    return {
      masterPeakDb,
      limiterReductionDb,
      autoGainEnabled: this.autoGainEnabled,
      splitCueEnabled: this.splitCueEnabled,
      micActive: this.micActive,
      recordingActive: this.recordingActive,
      recordingElapsedSec,
    };
  }

  get idle() {
    return (1 - this.active) as 0 | 1;
  }

  /** True from pressing Next until the outgoing deck has fully faded out. */
  get busy() {
    return this.ctx.currentTime < this.busyUntil;
  }

  /** Returns the currently selected scratch source buffer (Direct Vinyl Track, Slip-Mat Track, Incoming Deck, or 90s Battle Hook). */
  getScratchSourceBuffer(): { buffer: AudioBuffer; bpm: number; firstBeat: number; targetDeck: 0 | 1 } {
    if (!this.cutSampleBuffer) {
      this.cutSampleBuffer = createTurntablistCutBuffer(this.ctx);
    }
    const activeDeckIdx = this.active as 0 | 1;
    const activeDeck = this.decks[activeDeckIdx];
    const idleDeck = this.decks[this.idle];
    const effBpm = this.playing ? this.effBpm : activeDeck.analysis?.bpm ?? 94;

    if ((this.scratchSourceMode === "vinyl" || this.scratchSourceMode === "slip") && activeDeck.buffer) {
      return {
        buffer: activeDeck.buffer,
        bpm: effBpm,
        firstBeat: activeDeck.analysis?.firstBeat ?? 0,
        targetDeck: activeDeckIdx,
      };
    }
    if (this.scratchSourceMode === "incoming" && idleDeck.buffer) {
      return {
        buffer: idleDeck.buffer,
        bpm: effBpm,
        firstBeat: idleDeck.analysis?.firstBeat ?? 0,
        targetDeck: this.idle,
      };
    }
    return {
      buffer: this.cutSampleBuffer,
      bpm: effBpm,
      firstBeat: 0.08,
      targetDeck: activeDeckIdx,
    };
  }

  /** Restores the specified deck's AudioBuffer back to its unmodified original audio samples. */
  restoreDeckOriginal(slot: 0 | 1 = this.active as 0 | 1): boolean {
    return this.decks[slot].restoreOriginalBuffer();
  }

  /** Encodes the specified deck's current AudioBuffer (including all baked/spliced scratch modifications) to a 16-bit stereo WAV. */
  exportDeckWav(slot: 0 | 1 = this.active as 0 | 1): { wavBytes: Uint8Array; modCount: number } | null {
    const d = this.decks[slot];
    if (!d.buffer) return null;
    const buf = d.buffer;
    const numCh = Math.min(2, buf.numberOfChannels);
    const numFrames = buf.length;
    const sr = buf.sampleRate;
    const bytesPerSample = 2;
    const blockAlign = numCh * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const view = new DataView(ab);

    const writeAscii = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeAscii(36, "data");
    view.setUint32(40, dataSize, true);

    const ch0 = buf.getChannelData(0);
    const ch1 = numCh > 1 ? buf.getChannelData(1) : ch0;
    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      const s0 = Math.max(-1, Math.min(1, ch0[i]));
      view.setInt16(offset, s0 < 0 ? s0 * 0x8000 : s0 * 0x7fff, true);
      offset += 2;
      if (numCh > 1) {
        const s1 = Math.max(-1, Math.min(1, ch1[i]));
        view.setInt16(offset, s1 < 0 ? s1 * 0x8000 : s1 * 0x7fff, true);
        offset += 2;
      }
    }
    return { wavBytes: new Uint8Array(ab), modCount: d.modCount };
  }

  /**
   * Executes the deterministic 90s Scratch Agent pipeline (`slicerLite` -> `rulesDirector`/`llmDirector`
   * -> `compose` -> Kaiser-windowed sinc `renderTimeline` -> `evaluate` Critic reroll loop) and schedules
   * the resulting scratch performance onto the live mixer timeline.
   */
  async triggerScratchAgent(opts: AgentTriggerOptions): Promise<AgentTriggerOutput> {
    if (!this.cutSampleBuffer) {
      this.cutSampleBuffer = createTurntablistCutBuffer(this.ctx);
    }
    const { buffer: sourceBuf, bpm, firstBeat, targetDeck } = this.getScratchSourceBuffer();
    const srcMono = extractNormalizedMono(sourceBuf);
    const cutMono = extractNormalizedMono(this.cutSampleBuffer);

    let mainBank = buildSliceBank(srcMono, sourceBuf.sampleRate, "main", {
      maxSliceS: 0.35,
      minGapS: 0.06,
      delta: 0.22,
    });

    if (mainBank.slices.filter(s => s.end - s.start >= 0.08 && s.end - s.start <= 0.4).length === 0) {
      // Retry onset detection with a more sensitive adaptive flux threshold
      mainBank = buildSliceBank(srcMono, sourceBuf.sampleRate, "main", {
        maxSliceS: 0.35,
        minGapS: 0.04,
        delta: 0.06,
      });
    }

    if (mainBank.slices.filter(s => s.end - s.start >= 0.08 && s.end - s.start <= 0.4).length === 0) {
      // Continuous pad/drone audio with no sharp log-flux peaks: measure real RMS energy across beat-aligned windows
      const sr = sourceBuf.sampleRate;
      const dur = sourceBuf.duration;
      const measuredWindows: Array<{ id: number; start: number; end: number; rms: number }> = [];
      for (let i = 0; i < 8; i++) {
        const st = Math.min(dur - 0.3, 0.1 + i * 0.32);
        const en = st + 0.22;
        if (st > 0 && en < dur) {
          const i0 = Math.floor(st * sr);
          const i1 = Math.floor(en * sr);
          let sumSq = 0;
          for (let k = i0; k < i1; k++) sumSq += srcMono[k] * srcMono[k];
          const rms = Math.sqrt(sumSq / Math.max(1, i1 - i0));
          if (rms > 1e-4) {
            measuredWindows.push({ id: measuredWindows.length, start: st, end: en, rms });
          }
        }
      }
      const maxRms = Math.max(1e-6, ...measuredWindows.map(w => w.rms));
      mainBank = {
        ...mainBank,
        slices: measuredWindows.map(w => ({
          id: w.id,
          start: w.start,
          end: w.end,
          kind: "transient" as const,
          text: null,
          energy: +(w.rms / maxRms).toFixed(3),
        })),
      };
    }

    // Weight main-track slices by proximity to the live playhead so the 90s Agent scratches the active musical section
    const targetDeckForProx = this.decks[targetDeck];
    if (this.scratchSourceMode !== "cut" && targetDeckForProx.buffer) {
      const liveSec = targetDeckForProx.rawOffset();
      mainBank = {
        ...mainBank,
        slices: mainBank.slices.map(s => {
          const dist = Math.abs(s.start - liveSec);
          const proxBoost = 1 + 0.45 * Math.exp(-dist / 5.0);
          return {
            ...s,
            energy: +Math.min(1, s.energy * proxBoost).toFixed(3),
          };
        }),
      };
    }

    const cutBank: SliceBank = {
      source_path: "cut",
      sr: sourceBuf.sampleRate,
      slices: BATTLE_CUT_SLICES.map((syl, idx) => ({
        id: idx,
        start: syl.start,
        end: syl.start + syl.len,
        kind: "word" as const,
        text: syl.text,
        energy: syl.energy,
      })),
      vocal_onsets: [],
    };

    const bank = mergeBanks([
      ["main", mainBank],
      ["cut", cutBank],
    ]);

    const swing =
      opts.swing !== undefined
        ? opts.swing
        : opts.archetype === "premier"
          ? 0.05
          : opts.archetype === "philly"
            ? 0
            : opts.archetype === "bombsquad"
              ? 0.11
              : 0.04;

    const grid = gridFromBpm(bpm, firstBeat, Math.max(sourceBuf.duration, 16), swing);

    const cfgOverrides: Partial<ScratchConfig> = {
      placement_mode: opts.placementMode,
      ramp_ms: this.scratchCutMode === "mag-four" ? 1.1 : 2.2,
    };
    if (opts.archetype === "premier") {
      cfgOverrides.jitter_ms = 3;
      cfgOverrides.stroke_beats = 0.5;
    } else if (opts.archetype === "philly") {
      cfgOverrides.jitter_ms = 1;
      cfgOverrides.stroke_beats = 0.25;
      cfgOverrides.transform_duty = 0.48;
    } else if (opts.archetype === "bombsquad") {
      cfgOverrides.jitter_ms = 8;
      cfgOverrides.stroke_beats = 1.0;
      cfgOverrides.max_slew = 90;
    }

    let director: DirectorFn;
    if (opts.placementMode === "sentence") {
      const words =
        opts.sentenceWords && opts.sentenceWords.length > 0
          ? opts.sentenceWords
          : ["check", "fresh", "cut", "now"];
      director = sentenceDirectorFn(
        {
          words,
          primitive: opts.sentencePrimitive ?? "baby",
          intensity: 0.85,
        },
        bank
      );
    } else if (opts.useLlm && opts.llmModel) {
      director = async (c, s) =>
        (
          await llmDirector(c, {
            llm_url: opts.llmUrl || "http://localhost:11434/v1/chat/completions",
            llm_model: opts.llmModel!,
            temperature: 0.7,
            seed: s,
          })
        ).plan;
    } else {
      director = rulesDirectorFn;
    }

    const phraseStartBeat = (opts.startBar ?? 0) * 4;
    const res = await runScratchAgent({
      src: srcMono,
      sources: { cut: cutMono },
      fs: sourceBuf.sampleRate,
      bank,
      grid,
      bars: opts.bars,
      style: opts.style,
      seed: opts.seed,
      director,
      phraseStartBeat,
      cfg: cfgOverrides,
    });

    const outBuf = this.buildStereoAgentBuffer(
      res.audio,
      res.rateTimeline,
      res.cfg.headroom_db,
      sourceBuf.sampleRate
    );

    const curveSamples = new Float32Array(128);
    const gateSamples = new Float32Array(128);
    const velSamples = new Float32Array(128);
    const phraseSamples = Math.max(
      1,
      Math.min(
        res.dispTimeline.length,
        Math.floor(opts.bars * 4 * (60 / bpm) * sourceBuf.sampleRate)
      )
    );
    const step = Math.max(1, Math.floor(phraseSamples / 128));
    for (let i = 0; i < 128; i++) {
      let peakDisp = 0;
      let peakVel = 0;
      let maxGate = 0;
      const base = i * step;
      for (let j = 0; j < step && base + j < phraseSamples; j++) {
        const dVal = res.dispTimeline[base + j] ?? 0;
        const vVal = res.rateTimeline[base + j] ?? 0;
        const gVal = res.gateTimeline[base + j] ?? 0;
        if (Math.abs(dVal) > Math.abs(peakDisp)) peakDisp = dVal;
        if (Math.abs(vVal) > Math.abs(peakVel)) peakVel = vVal;
        if (gVal > maxGate) maxGate = gVal;
      }
      curveSamples[i] = peakDisp;
      velSamples[i] = peakVel;
      gateSamples[i] = maxGate;
    }

    const statusTag = res.passed ? "Critic PASS" : "Critic WARN";
    if (opts.previewOnly) {
      return {
        ok: true,
        message: `Pre-staged ${statusTag} (Seed ${res.seed}) - ${res.events.length} events @ ${bpm.toFixed(0)} BPM`,
        result: res,
        bank,
        sourceBuffer: sourceBuf,
        scratchBuffer: outBuf,
      };
    }

    this.stopScratch();
    const now = this.ctx.currentTime;
    const secPerBeat = 60 / bpm;
    const quantizeStep =
      this.scratchQuantize === "1/16" ? secPerBeat * 0.25 : secPerBeat * 0.5;
    const startAt =
      !this.playing || this.scratchQuantize === "instant"
        ? now + 0.006
        : nextBeatTime(now, this.anchor, quantizeStep, 0.014);
    const phraseDur = opts.bars * 4 * secPerBeat;
    const endAt = startAt + phraseDur;

    const targetDeckObj = this.decks[targetDeck];
    const deckInsertSec = targetDeckObj.playing
      ? targetDeckObj.rawOffset(startAt)
      : targetDeckObj.currentOffset(now) > 0.2
        ? targetDeckObj.currentOffset(now)
        : (targetDeckObj.analysis?.cuePoints?.drop ?? targetDeckObj.analysis?.firstBeat ?? 0.5);

    // Gate the deck's dry signal during active scratch events so the scratch replaces the track audio instead of layering noise over it
    if (targetDeckObj.playing && !this.busy) {
      const closedDryGain =
        this.scratchSourceMode === "cut" && opts.withHook ? 0.22 : 0.0;
      targetDeckObj.dryGate.gain.cancelScheduledValues(now);
      targetDeckObj.dryGate.gain.setValueAtTime(1.0, Math.max(now, startAt - 0.004));
      if (res.events.length > 0) {
        for (const ev of res.events) {
          const evStart = startAt + ev.t0;
          const evEnd = Math.min(endAt, evStart + ev.n_strokes * ev.stroke_T);
          if (evEnd > evStart + 0.005) {
            targetDeckObj.dryGate.gain.setValueAtTime(1.0, Math.max(now, evStart - 0.003));
            targetDeckObj.dryGate.gain.linearRampToValueAtTime(closedDryGain, evStart + 0.003);
            targetDeckObj.dryGate.gain.setValueAtTime(closedDryGain, Math.max(evStart + 0.003, evEnd - 0.004));
            targetDeckObj.dryGate.gain.linearRampToValueAtTime(1.0, evEnd + 0.004);
          }
        }
      } else {
        targetDeckObj.dryGate.gain.linearRampToValueAtTime(closedDryGain, startAt + 0.006);
        targetDeckObj.dryGate.gain.setValueAtTime(closedDryGain, endAt - 0.008);
        targetDeckObj.dryGate.gain.linearRampToValueAtTime(1.0, endAt + 0.006);
      }
    }

    // Permanently splice the rendered 90s Scratch Agent phrase into the deck's AudioBuffer when MOD TRACK is enabled
    let modApplied = false;
    if (this.commitTrackMod && targetDeckObj.buffer) {
      modApplied = targetDeckObj.spliceScratchIntoTrack(
        deckInsertSec,
        outBuf,
        res.gateTimeline,
        `90S ${opts.archetype?.toUpperCase() ?? "AGENT"}`
      );
    }

    // Route through targetDeck.scratchIn so the deck's EQ, Color Filter, Channel Fader, and Crossfader shape the scratch
    const srcNode = this.ctx.createBufferSource();
    srcNode.buffer = outBuf;
    srcNode.connect(targetDeckObj.scratchIn);
    srcNode.start(startAt);
    srcNode.stop(endAt + res.cfg.tail_s);
    this.scratchNode = srcNode;

    this.activeScratch = {
      patternId: "agent",
      patternName: `90s Agent (${opts.bars}B ${opts.style} · Seed ${res.seed})`,
      deck: targetDeck,
      startAt,
      endAt,
      totalBeats: opts.bars * 4,
      secPerBeat,
      anchorSec: deckInsertSec,
      deckInsertSec,
      cutSampleLabel:
        this.scratchSourceMode === "cut"
          ? "90S BANK"
          : `${modApplied ? "MOD " : ""}TRACK @ ${deckInsertSec.toFixed(2)}s`,
      curveSamples,
      gateSamples,
      velSamples,
    };

    return {
      ok: true,
      message: `${statusTag} (Seed ${res.seed})${modApplied ? ` · Spliced into Deck ${targetDeck === 0 ? "A" : "B"} @ ${deckInsertSec.toFixed(2)}s` : ""} · ${res.events.length} events @ ${bpm.toFixed(0)} BPM`,
      result: res,
      bank,
      sourceBuffer: sourceBuf,
      scratchBuffer: outBuf,
    };
  }

  /** Synthesizes a 2-channel stereo AudioBuffer from a rendered 90s Scratch Agent phrase with velocity-coupled stereo width. */
  private buildStereoAgentBuffer(
    audio: Float64Array,
    rateTimeline: Float32Array,
    headroomDb: number,
    sr: number
  ): AudioBuffer {
    const pcm = applyHeadroom(audio, headroomDb);
    const outBuf = this.ctx.createBuffer(2, pcm.length, sr);
    const chL = outBuf.getChannelData(0);
    const chR = outBuf.getChannelData(1);
    const haasDelay = Math.max(1, Math.floor(0.00028 * sr));
    for (let i = 0; i < pcm.length; i++) {
      const mono = pcm[i];
      const delayed = i >= haasDelay ? pcm[i - haasDelay] : mono;
      const vel = rateTimeline[i] ?? 0;
      const pan = Math.tanh(vel * 0.24) * 0.24; // -0.24..+0.24 stereo platter motion
      const width = Math.min(0.22, Math.abs(vel) * 0.08);
      const side = (mono - delayed) * width;
      chL[i] = Math.max(-1, Math.min(1, mono * (1 - pan) + side));
      chR[i] = Math.max(-1, Math.min(1, mono * (1 + pan) - side));
    }
    return outBuf;
  }

  /**
   * Cycles the turntablist primitive of a single event (`eventIdx`) in a staged 90s Scratch Agent output,
   * re-renders the Kaiser-windowed sinc timeline, and re-evaluates all Critic QA checks in real time.
   */
  cycleScratchAgentEventPrimitive(
    prev: AgentTriggerOutput,
    eventIdx: number,
    dropLive = false
  ): AgentTriggerOutput | null {
    if (!prev.result || !prev.bank || !prev.sourceBuffer) return null;
    const res = prev.result;
    if (eventIdx < 0 || eventIdx >= res.events.length) return null;

    if (!this.cutSampleBuffer) {
      this.cutSampleBuffer = createTurntablistCutBuffer(this.ctx);
    }
    const sourceBuf = prev.sourceBuffer;
    const sr = sourceBuf.sampleRate;
    const srcMono = extractNormalizedMono(sourceBuf);
    const cutMono = extractNormalizedMono(this.cutSampleBuffer);
    const sources: Record<string, Float32Array> = { [MAIN_SRC]: srcMono, cut: cutMono };

    const cycleOrder: Exclude<PrimitiveName, "rest">[] = [
      "baby",
      "flare",
      "chirp",
      "stab",
      "cut_forward",
      "tear",
      "crab",
      "transform",
    ];

    const oldEv = res.events[eventIdx];
    const curIdx = cycleOrder.indexOf(oldEv.primitive as Exclude<PrimitiveName, "rest">);
    const nextPrim = cycleOrder[(curIdx + 1) % cycleOrder.length];

    const byId = new Map(prev.bank.slices.map(s => [s.id, s]));
    const slice = byId.get(oldEv.slice_id);
    if (!slice) return null;

    const totalDur = oldEv.n_strokes * oldEv.stroke_T;
    const s0 = sourceStart(slice, res.cfg);
    const srcArr = sources[slice.src_id ?? MAIN_SRC] ?? srcMono;
    const srcDur = srcArr.length / sr;
    const room = Math.max(0.005, srcDur - res.cfg.source_guard_s - s0);
    const sliceLen = slice.end - slice.start;

    let nStrokes = 1;
    if (
      nextPrim === "baby" ||
      nextPrim === "cut_forward" ||
      nextPrim === "flare" ||
      nextPrim === "chirp" ||
      nextPrim === "tear" ||
      nextPrim === "crab"
    ) {
      nStrokes = Math.max(2, oldEv.n_strokes);
      if (nextPrim === "tear" && nStrokes % 2 !== 0) nStrokes += 1;
    }
    const strokeT = totalDur / nStrokes;
    const maxSpanFactor = nextPrim === "tear" ? 0.82 : 1.0;
    const span = Math.min(sliceLen, maxSpan(strokeT, res.cfg.max_rate) * maxSpanFactor, room);
    const params: Record<string, number> = {
      ...oldEv.params,
      avg_rate: span / strokeT,
    };
    if (nextPrim === "transform") {
      params.n_chops = 4;
      params.duty = res.cfg.transform_duty;
    } else if (nextPrim === "flare") {
      params.clicks = 2;
    } else if (nextPrim === "crab") {
      params.fingers = 4;
    }

    const updatedEvents = res.events.map((e, i) =>
      i === eventIdx
        ? { ...e, primitive: nextPrim, n_strokes: nStrokes, stroke_T: strokeT, span, params }
        : e
    );

    const placed: Placed[] = updatedEvents.map(e => {
      const sl = byId.get(e.slice_id)!;
      const srcId = sl.src_id ?? MAIN_SRC;
      return {
        t0: e.t0,
        prim: eventToPrimitive(e),
        s0: sourceStart(sl, res.cfg),
        gain: e.params.gain ?? 0.8,
        src: sources[srcId] ?? srcMono,
      };
    });

    const srcLenByEvent = updatedEvents.map(e => {
      const sl = byId.get(e.slice_id)!;
      return (sources[sl.src_id ?? MAIN_SRC] ?? srcMono).length;
    });

    const bpm = this.playing ? this.effBpm : this.decks[this.active].analysis?.bpm ?? 94;
    const grid = gridFromBpm(bpm, 0.08, Math.max(sourceBuf.duration, 16), 0.04);
    const phraseEnd = updatedEvents.reduce(
      (mx, e) => Math.max(mx, e.t0 + e.n_strokes * e.stroke_T),
      res.plan.bars * 4 * (60 / bpm)
    );
    const totalSec = phraseEnd + res.cfg.tail_s;

    const { audio, rateTimeline, dispTimeline, gateTimeline, posSecTimeline, rendered } =
      renderTimeline(srcMono, sr, placed, totalSec, res.cfg);

    const report = evaluate({
      events: updatedEvents,
      audio,
      rendered,
      grid,
      style: res.plan.style,
      srcLenSamples: srcMono.length,
      srcLenByEvent,
      srcDuration: srcMono.length / sr,
      phraseStartTime: 0,
      cfg: res.cfg,
    });

    const updatedResult: RunResult = {
      ...res,
      audio,
      rateTimeline,
      dispTimeline,
      gateTimeline,
      posSecTimeline,
      events: updatedEvents,
      passed: report.passed,
      attempts: [
        ...res.attempts.slice(0, -1),
        {
          seed: res.seed,
          director: "given" as const,
          report,
          failing: report.checks.filter(c => !c.passed).map(c => c.name),
          cfgChanges: [],
        },
      ],
    };

    const outBuf = this.buildStereoAgentBuffer(audio, rateTimeline, res.cfg.headroom_db, sr);

    if (dropLive) {
      this.scheduleAndSpliceAgentOutput(updatedResult, outBuf, bpm);
    }

    return {
      ok: true,
      message: `Event #${eventIdx + 1} -> ${nextPrim.toUpperCase()} (${report.passed ? "Critic PASS" : "Critic WARN"})`,
      result: updatedResult,
      bank: prev.bank,
      sourceBuffer: sourceBuf,
      scratchBuffer: outBuf,
    };
  }

  /** Schedules a rendered 90s Scratch Agent buffer onto the active deck and splices it into the track AudioBuffer if MOD TRACK is ON. */
  scheduleAndSpliceAgentOutput(res: RunResult, outBuf: AudioBuffer, bpm: number) {
    this.stopScratch();
    const now = this.ctx.currentTime;
    const secPerBeat = 60 / bpm;
    const quantizeStep =
      this.scratchQuantize === "1/16" ? secPerBeat * 0.25 : secPerBeat * 0.5;
    const startAt =
      !this.playing || this.scratchQuantize === "instant"
        ? now + 0.006
        : nextBeatTime(now, this.anchor, quantizeStep, 0.014);
    const phraseDur = res.plan.bars * 4 * secPerBeat;
    const endAt = startAt + phraseDur;
    const targetDeck = this.active as 0 | 1;
    const targetDeckObj = this.decks[targetDeck];
    const deckInsertSec = targetDeckObj.playing
      ? targetDeckObj.rawOffset(startAt)
      : targetDeckObj.currentOffset(now) > 0.2
        ? targetDeckObj.currentOffset(now)
        : (targetDeckObj.analysis?.cuePoints?.drop ?? targetDeckObj.analysis?.firstBeat ?? 0.5);

    if (targetDeckObj.playing && !this.busy) {
      targetDeckObj.dryGate.gain.cancelScheduledValues(now);
      targetDeckObj.dryGate.gain.setValueAtTime(1.0, Math.max(now, startAt - 0.004));
      for (const ev of res.events) {
        const evStart = startAt + ev.t0;
        const evEnd = Math.min(endAt, evStart + ev.n_strokes * ev.stroke_T);
        if (evEnd > evStart + 0.005) {
          targetDeckObj.dryGate.gain.setValueAtTime(1.0, Math.max(now, evStart - 0.003));
          targetDeckObj.dryGate.gain.linearRampToValueAtTime(0.0, evStart + 0.003);
          targetDeckObj.dryGate.gain.setValueAtTime(0.0, Math.max(evStart + 0.003, evEnd - 0.004));
          targetDeckObj.dryGate.gain.linearRampToValueAtTime(1.0, evEnd + 0.004);
        }
      }
    }

    if (this.commitTrackMod && targetDeckObj.buffer) {
      targetDeckObj.spliceScratchIntoTrack(
        deckInsertSec,
        outBuf,
        res.gateTimeline,
        "90S CUSTOM"
      );
    }

    const srcNode = this.ctx.createBufferSource();
    srcNode.buffer = outBuf;
    srcNode.connect(targetDeckObj.scratchIn);
    srcNode.start(startAt);
    srcNode.stop(endAt + res.cfg.tail_s);
    this.scratchNode = srcNode;

    const curveSamples = new Float32Array(128);
    const gateSamples = new Float32Array(128);
    const velSamples = new Float32Array(128);
    const phraseSamples = Math.max(
      1,
      Math.min(res.dispTimeline.length, Math.floor(phraseDur * outBuf.sampleRate))
    );
    const step = Math.max(1, Math.floor(phraseSamples / 128));
    for (let i = 0; i < 128; i++) {
      let peakDisp = 0;
      let peakVel = 0;
      let maxGate = 0;
      const base = i * step;
      for (let j = 0; j < step && base + j < phraseSamples; j++) {
        const dVal = res.dispTimeline[base + j] ?? 0;
        const vVal = res.rateTimeline[base + j] ?? 0;
        const gVal = res.gateTimeline[base + j] ?? 0;
        if (Math.abs(dVal) > Math.abs(peakDisp)) peakDisp = dVal;
        if (Math.abs(vVal) > Math.abs(peakVel)) peakVel = vVal;
        if (gVal > maxGate) maxGate = gVal;
      }
      curveSamples[i] = peakDisp;
      velSamples[i] = peakVel;
      gateSamples[i] = maxGate;
    }

    this.activeScratch = {
      patternId: "agent",
      patternName: `90s Custom (${res.plan.bars}B · Seed ${res.seed})`,
      deck: targetDeck,
      startAt,
      endAt,
      totalBeats: res.plan.bars * 4,
      secPerBeat,
      anchorSec: deckInsertSec,
      deckInsertSec,
      cutSampleLabel: `CUSTOM @ ${deckInsertSec.toFixed(2)}s`,
      curveSamples,
      gateSamples,
      velSamples,
    };
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

    if (now >= this.fadeStart && now < this.busyUntil) {
      const targetPos = this.active === 0 ? -1 : 1;
      const startPos = -targetPos;
      this.crossfader = startPos + (targetPos - startPos) * fade;
    } else if (!queued && !this.manualCrossfaderOverride) {
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
    this.decks[slot].load(buf, analyzed, this.autoGainEnabled);
    return analyzed;
  }

  /** Resumes or starts master playback from the active deck's current offset (never resets to 0 unless at track end). */
  play() {
    const d = this.decks[this.active];
    if (!d.analysis || !d.buffer) return false;
    const when = this.ctx.currentTime + 0.03;
    let resumeOffset = d.currentOffset();
    if (resumeOffset >= d.buffer.duration - 0.5 || resumeOffset <= 0) {
      resumeOffset = d.analysis.firstBeat;
    }
    const rate = d.rate > 0 ? d.rate : 1;
    this.effBpm = +(d.analysis.bpm * rate).toFixed(2);
    this.manualCrossfaderOverride = false;
    this.crossfader = this.active === 0 ? -1 : 1;

    d.out.gain.cancelScheduledValues(0);
    d.out.gain.setValueAtTime(d.channelVolume, when);
    this.decks[this.idle].out.gain.cancelScheduledValues(0);
    this.decks[this.idle].out.gain.setValueAtTime(0, when);

    d.start(when, resumeOffset, rate);
    this.playing = true;
    this.reanchorFromDeck(this.active as 0 | 1, when);
    return true;
  }

  /** Pauses all playing decks while preserving their exact playhead offsets. */
  pause() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    this.decks[0].pause(now);
    this.decks[1].pause(now);
    this.stopScratch();
    this.playing = false;
  }

  /** Starts or pauses an individual deck (A or B) for manual DJ mixing. */
  toggleDeckPlay(slot: 0 | 1): boolean {
    const d = this.decks[slot];
    if (!d.buffer || !d.analysis) return false;
    const now = this.ctx.currentTime;

    if (d.playing) {
      d.pause(now);
      const otherSlot = (1 - slot) as 0 | 1;
      if (this.decks[otherSlot].playing) {
        this.active = otherSlot;
        this.reanchorFromDeck(otherSlot, now);
      } else {
        this.playing = false;
      }
      return false;
    }

    let offset = d.currentOffset(now);
    if (offset >= d.buffer.duration - 0.5 || offset <= 0) {
      offset = d.analysis.firstBeat;
    }
    const otherSlot = (1 - slot) as 0 | 1;
    const otherDeck = this.decks[otherSlot];

    if (!this.playing || !otherDeck.playing) {
      this.active = slot;
      const rate = d.rate > 0 ? d.rate : 1;
      this.effBpm = +(d.analysis.bpm * rate).toFixed(2);
      this.crossfader = slot === 0 ? -1 : 1;
      this.manualCrossfaderOverride = false;
      d.start(now + 0.02, offset, rate);
      this.playing = true;
      this.applyFaderGains();
      this.reanchorFromDeck(slot, now + 0.02);
      return true;
    }

    // Other deck is already playing: start this deck beat-aligned to the master beat grid
    const rate = d.rate > 0 ? d.rate : pickRate(this.effBpm, d.analysis.bpm).rate;
    const secPerBeat = 60 / this.effBpm;
    const startAt = nextBeatTime(now, this.anchor, secPerBeat, 0.015);
    d.start(startAt, offset, rate);
    this.applyFaderGains();
    return true;
  }

  /** Syncs `slot`'s BPM and beat phase to the opposing deck (or resets to native if alone). */
  syncDeck(slot: 0 | 1): { syncedBpm: number; pct: number } {
    const d = this.decks[slot];
    const otherSlot = (1 - slot) as 0 | 1;
    const other = this.decks[otherSlot];
    if (!d.analysis || !d.buffer) return { syncedBpm: this.effBpm, pct: 0 };

    const targetBpm =
      other.playing && other.analysis
        ? other.analysis.bpm * other.rate
        : this.playing
          ? this.effBpm
          : other.analysis?.bpm ?? d.analysis.bpm;

    const { rate, effBpm } = pickRate(targetBpm, d.analysis.bpm);
    d.setRate(rate);

    if (slot === this.active) {
      this.effBpm = effBpm;
      this.reanchorFromDeck(slot);
    } else if (d.playing && other.playing && other.analysis) {
      // Snap incoming deck's beat phase to match the master deck's beat phase
      const now = this.ctx.currentTime;
      const masterBeatSec = 60 / this.effBpm;
      const masterBeatPhase = (((now - this.anchor) / masterBeatSec) % 1 + 1) % 1;
      const curOff = d.currentOffset(now);
      const deckBeatSec = 60 / d.analysis.bpm;
      const deckBeats = (curOff - d.analysis.firstBeat) / deckBeatSec;
      const snappedBeats = Math.floor(deckBeats) + masterBeatPhase;
      const alignedOffset = Math.max(0, d.analysis.firstBeat + snappedBeats * deckBeatSec);
      d.seek(alignedOffset, now);
    }

    return { syncedBpm: effBpm, pct: d.pitchPct };
  }

  /** Adjusts a single deck's pitch slider (-8% .. +8%). */
  setDeckPitchPct(slot: 0 | 1, pct: number): number {
    const d = this.decks[slot];
    if (!d.analysis) return 0;
    const clampedPct = Math.max(-8, Math.min(8, pct));
    const rate = 1 + clampedPct / 100;
    d.setRate(rate);
    const newBpm = +(d.analysis.bpm * rate).toFixed(2);
    if (slot === this.active) {
      this.effBpm = newBpm;
      this.reanchorFromDeck(slot);
    }
    return newBpm;
  }

  /** Manual crossfader override (-1 = Deck A, +1 = Deck B). */
  setCrossfader(pos: number) {
    this.crossfader = Math.max(-1, Math.min(1, pos));
    this.manualCrossfaderOverride = true;
    if (this.busy) return;

    // If master is playing and user blends into the idle deck, auto-start the idle deck beat-locked if paused
    if (this.playing) {
      const [xfA, xfB] = this.computeCrossfaderGains(this.crossfader);
      if (xfA > 0.03 && !this.decks[0].playing && this.decks[0].buffer) {
        this.toggleDeckPlay(0);
      }
      if (xfB > 0.03 && !this.decks[1].playing && this.decks[1].buffer) {
        this.toggleDeckPlay(1);
      }
      if (this.crossfader < -0.65 && this.decks[0].playing) {
        this.active = 0;
      } else if (this.crossfader > 0.65 && this.decks[1].playing) {
        this.active = 1;
      }
    }
    this.applyFaderGains();
  }

  /** Quantized jump to a structural cue point or arbitrary time on a deck. */
  seekDeck(slot: 0 | 1, targetSeconds: number) {
    const d = this.decks[slot];
    if (!d.buffer || !d.analysis) return;
    const clamped = Math.max(0, Math.min(d.buffer.duration - 0.2, targetSeconds));
    const secPerBeat = 60 / d.analysis.bpm;
    const beatIdx = Math.round((clamped - d.analysis.firstBeat) / secPerBeat);
    const snappedOffset = Math.max(0, d.analysis.firstBeat + beatIdx * secPerBeat);
    const now = this.ctx.currentTime;

    d.seek(snappedOffset, now);
    if (slot === this.active && this.playing) {
      this.reanchorFromDeck(slot, now + 0.01);
    }
  }

  /** Continuous unquantized playhead seek (for hardware MIDI scrub encoders and needle pots). */
  seekDeckContinuous(slot: 0 | 1, targetSeconds: number): number {
    const d = this.decks[slot];
    if (!d.buffer) return 0;
    const clamped = Math.max(0, Math.min(d.buffer.duration - 0.05, targetSeconds));
    const now = this.ctx.currentTime;
    d.seek(clamped, now);
    if (slot === this.active && this.playing) {
      this.reanchorFromDeck(slot, now + 0.01);
    }
    return clamped;
  }

  /** Nudges a deck's playhead continuously forward or backward by `deltaSeconds` (outer jog wheel ring). */
  nudgePlayhead(slot: 0 | 1, deltaSeconds: number): number {
    const d = this.decks[slot];
    if (!d.buffer) return 0;
    const now = this.ctx.currentTime;
    const cur = d.currentOffset(now);
    return this.seekDeckContinuous(slot, cur + deltaSeconds);
  }

  /** Jumps forward or backward by `deltaBeats` (e.g. -16, -4, +4, +16 beats) on `slot`. */
  beatJump(slot: 0 | 1, deltaBeats: number): number {
    const d = this.decks[slot];
    if (!d.buffer || !d.analysis) return 0;
    const now = this.ctx.currentTime;
    const cur = d.currentOffset(now);
    const secPerBeat = 60 / d.analysis.bpm;
    const target = Math.max(0, Math.min(d.buffer.duration - 0.2, cur + deltaBeats * secPerBeat));
    this.seekDeck(slot, target);
    return d.currentOffset(now);
  }

  /** Sets/overwrites a Hot Cue pad (`intro` | `drop` | `breakdown` | `outro`) at the current beat-snapped playhead. */
  setHotCue(slot: 0 | 1, cueKey: keyof CuePoints): number | null {
    const d = this.decks[slot];
    if (!d.buffer || !d.analysis) return null;
    const cur = d.currentOffset();
    const secPerBeat = 60 / d.analysis.bpm;
    const beatIdx = Math.round((cur - d.analysis.firstBeat) / secPerBeat);
    const snapped = +Math.max(0, Math.min(d.buffer.duration - 0.2, d.analysis.firstBeat + beatIdx * secPerBeat)).toFixed(2);
    if (!d.analysis.cuePoints) {
      d.analysis.cuePoints = { intro: snapped, drop: snapped, breakdown: snapped, outro: snapped };
    } else {
      d.analysis.cuePoints[cueKey] = snapped;
    }
    return snapped;
  }

  /** Adjusts master tempo BPM directly (shifts active deck rate proportionally and preserves beat phase). */
  setMasterBpm(targetBpm: number) {
    const clampedBpm = Math.max(70, Math.min(175, targetBpm));
    this.effBpm = clampedBpm;
    const d = this.decks[this.active];
    if (d.analysis) {
      const rate = clampedBpm / d.analysis.bpm;
      d.setRate(rate);
      if (this.playing) {
        this.reanchorFromDeck(this.active as 0 | 1);
      }
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
    const secPerBar = (60 / this.effBpm) * 4;
    const startAt = nextBarTime(this.ctx.currentTime, this.anchor, secPerBar);

    for (const p of [from.out.gain, to.out.gain, from.filter.frequency, to.filter.frequency]) {
      p.cancelScheduledValues(0);
    }
    to.out.gain.setValueAtTime(0, this.ctx.currentTime);
    to.filter.frequency.setValueAtTime(10, this.ctx.currentTime);
    from.out.gain.setValueAtTime(from.channelVolume, this.ctx.currentTime);

    const startOffset = to.analysis.cuePoints?.intro ?? to.analysis.firstBeat;
    to.start(startAt, startOffset, rate);
    const end = runTransition(from, to, preset, startAt, secPerBar);
    from.stop(end + 0.1);

    const match = evaluateHarmonicMatch(from.analysis?.key, to.analysis.key);

    this.prev = { deck: this.active, anchor: this.anchor, eff: this.effBpm };
    this.fadeStart = startAt;
    this.busyUntil = end;
    this.active = this.idle;
    this.manualCrossfaderOverride = false;
    this.auditioningSlot = null;
    if (this.splitCueEnabled) this.updatePflRouting();
    this.anchor = startAt;
    this.effBpm = effBpm;
    return { ok: true, rate, clamped, harmonicLabel: match.label };
  }

  /**
   * Triggers a beat-quantized bidirectional Autoscratch routine (Pads 1-8).
   */
  triggerAutoscratch(patternId: ScratchPatternId): { ok: boolean; message: string } {
    const activeDeckIdx = this.active as 0 | 1;
    const activeDeck = this.decks[activeDeckIdx];
    const idleDeck = this.decks[this.idle];

    if (!this.cutSampleBuffer) {
      this.cutSampleBuffer = createTurntablistCutBuffer(this.ctx);
    }

    if (!this.playing && activeDeck.buffer) {
      this.play();
    }

    const now = this.ctx.currentTime;
    const effBpm = this.playing ? this.effBpm : activeDeck.analysis?.bpm ?? 124;
    const secPerBeat = 60 / effBpm;
    const pattern = SCRATCH_PATTERNS.find(p => p.id === patternId) ?? SCRATCH_PATTERNS[0];

    const quantizeStep =
      this.scratchQuantize === "1/16" ? secPerBeat * 0.25 : secPerBeat * 0.5;
    const startAt =
      !this.playing || this.scratchQuantize === "instant"
        ? now + 0.004
        : nextBeatTime(now, this.anchor, quantizeStep, 0.012);

    let sourceBuf: AudioBuffer = this.cutSampleBuffer;
    let sourceAnchorSec = 0.42;
    let cutSampleLabel = "FRESH";
    let targetDeckIdx: 0 | 1 = activeDeckIdx;

    if ((this.scratchSourceMode === "vinyl" || this.scratchSourceMode === "slip") && activeDeck.buffer) {
      sourceBuf = activeDeck.buffer;
      const rawOffset = activeDeck.rawOffset(startAt);
      sourceAnchorSec = findNearestTransientAnchor(
        sourceBuf.getChannelData(0),
        sourceBuf.sampleRate,
        rawOffset,
        0.32
      );
      cutSampleLabel = `${this.scratchSourceMode === "vinyl" ? "VINYL" : "SLIP"} @ ${sourceAnchorSec.toFixed(2)}s`;
      targetDeckIdx = activeDeckIdx;
    } else if (this.scratchSourceMode === "incoming" && idleDeck.buffer) {
      sourceBuf = idleDeck.buffer;
      const rawDrop = idleDeck.analysis?.cuePoints?.drop ?? idleDeck.analysis?.firstBeat ?? 1.0;
      sourceAnchorSec = findNearestTransientAnchor(
        sourceBuf.getChannelData(0),
        sourceBuf.sampleRate,
        rawDrop,
        0.4
      );
      cutSampleLabel = `DECK B @ ${sourceAnchorSec.toFixed(2)}s`;
      targetDeckIdx = this.idle;
    } else {
      sourceBuf = this.cutSampleBuffer;
      const resolved = resolveBattleCutAnchor(patternId, this.battleSampleId);
      sourceAnchorSec = resolved.start;
      cutSampleLabel = `"${resolved.label}"`;
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
      this.scratchIntensity,
      this.scratchCutMode
    );

    const endAt = startAt + rendered.duration;
    const targetDeck = this.decks[targetDeckIdx];
    const deckInsertSec =
      this.scratchSourceMode === "vinyl" || this.scratchSourceMode === "slip" || this.scratchSourceMode === "incoming"
        ? sourceAnchorSec
        : targetDeck.playing
          ? targetDeck.rawOffset(startAt)
          : targetDeck.currentOffset(now);

    // Silence the deck's dry forward stream during the scratch so the warped vinyl groove replaces it instead of layering
    if (targetDeck.playing && !this.busy) {
      const duckLevel = this.scratchSourceMode === "cut" ? 0.14 : 0.0;
      targetDeck.dryGate.gain.cancelScheduledValues(now);
      targetDeck.dryGate.gain.setValueAtTime(1.0, Math.max(now, startAt - 0.003));
      targetDeck.dryGate.gain.linearRampToValueAtTime(duckLevel, startAt + 0.003);
      targetDeck.dryGate.gain.setValueAtTime(duckLevel, Math.max(startAt + 0.003, endAt - 0.004));
      targetDeck.dryGate.gain.linearRampToValueAtTime(1.0, endAt + 0.004);
    }

    // Permanently splice the rendered scratch audio into the deck's AudioBuffer when MOD TRACK is enabled
    let modApplied = false;
    if (this.commitTrackMod && targetDeck.buffer) {
      let gateTimeline: Float32Array | undefined;
      if (this.scratchSourceMode === "cut") {
        // When splicing a vocal cut into the track, only replace samples where the crossfader gate is open
        gateTimeline = new Float32Array(rendered.buffer.length);
        for (let i = 0; i < gateTimeline.length; i++) {
          const gIdx = Math.min(127, Math.floor((i / gateTimeline.length) * 128));
          gateTimeline[i] = rendered.gateSamples[gIdx];
        }
      }
      modApplied = targetDeck.spliceScratchIntoTrack(
        deckInsertSec,
        rendered.buffer,
        gateTimeline,
        pattern.name.toUpperCase()
      );
    }

    // Route through targetDeck.scratchIn so the deck's 3-Band EQ, Color Filter, Channel Fader, and Crossfader shape the scratch
    const src = this.ctx.createBufferSource();
    src.buffer = rendered.buffer;
    src.connect(targetDeck.scratchIn);
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
      anchorSec: sourceAnchorSec,
      deckInsertSec,
      cutSampleLabel: modApplied ? `MOD ${cutSampleLabel}` : cutSampleLabel,
      curveSamples: rendered.curveSamples,
      gateSamples: rendered.gateSamples,
    };

    const qTag = this.scratchQuantize === "instant" ? "INSTANT" : `${this.scratchQuantize} SNAP`;
    const cutTag = this.scratchCutMode === "mag-four" ? "MAG-FOUR" : "SMOOTH";
    const modTag = modApplied ? ` · Spliced into Deck ${targetDeckIdx === 0 ? "A" : "B"}` : "";
    return {
      ok: true,
      message: `${pattern.name} · ${cutSampleLabel}${modTag} (${qTag} · ${cutTag} @ ${effBpm.toFixed(0)} BPM)`,
    };
  }

  stopScratch() {
    try {
      this.scratchNode?.stop();
    } catch {
      // ignore
    }
    this.scratchNode = undefined;
    const now = this.ctx.currentTime;
    for (const d of this.decks) {
      d.scratchOverrideOffset = null;
      d.dryGate.gain.cancelScheduledValues(now);
      d.dryGate.gain.setTargetAtTime(1.0, now, 0.004);
    }
    if (this.activeScratch && this.playing && !this.busy) {
      this.applyFaderGains();
    }
    this.activeScratch = null;
  }

  /** Interactive manual vinyl scratching when the user drags the turntable platter (Slip-Mat/Vinyl + Kaiser-Sinc + M44-7 + Track Splice). */
  startManualScratch(deckIdx: 0 | 1) {
    this.stopScratch();
    if (!this.cutSampleBuffer) {
      this.cutSampleBuffer = createTurntablistCutBuffer(this.ctx);
    }
    const d = this.decks[deckIdx];
    const srcBuf = d.buffer ?? this.cutSampleBuffer;
    const rawSec = d.buffer ? d.rawOffset() : 0.42;
    const snappedAnchor = findNearestTransientAnchor(
      srcBuf.getChannelData(0),
      srcBuf.sampleRate,
      rawSec,
      0.22
    );
    // Physically stop the dry forward track while the DJ's hand holds the vinyl platter
    const now = this.ctx.currentTime;
    d.dryGate.gain.cancelScheduledValues(now);
    d.dryGate.gain.setTargetAtTime(0.0, now, 0.004);
    d.scratchOverrideOffset = snappedAnchor;

    const maxCaptureSamples = Math.floor(srcBuf.sampleRate * 12); // Up to 12 seconds of continuous manual platter scratch capture
    this.manualScratch = {
      deck: deckIdx,
      velocity: 0,
      displacement: 0,
      lastGrainAt: 0,
      startOffsetSec: snappedAnchor,
      playheadSec: snappedAnchor,
      styL1: 0,
      styL2: 0,
      styR1: 0,
      styR2: 0,
      captureL: new Float32Array(maxCaptureSamples),
      captureR: new Float32Array(maxCaptureSamples),
      capturedSamples: 0,
      sampleRate: srcBuf.sampleRate,
      curveSamples: new Float32Array(128),
      gateSamples: new Float32Array(128).fill(1),
    };
  }

  moveManualScratch(velocity: number) {
    if (!this.manualScratch) return;
    const clampedVel = Math.max(-3.6, Math.min(3.6, velocity));
    // Smooth velocity slightly to model direct-drive platter rotational inertia
    this.manualScratch.velocity = this.manualScratch.velocity * 0.25 + clampedVel * 0.75;
    const effVel = this.manualScratch.velocity;
    this.manualScratch.displacement += effVel * 0.014;

    this.manualScratch.curveSamples.copyWithin(0, 1);
    this.manualScratch.curveSamples[127] = Math.max(-1.5, Math.min(1.5, this.manualScratch.displacement));
    this.manualScratch.gateSamples.copyWithin(0, 1);
    this.manualScratch.gateSamples[127] = Math.abs(effVel) > 0.04 ? 1 : 0;

    const now = this.ctx.currentTime;
    const grainHopSec = 0.022; // 22ms hop with 46ms Hann-windowed grain (>50% phase-coherent overlap)
    if (now - this.manualScratch.lastGrainAt >= grainHopSec && Math.abs(effVel) > 0.04) {
      const dt = Math.min(0.045, Math.max(0.012, now - this.manualScratch.lastGrainAt));
      this.manualScratch.lastGrainAt = now;
      if (!this.cutSampleBuffer) {
        this.cutSampleBuffer = createTurntablistCutBuffer(this.ctx);
      }
      const d = this.decks[this.manualScratch.deck];
      const srcBuf = d.buffer ?? this.cutSampleBuffer;
      const sr = srcBuf.sampleRate;
      const grainDur = 0.046;
      const samples = Math.floor(grainDur * sr);
      const grain = this.ctx.createBuffer(2, samples, sr);
      const outL = grain.getChannelData(0);
      const outR = grain.getChannelData(1);
      const inpL = srcBuf.getChannelData(0);
      const inpR = srcBuf.numberOfChannels > 1 ? srcBuf.getChannelData(1) : inpL;

      const minSample = 0.02 * sr;
      const maxSample = Math.max(minSample + sr * 0.1, (srcBuf.duration - 0.02) * sr);
      let exactPos = Math.max(minSample, Math.min(maxSample, this.manualScratch.playheadSec * sr));

      // Advance playhead over the hop interval so consecutive grains stay phase-continuous
      this.manualScratch.playheadSec = Math.max(
        0.03,
        Math.min(srcBuf.duration - 0.05, this.manualScratch.playheadSec + effVel * dt)
      );
      d.scratchOverrideOffset = this.manualScratch.playheadSec;

      // 2-pole Shure M44-7 stylus presence resonator (~2.85 kHz vinyl groove bite)
      const styR = Math.exp((-Math.PI * 950) / sr);
      const styC1 = 2 * styR * Math.cos((2 * Math.PI * 2850) / sr);
      const styC2 = -(styR * styR);
      const styA0 = 1 - styR;
      let { styL1, styL2, styR1, styR2 } = this.manualScratch;
      const speedAbs = Math.abs(effVel);
      const stylusPresence = Math.min(0.75, speedAbs * 0.28);

      const hopSamples = Math.floor(dt * sr);
      const capStart = this.manualScratch.capturedSamples;
      const capL = this.manualScratch.captureL;
      const capR = this.manualScratch.captureR;

      for (let i = 0; i < samples; i++) {
        exactPos = Math.max(minSample, Math.min(maxSample, exactPos + effVel));
        const rawL = sampleKaiserSinc(inpL, exactPos, speedAbs);
        const rawR = sampleKaiserSinc(inpR, exactPos, speedAbs);

        const sOutL = styA0 * rawL + styC1 * styL1 + styC2 * styL2;
        styL2 = styL1;
        styL1 = sOutL;
        const sOutR = styA0 * rawR + styC1 * styR1 + styC2 * styR2;
        styR2 = styR1;
        styR1 = sOutR;

        // Hann window for seamless constant-amplitude overlap-add
        const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (samples - 1));
        const voicedL = Math.tanh((rawL + sOutL * stylusPresence) * 1.25) * 0.92;
        const voicedR = Math.tanh((rawR + sOutR * stylusPresence) * 1.25) * 0.92;
        const sL = voicedL * win;
        const sR = voicedR * win;
        outL[i] = sL;
        outR[i] = sR;

        if (capStart + i < capL.length) {
          capL[capStart + i] += sL;
          capR[capStart + i] += sR;
        }
      }

      this.manualScratch.capturedSamples = Math.min(
        capL.length - samples,
        capStart + Math.max(1, hopSamples)
      );
      this.manualScratch.styL1 = styL1;
      this.manualScratch.styL2 = styL2;
      this.manualScratch.styR1 = styR1;
      this.manualScratch.styR2 = styR2;

      const node = this.ctx.createBufferSource();
      node.buffer = grain;
      node.connect(d.scratchIn);
      node.start(now);
    }
  }

  endManualScratch(): { spliced: boolean; deck: 0 | 1; playheadSec: number } | null {
    if (!this.manualScratch) return null;
    const ms = this.manualScratch;
    const d = this.decks[ms.deck];
    const now = this.ctx.currentTime;
    d.scratchOverrideOffset = null;
    d.dryGate.gain.cancelScheduledValues(now);
    d.dryGate.gain.setTargetAtTime(1.0, now, 0.006);

    let spliced = false;
    if (this.commitTrackMod && d.buffer && ms.capturedSamples > Math.floor(0.06 * ms.sampleRate)) {
      const totalWrite = Math.min(ms.captureL.length, ms.capturedSamples + Math.floor(0.02 * ms.sampleRate));
      const capturedBuf = this.ctx.createBuffer(2, totalWrite, ms.sampleRate);
      capturedBuf.getChannelData(0).set(ms.captureL.subarray(0, totalWrite));
      capturedBuf.getChannelData(1).set(ms.captureR.subarray(0, totalWrite));
      spliced = d.spliceScratchIntoTrack(ms.startOffsetSec, capturedBuf, undefined, "PLATTER SCRUB");
    }

    // In direct VINYL mode, releasing the record resumes playback from the exact new scrubbed groove position
    if (this.scratchSourceMode === "vinyl" && d.buffer) {
      d.seek(ms.playheadSec, now);
      if (ms.deck === this.active && this.playing) {
        this.reanchorFromDeck(ms.deck, now + 0.01);
      }
    }

    if (this.playing && !this.busy) {
      this.applyFaderGains();
    }
    this.manualScratch = null;
    return { spliced, deck: ms.deck, playheadSec: ms.playheadSec };
  }

  /** Returns live 60fps scratch telemetry for platter rotation, waveform needle scrubbing & oscilloscope rendering. */
  scratchTelemetry(): ScratchTelemetry {
    if (this.manualScratch) {
      const d = this.decks[this.manualScratch.deck];
      d.scratchOverrideOffset = this.manualScratch.playheadSec;
      return {
        active: true,
        patternId: "manual",
        patternName: "Manual Vinyl Scrub (Kaiser-Sinc + M44-7)",
        deck: this.manualScratch.deck,
        progress: 0.5,
        velocity: this.manualScratch.velocity,
        displacement: this.manualScratch.displacement,
        faderOpen: Math.abs(this.manualScratch.velocity) > 0.04,
        faderGain: 1,
        anchorSec: this.manualScratch.startOffsetSec,
        headSec: this.manualScratch.playheadSec,
        cutSampleLabel: `VINYL @ ${this.manualScratch.playheadSec.toFixed(2)}s`,
        trackModCount: d.modCount,
        curveSamples: this.manualScratch.curveSamples,
        gateSamples: this.manualScratch.gateSamples,
      };
    }

    const s = this.activeScratch;
    const now = this.ctx.currentTime;
    if (!s || now > s.endAt) {
      if (s && now > s.endAt) {
        const finishedDeck = this.decks[s.deck];
        finishedDeck.scratchOverrideOffset = null;
        // If a Backspin finished in direct VINYL mode, physically rewind the playing deck by 1 bar
        if (s.patternId === "backspin" && this.scratchSourceMode === "vinyl" && finishedDeck.playing) {
          this.beatJump(s.deck, -4);
        }
        this.activeScratch = null;
      }
      const activeDeckObj = this.decks[this.active];
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
        trackModCount: activeDeckObj.modCount,
        curveSamples: new Float32Array(128),
        gateSamples: new Float32Array(128).fill(1),
      };
    }

    if (now < s.startAt) {
      return {
        active: true,
        patternId: s.patternId === "agent" ? null : s.patternId,
        patternName: `${s.patternName} (${this.scratchQuantize} Lock)`,
        deck: s.deck,
        progress: 0,
        velocity: 1,
        displacement: 0,
        faderOpen: true,
        faderGain: 1,
        anchorSec: s.anchorSec,
        headSec: s.anchorSec,
        cutSampleLabel: s.cutSampleLabel,
        trackModCount: this.decks[s.deck].modCount,
        curveSamples: s.curveSamples,
        gateSamples: s.gateSamples,
      };
    }

    const elapsed = now - s.startAt;
    const duration = Math.max(0.01, s.endAt - s.startAt);
    const progress = Math.max(0, Math.min(1, elapsed / duration));
    const scopeIdx = Math.min(127, Math.floor(progress * 128));
    const targetDeckObj = this.decks[s.deck];

    if (s.patternId === "agent") {
      const disp = s.curveSamples[scopeIdx] ?? 0;
      const g = s.gateSamples[scopeIdx] ?? 0;
      const vel = s.velSamples?.[scopeIdx] ?? (this.playing ? 1 : 0);
      const headSec = Math.max(0, s.deckInsertSec + elapsed + disp * 0.35);
      if (this.scratchSourceMode !== "cut") {
        targetDeckObj.scratchOverrideOffset = headSec;
      }
      return {
        active: true,
        patternId: "agent",
        patternName: s.patternName,
        deck: s.deck,
        progress,
        velocity: vel,
        displacement: disp,
        faderOpen: g > 0.25,
        faderGain: g,
        anchorSec: s.anchorSec,
        headSec,
        cutSampleLabel: s.cutSampleLabel,
        trackModCount: targetDeckObj.modCount,
        curveSamples: s.curveSamples,
        gateSamples: s.gateSamples,
      };
    }

    const beatPos = elapsed / s.secPerBeat;
    const { velocity, faderGain } = evaluateScratchTrajectory(
      s.patternId,
      beatPos,
      s.totalBeats,
      this.scratchIntensity,
      this.scratchCutMode
    );
    const displacement = s.curveSamples[scopeIdx] ?? 0;
    const headSec = Math.max(0, s.anchorSec + displacement * s.secPerBeat);
    if (this.scratchSourceMode !== "cut") {
      targetDeckObj.scratchOverrideOffset = headSec;
    }

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
      anchorSec: s.anchorSec,
      headSec,
      cutSampleLabel: s.cutSampleLabel,
      trackModCount: targetDeckObj.modCount,
      curveSamples: s.curveSamples,
      gateSamples: s.gateSamples,
    };
  }

  /** Synthesizes club FX one-shots synced to the master BPM using sample-accurate WebAudio automation. */
  triggerClubFX(fxId: "dub-siren" | "sub-drop" | "laser-riser" | "vinyl-brake") {
    const now = this.ctx.currentTime;
    const secPerBeat = 60 / this.effBpm;

    if (fxId === "vinyl-brake") {
      const d = this.decks[this.active];
      const brakeSec = secPerBeat * 0.72;
      const recoverSec = secPerBeat * 0.28;
      if (this.playing && d.playing) {
        d.vinylBrake(now, brakeSec, recoverSec);
        this.anchor = now + brakeSec + recoverSec;
        return;
      }
      // If deck is paused, synthesize an audible turntable spindown chord
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(28, now + brakeSec);
      g.gain.setValueAtTime(0.28, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + brakeSec);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + brakeSec);
      return;
    }

    const osc = this.ctx.createOscillator();
    const flt = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    osc.connect(flt);
    flt.connect(gain);
    gain.connect(this.masterGain);

    if (fxId === "dub-siren") {
      osc.type = "sawtooth";
      flt.type = "bandpass";
      flt.frequency.value = 1350;
      flt.Q.value = 2.8;
      const dur = secPerBeat * 2;
      for (let i = 0; i < 8; i++) {
        const t = now + (i * dur) / 8;
        osc.frequency.setValueAtTime(i % 2 === 0 ? 580 : 880, t);
      }
      gain.gain.setValueAtTime(0.26, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

      // 3/16th beat dub echo tail
      const delay = this.ctx.createDelay(1.0);
      const fb = this.ctx.createGain();
      delay.delayTime.value = Math.min(0.95, secPerBeat * 0.75);
      fb.gain.value = 0.36;
      gain.connect(delay);
      delay.connect(fb);
      fb.connect(delay);
      delay.connect(this.masterGain);

      osc.start(now);
      osc.stop(now + dur);
    } else if (fxId === "sub-drop") {
      osc.type = "sine";
      flt.type = "lowpass";
      flt.frequency.value = 180;
      const dur = secPerBeat * 3;
      osc.frequency.setValueAtTime(135, now);
      osc.frequency.exponentialRampToValueAtTime(32, now + dur);
      gain.gain.setValueAtTime(0.58, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.start(now);
      osc.stop(now + dur);
    } else if (fxId === "laser-riser") {
      osc.type = "sawtooth";
      flt.type = "lowpass";
      flt.Q.value = 4.5;
      const dur = secPerBeat * 2;
      osc.frequency.setValueAtTime(190, now);
      osc.frequency.exponentialRampToValueAtTime(2400, now + dur);
      flt.frequency.setValueAtTime(380, now);
      flt.frequency.exponentialRampToValueAtTime(5200, now + dur);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.linearRampToValueAtTime(0.28, now + dur * 0.88);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.start(now);
      osc.stop(now + dur);
    }
  }
}
