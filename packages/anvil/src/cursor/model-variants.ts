import { asRecord, nonEmptyString } from "#src/json-record";
import type { CodeAgentModelCatalog } from "@lrm/coforge-sdk/internal";

/** The parameter names `cursor-agent acp` uses for a reasoning-effort variant. Different model
 * families spell the same concept differently (`effort`, `reasoning_effort`, `reasoning`). */
const EFFORT_PARAMS = ["effort", "reasoning_effort", "reasoning"] as const;

export type CursorModelVariant = Readonly<{
  /** The id as listed: `claude-sonnet-5[thinking=true,context=300k,effort=high]`. */
  compositeId: string;
  /** The name before the bracket — what the user sees as the model. */
  baseName: string;
  /** The reasoning-effort parameter's value, when the variant carries one. */
  effort?: string;
  /** The variant's other parameters, `key=value` in listed order (`context`, `fast`, `thinking`). */
  params: string[];
}>;

/** Parses `name[k=v,k=v]` into its base name and effort. An unparseable or empty id gets no
 * variant; a base with no effort parameter answers `effort: undefined`. */
export function parseCursorModelId(compositeId: string): CursorModelVariant | undefined {
  const bracket = compositeId.indexOf("[");
  const baseName = bracket < 0 ? compositeId.trim() : compositeId.slice(0, bracket).trim();
  if (!baseName) return undefined;
  const variant: {
    compositeId: string;
    baseName: string;
    effort?: string;
    params: string[];
  } = { compositeId, baseName, params: [] };
  if (bracket < 0) return variant;
  const close = compositeId.indexOf("]", bracket);
  if (close < 0) return variant;
  for (const pair of compositeId
    .slice(bracket + 1, close)
    .split(",")
    .map((entry) => entry.trim())) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (EFFORT_PARAMS.includes(key as (typeof EFFORT_PARAMS)[number]) && value)
      variant.effort = value;
    else variant.params.push(pair);
  }
  return variant;
}

/**
 * The catalog projection of the `models` block `session/new`/`session/load` returns: one model
 * per base name, with every effort value its listed variants carry, in listed order. Model ids
 * in the catalog are base names — a launch always resolves the stored base plus effort back to
 * a listed composite id, it never composes one itself (the server rejects anything not listed).
 */
export function cursorModelCatalog(
  availableModels: readonly unknown[],
  currentModelId?: string,
): CodeAgentModelCatalog["models"] {
  const current = currentModelId ? parseCursorModelId(currentModelId) : undefined;
  const byBase = new Map<
    string,
    { baseName: string; displayName: string; efforts: string[]; params: string[] }
  >();
  for (const entry of availableModels) {
    const record = asRecord(entry);
    const compositeId = nonEmptyString(record?.modelId);
    if (!compositeId) continue;
    const parsed = parseCursorModelId(compositeId);
    if (!parsed) continue;
    let model = byBase.get(parsed.baseName);
    if (!model) {
      model = {
        baseName: parsed.baseName,
        displayName: nonEmptyString(record?.name) ?? parsed.baseName,
        efforts: [],
        params: parsed.params,
      };
      byBase.set(parsed.baseName, model);
    }
    if (parsed.effort && !model.efforts.includes(parsed.effort)) model.efforts.push(parsed.effort);
  }
  return [...byBase.values()].map((model) => ({
    id: model.baseName,
    displayName: model.displayName,
    // `description` stays empty: the effort-only resolution can pick a variant whose other
    // params differ from the first-listed one, and a stale display string would mislead.
    description: "",
    modelProvider: "",
    reasoningEfforts: model.efforts,
    // The first-listed variant is what a launch with no effort picks; its effort is the default.
    defaultReasoning: model.efforts[0] ?? "",
    recommended: current?.baseName === model.baseName,
  }));
}

/**
 * Maps a stored `runtime.model` (a base name) and `runtime.reasoning` (an effort value) to the
 * listed composite id that carries them. Without an effort the base's first listed variant is
 * the answer; `default` names the `default[]` Auto entry. A base or effort the list does not
 * carry answers undefined, which callers turn into a model-not-found failure — composing a
 * `name[effort=x]` the server never listed is rejected with `-32602` (verified 2026.10.22).
 */
export function resolveCursorCompositeId(
  availableModels: readonly unknown[],
  baseName: string,
  effort: string | undefined,
): string | undefined {
  for (const entry of availableModels) {
    const compositeId = nonEmptyString(asRecord(entry)?.modelId);
    if (!compositeId) continue;
    const parsed = parseCursorModelId(compositeId);
    if (!parsed) continue;
    if (parsed.baseName !== baseName) continue;
    if (effort === undefined) return compositeId;
    if (parsed.effort === effort) return compositeId;
  }
  // A base or effort the list does not carry answers undefined — callers turn it into a
  // model-not-found failure rather than running an unlisted effort or composing an id.
  return undefined;
}

/** The old `cursor-agent models` catalog baked effort into ids (`claude-sonnet-4.5-thinking`,
 * `gpt-5-high`). Only those shapes fall back to the default — a retired, plan-gated or misspelled
 * name still fails as `model_not_found`. */
const OLD_EFFORT_SUFFIX = /-(thinking|fast|high|medium|low|xhigh|max)$/i;
export function isOldCursorModelId(modelId: string): boolean {
  return OLD_EFFORT_SUFFIX.test(modelId);
}
