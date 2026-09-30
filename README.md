# Party DJ

Phase 0 scaffold: web prototype (Vite + TypeScript + Web Audio). Load two tracks, beat-match, one-tap NEXT with a transition preset.

    npm install && npm run dev

## Layout
- `src/engine/` – platform-agnostic audio logic (deck, mixer, transitions, analysis). Keep UI out of here so it can move to Tauri/JUCE later.
- `src/presets/` – transition + party-template JSON (shareable).
- `src/main.ts` – throwaway Phase 0 UI.

## Tests
    npm test   # synthetic click-track BPM/phase accuracy + sync/bar-grid math

## Known limits (next up)
1. Analysis is validated on synthetic click tracks only. Real music needs a proper beat tracker (essentia.js WASM), plus key, energy, and phrase/drop detection. The bar grid assumes the first detected beat is a downbeat.
2. Tempo sync uses `playbackRate`, which shifts pitch. Swap in real time-stretch (SoundTouch / Rubber Band WASM).
3. Phrase snapping (8/16/32 bars) using cue points; currently snaps to the next bar line.
4. Library + Live screen, Auto-DJ, hype pads, loops.
5. Not yet browser-tested end to end (no audio device in the build environment).
