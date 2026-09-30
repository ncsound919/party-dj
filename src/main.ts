import "./style.css";
import { Mixer } from "./engine/mixer";
import type { AgentTriggerOutput, ScratchArchetypeId } from "./engine/mixer";
import { MidiControllerEngine } from "./engine/midi";
import type { MidiControlId, MidiControllerProfileId, MidiJogMode } from "./engine/midi";
import {
  interpolateEnergyCurve,
  pickNextMarathonTrack,
  pickSmartScratchProfile,
  pickSmartTransitionPreset,
  scoreNextTrackCandidate,
  sequenceCrateForParty,
} from "./engine/marathon";
import { BATTLE_CUT_SLICES, SCRATCH_PATTERNS } from "./engine/scratch";
import { evaluateHarmonicMatch } from "./engine/sync";
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "./engine/synthTracks";
import { applyHeadroom, encodeWav16 } from "./scratch-agent";
import type { Style } from "./scratch-agent";
import transitions from "./presets/transitions.json";
import partyTemplates from "./presets/party-templates.json";
import type {
  BattleSampleId,
  CrossfaderCurve,
  PartyTemplate,
  ScratchCutMode,
  ScratchQuantizeMode,
  ScratchSourceMode,
  SetlistEntry,
  TrackAnalysis,
  TransitionPreset,
} from "./engine/types";

const presets = transitions as TransitionPreset[];
const templates = partyTemplates as PartyTemplate[];
const mixer = new Mixer();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const RING = 351.86; // circumference of r=56 ring

interface CrateTrack {
  id: string;
  name: string;
  artist: string;
  genre: string;
  buffer?: AudioBuffer;
  file?: File;
  analysis: TrackAnalysis;
  playCount?: number;
  lastPlayedAtMs?: number;
}

type DeckSlotMeta = {
  id: string;
  name: string;
  artist: string;
  genre: string;
  analysis: TrackAnalysis;
} | undefined;

const slots: [DeckSlotMeta, DeckSlotMeta] = [undefined, undefined];
const crate: CrateTrack[] = [];
const queue: CrateTrack[] = [];
const setlistHistory: SetlistEntry[] = [];

let selectedPresetId = "auto";
let selectedTemplateId = templates[0].id;
let autoPilotEnabled = true;
let autoScratchDrops = true;
let autoScratchFiredForTrackId = "";
let userPinnedScratchArchetype = false;
let crateSearchQuery = "";
let crateHarmonicOnly = false;
let marathonDurationMins = 240; // 0 = endless 60m wave
let sessionStartedAtMs = 0;
let wakeLockSentinel: WakeLockSentinel | null = null;
let loading = false;
let freePending = false;
let toastTimer = 0;

const PREFS_STORAGE_KEY = "party_dj_studio_booth_prefs_v1";
function saveBoothPrefs() {
  try {
    localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        selectedPresetId,
        selectedTemplateId,
        autoPilotEnabled,
        autoScratchDrops,
        marathonDurationMins,
        autoGainEnabled: mixer.autoGainEnabled,
        crossfaderCurve: mixer.crossfaderCurve,
      })
    );
  } catch {
    // ignore storage quota errors
  }
}

function loadBoothPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.selectedPresetId === "string") selectedPresetId = parsed.selectedPresetId;
    if (typeof parsed.selectedTemplateId === "string" && templates.some(t => t.id === parsed.selectedTemplateId)) {
      selectedTemplateId = parsed.selectedTemplateId;
    }
    if (typeof parsed.autoPilotEnabled === "boolean") autoPilotEnabled = parsed.autoPilotEnabled;
    if (typeof parsed.autoScratchDrops === "boolean") autoScratchDrops = parsed.autoScratchDrops;
    if (typeof parsed.marathonDurationMins === "number") marathonDurationMins = parsed.marathonDurationMins;
    if (typeof parsed.autoGainEnabled === "boolean") mixer.setAutoGain(parsed.autoGainEnabled);
    if (parsed.crossfaderCurve === "blend" || parsed.crossfaderCurve === "dip" || parsed.crossfaderCurve === "cut") {
      mixer.setCrossfaderCurve(parsed.crossfaderCurve);
    }
  } catch {
    // ignore malformed storage
  }
}
loadBoothPrefs();

// 90s Scratch Agent State
let agentArchetype: ScratchArchetypeId = "philly";
let agentBars: 2 | 4 = 2;
let agentStyle: Style = "medium";
let agentPlacementMode: "hook" | "answer" | "sentence" = "answer";
let lastAgentOutput: AgentTriggerOutput | null = null;
let agentRunning = false;

// Platter rotation tracking (degrees)
const platterAngles = [0, 0];
let lastFrameTime = performance.now();

const fmt = (s: number) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const clean = (n: string) => n.replace(/\.[^.]+$/, "");

function toast(msg: string) {
  $("toast").textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    $("toast").textContent = autoPilotEnabled
      ? "Auto-DJ Pilot Active - Phrase Automix Armed"
      : "Ready - Press Start Party or trigger any scratch pad (keys 1-8)";
  }, 4500);
}

// 1. Render 6 Interlocking Transition Preset Keys (Auto-Match + 5 Manual Presets)
const SHORT_PRESET_LABELS: Record<string, string> = {
  auto: "Auto-Match",
  smooth: "Smooth",
  "bass-swap": "Bass Swap",
  filter: "Filter",
  quick: "Quick Cut",
  long: "Long Blend",
};

const blendContainer = $("blend");
const allBlendOptions: Array<{ id: string; name: string; sub: string }> = [
  { id: "auto", name: "Auto-Match", sub: "Smart AI" },
  ...presets.map(p => ({
    id: p.id,
    name: SHORT_PRESET_LABELS[p.id] ?? p.name,
    sub: p.bars ? `${p.bars} bars` : "Instant",
  })),
];

for (const opt of allBlendOptions) {
  const l = document.createElement("label");
  const i = document.createElement("input");
  const s = document.createElement("span");
  const sm = document.createElement("small");
  i.type = "radio";
  i.name = "blend";
  i.value = opt.id;
  i.checked = opt.id === selectedPresetId;
  s.textContent = opt.name;
  sm.textContent = opt.sub;
  s.append(sm);
  l.append(i, s);
  blendContainer.append(l);
}
blendContainer.addEventListener("change", e => {
  selectedPresetId = (e.target as HTMLInputElement).value;
  saveBoothPrefs();
  if (selectedPresetId === "auto") {
    toast("Transition mode: Auto-Match (Automatically selects Bass Swap, Smooth, Filter, or Cut per track pair)");
  } else {
    const p = presets.find(x => x.id === selectedPresetId);
    if (p) toast(`Transition mode locked: ${p.name} (${p.bars} bars)`);
  }
});

function resolveActiveTransitionPreset(): { preset: TransitionPreset; autoReason?: string } {
  if (selectedPresetId !== "auto") {
    const manual = presets.find(p => p.id === selectedPresetId) ?? presets[0];
    return { preset: manual };
  }
  const fromMeta = slots[mixer.active] ?? slots[0];
  const toMeta = slots[mixer.idle] ?? slots[1];
  if (!fromMeta || !toMeta) {
    return { preset: presets[0] };
  }
  const picked = pickSmartTransitionPreset(
    {
      bpm: mixer.info()?.effBpm ?? fromMeta.analysis.bpm,
      key: fromMeta.analysis.key,
      energy: fromMeta.analysis.energy,
    },
    {
      bpm: toMeta.analysis.bpm,
      key: toMeta.analysis.key,
      energy: toMeta.analysis.energy,
    }
  );
  const preset = presets.find(p => p.id === picked.presetId) ?? presets[0];
  return { preset, autoReason: picked.reason };
}

// 2. Render 8 Fitted Autoscratch Performance Pads (4x2 Matrix)
const COMPACT_SCRATCH_LABELS: Record<string, { title: string; tag: string }> = {
  baby: { title: "Baby Scratch", tag: "2B OPEN" },
  flare: { title: "Orbit Flare", tag: "2B 2-CLK" },
  transformer: { title: "Transformer", tag: "2B GATE" },
  chirp: { title: "Chirp Cut", tag: "2B EDGE" },
  crab: { title: "4-Finger Crab", tag: "2B ROLL" },
  tear: { title: "Tear Scratch", tag: "2B SPLIT" },
  backspin: { title: "Backspin", tag: "4B WHIP" },
  uzis: { title: "Laser Stutter", tag: "2B 1/32" },
};

const scratchPadsContainer = $("scratchPads");
SCRATCH_PATTERNS.forEach((pat, idx) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "scratch-pad-btn";
  btn.dataset.scratchId = pat.id;
  btn.title = `${pat.name}: ${pat.description} (Key ${idx + 1})`;

  const compact = COMPACT_SCRATCH_LABELS[pat.id] ?? {
    title: pat.name,
    tag: `${pat.beats}B`,
  };

  const topRow = document.createElement("div");
  topRow.className = "scratch-pad-top";
  const keySpan = document.createElement("span");
  keySpan.className = "scratch-pad-key";
  keySpan.textContent = `0${idx + 1}`;
  const tagSpan = document.createElement("span");
  tagSpan.textContent = compact.tag;
  topRow.append(keySpan, tagSpan);

  const title = document.createElement("strong");
  title.textContent = compact.title;

  btn.append(topRow, title);

  btn.addEventListener("click", async () => {
    await mixer.ctx.resume();
    const res = mixer.triggerAutoscratch(pat.id);
    if (res.ok) toast(`Autoscratch: ${res.message}`);
  });

  scratchPadsContainer.append(btn);
});

// Scratch Source Mode, Quantize Grid, Optical Fader Cut-In, Intensity & Battle Cut Sample Switches
document.querySelectorAll<HTMLButtonElement>("[data-scratch-source]").forEach(btn => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-scratch-source]")
      .forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mixer.scratchSourceMode = btn.dataset.scratchSource as ScratchSourceMode;
    void autoStageScratchRoutine();
    toast(
      mixer.scratchSourceMode === "vinyl"
        ? "Scratch Source: Direct Vinyl Track (Warps & moves active music track playhead)"
        : mixer.scratchSourceMode === "slip"
          ? "Scratch Source: Slip-Mat Active Deck (Warps active track, preserves bar grid)"
          : mixer.scratchSourceMode === "incoming"
            ? "Scratch Source: Incoming Deck B Drop Transient"
            : "Scratch Source: 90s Battle Vocal Cuts (4-Formant + M44-7 Stylus Bite)"
    );
  });
});

const commitTrackModBtn = $<HTMLButtonElement>("commitTrackModBtn");
commitTrackModBtn.addEventListener("click", () => {
  mixer.commitTrackMod = !mixer.commitTrackMod;
  commitTrackModBtn.classList.toggle("active", mixer.commitTrackMod);
  commitTrackModBtn.setAttribute("aria-pressed", String(mixer.commitTrackMod));
  commitTrackModBtn.textContent = `MOD TRACK: ${mixer.commitTrackMod ? "ON" : "OFF"}`;
  toast(
    mixer.commitTrackMod
      ? "Track Modification ON: Scratches permanently splice into the deck's AudioBuffer & waveform"
      : "Track Modification OFF: Scratches manipulate live playback without overwriting track PCM"
  );
});

$("restoreTrackModBtn").addEventListener("click", () => {
  const slot = mixer.active as 0 | 1;
  const ok = mixer.restoreDeckOriginal(slot);
  if (ok) {
    toast(`Restored Deck ${slot === 0 ? "A" : "B"} ("${slots[slot]?.name ?? "Track"}") to original unmodified audio`);
  }
});

