import type { SliceBank } from "../schemas";
import { MAIN_SRC } from "../schemas";

/**
 * Combine slice banks from several sources into one bank the director/composer can use.
 * Slice ids are renumbered 0..n-1 (unique across sources) and each slice is tagged with its
 * source id. `vocal_onsets` come from the MAIN_SRC entry (or the first entry if none is main),
 * since they describe the hook that scratches answer to, not the cut sources.
 */
export function mergeBanks(entries: [srcId: string, bank: SliceBank][]): SliceBank {
  if (!entries.length) throw new Error("mergeBanks needs at least one bank");
  const sr = entries[0][1].sr;
  const seen = new Set<string>();
  let nextId = 0;
  const slices = entries.flatMap(([srcId, bank]) => {
    if (seen.has(srcId)) throw new Error(`duplicate source id "${srcId}"`);
    seen.add(srcId);
    if (bank.sr !== sr) throw new Error(`bank "${srcId}" is ${bank.sr} Hz but the first is ${sr} Hz; resample first`);
    return bank.slices.map((s) => ({ ...s, id: nextId++, src_id: srcId }));
  });
  const primary = entries.find(([id]) => id === MAIN_SRC) ?? entries[0];
  return { source_path: entries.map(([id]) => id).join("+"), sr, slices, vocal_onsets: primary[1].vocal_onsets };
}
