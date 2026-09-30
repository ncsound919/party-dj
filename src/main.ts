import "./style.css";
import { Mixer } from "./engine/mixer";
import { SCRATCH_PATTERNS } from "./engine/scratch";
import { evaluateHarmonicMatch } from "./engine/sync";
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "./engine/synthTracks";
import transitions from "./presets/transitions.json";
import partyTemplates from "./presets/party-templates.json";
import type {
  PartyTemplate,
  ScratchPatternId,
  ScratchSourceMode,
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

let selectedPresetId = presets[0].id;
let selectedTemplateId = templates[0].id;
let autoPilotEnabled = false;
let loading = false;
let freePending = false;
let toastTimer = 0;

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
      ? "Auto-DJ Pilot Active · Phrase-Synced Automix Armed"
      : "Ready · Click any Scratch Pad (1-8) or Smart Mix";
  }, 4500);
}

// 1. Render Transition Style Presets
const blendContainer = $("blend");
for (const p of presets) {
  const l = document.createElement("label");
  const i = document.createElement("input");
  const s = document.createElement("span");
  const sm = document.createElement("small");
  i.type = "radio";
  i.name = "blend";
  i.value = p.id;
  i.checked = p.id === selectedPresetId;
  s.textContent = p.name;
  sm.textContent = p.bars ? `${p.bars} bars · ${p.curve}` : "0 bars · instant";
  s.append(sm);
  l.append(i, s);
  blendContainer.append(l);
}
blendContainer.addEventListener("change", e => {
  selectedPresetId = (e.target as HTMLInputElement).value;
  const p = presets.find(x => x.id === selectedPresetId);
  if (p) toast(`Transition preset: ${p.name} (${p.bars} bars)`);
});

// 2. Render 8 Beat-Quantized Autoscratch Performance Pads
const scratchPadsContainer = $("scratchPads");
SCRATCH_PATTERNS.forEach((pat, idx) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "scratch-pad-btn";
  btn.dataset.scratchId = pat.id;
  btn.title = `${pat.description} (Shortcut: Key ${idx + 1})`;
  const title = document.createElement("strong");
  title.textContent = `${idx + 1}. ${pat.name}`;
  const sub = document.createElement("small");
  sub.textContent = pat.subtitle;
  btn.append(title, sub);

  btn.addEventListener("click", async () => {
    await mixer.ctx.resume();
    const res = mixer.triggerAutoscratch(pat.id);
    if (res.ok) toast(`Autoscratch: ${res.message}`);
  });

  scratchPadsContainer.append(btn);
});

// Scratch Source Mode & Intensity Segmented Controls
document.querySelectorAll<HTMLButtonElement>("[data-scratch-source]").forEach(btn => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-scratch-source]")
      .forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mixer.scratchSourceMode = btn.dataset.scratchSource as ScratchSourceMode;
    toast(`Scratch source: ${btn.textContent}`);
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

// 3. Render Party Energy Templates
const partyTemplatesBar = $("partyTemplates");
function renderPartyTemplates() {
  partyTemplatesBar.replaceChildren();
  for (const t of templates) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `template-btn ${t.id === selectedTemplateId ? "active" : ""}`;
    btn.textContent = `${t.name} (${t.transition})`;
    btn.addEventListener("click", () => {
      selectedTemplateId = t.id;
      selectedPresetId = t.transition;
      const radio = blendContainer.querySelector<HTMLInputElement>(`input[value="${t.transition}"]`);
      if (radio) radio.checked = true;
      renderPartyTemplates();
      toast(`Party Template: ${t.name} · Transition set to ${t.transition}`);
    });
    partyTemplatesBar.append(btn);
  }
}
renderPartyTemplates();

// Auto-DJ Pilot Toggle
const autoPilotBtn = $<HTMLButtonElement>("autoPilotBtn");
autoPilotBtn.addEventListener("click", () => {
  autoPilotEnabled = !autoPilotEnabled;
  autoPilotBtn.setAttribute("aria-pressed", String(autoPilotEnabled));
  autoPilotBtn.textContent = `Auto-DJ Pilot: ${autoPilotEnabled ? "On" : "Off"}`;
  toast(
    autoPilotEnabled
      ? "Auto-DJ Pilot Enabled · Will auto-blend tracks at phrase outro"
      : "Auto-DJ Pilot Disabled"
  );
});