$("exportModTrackBtn").addEventListener("click", () => {
  const slot = mixer.active as 0 | 1;
  const exported = mixer.exportDeckWav(slot);
  if (!exported) return toast("Load a track into the active deck first");
  const trackTitle = (slots[slot]?.name ?? `deck_${slot === 0 ? "a" : "b"}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  const blob = new Blob([exported.wavBytes.buffer as ArrayBuffer], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${trackTitle}_scratched_${exported.modCount}mods.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(
    `Exported Deck ${slot === 0 ? "A" : "B"} stereo WAV (${exported.modCount} scratch modification${exported.modCount === 1 ? "" : "s"} baked in)`
  );
});

document.querySelectorAll<HTMLButtonElement>("[data-scratch-quantize]").forEach(btn => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-scratch-quantize]")
      .forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mixer.scratchQuantize = (btn.dataset.scratchQuantize as ScratchQuantizeMode) || "1/16";
    toast(
      mixer.scratchQuantize === "instant"
        ? "Scratch Quantize: INSTANT (<4ms Zero-Latency Battle Pad Trigger)"
        : `Scratch Quantize: ${mixer.scratchQuantize} Beat Grid Pocket Lock`
    );
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-scratch-cut]").forEach(btn => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-scratch-cut]")
      .forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mixer.scratchCutMode = (btn.dataset.scratchCut as ScratchCutMode) || "mag-four";
    void autoStageScratchRoutine();
    toast(
      mixer.scratchCutMode === "mag-four"
        ? "Optical Fader Edge: Rane Mag-Four (0.55ms Ultra-Sharp Cut-In)"
        : "Optical Fader Edge: Classic Club VCA (1.6ms Smooth Envelope)"
    );
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-battle-sample]").forEach(btn => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-battle-sample]")
      .forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mixer.battleSampleId = (btn.dataset.battleSample as BattleSampleId) || "auto";
    toast(
      mixer.battleSampleId === "auto"
        ? "Battle Cut Sample: AUTO (Matches syllable timbre to each scratch pattern)"
        : `Battle Cut Sample Locked: "${mixer.battleSampleId.toUpperCase()}"`
    );
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-scratch-intensity]").forEach(btn => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-scratch-intensity]")
      .forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mixer.scratchIntensity = parseFloat(btn.dataset.scratchIntensity || "1.0");
    toast(`Scratch intensity: ${btn.textContent}`);
  });
});

// 2B. 90s Scratch Agent Controls, Critic QA Inspector & WAV Export
const sentenceInputRow = $("sentenceInputRow");
const sentenceWordsInput = $<HTMLInputElement>("sentenceWordsInput");
const wordBankPills = $("wordBankPills");

function syncAgentUiState() {
  document.querySelectorAll<HTMLButtonElement>("[data-agent-archetype]").forEach(b => {
    b.classList.toggle("active", b.dataset.agentArchetype === agentArchetype);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-agent-bars]").forEach(b => {
    b.classList.toggle("active", Number(b.dataset.agentBars) === agentBars);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-agent-style]").forEach(b => {
    b.classList.toggle("active", b.dataset.agentStyle === agentStyle);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-agent-mode]").forEach(b => {
    b.classList.toggle("active", b.dataset.agentMode === agentPlacementMode);
  });
  sentenceInputRow.hidden = agentPlacementMode !== "sentence";
}

// Populate clickable 90s Battle Cut word chips for Sentence Mode
for (const syl of BATTLE_CUT_SLICES) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "word-pill-btn";
  chip.textContent = `+${syl.text}`;
  chip.title = `Append "${syl.text}" (${Math.round(syl.len * 1000)}ms cut word) to sentence`;
  chip.addEventListener("click", () => {
    const cur = sentenceWordsInput.value.trim();
    const tokens = cur ? cur.split(/\s+/) : [];
    if (tokens.length >= 6) tokens.shift();
    tokens.push(syl.text);
    sentenceWordsInput.value = tokens.join(" ");
  });
  wordBankPills.append(chip);
}

function parseSentenceTokens(raw: string): (string | number)[] {
  return raw
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(tok => (/^\d+$/.test(tok) ? parseInt(tok, 10) : tok));
}

document.querySelectorAll<HTMLButtonElement>("[data-agent-archetype]").forEach(btn => {
  btn.addEventListener("click", () => {
    const arch = (btn.dataset.agentArchetype as ScratchArchetypeId) || "philly";
    userPinnedScratchArchetype = true;
    agentArchetype = arch;
    if (arch === "premier") {
      agentPlacementMode = "sentence";
      agentStyle = "sparse";
      agentBars = 2;
      toast("Archetype: DJ Premier (Sentence-Hook, forward strokes, sparse + swing)");
    } else if (arch === "philly") {
      agentPlacementMode = "answer";
      agentStyle = "busy";
      agentBars = 2;
      toast("Archetype: Philly Transform (Rigid 16th grid, high-density fader chops)");
    } else if (arch === "bombsquad") {
      agentPlacementMode = "hook";
      agentStyle = "busy";
      agentBars = 4;
      toast("Archetype: Bomb Squad (4-Bar collage, wide sustained strokes)");
    }
    syncAgentUiState();
    void autoStageScratchRoutine();
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-agent-bars]").forEach(btn => {
  btn.addEventListener("click", () => {
    agentBars = Number(btn.dataset.agentBars) === 4 ? 4 : 2;
    syncAgentUiState();
    toast(`90s Agent phrase length: ${agentBars} bars`);
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-agent-style]").forEach(btn => {
  btn.addEventListener("click", () => {
    agentStyle = (btn.dataset.agentStyle as Style) || "medium";
    syncAgentUiState();
    toast(`90s Agent style: ${agentStyle.toUpperCase()}`);
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-agent-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    const m = btn.dataset.agentMode;
    agentPlacementMode = m === "hook" ? "hook" : m === "sentence" ? "sentence" : "answer";
    syncAgentUiState();
    toast(
      agentPlacementMode === "sentence"
        ? "90s Agent pocket: SENTENCE (Ordered multi-source words/slices, 1 forward stroke each)"
        : agentPlacementMode === "answer"
          ? "90s Agent pocket: ANSWER (Beats 1-2 open for vocal, scratch on beats 3-4)"
          : "90s Agent pocket: HOOK (Scratch across all beats)"
    );
  });
});

const agentSeedInput = $<HTMLInputElement>("agentSeedInput");
const agentWithHookInput = $<HTMLInputElement>("agentWithHook");
const agentExportWavBtn = $<HTMLButtonElement>("agentExportWavBtn");

function formatCriticMetric(name: string, val: number | null, threshold: number | null): string {
  if (val === null) return "not measured";
  if (name === "clipping") return `peak=${val.toFixed(2)}`;
  if (name === "gate_clicks") return `jump=${val.toFixed(2)}`;
  if (name === "grid_adherence") return `${val.toFixed(1)}ms`;
  if (name === "density") return `${val.toFixed(0)}/${threshold ?? 0}bar`;
  if (name === "silence") return `rms=${val.toFixed(3)}`;
  if (name === "diversity") return `rep=${val.toFixed(0)}`;
  if (name === "intelligibility") return `${Math.round(val * 100)}%`;
  return `${val.toFixed(2)}`;
}

function renderAgentInspector(out: AgentTriggerOutput) {
  const res = out.result;
  if (!res) return;

  const badge = $("criticStatusBadge");
  badge.classList.remove("pass", "warn");
  badge.classList.add(res.passed ? "pass" : "warn");
  badge.textContent = `${res.passed ? "CRITIC PASS" : "CRITIC WARN"} / TRY ${res.attempts.length}/${res.cfg.max_tries} / SEED ${res.seed}`;

  $("agentInspectorSummary").textContent = `CRITIC QA: ${res.passed ? "PASS" : "WARN"} (${res.events.length} EVENTS / ${out.bank?.slices.length ?? 0} SLICES / SEED ${res.seed})`;

  const checksGrid = $("agentCriticChecks");
  checksGrid.replaceChildren();
  const lastAttempt = res.attempts[res.attempts.length - 1];
  if (lastAttempt) {
    for (const c of lastAttempt.report.checks) {
      const chip = document.createElement("span");
      const isUnmeasured = c.value === null;
      chip.className = `critic-check-chip ${c.passed ? "ok" : "fail"}`;
      const b = document.createElement("b");
      b.textContent = isUnmeasured ? "N/A" : c.passed ? "OK" : "WARN";
      const txt = document.createElement("span");
      const metricStr = formatCriticMetric(c.name, c.value, c.threshold);
      txt.textContent = metricStr ? `${c.name} (${metricStr})` : c.name;
      chip.append(b, txt);
      checksGrid.append(chip);
    }
  }

  const eventsStrip = $("agentEventPills");
  eventsStrip.replaceChildren();
  const secPerBeat = 60 / (mixer.info()?.effBpm ?? slots[mixer.active]?.analysis.bpm ?? 124);
  const byId = new Map((out.bank?.slices ?? []).map(s => [s.id, s]));
  res.events.forEach((ev, idx) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "event-chip";
    pill.title = "Click to cycle scratch primitive (Baby -> Flare -> Chirp -> Stab -> Cut -> Tear -> Crab -> Transform) · Shift+Click to drop live";
    const beatPos = (ev.t0 / secPerBeat).toFixed(2);
    const sl = byId.get(ev.slice_id);
    const srcTag = sl?.text ? `${sl.src_id ?? "cut"}:"${sl.text}"` : `${sl?.src_id ?? "main"}:S${ev.slice_id}`;
    const rateTag = ev.params.avg_rate !== undefined ? ` / ${ev.params.avg_rate.toFixed(2)}x` : "";
    pill.innerHTML = `<b>#${idx + 1} ${ev.primitive}</b> @ ${beatPos}B (${srcTag}, ${ev.n_strokes}x${rateTag})`;
    pill.addEventListener("click", async e => {
      if (!lastAgentOutput) return;
      if (e.shiftKey) await mixer.ctx.resume();
      const updated = mixer.cycleScratchAgentEventPrimitive(lastAgentOutput, idx, e.shiftKey);
      if (updated) {
        lastAgentOutput = updated;
        renderAgentInspector(updated);
        toast(updated.message);
      }
    });
    eventsStrip.append(pill);
  });

  agentExportWavBtn.disabled = false;
}

