export interface BuiltInTrackSpec {
  id: string;
  title: string;
  artist: string;
  genre: string;
  bpm: number;
  camelot: string;
  keyName: string;
  rootMidi: number;
  durationSec: number;
}

export const BUILTIN_TRACK_SPECS: BuiltInTrackSpec[] = [
  {
    id: "warehouse-groove",
    title: "Midnight Warehouse",
    artist: "Sublevel 808",
    genre: "Deep House",
    bpm: 124,
    camelot: "8A",
    keyName: "A Minor",
    rootMidi: 45, // A2
    durationSec: 46,
  },
  {
    id: "neon-ignition",
    title: "Neon Ignition",
    artist: "Kinetix Club",
    genre: "Tech House",
    bpm: 126,
    camelot: "9A",
    keyName: "E Minor",
    rootMidi: 40, // E2
    durationSec: 46,
  },
  {
    id: "brooklyn-breaks",
    title: "Brooklyn Block Party",
    artist: "Grandmaster Cut",
    genre: "Golden Era Breaks",
    bpm: 102,
    camelot: "5A",
    keyName: "C Minor",
    rootMidi: 36, // C2
    durationSec: 42,
  },
  {
    id: "hyperdrive-electro",
    title: "Hyperdrive 3000",
    artist: "Voltage Syndicate",
    genre: "Electro Breakbeat",
    bpm: 128,
    camelot: "10A",
    keyName: "B Minor",
    rootMidi: 47, // B2
    durationSec: 45,
  },
];

const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Synthesizes a full stereo AudioBuffer with a real beat grid, intro, main drop, breakdown,
 * and outro so the user can test beat-matching, EQ, hot cues, and autoscratching immediately.
 */