// Master BPM Nudge Controls
$("bpmDownBtn").addEventListener("click", () => {
  const cur = mixer.info()?.effBpm ?? slots[0]?.analysis.bpm ?? 124;
  mixer.setMasterBpm(cur - 1);
  toast(`Master Tempo nudged to ${(cur - 1).toFixed(1)} BPM`);
});
$("bpmUpBtn").addEventListener("click", () => {
  const cur = mixer.info()?.effBpm ?? slots[0]?.analysis.bpm ?? 124;
  mixer.setMasterBpm(cur + 1);
  toast(`Master Tempo nudged to ${(cur + 1).toFixed(1)} BPM`);
});
$("bpmResetBtn").addEventListener("click", () => {
  const native = slots[mixer.active]?.analysis.bpm ?? 124;
  mixer.setMasterBpm(native);
  toast(`Master Tempo locked to native ${native.toFixed(1)} BPM`);
});

// 4. Quantized Hot Cues & Beat Loops
document.querySelectorAll<HTMLButtonElement>(".cue-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    await mixer.ctx.resume();
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
        ? `Deck ${deckIdx === 0 ? "A" : "B"} locked in ${d.loopBars}-bar beat loop`
        : `Deck ${deckIdx === 0 ? "A" : "B"} loop released`
    );
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
    activeBars > 0 ? `${activeBars} Bar Loop Active` : "Loop Off";
}

// 5. 3-Band Isolator EQ, Color Filter & Crossfader Controls
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

// Club FX One-Shot Pads
document.querySelectorAll<HTMLButtonElement>("[data-fx]").forEach(btn => {
  btn.addEventListener("click", async () => {
    await mixer.ctx.resume();
    const fx = btn.dataset.fx as "dub-siren" | "sub-drop" | "laser-riser" | "vinyl-brake";
    mixer.triggerClubFX(fx);
    toast(`Triggered FX: ${btn.textContent}`);
  });
});

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

    // Normal 33.3 RPM = 3.49 rad/sec
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
    mixer.endManualScratch();
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
}
bindInteractivePlatter("platterA", 0);
bindInteractivePlatter("platterB", 1);

// 7. Crate & Queue Management
async function loadTrackIntoDeck(slot: 0 | 1, item: CrateTrack) {
  if (mixer.playing && slot === mixer.active && !mixer.busy) {
    return toast(`Deck ${slot === 0 ? "A" : "B"} is playing live! Load into Deck ${slot === 0 ? "B" : "A"} instead.`);
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
    updateDeckStaticLabels(slot);
    renderCrateTable();
  } catch {
    toast(`Couldn't decode ${item.name}. Try MP3, WAV, FLAC, or M4A.`);
  }
}

function updateDeckStaticLabels(slot: 0 | 1) {
  const m = slots[slot];
  const prefix = slot === 0 ? "A" : "B";
  if (!m) return;
  $(`deck${prefix}Title`).textContent = m.name;
  $(`waveLabel${prefix}`).textContent = `${m.name} (${m.analysis.bpm.toFixed(0)} BPM · ${m.analysis.key ?? "8A"})`;
  const energyPct = Math.round((m.analysis.energy ?? 0.8) * 100);
  $(`deck${prefix}Meta`).textContent = `${m.analysis.bpm.toFixed(1)} BPM · Key ${m.analysis.key ?? "8A"} (${m.analysis.keyName ?? "Minor"}) · Energy ${energyPct}%`;

  if (m.analysis.cuePoints) {
    $(`cueTime${prefix}Intro`).textContent = fmt(m.analysis.cuePoints.intro);
    $(`cueTime${prefix}Drop`).textContent = fmt(m.analysis.cuePoints.drop);
    $(`cueTime${prefix}Break`).textContent = fmt(m.analysis.cuePoints.breakdown);
    $(`cueTime${prefix}Outro`).textContent = fmt(m.analysis.cuePoints.outro);
  }
  updateLoopButtons(slot);
}

function renderQueue() {
  const ol = $("queue");
  ol.replaceChildren();
  $("queueCount").textContent = `${queue.length} ${queue.length === 1 ? "track" : "tracks"}`;
  queue.forEach((item, i) => {
    const li = document.createElement("li");
    const s = document.createElement("span");
    const b = document.createElement("button");
    s.textContent = `${item.name} · ${item.analysis.bpm.toFixed(0)} BPM · ${item.analysis.key ?? "8A"}`;
    b.textContent = "Remove";
    b.setAttribute("aria-label", `Remove ${item.name}`);
    b.onclick = () => {
      queue.splice(i, 1);
      renderQueue();
    };
    li.append(s, b);
    ol.append(li);
  });
}