async function trigger90sScratchAgent(incrementSeed = false) {
  if (agentRunning) return;
  agentRunning = true;
  const dropBtn = $<HTMLButtonElement>("agentDropBtn");
  dropBtn.disabled = true;
  try {
    await mixer.ctx.resume();
    let seed = parseInt(agentSeedInput.value || "7", 10);
    if (Number.isNaN(seed)) seed = 7;
    if (incrementSeed) {
      seed += 1;
      agentSeedInput.value = String(seed);
    }
    const sentenceWords =
      agentPlacementMode === "sentence"
        ? parseSentenceTokens(sentenceWordsInput.value)
        : undefined;
    const out = await mixer.triggerScratchAgent({
      bars: agentBars,
      style: agentStyle,
      placementMode: agentPlacementMode,
      seed,
      archetype: agentArchetype,
      sentenceWords,
      withHook: agentWithHookInput.checked,
    });
    lastAgentOutput = out;
    if (out.result) {
      agentSeedInput.value = String(out.result.seed);
    }
    renderAgentInspector(out);
    toast(`90s Scratch Agent: ${out.message}`);
  } catch (err) {
    toast(`90s Scratch Agent error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    agentRunning = false;
    dropBtn.disabled = false;
  }
}

async function autoStageScratchRoutine() {
  if (agentRunning) return;
  const activeMeta = slots[mixer.active] ?? slots[0];
  if (activeMeta && !userPinnedScratchArchetype) {
    const prof = pickSmartScratchProfile({
      bpm: activeMeta.analysis.bpm,
      energy: activeMeta.analysis.energy,
      genre: activeMeta.genre,
    });
    agentArchetype = prof.archetype;
    agentBars = prof.bars;
    agentStyle = prof.style;
    agentPlacementMode = prof.placementMode;
    syncAgentUiState();
  }
  try {
    const seed = parseInt(agentSeedInput.value || "7", 10) || 7;
    const sentenceWords =
      agentPlacementMode === "sentence"
        ? parseSentenceTokens(sentenceWordsInput.value)
        : undefined;
    const out = await mixer.triggerScratchAgent({
      bars: agentBars,
      style: agentStyle,
      placementMode: agentPlacementMode,
      seed,
      archetype: agentArchetype,
      sentenceWords,
      withHook: agentWithHookInput.checked,
      previewOnly: true,
    });
    lastAgentOutput = out;
    renderAgentInspector(out);
  } catch {
    // ignore background preview errors
  }
}

$("agentDropBtn").addEventListener("click", () => void trigger90sScratchAgent(false));
$("agentRerollBtn").addEventListener("click", () => void trigger90sScratchAgent(true));

agentExportWavBtn.addEventListener("click", () => {
  const res = lastAgentOutput?.result;
  const sr = lastAgentOutput?.sourceBuffer?.sampleRate ?? mixer.ctx.sampleRate;
  if (!res) return;
  const pcm = applyHeadroom(res.audio, res.cfg.headroom_db);
  const wavBytes = encodeWav16(pcm, sr);
  const blob = new Blob([wavBytes.buffer as ArrayBuffer], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `90s_scratch_agent_${res.plan.bars}b_${res.plan.style}_seed${res.seed}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Exported 16-bit PCM WAV (Seed ${res.seed})`);
});

// 3. Render Party Energy Templates & Marathon Sequencer Controls
function getActiveTemplate(): PartyTemplate {
  return templates.find(t => t.id === selectedTemplateId) ?? templates[0];
}

function getSessionProgress01(): number {
  if (!sessionStartedAtMs || !mixer.playing) return 0;
  const elapsedMin = (Date.now() - sessionStartedAtMs) / 60000;
  if (marathonDurationMins <= 0) {
    // Endless mode: 60-minute wave cycle
    return (elapsedMin % 60) / 60;
  }
  return Math.min(1, elapsedMin / marathonDurationMins);
}

function getCurrentTargetEnergy(): number {
  const tpl = getActiveTemplate();
  return interpolateEnergyCurve(tpl.energyCurve, getSessionProgress01());
}

/**
 * Evicts decoded 32-bit AudioBuffers from user-uploaded File tracks that are not in
 * Deck A, Deck B, or the next 2 queue slots so 4-hour 100-track sets stay under ~250MB RAM.
 */
function countBuffersInRam(): number {
  let count = 0;
  for (const item of crate) {
    if (item.buffer) count++;
  }
  return count;
}

function updateRamAndWakeBadge() {
  const badge = $("wakeLockBadge");
  const ramCount = countBuffersInRam();
  badge.classList.toggle("active", mixer.playing);
  const wlText = wakeLockSentinel ? "WAKELOCK ON" : "WAKELOCK OFF";
  badge.textContent = `RAM: ${ramCount}/${crate.length} BUFFERS · ${wlText}`;
}

function evictIdleCrateBuffers() {
  const keepIds = new Set<string>();
  if (slots[0]?.id) keepIds.add(slots[0].id);
  if (slots[1]?.id) keepIds.add(slots[1].id);
  if (queue[0]?.id) keepIds.add(queue[0].id);
  if (queue[1]?.id) keepIds.add(queue[1].id);

  for (const item of crate) {
    if (item.file && item.buffer && !keepIds.has(item.id)) {
      item.buffer = undefined;
    }
  }
  updateRamAndWakeBadge();
}

async function syncWakeLock() {
  if (!mixer.playing) {
    if (wakeLockSentinel) {
      try {
        await wakeLockSentinel.release();
      } catch {
        // Ignore release errors
      }
      wakeLockSentinel = null;
    }
    updateRamAndWakeBadge();
    return;
  }

  if ("wakeLock" in navigator && !wakeLockSentinel) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request("screen");
      wakeLockSentinel.addEventListener("release", () => {
        wakeLockSentinel = null;
        updateRamAndWakeBadge();
      });
    } catch {
      wakeLockSentinel = null;
    }
  }
  updateRamAndWakeBadge();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && mixer.playing) {
    void syncWakeLock();
  }
});

function logTrackToSetlist(meta: DeckSlotMeta, presetName: string, harmonicMatch: string) {
  if (!meta) return;
  if (!sessionStartedAtMs) sessionStartedAtMs = Date.now();
  const elapsedMin = +((Date.now() - sessionStartedAtMs) / 60000).toFixed(1);
  const crateItem = crate.find(c => c.id === meta.id);
  const fileName = crateItem?.file?.name ?? `${meta.id}.synth.wav`;

  setlistHistory.push({
    index: setlistHistory.length + 1,
    playedAtIso: new Date().toISOString(),
    elapsedSessionMin: elapsedMin,
    title: meta.name,
    artist: meta.artist,
    fileName,
    bpm: +meta.analysis.bpm.toFixed(1),
    key: meta.analysis.key ?? "8A",
    energy: Math.round((meta.analysis.energy ?? 0.75) * 100),
    transitionPreset: presetName,
    harmonicMatch,
  });
  $("setlistCountBadge").textContent = String(setlistHistory.length);

  if (crateItem) {
    crateItem.playCount = (crateItem.playCount ?? 0) + 1;
    crateItem.lastPlayedAtMs = Date.now();
  }
}

const partyTemplatesBar = $("partyTemplates");
function renderPartyTemplates() {
  partyTemplatesBar.replaceChildren();
  for (const t of templates) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `template-btn ${t.id === selectedTemplateId ? "active" : ""}`;
    btn.textContent = `${t.name}`;
    btn.addEventListener("click", () => {
      selectedTemplateId = t.id;
      $("marathonArcLabel").textContent = `ENERGY ARC: ${t.name.toUpperCase()}`;
      autoSequenceQueueSilently();
      renderQueue();
      renderPartyTemplates();
      saveBoothPrefs();
      toast(`Party Vibe: ${t.name} (Queue auto-sequenced to ${t.name} energy curve)`);
    });
    partyTemplatesBar.append(btn);
  }
}
renderPartyTemplates();

// Marathon Duration & Queue Auto-Sequencer Controls
document.querySelectorAll<HTMLButtonElement>("[data-marathon-mins]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>("[data-marathon-mins]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    marathonDurationMins = parseInt(btn.dataset.marathonMins || "240", 10);
    saveBoothPrefs();
    toast(
      marathonDurationMins > 0
        ? `Marathon set target: ${marathonDurationMins} minutes (${marathonDurationMins / 60}H)`
        : "Marathon set target: ENDLESS (60m wave cycle)"
    );
  });
});

$("autoSequenceBtn").addEventListener("click", () => {
  const activeMeta = slots[mixer.active] ?? slots[0];
  const anchor = {
    bpm: activeMeta?.analysis.bpm ?? 124,
    key: activeMeta?.analysis.key ?? "8A",
  };
  if (queue.length < 2) {
    const activeIds = new Set([slots[0]?.id, slots[1]?.id, ...queue.map(q => q.id)]);
    for (const c of crate) {
      if (!activeIds.has(c.id)) queue.push(c);
    }
  }
  const tpl = getActiveTemplate();
  const reordered = sequenceCrateForParty(anchor, queue, tpl.energyCurve, getSessionProgress01());
  queue.splice(0, queue.length, ...reordered);
  renderQueue();
  void fill();
  toast(`Auto-sequenced ${queue.length} track(s) by Camelot Key + BPM + ${tpl.name} Energy Curve`);
});

const autoGainToggle = $<HTMLButtonElement>("autoGainToggle");
autoGainToggle.addEventListener("click", () => {
  mixer.setAutoGain(!mixer.autoGainEnabled);
  autoGainToggle.classList.toggle("active", mixer.autoGainEnabled);
  autoGainToggle.setAttribute("aria-pressed", String(mixer.autoGainEnabled));
  autoGainToggle.textContent = `AUTO-GAIN: ${mixer.autoGainEnabled ? "ON" : "OFF"}`;
  saveBoothPrefs();
  toast(
    mixer.autoGainEnabled
      ? "Club Auto-Gain Enabled (-11.5 dBFS RMS target)"
      : "Club Auto-Gain Bypassed (0dB raw deck levels)"
  );
});

const splitCueToggle = $<HTMLButtonElement>("splitCueToggle");
function updateCueUiState() {
  splitCueToggle.classList.toggle("active", mixer.splitCueEnabled);
  splitCueToggle.setAttribute("aria-pressed", String(mixer.splitCueEnabled));
  splitCueToggle.textContent = `SPLIT CUE (L:MST / R:CUE): ${mixer.splitCueEnabled ? "ON" : "OFF"}`;
  $("cueListenA").classList.toggle("active", mixer.auditioningSlot === 0);
  $("cueListenB").classList.toggle("active", mixer.auditioningSlot === 1);
}

splitCueToggle.addEventListener("click", () => {
  mixer.setSplitCue(!mixer.splitCueEnabled);
  updateCueUiState();
  toast(
    mixer.splitCueEnabled
      ? "Split-Cue Active: Left = Master PA, Right = Pre-Fader Headphone Cue"
      : "Split-Cue Off: Standard Stereo Master Output"
  );
});

$("cueListenA").addEventListener("click", async () => {
  await mixer.ctx.resume();
  const on = mixer.toggleCueAudition(0);
  updateCueUiState();
  toast(on ? "Headphone Cue: Auditioning Deck A (Right Channel)" : "Headphone Cue: Deck A released");
});

$("cueListenB").addEventListener("click", async () => {
  await mixer.ctx.resume();
  const on = mixer.toggleCueAudition(1);
  updateCueUiState();
  toast(on ? "Headphone Cue: Auditioning Deck B (Right Channel)" : "Headphone Cue: Deck B released");
});

const autoScratchToggle = $<HTMLButtonElement>("autoScratchToggle");
autoScratchToggle.addEventListener("click", () => {
  autoScratchDrops = !autoScratchDrops;
  autoScratchToggle.classList.toggle("active", autoScratchDrops);
  autoScratchToggle.setAttribute("aria-pressed", String(autoScratchDrops));
  autoScratchToggle.textContent = `AUTO-SCRATCH DROPS: ${autoScratchDrops ? "ON" : "OFF"}`;
  toast(
    autoScratchDrops
      ? "Auto-Scratch Drops Armed: Will drop a 90s Scratch Agent phrase 6 bars before Auto-DJ transitions"
      : "Auto-Scratch Drops Disabled"
  );
});

$("exportSetlistBtn").addEventListener("click", () => {
  if (setlistHistory.length === 0 && slots[mixer.active]) {
    logTrackToSetlist(slots[mixer.active], "Opening Track", "Initial Lock");
  }
  const lines = [
    "#EXTM3U",
    `#PLAYLIST:Party DJ Studio - ${getActiveTemplate().name} Setlist`,
    ...setlistHistory.flatMap(entry => [
      `#EXTINF:-1,${entry.artist} - ${entry.title} [${entry.bpm} BPM | Key ${entry.key} | Energy ${entry.energy}% | Mix: ${entry.transitionPreset} | ${entry.harmonicMatch} @ +${entry.elapsedSessionMin}m]`,
      entry.fileName,
    ]),
  ];
  const blob = new Blob([lines.join("\n")], { type: "audio/x-mpegurl" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `party_dj_setlist_${Date.now()}.m3u8`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Exported Setlist (.M3U8) with ${setlistHistory.length} played track(s)`);
});

// Auto-DJ Pilot, Mic Talkover & Live Set Recorder Toggles
const autoPilotBtn = $<HTMLButtonElement>("autoPilotBtn");
autoPilotBtn.addEventListener("click", () => {
  autoPilotEnabled = !autoPilotEnabled;
  autoPilotBtn.setAttribute("aria-pressed", String(autoPilotEnabled));
  autoPilotBtn.innerHTML = `<span class="switch-led"></span><span>Auto-DJ: ${autoPilotEnabled ? "On" : "Off"}</span>`;
  toast(
    autoPilotEnabled
      ? "Auto-DJ Pilot Enabled - Will auto-blend tracks at phrase outro"
      : "Auto-DJ Pilot Disabled"
  );
});

const micTalkoverBtn = $<HTMLButtonElement>("micTalkoverBtn");
micTalkoverBtn.addEventListener("click", async () => {
  const res = await mixer.toggleMicTalkover();
  micTalkoverBtn.setAttribute("aria-pressed", String(res.active));
  $("micTalkoverLabel").textContent = `Mic: ${res.active ? "On (-10dB)" : "Off"}`;
  toast(res.message);
});

const recSetBtn = $<HTMLButtonElement>("recSetBtn");
recSetBtn.addEventListener("click", async () => {
  const res = await mixer.toggleRecording();
  recSetBtn.setAttribute("aria-pressed", String(res.recording));
  if (!res.recording) {
    $("recSetLabel").textContent = "Rec Set";
    if (res.blob) {
      const url = URL.createObjectURL(res.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `party_dj_live_set_${Date.now()}.${res.ext ?? "webm"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }
  toast(res.message);
});

// Master BPM Nudge Controls
$("bpmDownBtn").addEventListener("click", () => {
  const cur = mixer.info()?.effBpm ?? slots[0]?.analysis.bpm ?? 124;
  mixer.setMasterBpm(cur - 1);
  syncPitchSlidersFromDecks();
  toast(`Master Tempo nudged to ${(cur - 1).toFixed(1)} BPM`);
});
$("bpmUpBtn").addEventListener("click", () => {
  const cur = mixer.info()?.effBpm ?? slots[0]?.analysis.bpm ?? 124;
  mixer.setMasterBpm(cur + 1);
  syncPitchSlidersFromDecks();
  toast(`Master Tempo nudged to ${(cur + 1).toFixed(1)} BPM`);
});
$("bpmResetBtn").addEventListener("click", () => {
  const native = slots[mixer.active]?.analysis.bpm ?? 124;
  mixer.setMasterBpm(native);
  syncPitchSlidersFromDecks();
  toast(`Master Tempo synced to ${native.toFixed(1)} BPM`);
});

// 4A. Per-Deck Transport, Sync, Beat-Jump & Pitch Sliders
function syncPitchSlidersFromDecks() {
  for (let slot = 0 as 0 | 1; slot <= 1; slot = (slot + 1) as 0 | 1) {
    const prefix = slot === 0 ? "A" : "B";
    const pct = mixer.decks[slot].pitchPct;
    const slider = $<HTMLInputElement>(`pitchSlider${prefix}`);
    slider.value = String(Math.max(-8, Math.min(8, pct)));
    $(`pitchVal${prefix}`).textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    if (typeof midiEngine !== "undefined") {
      midiEngine.setSoftwareTargetNormalized(slot === 0 ? "pitchA" : "pitchB", (pct + 8) / 16);
    }
  }
}

([0, 1] as const).forEach(slot => {
  const prefix = slot === 0 ? "A" : "B";
  $(`deckPlay${prefix}`).addEventListener("click", async () => {
    await mixer.ctx.resume();
    if (!slots[slot]) return toast(`Load a track into Deck ${prefix} first`);
    const nowPlaying = mixer.toggleDeckPlay(slot);
    if (nowPlaying && !sessionStartedAtMs) sessionStartedAtMs = Date.now();
    void syncWakeLock();
    toast(nowPlaying ? `Deck ${prefix} Playing` : `Deck ${prefix} Paused`);
  });

  $(`deckSync${prefix}`).addEventListener("click", async () => {
    await mixer.ctx.resume();
    if (!slots[slot]) return toast(`Load a track into Deck ${prefix} first`);
    const res = mixer.syncDeck(slot);
    syncPitchSlidersFromDecks();
    toast(`Deck ${prefix} Synced to ${res.syncedBpm.toFixed(1)} BPM (${res.pct >= 0 ? "+" : ""}${res.pct.toFixed(1)}%)`);
  });

  const pitchSlider = $<HTMLInputElement>(`pitchSlider${prefix}`);
  const applyPitch = () => {
    const pct = parseFloat(pitchSlider.value || "0");
    const newBpm = mixer.setDeckPitchPct(slot, pct);
    $(`pitchVal${prefix}`).textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    if (newBpm > 0) {
      toast(`Deck ${prefix} Pitch: ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% (${newBpm.toFixed(1)} BPM)`);
    }
  };
  pitchSlider.addEventListener("input", applyPitch);
  pitchSlider.addEventListener("dblclick", () => {
    pitchSlider.value = "0";
    applyPitch();
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-beatjump-deck]").forEach(btn => {
  btn.addEventListener("click", async () => {
    await mixer.ctx.resume();
    const slot = Number(btn.dataset.beatjumpDeck) as 0 | 1;
    const beats = parseInt(btn.dataset.beats || "4", 10);
    if (!slots[slot]) return toast(`Load a track into Deck ${slot === 0 ? "A" : "B"} first`);
    const newOff = mixer.beatJump(slot, beats);
    const bars = beats / 4;
    toast(`Deck ${slot === 0 ? "A" : "B"} Beat Jump ${bars > 0 ? `+${bars}` : bars}B -> ${fmt(newOff)}`);
  });
});

// 4B. Quantized Hot Cues (Click = Jump, Shift+Click / Right-Click = Set at Current Playhead) & Beat Loops
document.querySelectorAll<HTMLButtonElement>(".cue-btn").forEach(btn => {
  const handleSetCue = () => {
    const deckIdx = Number(btn.dataset.deck) as 0 | 1;
    const cueKey = btn.dataset.cue as "intro" | "drop" | "breakdown" | "outro";
    const snapped = mixer.setHotCue(deckIdx, cueKey);
    if (snapped === null) return toast("Load a track on this deck first");
    if (slots[deckIdx]?.analysis.cuePoints) {
      slots[deckIdx]!.analysis.cuePoints![cueKey] = snapped;
    }
    updateDeckStaticLabels(deckIdx);
    toast(`Set Deck ${deckIdx === 0 ? "A" : "B"} ${cueKey.toUpperCase()} Cue at ${fmt(snapped)}`);
  };

  btn.addEventListener("contextmenu", e => {
    e.preventDefault();
    handleSetCue();
  });

  btn.addEventListener("click", async e => {
    await mixer.ctx.resume();
    if (e.shiftKey) {
      handleSetCue();
      return;
    }
    const deckIdx = Number(btn.dataset.deck) as 0 | 1;
    const cueKey = btn.dataset.cue as "intro" | "drop" | "breakdown" | "outro";
    const meta = slots[deckIdx];
    if (!meta?.analysis.cuePoints) return toast("Load a track on this deck first");
    const targetSec = meta.analysis.cuePoints[cueKey];
    mixer.seekDeck(deckIdx, targetSec);
    toast(`Deck ${deckIdx === 0 ? "A" : "B"} jumped to ${cueKey.toUpperCase()} (${fmt(targetSec)})`);
  });
});

document.querySelectorAll<HTMLButtonElement>(".loop-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const deckIdx = Number(btn.dataset.deck) as 0 | 1;
    const bars = parseFloat(btn.dataset.bars || "0");
    const d = mixer.decks[deckIdx];
    if (!d.buffer) return toast("Load a track on this deck first");
    d.setLoop(bars);
    updateLoopButtons(deckIdx);
    toast(
      d.loopBars > 0
        ? `Deck ${deckIdx === 0 ? "A" : "B"} locked in ${d.loopBars}-bar loop`
        : `Deck ${deckIdx === 0 ? "A" : "B"} loop released`
    );
  });
});