export function synthesizeStudioTrack(ctx: BaseAudioContext, spec: BuiltInTrackSpec): AudioBuffer {
  const sr = ctx.sampleRate;
  const totalSamples = Math.floor(sr * spec.durationSec);
  const buf = ctx.createBuffer(2, totalSamples, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);

  const secPerBeat = 60 / spec.bpm;
  const secPerBar = secPerBeat * 4;
  const firstBeat = 0.24;
  const rootFreq = midiToFreq(spec.rootMidi);

  // Minor triad & scale intervals in semitones (Root, Minor 3rd, Perfect 5th, Sub-octave, Minor 7th)
  const bassNotes = [0, 0, 3, 7, 0, 7, 3, 7].map(semi => midiToFreq(spec.rootMidi + semi));
  const chordSemis = [0, 3, 7, 12, 15, 19]; // Pure Minor Triad across two octaves for true tonal chroma

  let noiseSeed = (spec.rootMidi * 1337) >>> 0;
  const nextNoise = () => {
    noiseSeed = (noiseSeed * 1664525 + 1013904223) >>> 0;
    return noiseSeed / 2147483648 - 1;
  };

  const totalBeats = Math.floor((spec.durationSec - firstBeat) / secPerBeat);

  for (let beatIdx = 0; beatIdx < totalBeats; beatIdx++) {
    const barIdx = Math.floor(beatIdx / 4);
    const beatInBar = beatIdx % 4;
    const beatTime = firstBeat + beatIdx * secPerBeat;
    const beatStartSample = Math.floor(beatTime * sr);
    const beatSamples = Math.min(totalSamples - beatStartSample, Math.floor(secPerBeat * sr));

    // Structural arrangement across bars:
    // Bars 0..3: Intro (kick + hats)
    // Bars 4..11: Main Drop (full kick, sub bass, synth stabs, clap, hats)
    // Bars 12..15: Breakdown (chords + bass filter + vocal/lead hook, no kick on bars 12..14, snare build on bar 15)
    // Bars 16..19: Second Drop
    // Bars 20+: Outro (stripped percussion groove)
    const isIntro = barIdx < 3;
    const isBreakdown = barIdx >= 11 && barIdx <= 13;
    const isBuild = barIdx === 14;
    const isOutro = barIdx >= 19;
    const isDrop = !isIntro && !isBreakdown && !isBuild && !isOutro;

    const hasKick = !isBreakdown && (!isBuild || beatInBar === 0);
    const hasClap = (isDrop || isOutro) && (beatInBar === 1 || beatInBar === 3);
    const bassFreq = bassNotes[(barIdx * 2 + (beatInBar >= 2 ? 1 : 0)) % bassNotes.length];

    for (let k = 0; k < beatSamples; k++) {
      const idx = beatStartSample + k;
      const t = k / sr; // time within current beat
      const beatFrac = t / secPerBeat;

      let sigL = 0;
      let sigR = 0;

      // 1. Punchy 909 Kick on every beat (or breakbeat syncopation for Brooklyn Breaks)
      if (hasKick && t < 0.26) {
        const kickPitch = 52 + 125 * Math.exp(-t * 44);
        const kickEnv = Math.exp(-t * 13.5);
        const click = t < 0.006 ? Math.sin(2 * Math.PI * 1800 * t) * 0.35 : 0;
        const kick = Math.tanh((Math.sin(2 * Math.PI * kickPitch * t) + click) * kickEnv * 1.45) * 0.68;
        sigL += kick;
        sigR += kick;
      }

      // 2. Crisp Clap / Snare on beats 2 and 4
      if (hasClap && t < 0.18) {
        const snareEnv = Math.exp(-t * 22);
        const body = Math.sin(2 * Math.PI * 195 * t) * Math.exp(-t * 32) * 0.35;
        const snap = nextNoise() * snareEnv * 0.42;
        sigL += body + snap * 1.08;
        sigR += body + snap * 0.92;
      }

      // 3. Build-up 1/16th snare roll on build bar
      if (isBuild) {
        const sixteenth = (beatFrac * 4) % 1;
        const subT = (sixteenth * secPerBeat) / 4;
        if (subT < 0.08) {
          const buildGain = 0.2 + 0.55 * (beatInBar / 4 + beatFrac * 0.25);
          const roll = nextNoise() * Math.exp(-subT * 38) * buildGain;
          sigL += roll;
          sigR += roll;
        }
      }

      // 4. Off-beat Open Hi-Hat (beatFrac >= 0.5) & Closed 1/16th shaker
      const sub16 = (beatFrac * 4) % 1;
      const t16 = (sub16 * secPerBeat) / 4;
      const isOffbeat = beatFrac >= 0.5 && beatFrac < 0.88;
      if (isOffbeat) {
        const ohT = t - 0.5 * secPerBeat;
        const oh = nextNoise() * Math.exp(-ohT * (isDrop ? 16 : 26)) * (isDrop ? 0.24 : 0.14);
        sigL += oh * 0.85;
        sigR += oh * 1.15;
      } else if (t16 < 0.045) {
        const ch = nextNoise() * Math.exp(-t16 * 55) * 0.1;
        sigL += ch * 1.1;
        sigR += ch * 0.9;
      }

      // 5. Rolling Off-Beat Harmonic Sub-Bass (Fundamental + Octave + 5th overtone)
      if (!isIntro) {
        const bassGate =
          beatFrac > 0.22
            ? Math.min(1, (beatFrac - 0.22) * 14) * Math.exp(-(beatFrac - 0.22) * 2.4)
            : 0.22;
        const fund = Math.sin(2 * Math.PI * bassFreq * t);
        const oct = Math.sin(2 * Math.PI * bassFreq * 2 * t) * 0.45;
        const fifth = Math.sin(2 * Math.PI * bassFreq * 1.4983 * t) * 0.22;
        const bass = (fund + oct + fifth) * bassGate * (isDrop ? 0.38 : 0.24);
        sigL += bass;
        sigR += bass;
      }

      // 6. Harmonic Minor Triad Synth Stabs & Pad (gives key analyzer & scratch engine true tonal pitch-class energy)
      const playStab =
        (isDrop && (beatInBar === 0 || beatFrac >= 0.5)) ||
        isBreakdown ||
        isBuild ||
        isIntro ||
        isOutro;
      if (playStab) {
        const stabEnv = isBreakdown
          ? 0.3 * (0.75 + 0.25 * Math.sin(2 * Math.PI * 2 * beatFrac))
          : Math.exp(-((beatFrac % 0.5) * 6.5)) * (isDrop ? 0.34 : 0.22);
        let chordL = 0;
        let chordR = 0;
        for (let c = 0; c < chordSemis.length; c++) {
          const cf = midiToFreq(spec.rootMidi + chordSemis[c]);
          const weight = c === 0 || c === 3 ? 0.32 : 0.22; // emphasize tonic root
          const v1 = Math.sin(2 * Math.PI * cf * t);
          const v2 = Math.sin(2 * Math.PI * cf * 1.002 * t + c);
          chordL += (v1 + 0.35 * v2) * weight;
          chordR += (v2 + 0.35 * v1) * weight;
        }
        sigL += chordL * stabEnv;
        sigR += chordR * stabEnv;
      }

      L[idx] = Math.tanh(sigL * 1.15) * 0.88;
      R[idx] = Math.tanh(sigR * 1.15) * 0.88;
    }
  }

  return buf;
}
