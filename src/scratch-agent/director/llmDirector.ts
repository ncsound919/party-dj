import { DIRECTOR_JSON_SCHEMA, validateDirectorPlan } from "../schemas";
import type { DirectorPlan } from "../schemas";
import type { DirectorContext } from "./rulesDirector";

// The model never touches audio: it only returns a small JSON plan that gets validated.
// This is the only module that talks to a model (PLAN §0 rule 4).

export interface LlmConfig {
  llm_url: string; // OpenAI-compatible, e.g. http://localhost:11434/v1/chat/completions
  llm_model: string; // read from config, never hardcoded
  temperature: number;
  seed: number;
  timeout_ms?: number;
}

const SYSTEM =
  "You are a scratch-pattern director for hip-hop hooks. " +
  "Reply with ONLY a JSON object matching the schema. Use only the given slice ids. " +
  "Prefer sparse, rhythmic, pocketed patterns.";

export interface DirectResult {
  plan: DirectorPlan | null; // null => caller falls back to rulesDirector
  attempts: number;
  firstAttemptValid: boolean; // feeds the structural failure rate in the benchmark
  errors: string[];
}

export async function llmDirector(ctx: DirectorContext, cfg: LlmConfig, retries = 2): Promise<DirectResult> {
  const messages: { role: string; content: string }[] = [
    { role: "system", content: `${SYSTEM}\nSchema: ${JSON.stringify(DIRECTOR_JSON_SCHEMA)}` },
    { role: "user", content: JSON.stringify(ctx) },
  ];
  const validIds = new Set(ctx.slices.map((s) => s.id));
  const errors: string[] = [];

  for (let attempt = 0; attempt <= retries; attempt++) {
    let text = "";
    try {
      const r = await fetch(cfg.llm_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.llm_model, messages, temperature: cfg.temperature, seed: cfg.seed }),
        signal: AbortSignal.timeout(cfg.timeout_ms ?? 120_000),
      });
      const j = await r.json();
      text = j.choices[0].message.content as string;
    } catch (e) {
      errors.push(`request failed: ${String(e).slice(0, 200)}`);
      return { plan: null, attempts: attempt + 1, firstAttemptValid: false, errors };
    }

    let err: string;
    try {
      const v = validateDirectorPlan(JSON.parse(text));
      if (v.ok) {
        if (v.plan.items.every((i) => validIds.has(i.slice_id))) {
          return { plan: v.plan, attempts: attempt + 1, firstAttemptValid: attempt === 0, errors };
        }
        err = "slice_id not in provided list";
      } else err = v.error;
    } catch (e) {
      err = `invalid JSON: ${String(e).slice(0, 200)}`;
    }
    errors.push(err);
    messages.push({ role: "assistant", content: text }, { role: "user", content: `Invalid: ${err}. Return corrected JSON only.` });
  }
  return { plan: null, attempts: retries + 1, firstAttemptValid: false, errors };
}