document.querySelectorAll<HTMLButtonElement>(".loop-op-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const deckIdx = Number(btn.dataset.deck) as 0 | 1;
    const op = btn.dataset.loopOp;
    const d = mixer.decks[deckIdx];
    if (!d.buffer) return toast("Load a track on this deck first");
    if (op === "halve") d.halveLoop();
    else d.doubleLoop();
    updateLoopButtons(deckIdx);
    toast(`Deck ${deckIdx === 0 ? "A" : "B"} loop roll: ${d.loopBars} bars`);
  });
});

function updateLoopButtons(deckIdx: 0 | 1) {
  const activeBars = mixer.decks[deckIdx].loopBars;
  document
    .querySelectorAll<HTMLButtonElement>(`.loop-btn[data-deck="${deckIdx}"]`)
    .forEach(b => {
      const bars = parseFloat(b.dataset.bars || "0");
      b.classList.toggle("active", activeBars === bars);
    });
  $(deckIdx === 0 ? "loopStatusA" : "loopStatusB").textContent =
    activeBars > 0 ? `${activeBars}B ACTIVE` : "OFF";
}

// 5. 3-Band Isolator EQ, Kill Switches, Channel Volume Faders, Color Filter & Crossfader Controls
document.querySelectorAll<HTMLInputElement>("[data-eq-deck]").forEach(input => {
  const updateEq = () => {
    const deckIdx = Number(input.dataset.eqDeck) as 0 | 1;
    const band = input.dataset.eqBand as "low" | "mid" | "high";
    const db = parseFloat(input.value);
    mixer.decks[deckIdx].setEq(band, db);
    const labelId = `eqVal${deckIdx === 0 ? "A" : "B"}${band.charAt(0).toUpperCase() + band.slice(1)}`;
    $(labelId).textContent = `${db > 0 ? "+" : ""}${db.toFixed(0)}dB`;
  };
  input.addEventListener("input", updateEq);
  input.addEventListener("dblclick", () => {
    input.value = "0";
    updateEq();
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-kill-deck]").forEach(btn => {
  btn.addEventListener("click", () => {
    const deckIdx = Number(btn.dataset.killDeck) as 0 | 1;
    const band = btn.dataset.killBand as "low" | "mid" | "high";
    const killed = mixer.decks[deckIdx].toggleEqKill(band);
    btn.classList.toggle("active", killed);
    toast(`Deck ${deckIdx === 0 ? "A" : "B"} ${band.toUpperCase()} EQ ${killed ? "KILLED (-48dB)" : "Restored"}`);
  });
});

([0, 1] as const).forEach(slot => {
  const prefix = slot === 0 ? "A" : "B";
  const input = $<HTMLInputElement>(`chanVol${prefix}`);
  input.addEventListener("input", () => {
    const v = parseFloat(input.value || "1");
    mixer.setDeckChannelVolume(slot, v);
    $(`chanVolVal${prefix}`).textContent = `${Math.round(v * 100)}%`;
  });
  input.addEventListener("dblclick", () => {
    input.value = "1";
    mixer.setDeckChannelVolume(slot, 1);
    $(`chanVolVal${prefix}`).textContent = "100%";
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-cf-curve]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>("[data-cf-curve]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const curve = (btn.dataset.cfCurve as CrossfaderCurve) || "blend";
    mixer.setCrossfaderCurve(curve);
    toast(
      curve === "cut"
        ? "Crossfader Curve: Turntablist Sharp Cut (12% edge)"
        : curve === "dip"
          ? "Crossfader Curve: Linear Club Dip"
          : "Crossfader Curve: Constant-Power Smooth Blend"
    );
  });
});

document.querySelectorAll<HTMLInputElement>("[data-color-deck]").forEach(input => {
  const updateColor = () => {
    const deckIdx = Number(input.dataset.colorDeck) as 0 | 1;
    const val = parseFloat(input.value);
    mixer.decks[deckIdx].setColorFilter(val);
    const label = $(deckIdx === 0 ? "colorValA" : "colorValB");
    if (Math.abs(val) < 0.05) label.textContent = "FLAT";
    else if (val < 0) label.textContent = `LP ${Math.round((1 + val) * 100)}%`;
    else label.textContent = `HP ${Math.round(val * 100)}%`;
  };
  input.addEventListener("input", updateColor);
  input.addEventListener("dblclick", () => {
    input.value = "0";
    updateColor();
  });
});

const crossfaderInput = $<HTMLInputElement>("crossfaderInput");
crossfaderInput.addEventListener("input", () => {
  mixer.setCrossfader(parseFloat(crossfaderInput.value));
});
crossfaderInput.addEventListener("dblclick", () => {
  crossfaderInput.value = "0";
  mixer.setCrossfader(0);
  toast("Crossfader centered (Both Deck A & Deck B live)");
});

// Club FX One-Shot Keys
document.querySelectorAll<HTMLButtonElement>("[data-fx]").forEach(btn => {
  btn.addEventListener("click", async () => {
    await mixer.ctx.resume();
    const fx = btn.dataset.fx as "dub-siren" | "sub-drop" | "laser-riser" | "vinyl-brake";
    mixer.triggerClubFX(fx);
    toast(`Triggered FX: ${btn.title || btn.textContent}`);
  });
});

// 5B. Hardware Web MIDI Controller Engine & Interactive MIDI Learn Matrix
let selectedMidiCategory = "all";

const midiEngine = new MidiControllerEngine({
  onCrossfader: pos => {
    mixer.setCrossfader(pos);
    crossfaderInput.value = pos.toFixed(2);
  },
  onChannelVolume: (deck, val01) => {
    mixer.setDeckChannelVolume(deck, val01);
    const prefix = deck === 0 ? "A" : "B";
    $<HTMLInputElement>(`chanVol${prefix}`).value = val01.toFixed(2);
    $(`chanVolVal${prefix}`).textContent = `${Math.round(val01 * 100)}%`;
  },
  onEq: (deck, band, db) => {
    mixer.decks[deck].setEq(band, db);
    const prefix = deck === 0 ? "A" : "B";
    const input = document.querySelector<HTMLInputElement>(
      `[data-eq-deck="${deck}"][data-eq-band="${band}"]`
    );
    if (input) input.value = String(db);
    const labelId = `eqVal${prefix}${band.charAt(0).toUpperCase() + band.slice(1)}`;
    $(labelId).textContent = `${db > 0 ? "+" : ""}${db.toFixed(0)}dB`;
  },
  onEqKill: (deck, band) => {
    const killed = mixer.decks[deck].toggleEqKill(band);
    const btn = document.querySelector<HTMLButtonElement>(
      `[data-kill-deck="${deck}"][data-kill-band="${band}"]`
    );
    if (btn) btn.classList.toggle("active", killed);
    const killId = `kill${band.charAt(0).toUpperCase() + band.slice(1)}${deck === 0 ? "A" : "B"}` as MidiControlId;
    midiEngine.sendControlLed(killId, killed);
    toast(`MIDI Deck ${deck === 0 ? "A" : "B"} ${band.toUpperCase()} EQ ${killed ? "KILLED (-48dB)" : "Restored"}`);
  },
  onColorFilter: (deck, val) => {
    mixer.decks[deck].setColorFilter(val);
    const input = document.querySelector<HTMLInputElement>(`[data-color-deck="${deck}"]`);
    if (input) input.value = val.toFixed(2);
    const label = $(deck === 0 ? "colorValA" : "colorValB");
    if (Math.abs(val) < 0.05) label.textContent = "FLAT";
    else if (val < 0) label.textContent = `LP ${Math.round((1 + val) * 100)}%`;
    else label.textContent = `HP ${Math.round(val * 100)}%`;
  },
  onPitchPct: (deck, pct) => {
    const newBpm = mixer.setDeckPitchPct(deck, pct);
    const prefix = deck === 0 ? "A" : "B";
    $<HTMLInputElement>(`pitchSlider${prefix}`).value = String(pct);
    $(`pitchVal${prefix}`).textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    if (newBpm > 0) {
      $(`waveLabel${prefix}`).textContent = `${slots[deck]?.name ?? "Track"} (${newBpm.toFixed(0)} BPM)`;
    }
  },
  onSeekNormalized: (deck, ratio01) => {
    const d = mixer.decks[deck];
    if (!d.buffer) return;
    const targetSec = ratio01 * d.buffer.duration;
    mixer.seekDeckContinuous(deck, targetSec);
  },
  onJogNudge: (deck, deltaSec, deltaDeg) => {
    platterAngles[deck] = (platterAngles[deck] + deltaDeg) % 360;
    mixer.nudgePlayhead(deck, deltaSec);
  },
  onBeatJump: (deck, deltaBeats) => {
    const newSec = mixer.beatJump(deck, deltaBeats);
    const sign = deltaBeats > 0 ? "+" : "";
    toast(`MIDI Deck ${deck === 0 ? "A" : "B"} Beatjump ${sign}${deltaBeats} Beats -> ${fmt(newSec)}`);
  },
  onPlatterTouch: (deck, touched) => {
    void mixer.ctx.resume();
    if (touched) {
      mixer.startManualScratch(deck);
    } else {
      const res = mixer.endManualScratch();
      if (res?.spliced) {
        toast(`MIDI Jog scratch spliced into Deck ${res.deck === 0 ? "A" : "B"} @ ${fmt(res.playheadSec)}`);
      }
    }
  },
  onJogScratchVelocity: (deck, velocity, deltaDeg) => {
    platterAngles[deck] = (platterAngles[deck] + deltaDeg) % 360;
    mixer.moveManualScratch(velocity);
  },
  onPlayToggle: deck => {
    void mixer.ctx.resume().then(() => {
      if (!slots[deck]) return;
      const nowPlaying = mixer.toggleDeckPlay(deck);
      if (nowPlaying && !sessionStartedAtMs) sessionStartedAtMs = Date.now();
      midiEngine.sendControlLed(deck === 0 ? "playA" : "playB", nowPlaying);
      void syncWakeLock();
      toast(`MIDI Deck ${deck === 0 ? "A" : "B"} ${nowPlaying ? "Playing" : "Paused"}`);
    });
  },
  onSyncDeck: deck => {
    if (!slots[deck]) return;
    const res = mixer.syncDeck(deck);
    syncPitchSlidersFromDecks();
    toast(`MIDI Deck ${deck === 0 ? "A" : "B"} Synced to ${res.syncedBpm.toFixed(1)} BPM`);
  },
  onPflToggle: deck => {
    const btn = $<HTMLButtonElement>(deck === 0 ? "cueListenA" : "cueListenB");
    btn.click();
    midiEngine.sendControlLed(deck === 0 ? "pflA" : "pflB", mixer.auditioningSlot === deck);
  },
  onLoopAction: (deck, action) => {
    const d = mixer.decks[deck];
    if (!d.buffer) return;
    if (action === "toggle") {
      d.setLoop(d.loopBars > 0 ? 0 : 4);
    } else if (action === "halve") {
      d.halveLoop();
    } else {
      d.doubleLoop();
    }
    updateLoopButtons(deck);
    midiEngine.sendControlLed(deck === 0 ? "loopToggleA" : "loopToggleB", d.loopBars > 0);
    toast(
      d.loopBars > 0
        ? `MIDI Deck ${deck === 0 ? "A" : "B"} Loop: ${d.loopBars}B`
        : `MIDI Deck ${deck === 0 ? "A" : "B"} Loop Released`
    );
  },
  onClubFx: fx => {
    void mixer.ctx.resume();
    mixer.triggerClubFX(fx);
    toast(`MIDI Club FX: ${fx.toUpperCase()}`);
  },
  onHotCue: (deck, cue) => {
    void mixer.ctx.resume();
    const meta = slots[deck];
    if (!meta?.analysis.cuePoints) return;
    const targetSec = meta.analysis.cuePoints[cue];
    mixer.seekDeck(deck, targetSec);
    toast(`MIDI Deck ${deck === 0 ? "A" : "B"} -> ${cue.toUpperCase()} (${fmt(targetSec)})`);
  },
  onScratchPad: patternId => {
    void mixer.ctx.resume();
    const res = mixer.triggerAutoscratch(patternId);
    if (res.ok) toast(`MIDI Pad: ${res.message}`);
  },
  onDrop90sAgent: () => {
    void trigger90sScratchAgent(false);
  },
  onSmartMix: () => {
    pad.click();
  },
  onStateChange: () => {
    renderMidiUi();
  },
  onLearned: binding => {
    toast(`MIDI Learned: ${binding.label} -> CH${binding.channel + 1} ${binding.kind.toUpperCase()}#${binding.number}`);
  },
  onMidiActivity: summary => {
    $("midiMonitorReadout").textContent = summary;
  },
});

function formatMidiAssignment(b: { kind: string; channel: number; number: number }): string {
  const ch = b.channel < 0 ? "ANY" : `CH${b.channel + 1}`;
  const kind =
    b.kind === "cc"
      ? `CC#${b.number}`
      : b.kind === "pitchbend"
        ? "PITCHBEND"
        : `NOTE#${b.number}`;
  return `${ch} ${kind}`;
}

function renderMidiUi() {
  const connectBtn = $<HTMLButtonElement>("midiConnectBtn");
  const connectLabel = $("midiConnectLabel");
  const devReadout = $("midiDevicesReadout");
  const summaryEl = $("midiDrawerSummary");
  const grid = $("midiMappingGrid");

  const nDevs = midiEngine.connectedInputs.length;
  connectBtn.setAttribute("aria-pressed", String(midiEngine.accessGranted));
  if (midiEngine.learningControlId) {
    connectLabel.textContent = "MIDI: LEARN";
  } else if (nDevs > 0) {
    connectLabel.textContent = `MIDI: ${nDevs} DECK${nDevs === 1 ? "" : "S"}`;
  } else if (midiEngine.accessGranted) {
    connectLabel.textContent = "MIDI: ARMED";
  } else {
    connectLabel.textContent = "MIDI: Standby";
  }

  devReadout.textContent =
    nDevs > 0
      ? `DEVICES (${nDevs}): ${midiEngine.connectedInputs.join(" · ").toUpperCase()}`
      : midiEngine.accessGranted
        ? "DEVICES: 0 PLUGGED IN (WEB MIDI ARMED)"
        : "DEVICES: CLICK CONNECT MIDI";

  summaryEl.textContent =
    nDevs > 0
      ? `WEB MIDI LIVE (${nDevs} CONTROLLER${nDevs === 1 ? "" : "S"} · CLICK ANY CONTROL TO LEARN)`
      : "HARDWARE WEB MIDI CONTROLLER & LEARN MATRIX";

  document.querySelectorAll<HTMLButtonElement>("[data-midi-profile]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.midiProfile === midiEngine.activeProfile);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-midi-jog-mode]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.midiJogMode === midiEngine.jogWheelMode);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-midi-jog-sens]").forEach(btn => {
    btn.classList.toggle(
      "active",
      Math.abs(parseFloat(btn.dataset.midiJogSens || "1.0") - midiEngine.jogSensitivity) < 0.05
    );
  });
  const pickupBtn = $<HTMLButtonElement>("midiSoftTakeoverBtn");
  pickupBtn.classList.toggle("active", midiEngine.softTakeoverEnabled);
  pickupBtn.setAttribute("aria-pressed", String(midiEngine.softTakeoverEnabled));
  pickupBtn.textContent = `PICKUP: ${midiEngine.softTakeoverEnabled ? "ON" : "OFF"}`;

  const clockBtn = $<HTMLButtonElement>("midiClockOutBtn");
  clockBtn.classList.toggle("active", midiEngine.midiClockOutEnabled);
  clockBtn.setAttribute("aria-pressed", String(midiEngine.midiClockOutEnabled));
  clockBtn.textContent = `24PPQN CLK: ${midiEngine.midiClockOutEnabled ? "ON" : "OFF"}`;

  grid.replaceChildren();
  const visible = midiEngine.bindings.filter(
    b => selectedMidiCategory === "all" || b.category === selectedMidiCategory
  );
  for (const b of visible) {
    const row = document.createElement("button");
    row.type = "button";
    const isLearning = midiEngine.learningControlId === b.controlId;
    row.className = `midi-map-row ${isLearning ? "learning" : ""}`;
    row.title = isLearning
      ? "Move any physical knob, fader, jog wheel, or pad on your MIDI controller now (or click again to cancel)"
      : `Click to arm MIDI Learn for ${b.label}`;

    const lbl = document.createElement("span");
    lbl.className = "midi-map-label";
    lbl.textContent = b.label;

    const code = document.createElement("span");
    code.className = "midi-map-code";
    code.textContent = isLearning ? "MOVE MIDI..." : formatMidiAssignment(b);

    row.append(lbl, code);
    row.addEventListener("click", async () => {
      if (!midiEngine.accessGranted && midiEngine.supported) {
        await midiEngine.connect();
      }
      midiEngine.armLearn(b.controlId);
    });
    grid.append(row);
  }
}

async function handleConnectMidiClick() {
  const drawer = $<HTMLDetailsElement>("midiControllerDrawer");
  drawer.open = true;
  const res = await midiEngine.connect();
  renderMidiUi();
  toast(res.message);
}

$("midiConnectBtn").addEventListener("click", () => void handleConnectMidiClick());
$("midiScanBtn").addEventListener("click", () => void handleConnectMidiClick());
$("midiResetMapBtn").addEventListener("click", () => {
  midiEngine.resetDefaultBindings();
  toast("Restored default Pioneer DDJ hardware controller MIDI mappings");
});

document.querySelectorAll<HTMLButtonElement>("[data-midi-profile]").forEach(btn => {
  btn.addEventListener("click", () => {
    const profile = (btn.dataset.midiProfile as MidiControllerProfileId) || "pioneer-ddj";
    midiEngine.applyControllerProfile(profile);
    const label =
      profile === "pioneer-ddj"
        ? "Pioneer DDJ-400 / FLX4 / SB3"
        : profile === "numark-hercules"
          ? "Numark Mixtrack / Hercules Inpulse"
          : "Generic Single-Channel USB Knob/Pad Bank";
    toast(`MIDI Profile loaded: ${label}`);
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-midi-jog-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = (btn.dataset.midiJogMode as MidiJogMode) || "vinyl";
    midiEngine.setJogWheelMode(mode);
    toast(
      mode === "vinyl"
        ? "MIDI Jog Mode: Direct Vinyl Scratch (Kaiser-Sinc + M44-7)"
        : "MIDI Jog Mode: Continuous Playhead Nudge (Phase Bend)"
    );
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-midi-jog-sens]").forEach(btn => {
  btn.addEventListener("click", () => {
    const sens = parseFloat(btn.dataset.midiJogSens || "1.0");
    midiEngine.setJogSensitivity(sens);
    toast(`MIDI Jog Sensitivity set to ${sens.toFixed(1)}x`);
  });
});

$("midiSoftTakeoverBtn").addEventListener("click", () => {
  midiEngine.setSoftTakeover(!midiEngine.softTakeoverEnabled);
  toast(
    midiEngine.softTakeoverEnabled
      ? "MIDI Soft-Takeover (Pickup Mode) ON — pots must cross current software value before changing"
      : "MIDI Soft-Takeover OFF — immediate 1:1 pot response"
  );
});

$("midiClockOutBtn").addEventListener("click", () => {
  midiEngine.midiClockOutEnabled = !midiEngine.midiClockOutEnabled;
  renderMidiUi();
  toast(
    midiEngine.midiClockOutEnabled
      ? "24 PPQN MIDI Timing Clock Out (0xF8) ARMED — syncing external hardware to Master BPM"
      : "24 PPQN MIDI Timing Clock Out OFF"
  );
});

$("midiExportJsonBtn").addEventListener("click", () => {
  const json = midiEngine.exportBindingsJson();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `party_dj_midi_map_${midiEngine.activeProfile}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Exported MIDI mapping JSON (${midiEngine.bindings.length} controls)`);
});

$<HTMLInputElement>("midiImportJsonInput").addEventListener("change", async e => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const res = midiEngine.importBindingsJson(text);
    toast(res.message);
  } finally {
    input.value = "";
  }
});

