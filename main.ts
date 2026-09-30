import "./style.css";
import { Mixer } from "./engine/mixer";
import transitions from "./presets/transitions.json";
import type { TransitionPreset } from "./engine/types";

const presets = transitions as TransitionPreset[];
const mixer = new Mixer();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const RING = 351.86; // circumference of the r=56 ring

type Slot = { name: string; bpm: number } | undefined;
const slots: Slot[] = [undefined, undefined];
const queue: File[] = [];
let selected = presets[0].id, loading = false, freePending = false, toastTimer = 0;

const fmt = (s: number) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const clean = (n: string) => n.replace(/\.[^.]+$/, "");
function toast(msg: string) {
  $("toast").textContent = msg;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => ($("toast").textContent = ""), 4500);
}

// blend style chips
const blend = $("blend");
for (const p of presets) {
  const l = document.createElement("label"), i = document.createElement("input"), s = document.createElement("span"), sm = document.createElement("small");
  i.type = "radio"; i.name = "blend"; i.value = p.id; i.checked = p.id === selected;
  s.textContent = p.name; sm.textContent = p.bars ? `${p.bars} bars` : "instant"; s.append(sm);
  l.append(i, s); blend.append(l);
}
blend.addEventListener("change", e => { selected = (e.target as HTMLInputElement).value; });

function renderQueue() {
  const ol = $("queue"); ol.replaceChildren();
  queue.forEach((f, i) => {
    const li = document.createElement("li"), s = document.createElement("span"), b = document.createElement("button");
    s.textContent = clean(f.name); b.textContent = "Remove"; b.setAttribute("aria-label", `Remove ${clean(f.name)}`);
    b.onclick = () => { queue.splice(i, 1); renderQueue(); };
    li.append(s, b); ol.append(li);
  });
}

/** Keep the idle deck (both decks before Start) loaded from the queue. */
async function fill() {
  if (loading) return; loading = true;
  try {
    const targets: (0 | 1)[] = mixer.playing ? (mixer.busy ? [] : [mixer.idle]) : [0, 1];
    for (const slot of targets) {
      if (slots[slot] || !queue.length) continue;
      const f = queue.shift()!; renderQueue();
      try { const a = await mixer.loadFile(slot, f); slots[slot] = { name: clean(f.name), bpm: a.bpm }; }
      catch { toast(`Couldn't read ${f.name}. Try an MP3, WAV or M4A file.`); }
    }
  } finally { loading = false; renderQueue(); }
}

function addFiles(list: FileList | null) {
  const files = Array.from(list ?? []).filter(f => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f.name));
  if (!files.length) return toast("Those aren't audio files. Try MP3, WAV or M4A.");
  queue.push(...files); renderQueue(); void fill();
}
$<HTMLInputElement>("files").addEventListener("change", e => { const t = e.target as HTMLInputElement; addFiles(t.files); t.value = ""; });
const drop = $("drop");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer?.files ?? null); });

const pad = $<HTMLButtonElement>("pad");
pad.onclick = async () => {
  if (!mixer.playing) {
    await mixer.ctx.resume();
    if (mixer.play()) { toast("Playing"); void fill(); } else toast("Add a song first");
    return;
  }
  const r = mixer.next(presets.find(p => p.id === selected)!);
  if (!r.ok) return toast(r.reason);
  freePending = true;
  toast(r.clamped ? "Tempos are far apart, so this blend is looser" : `Blending in (tempo shifted ${((r.rate - 1) * 100).toFixed(1)}%)`);
};

function tick() {
  const info = mixer.info(), playing = !!info;
  document.body.classList.toggle("playing", playing);

  const shown = info ? slots[info.deck] : slots[0];
  $("title").textContent = shown?.name ?? "Nothing playing yet";
  $("meta").textContent = info ? `${info.effBpm.toFixed(0)} BPM` : shown ? `${shown.bpm.toFixed(0)} BPM, ready to start` : "Add songs below to get started";
  $("fill").style.width = info ? `${(info.elapsed / info.duration) * 100}%` : "0%";
  $("elapsed").textContent = fmt(info?.elapsed ?? 0);
  $("left").textContent = `-${fmt(info?.remaining ?? 0)}`;
  $("ring").style.strokeDashoffset = String(RING * (1 - (info?.fade ?? 0)));

  const next = slots[mixer.idle];
  if (!mixer.playing) { pad.disabled = !slots[0]; $("padlabel").textContent = slots[0] ? "Start" : "Add songs"; $("upnext").textContent = slots[1] ? `Up next: ${slots[1].name}` : ""; }
  else if (mixer.busy) { pad.disabled = true; $("padlabel").textContent = "Mixing"; $("upnext").textContent = ""; }
  else { pad.disabled = !next; $("padlabel").textContent = "Next";
    $("upnext").textContent = next ? `Up next: ${next.name} (${next.bpm.toFixed(0)} BPM)` : queue.length || loading ? "Loading the next song…" : "Add another song to mix into"; }

  if (freePending && !mixer.busy) { slots[mixer.idle] = undefined; freePending = false; void fill(); }
  requestAnimationFrame(tick);
}
tick();