function renderCrateTable() {
  const tbody = $("crateBody");
  tbody.replaceChildren();
  const activeKey = slots[mixer.active]?.analysis.key ?? "8A";

  for (const item of crate) {
    const tr = document.createElement("tr");
    const match = evaluateHarmonicMatch(activeKey, item.analysis.key);
    const energyPct = Math.round((item.analysis.energy ?? 0.78) * 100);

    const tdTitle = document.createElement("td");
    tdTitle.innerHTML = `<strong>${item.name}</strong>`;

    const tdGenre = document.createElement("td");
    tdGenre.textContent = `${item.artist} · ${item.genre}`;

    const tdBpm = document.createElement("td");
    tdBpm.className = "num-col mono";
    tdBpm.textContent = item.analysis.bpm.toFixed(1);

    const tdKey = document.createElement("td");
    tdKey.className = "mono";
    tdKey.textContent = `${item.analysis.key ?? "8A"} (${item.analysis.keyName ?? "Minor"})`;

    const tdMatch = document.createElement("td");
    tdMatch.textContent = match.label;

    const tdEnergy = document.createElement("td");
    tdEnergy.className = "mono";
    tdEnergy.textContent = `${energyPct}%`;

    const tdActions = document.createElement("td");
    tdActions.className = "action-col";
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
    tdActions.append(actWrap);
    tr.append(tdTitle, tdGenre, tdBpm, tdKey, tdMatch, tdEnergy, tdActions);
    tbody.append(tr);
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

async function addFiles(list: FileList | null) {
  const files = Array.from(list ?? []).filter(
    f => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f.name)
  );
  if (!files.length) return toast("Those aren't audio files. Try MP3, WAV, FLAC, or M4A.");

  toast(`Analyzing ${files.length} audio ${files.length === 1 ? "file" : "files"}…`);
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
        artist: "Local Audio",
        genre: "Custom File",
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
  renderCrateTable();
  renderQueue();
  void fill();
  toast(`Added ${files.length} track(s) · Beat grid & Camelot key analyzed`);
}

$<HTMLInputElement>("files").addEventListener("change", e => {
  const t = e.target as HTMLInputElement;
  void addFiles(t.files);
  t.value = "";
});

const drop = $("drop");
drop.addEventListener("dragover", e => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => {
  e.preventDefault();
  drop.classList.remove("over");
  void addFiles(e.dataTransfer?.files ?? null);
});

// 8. Primary Hero Smart Mix Pad & Transport Controls
const pad = $<HTMLButtonElement>("pad");
async function triggerPrimaryAction() {
  await mixer.ctx.resume();
  if (!mixer.playing) {
    if (mixer.play()) {
      toast("Party Started · Beat Grid Locked");
      void fill();
    } else {
      toast("Add a song first");
    }
    return;
  }
  const preset = presets.find(p => p.id === selectedPresetId) ?? presets[0];
  const r = mixer.next(preset);
  if (!r.ok) return toast(r.reason);
  freePending = true;
  const shiftPct = ((r.rate - 1) * 100).toFixed(1);
  toast(
    r.clamped
      ? `Smart Mix (${preset.name}) · Wide tempo range clamped`
      : `Smart Mix (${preset.name}) · ${r.harmonicLabel} · Tempo ${shiftPct}%`
  );
}
pad.onclick = () => void triggerPrimaryAction();

$("playPauseToggle").addEventListener("click", async () => {
  await mixer.ctx.resume();
  if (mixer.playing) {
    mixer.pause();
    toast("Playback Paused");
  } else if (mixer.play()) {
    toast("Playback Resumed");
  }
});

// Keyboard Shortcuts (Space = Start/Mix, 1-8 = Autoscratch Pads)
window.addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.code === "Space") {
    e.preventDefault();
    void triggerPrimaryAction();
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

// 10. Canvas Renderers: Parallel 3-Band Waveforms & Scratch Oscilloscope
const waveCtx = waveCanvas.getContext("2d")!;
const scopeCanvas = $<HTMLCanvasElement>("scratchScope");
const scopeCtx = scopeCanvas.getContext("2d")!;

function drawParallelWaveforms() {
  const W = waveCanvas.width;
  const H = waveCanvas.height;
  const halfH = H * 0.5;

  waveCtx.fillStyle = "#07090e";
  waveCtx.fillRect(0, 0, W, H);

  // Center horizontal divider between Deck A and Deck B
  waveCtx.strokeStyle = "rgba(255,255,255,0.12)";
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

    if (!d.buffer || !meta?.analysis.waveform) continue;

    const wf = meta.analysis.waveform;
    const dur = d.buffer.duration;
    const curSec = d.currentOffset();
    const curRatio = curSec / Math.max(0.1, dur);
    const n = wf.low.length;
    const barW = W / n;

    // Draw 3-Band Frequency Waveform (Low = Amber/Red, Mid = Emerald, High = Cyan)
    for (let i = 0; i < n; i++) {
      const x = i * barW;
      const played = i / n <= curRatio;
      const alpha = played ? 0.42 : 0.92;

      const lAmp = wf.low[i] * maxAmp;
      const mAmp = wf.mid[i] * maxAmp * 0.82;
      const hAmp = wf.high[i] * maxAmp * 0.6;

      // Low Band (Bass)
      waveCtx.fillStyle =
        slot === 0 ? `rgba(245, 158, 11, ${alpha})` : `rgba(6, 182, 212, ${alpha})`;
      waveCtx.fillRect(x, centerY - lAmp, Math.max(1.5, barW - 0.5), lAmp * 2);

      // Mid Band
      waveCtx.fillStyle = `rgba(16, 185, 129, ${alpha * 0.75})`;
      waveCtx.fillRect(x, centerY - mAmp, Math.max(1.5, barW - 0.5), mAmp * 2);

      // High Band
      waveCtx.fillStyle = `rgba(244, 246, 251, ${alpha * 0.65})`;
      waveCtx.fillRect(x, centerY - hAmp, Math.max(1.5, barW - 0.5), hAmp * 2);
    }

    // Draw Bar Grid ticks
    const secPerBar = (60 / meta.analysis.bpm) * 4;
    waveCtx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    waveCtx.lineWidth = 1;
    for (let t = meta.analysis.firstBeat; t < dur; t += secPerBar) {
      const x = (t / dur) * W;
      waveCtx.beginPath();
      waveCtx.moveTo(x, topY + 2);
      waveCtx.lineTo(x, topY + halfH - 2);
      waveCtx.stroke();
    }

    // Draw Cue Flags (Intro, Drop, Break, Outro)
    if (meta.analysis.cuePoints) {
      const cues: Array<[string, number, string]> = [
        ["IN", meta.analysis.cuePoints.intro, "#10b981"],
        ["DROP", meta.analysis.cuePoints.drop, "#f59e0b"],
        ["BRK", meta.analysis.cuePoints.breakdown, "#06b6d4"],
        ["OUT", meta.analysis.cuePoints.outro, "#ef4444"],
      ];
      waveCtx.font = "600 10px 'JetBrains Mono', monospace";
      for (const [label, sec, color] of cues) {
        const cx = (sec / dur) * W;
        waveCtx.strokeStyle = color;
        waveCtx.beginPath();
        waveCtx.moveTo(cx, topY);
        waveCtx.lineTo(cx, topY + halfH);
        waveCtx.stroke();
        waveCtx.fillStyle = color;
        waveCtx.fillText(label, cx + 3, topY + 12);
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

function drawScratchScope(telemetry: ReturnType<typeof mixer.scratchTelemetry>) {
  const W = scopeCanvas.width;
  const H = scopeCanvas.height;
  scopeCtx.fillStyle = "#07090e";
  scopeCtx.fillRect(0, 0, W, H);

  // Center zero-displacement reference line
  scopeCtx.strokeStyle = "rgba(255,255,255,0.12)";
  scopeCtx.lineWidth = 1;
  scopeCtx.beginPath();
  scopeCtx.moveTo(0, H * 0.5);
  scopeCtx.lineTo(W, H * 0.5);
  scopeCtx.stroke();

  const curve = telemetry.curveSamples;
  const gate = telemetry.gateSamples;
  const len = curve.length;

  // Draw VCA Crossfader Gate blocks along the bottom
  for (let i = 0; i < len; i++) {
    const x = (i / len) * W;
    const g = gate[i];
    scopeCtx.fillStyle = g > 0.25 ? "rgba(16, 185, 129, 0.22)" : "rgba(239, 68, 68, 0.18)";
    scopeCtx.fillRect(x, H - 10, W / len + 0.5, 10);
  }

  // Draw Vinyl Platter Displacement Trajectory
  scopeCtx.strokeStyle = telemetry.active ? "#f59e0b" : "#06b6d4";
  scopeCtx.lineWidth = 2;
  scopeCtx.beginPath();
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * W;
    const normY = H * 0.5 - Math.max(-1, Math.min(1, curve[i])) * (H * 0.36);
    if (i === 0) scopeCtx.moveTo(x, normY);
    else scopeCtx.lineTo(x, normY);
  }
  scopeCtx.stroke();

  // Draw live progress cursor if scratch is active
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

// 11. Initialize Built-In Studio Crate so app is immediately playable
function bootstrapStudioCrate() {
  for (const spec of BUILTIN_TRACK_SPECS) {
    const buf = synthesizeStudioTrack(mixer.ctx, spec);
    const tempSlot = crate.length < 2 ? (crate.length as 0 | 1) : undefined;
    let analysis: TrackAnalysis;

    if (tempSlot !== undefined) {
      analysis = mixer.loadBuffer(tempSlot, buf, {
        bpm: spec.bpm,
        key: spec.camelot,
        keyName: spec.keyName,
      });
    } else {
      // Load into idle temporarily to analyze then restore
      analysis = {
        ...mixer.loadBuffer(1, buf, {
          bpm: spec.bpm,
          key: spec.camelot,
          keyName: spec.keyName,
        }),
      };
    }

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

  // Ensure Deck A has Track 0, Deck B has Track 1, and Queue has Tracks 2 & 3
  if (crate[0]?.buffer) {
    const a0 = mixer.loadBuffer(0, crate[0].buffer, crate[0].analysis);
    slots[0] = {
      id: crate[0].id,
      name: crate[0].name,
      artist: crate[0].artist,
      genre: crate[0].genre,
      analysis: a0,
    };
    updateDeckStaticLabels(0);
  }
  if (crate[1]?.buffer) {
    const a1 = mixer.loadBuffer(1, crate[1].buffer, crate[1].analysis);
    slots[1] = {
      id: crate[1].id,
      name: crate[1].name,
      artist: crate[1].artist,
      genre: crate[1].genre,
      analysis: a1,
    };
    updateDeckStaticLabels(1);
  }
  queue.push(...crate.slice(2));
  renderCrateTable();
  renderQueue();
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

  // Update Active Master Summary & Legacy IDs
  const shown = info ? slots[info.deck] : slots[0];
  const nextSlot = slots[mixer.idle];
  $("title").textContent = shown?.name ?? "Nothing playing yet";
  $("meta").textContent = info
    ? `${info.effBpm.toFixed(1)} BPM · Key ${shown?.analysis.key ?? "8A"} (${shown?.analysis.keyName ?? "Minor"})`
    : shown
      ? `${shown.analysis.bpm.toFixed(1)} BPM · Key ${shown.analysis.key ?? "8A"}, ready to start`
      : "Add songs below to get started";

  $("fill").style.width = info ? `${(info.elapsed / info.duration) * 100}%` : "0%";
  $("elapsed").textContent = fmt(info?.elapsed ?? 0);
  $("left").textContent = `-${fmt(info?.remaining ?? 0)}`;
  $("ring").style.strokeDashoffset = String(RING * (1 - (info?.fade ?? 0)));

  // Master Telemetry Bar
  const masterBpm = info?.effBpm ?? shown?.analysis.bpm ?? 124;
  $("masterBpmReadout").textContent = `${masterBpm.toFixed(1)} BPM`;
  const match = evaluateHarmonicMatch(shown?.analysis.key, nextSlot?.analysis.key);
  $("harmonicReadout").textContent = match.label;

  if (info) {
    const barNum = Math.floor(info.elapsed / ((60 / info.effBpm) * 4)) + 1;
    $("beatCountReadout").textContent = `Bar ${barNum} · Beat ${info.beatInBar + 1}`;
    $("phraseCountdown").textContent = mixer.busy
      ? `Blending ${Math.round(info.fade * 100)}%`
      : `Next bar window in ${info.nextBarIn.toFixed(1)}s`;
  } else {
    $("beatCountReadout").textContent = "Bar 1 · Beat 1";
    $("phraseCountdown").textContent = "Quantized bar-sync armed";
  }

  // Update Deck A & Deck B Time & Platter Physics
  for (let slot = 0 as 0 | 1; slot <= 1; slot = (slot + 1) as 0 | 1) {
    const d = mixer.decks[slot];
    const prefix = slot === 0 ? "A" : "B";
    const curOff = d.currentOffset();
    const dur = d.buffer?.duration ?? 0;
    $(`deck${prefix}Elapsed`).textContent = fmt(curOff);
    $(`deck${prefix}Remaining`).textContent = `-${fmt(Math.max(0, dur - curOff))}`;

    const isMaster = mixer.active === slot;
    $(`deck${prefix}StatusText`).textContent = mixer.busy
      ? "Transitioning"
      : isMaster
        ? playing
          ? "On Air · Master"
          : "Ready · Master"
        : "Cued · Sync Locked";

    // Platter angular velocity (33.33 RPM = 200 deg/sec at 1.0x)
    let platterSpeed = 0;
    if (scratch.active && scratch.deck === slot) {
      platterSpeed = scratch.velocity;
    } else if (playing && (isMaster || mixer.busy)) {
      platterSpeed = info?.speed ?? 1;
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

    // VU Meter
    const level = d.getLevel();
    const vuFill = $(`vuFill${prefix}`);
    vuFill.style.height = `${Math.max(6, Math.round(level * 100))}%`;
  }

  // Update Crossfader UI during automated blends
  if (mixer.busy) {
    crossfaderInput.value = mixer.crossfader.toFixed(2);
  }

  // Update Smart Mix Pad & Up Next status
  if (!mixer.playing) {
    pad.disabled = !slots[0];
    $("padlabel").textContent = slots[0] ? "Start Party" : "Add Songs";
    $("upnext").textContent = slots[1] ? `Up next: ${slots[1].name} (${slots[1].analysis.bpm.toFixed(0)} BPM)` : "";
  } else if (mixer.busy) {
    pad.disabled = true;
    $("padlabel").textContent = "Mixing…";
    $("upnext").textContent = `Blending into ${slots[mixer.active]?.name ?? "Next Track"}`;
  } else {
    pad.disabled = !nextSlot;
    $("padlabel").textContent = "Smart Mix Next";
    $("upnext").textContent = nextSlot
      ? `Up next: ${nextSlot.name} (${nextSlot.analysis.bpm.toFixed(0)} BPM · ${nextSlot.analysis.key ?? "8A"})`
      : queue.length || loading
        ? "Loading next track…"
        : "Select a track from Crate to mix into";
  }

  // Auto-DJ Party Pilot: Automatically trigger phrase-aligned transition at track outro
  if (autoPilotEnabled && info && !mixer.busy && nextSlot) {
    const activeCueOutro = shown?.analysis.cuePoints?.outro ?? info.duration - 12;
    if (info.elapsed >= activeCueOutro || info.remaining <= 10) {
      const preset = presets.find(p => p.id === selectedPresetId) ?? presets[0];
      const r = mixer.next(preset);
      if (r.ok) {
        freePending = true;
        toast(`Auto-DJ Pilot triggered ${preset.name} into ${nextSlot.name}`);
      }
    }
  }

  // When a transition finishes, replenish the newly idle deck from the queue (or cycle crate)
  if (freePending && !mixer.busy) {
    slots[mixer.idle] = undefined;
    freePending = false;
    if (queue.length === 0 && crate.length > 1) {
      // Auto-replenish queue from crate so non-DJs never run out of music
      const nextCrateTrack = crate.find(c => c.id !== slots[mixer.active]?.id) ?? crate[0];
      queue.push(nextCrateTrack);
    }
    void fill();
  }

  // Update Autoscratch UI & Oscilloscope
  document.querySelectorAll<HTMLButtonElement>(".scratch-pad-btn").forEach(btn => {
    btn.classList.toggle("active", scratch.active && btn.dataset.scratchId === scratch.patternId);
  });
  $("gateDot").classList.toggle("cut", !scratch.faderOpen);
  $("faderGateText").textContent = scratch.faderOpen ? "FADER OPEN" : "FADER CUT";
  $("activeScratchName").textContent = scratch.active
    ? `Active: ${scratch.patternName} · Gate ${Math.round(scratch.faderGain * 100)}%`
    : "Trajectory Scope · Ready (Click 1–8 or drag turntable platter)";
  $("activeScratchVel").textContent = `Platter: ${scratch.velocity >= 0 ? "+" : ""}${scratch.velocity.toFixed(2)}x`;

  drawParallelWaveforms();
  drawScratchScope(scratch);

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