document.querySelectorAll<HTMLButtonElement>("[data-midi-cat]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>("[data-midi-cat]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedMidiCategory = btn.dataset.midiCat || "all";
    renderMidiUi();
  });
});

renderMidiUi();

// 6. Interactive Turntable Platter Drag-to-Scratch
function bindInteractivePlatter(platterId: string, deckIdx: 0 | 1) {
  const el = $(platterId);
  let dragging = false;
  let prevAngle = 0;
  let prevTime = 0;

  const getAngle = (clientX: number, clientY: number) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    return Math.atan2(clientY - cy, clientX - cx);
  };

  el.addEventListener("pointerdown", async e => {
    await mixer.ctx.resume();
    dragging = true;
    el.setPointerCapture(e.pointerId);
    prevAngle = getAngle(e.clientX, e.clientY);
    prevTime = performance.now();
    mixer.startManualScratch(deckIdx);
  });

  el.addEventListener("pointermove", e => {
    if (!dragging) return;
    const now = performance.now();
    const dt = Math.max(4, now - prevTime) / 1000;
    const curAngle = getAngle(e.clientX, e.clientY);
    let dTheta = curAngle - prevAngle;
    if (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    if (dTheta < -Math.PI) dTheta += 2 * Math.PI;

    const radPerSec = dTheta / dt;
    const velocity = radPerSec / 3.49;
    platterAngles[deckIdx] += (dTheta * 180) / Math.PI;
    mixer.moveManualScratch(velocity);

    prevAngle = curAngle;
    prevTime = now;
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    const res = mixer.endManualScratch();
    if (res?.spliced) {
      toast(
        `Spliced manual platter scratch into Deck ${res.deck === 0 ? "A" : "B"} @ ${fmt(res.playheadSec)}`
      );
    }
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
}
bindInteractivePlatter("platterA", 0);
bindInteractivePlatter("platterB", 1);

// 7. Crate & Queue Management (2-Column Hardware Track Cartridges)
async function loadTrackIntoDeck(slot: 0 | 1, item: CrateTrack) {
  if (mixer.playing && slot === mixer.active && !mixer.busy) {
    return toast(`Deck ${slot === 0 ? "A" : "B"} is live on air. Load into Deck ${slot === 0 ? "B" : "A"}.`);
  }
  try {
    let analysis = item.analysis;
    if (item.buffer) {
      analysis = mixer.loadBuffer(slot, item.buffer, item.analysis);
    } else if (item.file) {
      analysis = await mixer.loadFile(slot, item.file);
      item.analysis = analysis;
      item.buffer = mixer.decks[slot].buffer;
    }
    slots[slot] = {
      id: item.id,
      name: item.name,
      artist: item.artist,
      genre: item.genre,
      analysis,
    };
    // Automatically pre-sync incoming deck BPM to the active Master Deck so no manual SYNC click is needed
    if (slot === mixer.idle && slots[mixer.active]) {
      mixer.syncDeck(slot);
      syncPitchSlidersFromDecks();
    }
    updateDeckStaticLabels(slot);
    renderCrateCards();
    if (slot === mixer.active) {
      void autoStageScratchRoutine();
    }
  } catch {
    toast(`Couldn't decode ${item.name}. Try MP3, WAV, FLAC, or M4A.`);
  }
}

function updateDeckStaticLabels(slot: 0 | 1) {
  const m = slots[slot];
  const prefix = slot === 0 ? "A" : "B";
  if (!m) return;
  $(`deck${prefix}Title`).textContent = m.name;
  $(`waveLabel${prefix}`).textContent = `${m.name} (${m.analysis.bpm.toFixed(0)} BPM)`;
  const energyPct = Math.round((m.analysis.energy ?? 0.8) * 100);
  const agDb = m.analysis.autoGainDb ?? 0;
  const agStr = `${agDb >= 0 ? "+" : ""}${agDb.toFixed(1)}dB`;
  $(`deck${prefix}Meta`).textContent = `${m.analysis.bpm.toFixed(1)} BPM / Key ${m.analysis.key ?? "8A"} / E:${energyPct}% / AG:${agStr}`;

  if (m.analysis.cuePoints) {
    $(`cueTime${prefix}Intro`).textContent = fmt(m.analysis.cuePoints.intro);
    $(`cueTime${prefix}Drop`).textContent = fmt(m.analysis.cuePoints.drop);
    $(`cueTime${prefix}Break`).textContent = fmt(m.analysis.cuePoints.breakdown);
    $(`cueTime${prefix}Outro`).textContent = fmt(m.analysis.cuePoints.outro);
  }
  updateLoopButtons(slot);
}

function getFilteredCrate(): CrateTrack[] {
  const activeKey = slots[mixer.active]?.analysis.key ?? "8A";
  const q = crateSearchQuery.trim().toLowerCase();
  return crate.filter(item => {
    if (crateHarmonicOnly) {
      const match = evaluateHarmonicMatch(activeKey, item.analysis.key);
      if (match.score < 0.8) return false;
    }
    if (!q) return true;
    const hay = `${item.name} ${item.artist} ${item.genre} ${item.analysis.key ?? ""} ${item.analysis.bpm.toFixed(0)}`.toLowerCase();
    return hay.includes(q);
  });
}

$<HTMLInputElement>("crateSearchInput").addEventListener("input", e => {
  crateSearchQuery = (e.target as HTMLInputElement).value;
  renderCrateCards();
});

const crateKeyFilterBtn = $<HTMLButtonElement>("crateKeyFilterBtn");
crateKeyFilterBtn.addEventListener("click", () => {
  crateHarmonicOnly = !crateHarmonicOnly;
  crateKeyFilterBtn.classList.toggle("active", crateHarmonicOnly);
  crateKeyFilterBtn.setAttribute("aria-pressed", String(crateHarmonicOnly));
  crateKeyFilterBtn.textContent = `HARMONIC MATCH ONLY: ${crateHarmonicOnly ? "ON" : "OFF"}`;
  renderCrateCards();
});

$("queueAllCrateBtn").addEventListener("click", () => {
  const filtered = getFilteredCrate();
  let added = 0;
  for (const item of filtered) {
    if (!queue.some(q => q.id === item.id)) {
      queue.push(item);
      added++;
    }
  }
  renderQueue();
  void fill();
  toast(added > 0 ? `Queued ${added} track(s) from crate` : "All matching crate tracks are already in queue");
});

$("shuffleQueueBtn").addEventListener("click", () => {
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  renderQueue();
  toast("Shuffled Up Next Queue");
});

$("clearQueueBtn").addEventListener("click", () => {
  queue.length = 0;
  renderQueue();
  toast("Cleared Up Next Queue");
});

function renderQueue() {
  const ol = $("queue");
  ol.replaceChildren();
  $("queueCount").textContent = `${queue.length}`;
  const anchorMeta = slots[mixer.active] ?? slots[0];
  let prevBpm = anchorMeta?.analysis.bpm ?? 124;
  let prevKey = anchorMeta?.analysis.key ?? "8A";
  const targetE = getCurrentTargetEnergy();

  queue.forEach((item, i) => {
    const li = document.createElement("li");
    const s = document.createElement("span");
    const act = document.createElement("div");
    act.className = "queue-item-actions";
    const sc = scoreNextTrackCandidate({ bpm: prevBpm, key: prevKey }, item, targetE);
    prevBpm = item.analysis.bpm;
    prevKey = item.analysis.key ?? prevKey;

    s.textContent = `${item.name} (${item.analysis.bpm.toFixed(0)} BPM · ${item.analysis.key ?? "8A"} · Fit ${Math.round(sc.total * 100)}%)`;

    if (i > 0) {
      const topBtn = document.createElement("button");
      topBtn.type = "button";
      topBtn.textContent = "Top";
      topBtn.title = "Move to top of queue (Play Next)";
      topBtn.onclick = () => {
        const [picked] = queue.splice(i, 1);
        queue.unshift(picked);
        renderQueue();
      };
      act.append(topBtn);
    }

    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Remove";
    b.setAttribute("aria-label", `Remove ${item.name}`);
    b.onclick = () => {
      queue.splice(i, 1);
      renderQueue();
    };
    act.append(b);
    li.append(s, act);
    ol.append(li);
  });
}

function renderCrateCards() {
  const container = $("crateBody");
  container.replaceChildren();
  const activeKey = slots[mixer.active]?.analysis.key ?? "8A";
  const visible = getFilteredCrate();

  for (const item of visible) {
    const card = document.createElement("div");
    card.className = "crate-card";
    card.setAttribute("role", "listitem");

    const match = evaluateHarmonicMatch(activeKey, item.analysis.key);

    const infoDiv = document.createElement("div");
    infoDiv.className = "crate-card-info";

    const titleEl = document.createElement("div");
    titleEl.className = "crate-card-title";
    titleEl.textContent = item.name;

    const metaEl = document.createElement("div");
    metaEl.className = "crate-card-meta";
    metaEl.textContent = `${item.analysis.bpm.toFixed(0)} BPM / Key ${item.analysis.key ?? "8A"} / ${match.label}`;

    infoDiv.append(titleEl, metaEl);

    const actWrap = document.createElement("div");
    actWrap.className = "crate-actions";

    const btnA = document.createElement("button");
    btnA.type = "button";
    btnA.className = "btn-micro";
    btnA.textContent = "Deck A";
    btnA.onclick = () => {
      void loadTrackIntoDeck(0, item);
      toast(`Loaded "${item.name}" into Deck A`);
    };

    const btnB = document.createElement("button");
    btnB.type = "button";
    btnB.className = "btn-micro";
    btnB.textContent = "Deck B";
    btnB.onclick = () => {
      void loadTrackIntoDeck(1, item);
      toast(`Loaded "${item.name}" into Deck B`);
    };

    const btnQ = document.createElement("button");
    btnQ.type = "button";
    btnQ.className = "btn-micro";
    btnQ.textContent = "+ Queue";
    btnQ.onclick = () => {
      queue.push(item);
      renderQueue();
      void fill();
      toast(`Queued "${item.name}"`);
    };

    actWrap.append(btnA, btnB, btnQ);
    card.append(infoDiv, actWrap);
    container.append(card);
  }
}

/** Keep the idle deck (or both decks before Start) loaded from the queue. */
async function fill() {
  if (loading) return;
  loading = true;
  try {
    const targets: (0 | 1)[] = mixer.playing ? (mixer.busy ? [] : [mixer.idle]) : [0, 1];
    for (const slot of targets) {
      if (slots[slot] || !queue.length) continue;
      const nextItem = queue.shift()!;
      renderQueue();
      await loadTrackIntoDeck(slot, nextItem);
    }
  } finally {
    loading = false;
    renderQueue();
  }
}

function autoSequenceQueueSilently() {
  if (queue.length < 2) return;
  const activeMeta = slots[mixer.active] ?? slots[0];
  const anchor = {
    bpm: activeMeta?.analysis.bpm ?? 124,
    key: activeMeta?.analysis.key ?? "8A",
  };
  const tpl = getActiveTemplate();
  const reordered = sequenceCrateForParty(anchor, queue, tpl.energyCurve, getSessionProgress01());
  queue.splice(0, queue.length, ...reordered);
}

async function addFiles(list: FileList | null) {
  const files = Array.from(list ?? []).filter(
    f => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f.name)
  );
  if (!files.length) return toast("Unsupported file type. Try MP3, WAV, FLAC, or M4A.");

  toast(`Analyzing ${files.length} audio ${files.length === 1 ? "file" : "files"}...`);
  for (const f of files) {
    try {
      const buf = await mixer.ctx.decodeAudioData(await f.arrayBuffer());
      const tempDeckSlot = (!slots[0] ? 0 : !slots[1] ? 1 : mixer.idle) as 0 | 1;
      const analysis =
        !slots[tempDeckSlot]
          ? mixer.loadBuffer(tempDeckSlot, buf)
          : (await import("./engine/analysis")).analyze(buf);

      const item: CrateTrack = {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: clean(f.name),
        artist: "Custom Audio",
        genre: "User Stem",
        buffer: buf,
        file: f,
        analysis,
      };
      crate.unshift(item);
      queue.push(item);
      if (!slots[tempDeckSlot]) {
        slots[tempDeckSlot] = {
          id: item.id,
          name: item.name,
          artist: item.artist,
          genre: item.genre,
          analysis,
        };
        updateDeckStaticLabels(tempDeckSlot);
      }
    } catch {
      toast(`Couldn't read ${f.name}. Try an MP3, WAV or M4A file.`);
    }
  }
  autoSequenceQueueSilently();
  renderCrateCards();
  renderQueue();
  await fill();
  evictIdleCrateBuffers();
  toast(`Added & auto-sequenced ${files.length} track(s) by Camelot Key, BPM & Energy Curve`);
}

$<HTMLInputElement>("files").addEventListener("change", e => {
  const t = e.target as HTMLInputElement;
  void addFiles(t.files);
  t.value = "";
});

const drop = $("drop");
window.addEventListener("dragover", e => {
  e.preventDefault();
  drop.classList.add("over");
});
window.addEventListener("dragleave", e => {
  if (!e.relatedTarget) drop.classList.remove("over");
});
window.addEventListener("drop", e => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer?.files?.length) {
    void addFiles(e.dataTransfer.files);
  }
});

// 8. Primary Hero Smart Mix Pad & Transport Controls
const pad = $<HTMLButtonElement>("pad");
async function triggerPrimaryAction() {
  await mixer.ctx.resume();
  if (!mixer.playing) {
    if (mixer.play()) {
      if (!sessionStartedAtMs) sessionStartedAtMs = Date.now();
      logTrackToSetlist(slots[mixer.active], "Set Opener", "Master Lock");
      void syncWakeLock();
      toast("Party Started - Auto-DJ, Beat Grid, Auto-Gain & Club Limiter Active");
      void fill();
    } else {
      toast("Add a song first");
    }
    return;
  }
  const { preset, autoReason } = resolveActiveTransitionPreset();
  const incomingMeta = slots[mixer.idle];
  const r = mixer.next(preset);
  if (!r.ok) return toast(r.reason);
  freePending = true;
  logTrackToSetlist(incomingMeta, preset.name, r.harmonicLabel);
  const shiftPct = ((r.rate - 1) * 100).toFixed(1);
  const modeTag = autoReason ? `Auto: ${preset.name}` : preset.name;
  toast(
    r.clamped
      ? `Smart Mix (${modeTag}) - Wide tempo range clamped`
      : `Smart Mix (${modeTag}) - ${r.harmonicLabel} (Tempo ${shiftPct}%)`
  );
}
pad.onclick = () => void triggerPrimaryAction();

$("playPauseToggle").addEventListener("click", async () => {
  await mixer.ctx.resume();
  if (mixer.playing) {
    mixer.pause();
    void syncWakeLock();
    toast("Playback Paused");
  } else if (mixer.play()) {
    if (!sessionStartedAtMs) sessionStartedAtMs = Date.now();
    void syncWakeLock();
    toast("Playback Resumed");
  }
});

// Keyboard Shortcuts (Space = Start/Mix, G = Drop 90s Agent Cut, R = Reroll Agent, 1-8 = Autoscratch Pads)
window.addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.code === "Space") {
    e.preventDefault();
    void triggerPrimaryAction();
  } else if (e.key === "g" || e.key === "G") {
    e.preventDefault();
    void trigger90sScratchAgent(false);
  } else if (e.key === "r" || e.key === "R") {
    e.preventDefault();
    void trigger90sScratchAgent(true);
  } else if (e.key >= "1" && e.key <= "8") {
    const idx = parseInt(e.key, 10) - 1;
    const pat = SCRATCH_PATTERNS[idx];
    if (pat) {
      void mixer.ctx.resume().then(() => {
        const res = mixer.triggerAutoscratch(pat.id);
        if (res.ok) toast(`Autoscratch: ${res.message}`);
      });
    }
  }
});

// 9. Waveform Click-to-Seek
const waveCanvas = $<HTMLCanvasElement>("waveCanvas");
waveCanvas.addEventListener("click", async e => {
  await mixer.ctx.resume();
  const rect = waveCanvas.getBoundingClientRect();
  const yRatio = (e.clientY - rect.top) / rect.height;
  const xRatio = (e.clientX - rect.left) / rect.width;
  const targetDeck: 0 | 1 = yRatio < 0.5 ? 0 : 1;
  const d = mixer.decks[targetDeck];
  if (!d.buffer) return;
  const targetSec = xRatio * d.buffer.duration;
  mixer.seekDeck(targetDeck, targetSec);
  toast(`Deck ${targetDeck === 0 ? "A" : "B"} seeked to ${fmt(targetSec)}`);
});

// 10. Canvas Renderers: Parallel 3-Band Waveforms, Scratch Scope & Marathon Energy Curve
const waveCtx = waveCanvas.getContext("2d")!;
const scopeCanvas = $<HTMLCanvasElement>("scratchScope");
const scopeCtx = scopeCanvas.getContext("2d")!;
const energyCurveCanvas = $<HTMLCanvasElement>("energyCurveCanvas");
const energyCurveCtx = energyCurveCanvas.getContext("2d")!;

function drawEnergyCurve() {
  const W = energyCurveCanvas.width;
  const H = energyCurveCanvas.height;
  energyCurveCtx.fillStyle = "#07090d";
  energyCurveCtx.fillRect(0, 0, W, H);

  const tpl = getActiveTemplate();
  const curve = tpl.energyCurve;
  const prog = getSessionProgress01();
  const targetE = interpolateEnergyCurve(curve, prog);

  // Grid line
  energyCurveCtx.strokeStyle = "rgba(255,255,255,0.07)";
  energyCurveCtx.lineWidth = 1;
  energyCurveCtx.beginPath();
  energyCurveCtx.moveTo(0, H * 0.5);
  energyCurveCtx.lineTo(W, H * 0.5);
  energyCurveCtx.stroke();

  // Fill under target energy curve
  energyCurveCtx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    const x = (i / Math.max(1, curve.length - 1)) * W;
    const y = H - 4 - curve[i] * (H - 10);
    if (i === 0) energyCurveCtx.moveTo(x, y);
    else energyCurveCtx.lineTo(x, y);
  }
  energyCurveCtx.strokeStyle = "#f59e0b";
  energyCurveCtx.lineWidth = 2;
  energyCurveCtx.stroke();

  energyCurveCtx.lineTo(W, H);
  energyCurveCtx.lineTo(0, H);
  energyCurveCtx.closePath();
  energyCurveCtx.fillStyle = "rgba(245, 158, 11, 0.14)";
  energyCurveCtx.fill();

  // Plot queued track energy dots along upcoming horizon
  for (let i = 0; i < Math.min(6, queue.length); i++) {
    const qProg = Math.min(1, prog + (i + 1) * 0.1);
    const qx = qProg * W;
    const qe = queue[i].analysis.energy ?? 0.75;
    const qy = H - 4 - qe * (H - 10);
    energyCurveCtx.fillStyle = "#38bdf8";
    energyCurveCtx.beginPath();
    energyCurveCtx.arc(qx, qy, 3, 0, Math.PI * 2);
    energyCurveCtx.fill();
  }

  // Current set progress playhead & target dot
  const cx = prog * W;
  const cy = H - 4 - targetE * (H - 10);
  energyCurveCtx.strokeStyle = "#ffffff";
  energyCurveCtx.lineWidth = 1.5;
  energyCurveCtx.beginPath();
  energyCurveCtx.moveTo(cx, 0);
  energyCurveCtx.lineTo(cx, H);
  energyCurveCtx.stroke();

  energyCurveCtx.fillStyle = "#fbbf24";
  energyCurveCtx.beginPath();
  energyCurveCtx.arc(cx, cy, 4, 0, Math.PI * 2);
  energyCurveCtx.fill();
}

function drawParallelWaveforms() {
  const W = waveCanvas.width;
  const H = waveCanvas.height;
  const halfH = H * 0.5;

  waveCtx.fillStyle = "#05070a";
  waveCtx.fillRect(0, 0, W, H);

  // Center horizontal divider between Deck A and Deck B
  waveCtx.strokeStyle = "rgba(255,255,255,0.1)";
  waveCtx.lineWidth = 1;
  waveCtx.beginPath();
  waveCtx.moveTo(0, halfH);
  waveCtx.lineTo(W, halfH);
  waveCtx.stroke();

  for (let slot = 0 as 0 | 1; slot <= 1; slot = (slot + 1) as 0 | 1) {
    const d = mixer.decks[slot];
    const meta = slots[slot];
    const topY = slot === 0 ? 0 : halfH;
    const centerY = topY + halfH * 0.5;
    const maxAmp = halfH * 0.42;

    if (!d.buffer || !meta || !(d.analysis?.waveform ?? meta.analysis.waveform)) continue;

    const wf = (d.analysis?.waveform ?? meta.analysis.waveform)!;
    const dur = d.buffer.duration;
    const curSec = d.currentOffset();
    const curRatio = curSec / Math.max(0.1, dur);
    const n = wf.low.length;
    const barW = W / n;

    // Cohesive Warm Amber / Titanium 3-Band Spectrum
    for (let i = 0; i < n; i++) {
      const x = i * barW;
      const played = i / n <= curRatio;
      const alpha = played ? 0.35 : 0.9;

      const lAmp = wf.low[i] * maxAmp;
      const mAmp = wf.mid[i] * maxAmp * 0.78;
      const hAmp = wf.high[i] * maxAmp * 0.55;

      // Low Band (Warm Amber on Deck A, Cool Silver-Slate on Deck B)
      waveCtx.fillStyle =
        slot === 0 ? `rgba(245, 158, 11, ${alpha})` : `rgba(148, 163, 184, ${alpha})`;
      waveCtx.fillRect(x, centerY - lAmp, Math.max(1.5, barW - 0.5), lAmp * 2);

      // Mid Band
      waveCtx.fillStyle =
        slot === 0 ? `rgba(251, 191, 36, ${alpha * 0.75})` : `rgba(203, 213, 225, ${alpha * 0.75})`;
      waveCtx.fillRect(x, centerY - mAmp, Math.max(1.5, barW - 0.5), mAmp * 2);

      // High Band
      waveCtx.fillStyle = `rgba(241, 245, 249, ${alpha * 0.65})`;
      waveCtx.fillRect(x, centerY - hAmp, Math.max(1.5, barW - 0.5), hAmp * 2);
    }

    // Highlight permanently spliced scratch regions in the music file
    if (d.modRegions.length > 0) {
      waveCtx.font = "600 8px 'JetBrains Mono', monospace";
      for (const reg of d.modRegions) {
        const rx = (reg.startSec / dur) * W;
        const rw = Math.max(3, ((reg.endSec - reg.startSec) / dur) * W);
        waveCtx.fillStyle = "rgba(56, 189, 248, 0.22)";
        waveCtx.fillRect(rx, topY + 1, rw, halfH - 2);
        waveCtx.strokeStyle = "rgba(56, 189, 248, 0.85)";
        waveCtx.lineWidth = 1;
        waveCtx.strokeRect(rx, topY + 1, rw, halfH - 2);
        if (rw > 18) {
          waveCtx.fillStyle = "#38bdf8";
          waveCtx.fillText("MOD", rx + 2, topY + halfH - 3);
        }
      }
    }

    // Draw Bar Grid ticks
    const secPerBar = (60 / meta.analysis.bpm) * 4;
    waveCtx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    waveCtx.lineWidth = 1;
    for (let t = meta.analysis.firstBeat; t < dur; t += secPerBar) {
      const x = (t / dur) * W;
      waveCtx.beginPath();
      waveCtx.moveTo(x, topY + 2);
      waveCtx.lineTo(x, topY + halfH - 2);
      waveCtx.stroke();
    }

    // Draw Cue Flags (IN, DROP, BRK, OUT)
    if (meta.analysis.cuePoints) {
      const cues: Array<[string, number]> = [
        ["IN", meta.analysis.cuePoints.intro],
        ["DROP", meta.analysis.cuePoints.drop],
        ["BRK", meta.analysis.cuePoints.breakdown],
        ["OUT", meta.analysis.cuePoints.outro],
      ];
      waveCtx.font = "600 9px 'JetBrains Mono', monospace";
      for (const [label, sec] of cues) {
        const cx = (sec / dur) * W;
        waveCtx.strokeStyle = "rgba(251, 191, 36, 0.75)";
        waveCtx.beginPath();
        waveCtx.moveTo(cx, topY);
        waveCtx.lineTo(cx, topY + halfH);
        waveCtx.stroke();
        waveCtx.fillStyle = "#fbbf24";
        waveCtx.fillText(label, cx + 3, topY + 10);
      }
    }

    // Draw Deck Playhead Needle
    const px = curRatio * W;
    waveCtx.strokeStyle = "#ffffff";
    waveCtx.lineWidth = 2;
    waveCtx.beginPath();
    waveCtx.moveTo(px, topY);
    waveCtx.lineTo(px, topY + halfH);
    waveCtx.stroke();
  }
}

const PRIMITIVE_COLORS: Record<string, string> = {
  baby: "#f59e0b",
  stab: "#fbbf24",
  cut_forward: "#38bdf8",
  transform: "#c084fc",
  flare: "#22d3ee",
  chirp: "#fb923c",
  tear: "#a3e635",
  crab: "#f472b6",
  rest: "#64748b",
};

scopeCanvas.style.cursor = "pointer";
scopeCanvas.title = "Click any placed scratch event block to cycle its primitive · Shift+Click to drop live";
scopeCanvas.addEventListener("click", async e => {
  if (!lastAgentOutput?.result) return;
  const res = lastAgentOutput.result;
  const rect = scopeCanvas.getBoundingClientRect();
  const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
  const bpm = mixer.info()?.effBpm ?? slots[mixer.active]?.analysis.bpm ?? 124;
  const totalSec = res.plan.bars * 4 * (60 / bpm);
  const clickSec = clickRatio * totalSec;

  let hitIdx = -1;
  for (let i = 0; i < res.events.length; i++) {
    const ev = res.events[i];
    const dur = ev.n_strokes * ev.stroke_T;
    if (clickSec >= ev.t0 - 0.04 && clickSec <= ev.t0 + dur + 0.04) {
      hitIdx = i;
      break;
    }
  }
  if (hitIdx >= 0) {
    if (e.shiftKey) await mixer.ctx.resume();
    const updated = mixer.cycleScratchAgentEventPrimitive(lastAgentOutput, hitIdx, e.shiftKey);
    if (updated) {
      lastAgentOutput = updated;
      renderAgentInspector(updated);
      toast(updated.message);
    }
  }
});

function drawScratchScope(telemetry: ReturnType<typeof mixer.scratchTelemetry>) {
  const W = scopeCanvas.width;
  const H = scopeCanvas.height;
  scopeCtx.fillStyle = "#07090d";
  scopeCtx.fillRect(0, 0, W, H);

  const showAgentTimeline =
    lastAgentOutput?.result &&
    (telemetry.patternId === "agent" || !telemetry.active);

  if (showAgentTimeline && lastAgentOutput?.result) {
    const res = lastAgentOutput.result;
    const bpm = mixer.info()?.effBpm ?? slots[mixer.active]?.analysis.bpm ?? 124;
    const totalSec = res.plan.bars * 4 * (60 / bpm);

    // Center line
    scopeCtx.strokeStyle = "rgba(255,255,255,0.08)";
    scopeCtx.lineWidth = 1;
    scopeCtx.beginPath();
    scopeCtx.moveTo(0, H * 0.5);
    scopeCtx.lineTo(W, H * 0.5);
    scopeCtx.stroke();

    // Beat grid lines across the phrase
    const totalBeats = res.plan.bars * 4;
    for (let b = 0; b <= totalBeats; b++) {
      const x = (b / totalBeats) * W;
      const isBar = b % 4 === 0;
      scopeCtx.strokeStyle = isBar ? "rgba(251, 191, 36, 0.32)" : "rgba(255, 255, 255, 0.09)";
      scopeCtx.lineWidth = isBar ? 1.5 : 1;
      scopeCtx.beginPath();
      scopeCtx.moveTo(x, 0);
      scopeCtx.lineTo(x, H);
      scopeCtx.stroke();
    }

    // Placed 90s ScratchEvent blocks (baby, stab, cut_forward, transform)
    scopeCtx.font = "600 8px 'JetBrains Mono', monospace";
    for (const ev of res.events) {
      const x0 = (ev.t0 / totalSec) * W;
      const dur = ev.n_strokes * ev.stroke_T;
      const w = Math.max(4, (dur / totalSec) * W);
      const col = PRIMITIVE_COLORS[ev.primitive] ?? "#f59e0b";
      scopeCtx.fillStyle = `${col}2e`;
      scopeCtx.strokeStyle = col;
      scopeCtx.lineWidth = 1;
      scopeCtx.fillRect(x0, 3, w, H - 6);
      scopeCtx.strokeRect(x0, 3, w, H - 6);
      if (w > 24) {
        scopeCtx.fillStyle = "#f8fafc";
        scopeCtx.fillText(ev.primitive.slice(0, 5).toUpperCase(), x0 + 3, 12);
      }
    }

    // Rendered Kaiser-windowed sinc scratch audio waveform overlay
    const audio = res.audio;
    const step = Math.max(1, Math.floor(audio.length / W));
    scopeCtx.strokeStyle = telemetry.active ? "#fbbf24" : "#f59e0b";
    scopeCtx.lineWidth = 1.3;
    scopeCtx.beginPath();
    for (let px = 0; px < W; px++) {
      let pk = 0;
      const base = px * step;
      for (let j = 0; j < step && base + j < audio.length; j++) {
        const v = audio[base + j];
        if (Math.abs(v) > Math.abs(pk)) pk = v;
      }
      const y = H * 0.55 - Math.max(-1, Math.min(1, pk)) * (H * 0.36);
      if (px === 0) scopeCtx.moveTo(px, y);
      else scopeCtx.lineTo(px, y);
    }
    scopeCtx.stroke();

    // Live playhead needle when active
    if (telemetry.active) {
      const cx = telemetry.progress * W;
      scopeCtx.strokeStyle = "#ffffff";
      scopeCtx.lineWidth = 1.8;
      scopeCtx.beginPath();
      scopeCtx.moveTo(cx, 0);
      scopeCtx.lineTo(cx, H);
      scopeCtx.stroke();
    }
    return;
  }

  // 16th-note precision grid lines on Pad / Manual Scratch Scope
  for (let gIdx = 1; gIdx < 8; gIdx++) {
    const gx = (gIdx / 8) * W;
    scopeCtx.strokeStyle = gIdx % 2 === 0 ? "rgba(251, 191, 36, 0.2)" : "rgba(255, 255, 255, 0.06)";
    scopeCtx.lineWidth = 1;
    scopeCtx.beginPath();
    scopeCtx.moveTo(gx, 0);
    scopeCtx.lineTo(gx, H);
    scopeCtx.stroke();
  }

  scopeCtx.strokeStyle = "rgba(255,255,255,0.1)";
  scopeCtx.lineWidth = 1;
  scopeCtx.beginPath();
  scopeCtx.moveTo(0, H * 0.5);
  scopeCtx.lineTo(W, H * 0.5);
  scopeCtx.stroke();

  const curve = telemetry.curveSamples;
  const gate = telemetry.gateSamples;
  const len = curve.length;

  // VCA Gate Bar along bottom
  for (let i = 0; i < len; i++) {
    const x = (i / len) * W;
    const g = gate[i];
    scopeCtx.fillStyle = g > 0.25 ? "rgba(245, 158, 11, 0.22)" : "rgba(100, 116, 139, 0.12)";
    scopeCtx.fillRect(x, H - 7, W / len + 0.5, 7);
  }

  // Vinyl Platter Displacement Trajectory
  scopeCtx.strokeStyle = telemetry.active ? "#fbbf24" : "#94a3b8";
  scopeCtx.lineWidth = 1.8;
  scopeCtx.beginPath();
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * W;
    const normY = H * 0.5 - Math.max(-1, Math.min(1, curve[i])) * (H * 0.36);
    if (i === 0) scopeCtx.moveTo(x, normY);
    else scopeCtx.lineTo(x, normY);
  }
  scopeCtx.stroke();

  if (telemetry.active) {
    const cx = telemetry.progress * W;
    scopeCtx.strokeStyle = "#ffffff";
    scopeCtx.lineWidth = 1.5;
    scopeCtx.beginPath();
    scopeCtx.moveTo(cx, 0);
    scopeCtx.lineTo(cx, H);
    scopeCtx.stroke();
  }
}

// 11. Initialize Built-In Studio Crate (Analyzed directly from PCM via analyze())
function bootstrapStudioCrate() {
  for (const spec of BUILTIN_TRACK_SPECS) {
    const buf = synthesizeStudioTrack(mixer.ctx, spec);
    const tempSlot = crate.length < 2 ? (crate.length as 0 | 1) : 1;
    const analysis = mixer.loadBuffer(tempSlot, buf);

    const item: CrateTrack = {
      id: spec.id,
      name: spec.title,
      artist: spec.artist,
      genre: spec.genre,
      buffer: buf,
      analysis,
    };
    crate.push(item);
  }

  // Auto-sequence the entire built-in crate by the active Party Template energy curve on startup
  const tpl = getActiveTemplate();
  const sequenced = sequenceCrateForParty(
    { bpm: crate[0]?.analysis.bpm ?? 124, key: crate[0]?.analysis.key ?? "8A" },
    crate.slice(1),
    tpl.energyCurve,
    0
  );
  const deckATrack = crate[0];
  const deckBTrack = sequenced[0] ?? crate[1];
  const remainingQueue = sequenced.slice(1);

  if (deckATrack?.buffer) {
    const a0 = mixer.loadBuffer(0, deckATrack.buffer, deckATrack.analysis);
    slots[0] = {
      id: deckATrack.id,
      name: deckATrack.name,
      artist: deckATrack.artist,
      genre: deckATrack.genre,
      analysis: a0,
    };
    updateDeckStaticLabels(0);
  }
  if (deckBTrack?.buffer) {
    const a1 = mixer.loadBuffer(1, deckBTrack.buffer, deckBTrack.analysis);
    slots[1] = {
      id: deckBTrack.id,
      name: deckBTrack.name,
      artist: deckBTrack.artist,
      genre: deckBTrack.genre,
      analysis: a1,
    };
    mixer.syncDeck(1);
    syncPitchSlidersFromDecks();
    updateDeckStaticLabels(1);
  }
  queue.push(...remainingQueue);
  renderCrateCards();
  renderQueue();
  updateRamAndWakeBadge();

  // Sync persisted booth toggle UI states & pre-stage the 90s Scratch Agent scope
  autoPilotBtn.setAttribute("aria-pressed", String(autoPilotEnabled));
  autoPilotBtn.innerHTML = `<span class="switch-led"></span><span>Auto-DJ: ${autoPilotEnabled ? "On" : "Off"}</span>`;
  autoScratchToggle.classList.toggle("active", autoScratchDrops);
  autoScratchToggle.setAttribute("aria-pressed", String(autoScratchDrops));
  autoScratchToggle.textContent = `AUTO-SCRATCH DROPS: ${autoScratchDrops ? "ON" : "OFF"}`;
  autoGainToggle.classList.toggle("active", mixer.autoGainEnabled);
  autoGainToggle.setAttribute("aria-pressed", String(mixer.autoGainEnabled));
  autoGainToggle.textContent = `AUTO-GAIN: ${mixer.autoGainEnabled ? "ON" : "OFF"}`;
  document.querySelectorAll<HTMLButtonElement>("[data-cf-curve]").forEach(b => {
    b.classList.toggle("active", b.dataset.cfCurve === mixer.crossfaderCurve);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-marathon-mins]").forEach(b => {
    b.classList.toggle("active", parseInt(b.dataset.marathonMins || "240", 10) === marathonDurationMins);
  });
  void autoStageScratchRoutine();
}
bootstrapStudioCrate();

// 12. Main 60fps UI & Physics Loop
function tick(nowPerf = performance.now()) {
  const dt = Math.min(0.1, Math.max(0.001, (nowPerf - lastFrameTime) / 1000));
  lastFrameTime = nowPerf;

  const info = mixer.info();
  const playing = !!info;
  document.body.classList.toggle("playing", playing);

  const scratch = mixer.scratchTelemetry();

  const shown = info ? slots[info.deck] : slots[0];
  const nextSlot = slots[mixer.idle];
  $("title").textContent = shown?.name ?? "Nothing playing yet";
  $("meta").textContent = info
    ? `${info.effBpm.toFixed(1)} BPM / Key ${shown?.analysis.key ?? "8A"} (${shown?.analysis.keyName ?? "Minor"})`
    : shown
      ? `${shown.analysis.bpm.toFixed(1)} BPM / Key ${shown.analysis.key ?? "8A"} Ready`
      : "Load audio below to start";

  $("fill").style.width = info ? `${(info.elapsed / info.duration) * 100}%` : "0%";
  $("elapsed").textContent = fmt(info?.elapsed ?? 0);
  $("left").textContent = `-${fmt(info?.remaining ?? 0)}`;
  $("ring").style.strokeDashoffset = String(RING * (1 - (info?.fade ?? 0)));

  const masterBpm = info?.effBpm ?? shown?.analysis.bpm ?? 124;
  $("masterBpmReadout").textContent = `${masterBpm.toFixed(1)} BPM`;
  midiEngine.syncMidiClockOutput(playing, masterBpm);
  const match = evaluateHarmonicMatch(shown?.analysis.key, nextSlot?.analysis.key);
  $("harmonicReadout").textContent = match.label.replace("→", "to");

  if (info) {
    const barNum = Math.floor(info.elapsed / ((60 / info.effBpm) * 4)) + 1;
    $("beatCountReadout").textContent = `Bar ${barNum} / Beat ${info.beatInBar + 1}`;
    $("phraseCountdown").textContent = mixer.busy
      ? `BLENDING ${Math.round(info.fade * 100)}%`
      : `NEXT BAR IN ${info.nextBarIn.toFixed(1)}S`;
  } else {
    $("beatCountReadout").textContent = "Bar 1 / Beat 1";
    $("phraseCountdown").textContent = "BAR SYNC READY";
  }

  for (let slot = 0 as 0 | 1; slot <= 1; slot = (slot + 1) as 0 | 1) {
    const d = mixer.decks[slot];
    const prefix = slot === 0 ? "A" : "B";
    const curOff = d.currentOffset();
    const dur = d.buffer?.duration ?? 0;
    $(`deck${prefix}Elapsed`).textContent = fmt(curOff);
    $(`deck${prefix}Remaining`).textContent = `-${fmt(Math.max(0, dur - curOff))}`;

    const isMaster = mixer.active === slot;
    const deckPlayBtn = $(`deckPlay${prefix}`);
    deckPlayBtn.classList.toggle("active", d.playing);
    deckPlayBtn.textContent = d.playing ? `PAUSE ${prefix}` : `PLAY ${prefix}`;

    $(`deck${prefix}StatusText`).textContent = mixer.busy
      ? "MIXING"
      : d.playing
        ? isMaster
          ? "ON AIR"
          : "BLENDING"
        : isMaster
          ? "MASTER"
          : "CUED";

    let platterSpeed = 0;
    if (scratch.active && scratch.deck === slot) {
      platterSpeed = scratch.velocity;
    } else if (d.playing) {
      platterSpeed = d.rate;
    }
    platterAngles[slot] = (platterAngles[slot] + platterSpeed * 200 * dt) % 360;
    const rotor = document.getElementById(`vinylRotor${prefix}`);
    if (rotor) {
      rotor.setAttribute("transform", `rotate(${platterAngles[slot].toFixed(1)} 110 110)`);
    }
    $(`platter${prefix}Readout`).textContent =
      scratch.active && scratch.deck === slot
        ? `SCRATCH ${scratch.velocity >= 0 ? "+" : ""}${scratch.velocity.toFixed(2)}x`
        : playing && isMaster
          ? `${(33.3 * platterSpeed).toFixed(1)} RPM`
          : "CUED";

    const level = d.getLevel();
    const vuFill = $(`vuFill${prefix}`);
    vuFill.style.height = `${Math.max(6, Math.round(level * 100))}%`;
  }

  if (mixer.busy) {
    crossfaderInput.value = mixer.crossfader.toFixed(2);
  }

  if (!mixer.playing) {
    pad.disabled = !slots[0];
    $("padlabel").textContent = slots[0] ? "START PARTY" : "ADD SONGS";
    $("upnext").textContent = slots[1] ? `Next: ${slots[1].name}` : "";
  } else if (mixer.busy) {
    pad.disabled = true;
    $("padlabel").textContent = "MIXING";
    $("upnext").textContent = `Into ${slots[mixer.active]?.name ?? "Next Track"}`;
  } else {
    pad.disabled = !nextSlot;
    $("padlabel").textContent = "SMART MIX";
    $("upnext").textContent = nextSlot
      ? `Next: ${nextSlot.name} (${nextSlot.analysis.bpm.toFixed(0)} BPM)`
      : queue.length || loading
        ? "Loading next..."
        : "Pick track below";
  }

  if (autoPilotEnabled && info && !mixer.busy && nextSlot) {
    const activeCueOutro = shown?.analysis.cuePoints?.outro ?? info.duration - 12;
    const secPerBar = (60 / info.effBpm) * 4;
    // Optional Auto-Scratch Drop 6 bars before the outro transition
    if (
      autoScratchDrops &&
      shown?.id &&
      autoScratchFiredForTrackId !== shown.id &&
      !scratch.active &&
      info.elapsed >= Math.max(4, activeCueOutro - 6 * secPerBar) &&
      info.elapsed < activeCueOutro - secPerBar
    ) {
      autoScratchFiredForTrackId = shown.id;
      void trigger90sScratchAgent(true);
    }

    if (info.elapsed >= activeCueOutro || info.remaining <= 10) {
      const { preset, autoReason } = resolveActiveTransitionPreset();
      const r = mixer.next(preset);
      if (r.ok) {
        freePending = true;
        logTrackToSetlist(nextSlot, preset.name, r.harmonicLabel);
        const modeTag = autoReason ? `Auto ${preset.name}` : preset.name;
        toast(`Auto-DJ triggered ${modeTag} into ${nextSlot.name} (${r.harmonicLabel})`);
      }
    }
  }

  if (freePending && !mixer.busy) {
    slots[mixer.idle] = undefined;
    freePending = false;
    if (queue.length === 0 && crate.length > 1) {
      const activeMeta = slots[mixer.active];
      const exclude = new Set<string>(activeMeta ? [activeMeta.id] : []);
      const picked = pickNextMarathonTrack(
        { bpm: activeMeta?.analysis.bpm ?? 124, key: activeMeta?.analysis.key ?? "8A" },
        crate,
        exclude,
        getCurrentTargetEnergy()
      );
      if (picked) {
        queue.push(picked.track);
      }
    }
    void fill().then(() => {
      evictIdleCrateBuffers();
      void autoStageScratchRoutine();
    });
  }

  // Master Bus & Marathon Telemetry Readouts
  const masterBus = mixer.getMasterTelemetry();
  if (masterBus.recordingActive) {
    $("recSetLabel").textContent = `REC ${fmt(masterBus.recordingElapsedSec)}`;
  }
  const grText =
    masterBus.limiterReductionDb < -0.1
      ? `GR ${masterBus.limiterReductionDb.toFixed(1)}dB`
      : `PK ${masterBus.masterPeakDb > -55 ? masterBus.masterPeakDb.toFixed(1) : "-INF"}dB`;
  $("masterBusReadout").textContent = `LIM ${grText} / AG ${masterBus.autoGainEnabled ? "ON" : "OFF"}`;

  const targetEnergyPct = Math.round(getCurrentTargetEnergy() * 100);
  $("targetEnergyReadout").textContent = `TARGET ENERGY ${targetEnergyPct}%`;
  const elapsedMinTotal = sessionStartedAtMs && mixer.playing
    ? Math.floor((Date.now() - sessionStartedAtMs) / 60000)
    : 0;
  const elapsedHrs = Math.floor(elapsedMinTotal / 60);
  const elapsedMinsRem = elapsedMinTotal % 60;
  const clockStr = `${String(elapsedHrs).padStart(2, "0")}:${String(elapsedMinsRem).padStart(2, "0")}`;
  const durLabel = marathonDurationMins > 0 ? `${marathonDurationMins / 60}H` : "INF";
  $("sessionClockReadout").textContent = `SET ${clockStr} / ${durLabel}`;

  document.querySelectorAll<HTMLButtonElement>(".scratch-pad-btn").forEach(btn => {
    btn.classList.toggle("active", scratch.active && btn.dataset.scratchId === scratch.patternId);
  });
  const activeDeckModCount = mixer.decks[mixer.active].modCount;
  $("trackModReadout").textContent =
    activeDeckModCount > 0
      ? `${activeDeckModCount} SPLICE${activeDeckModCount === 1 ? "" : "S"} IN DECK ${mixer.active === 0 ? "A" : "B"}`
      : "0 SPLICES IN TRACK";
  $<HTMLButtonElement>("restoreTrackModBtn").disabled = activeDeckModCount === 0;

  $("gateDot").classList.toggle("cut", !scratch.faderOpen);
  $("faderGateText").textContent = scratch.faderOpen ? "GATE OPEN" : "GATE CUT";
  $("scratchAnchorBadge").textContent =
    scratch.active && scratch.cutSampleLabel
      ? `${scratch.cutSampleLabel} · ${mixer.scratchCutMode === "mag-four" ? "MAG-4" : "VCA"}`
      : `M44-7 · 32-TAP SINC · ${mixer.scratchCutMode === "mag-four" ? "0.55MS MAG-4" : "1.6MS VCA"}`;
  $("activeScratchName").textContent = scratch.active
    ? `${scratch.patternName} (Gate ${Math.round(scratch.faderGain * 100)}%)`
    : lastAgentOutput?.result
      ? `90s Agent (${lastAgentOutput.result.plan.bars}B ${lastAgentOutput.result.plan.style.toUpperCase()} / ${lastAgentOutput.result.events.length} events)`
      : "90s Agent Ready (Press DROP 90S CUT, Key G, or Keys 1-8)";
  $("activeScratchVel").textContent = `${scratch.velocity >= 0 ? "+" : ""}${scratch.velocity.toFixed(2)}x`;

  drawParallelWaveforms();
  drawScratchScope(scratch);
  drawEnergyCurve();

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
