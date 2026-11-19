import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";

const MODELS_JSON_MAX_BYTES = 1024 * 1024;

type FieldValidator = (value: unknown) => boolean;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

const MODEL_OVERRIDE_FIELD_VALIDATORS: Readonly<Record<string, FieldValidator>> = {
  name: (value) => typeof value === "string" && value.length > 0,
  reasoning: (value) => typeof value === "boolean",
  thinkingLevelMap: isPlainObject,
  input: (value) =>
    Array.isArray(value) && value.every((entry) => entry === "text" || entry === "image"),
  inputLimits: isPlainObject,
  cost: isPlainObject,
  promptCache: isPlainObject,
  contextWindow: isPositiveFiniteNumber,
  maxTokens: isPositiveFiniteNumber,
};

export function filterWorkspaceModelsJson(parsed: unknown): {
  providers: Record<string, { modelOverrides: Record<string, Record<string, unknown>> }>;
} {
  const providers: Record<string, { modelOverrides: Record<string, Record<string, unknown>> }> = {};
  if (!isPlainObject(parsed) || !isPlainObject(parsed.providers)) return { providers };
  for (const [providerId, rawProvider] of Object.entries(parsed.providers)) {
    if (!isPlainObject(rawProvider) || !isPlainObject(rawProvider.modelOverrides)) continue;
    const sanitizedOverrides: Record<string, Record<string, unknown>> = {};
    for (const [modelId, rawOverride] of Object.entries(rawProvider.modelOverrides)) {
      if (!isPlainObject(rawOverride)) continue;
      const kept: Record<string, unknown> = {};
      for (const [field, validator] of Object.entries(MODEL_OVERRIDE_FIELD_VALIDATORS)) {
        if (field in rawOverride && validator(rawOverride[field])) kept[field] = rawOverride[field];
      }
      if (Object.keys(kept).length > 0) sanitizedOverrides[modelId] = kept;
    }
    if (Object.keys(sanitizedOverrides).length > 0) {
      providers[providerId] = { modelOverrides: sanitizedOverrides };
    }
  }
  return { providers };
}

export async function prepareWorkspaceModelsPath(
  sourceModelsPath: string,
): Promise<{ modelsPath: string | null; cleanup: () => Promise<void> }> {
  const noop = async () => {};
  let stat;
  try {
    stat = await lstat(sourceModelsPath);
  } catch {
    return { modelsPath: null, cleanup: noop };
  }
  if (!stat.isFile() || stat.size > MODELS_JSON_MAX_BYTES) {
    return { modelsPath: null, cleanup: noop };
  }
  let parsed: unknown;
  try {
    const raw = (await readFile(sourceModelsPath, "utf8")).replace(/^\uFEFF/, "");
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { modelsPath: null, cleanup: noop };
  }
  const filtered = filterWorkspaceModelsJson(parsed);
  if (Object.keys(filtered.providers).length === 0) {
    return { modelsPath: null, cleanup: noop };
  }
  const scratchDir = await mkdtemp(join(tmpdir(), "coforge-pi-models-"));
  const sanitizedPath = join(scratchDir, "models.json");
  await writeFile(sanitizedPath, `${JSON.stringify(filtered)}\n`, { mode: 0o600 });
  let cleaned = false;
  return {
    modelsPath: sanitizedPath,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const cachedBuiltinOrigins = new Map<string, readonly string[]>();

function extractOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return undefined;
  }
}

export function builtinProviderExpectedOrigins(providerId: string): readonly string[] {
  const cached = cachedBuiltinOrigins.get(providerId);
  if (cached !== undefined) return cached;
  const origins = new Set<string>();
  const models = builtinProviderCatalog.getAllBuiltinModels(providerId as never);
  for (const model of models) {
    const origin = extractOrigin(model.baseUrl);
    if (origin) origins.add(origin);
  }
  const result = [...origins];
  cachedBuiltinOrigins.set(providerId, result);
  return result;
}

export class BuiltinModelTransportError extends Error {
  readonly provider: string;
  readonly actualOrigin: string;
  readonly expectedOrigins: readonly string[];

  constructor(provider: string, actualOrigin: string, expectedOrigins: readonly string[]) {
    super(
      `Built-in model provider "${provider}" resolved to unexpected origin "${actualOrigin}" ` +
        `(expected ${expectedOrigins.join(" or ")}). Built-in agents cannot override provider ` +
        `endpoints, headers, or credentials in .builtin-runtime/models.json.`,
    );
    this.name = "BuiltinModelTransportError";
    this.provider = provider;
    this.actualOrigin = actualOrigin;
    this.expectedOrigins = expectedOrigins;
  }
}

export function assertBuiltinModelOriginSafe(
  model: { provider: string; baseUrl?: string },
  expectedOrigins: readonly string[] = builtinProviderExpectedOrigins(model.provider),
): void {
  if (expectedOrigins.length === 0 || !model.baseUrl) return;
  const actualOrigin = extractOrigin(model.baseUrl);
  if (!actualOrigin) {
    throw new BuiltinModelTransportError(model.provider, model.baseUrl, expectedOrigins);
  }
  const normalizedExpected = expectedOrigins.map((origin) => origin.toLowerCase());
  if (!normalizedExpected.includes(actualOrigin)) {
    throw new BuiltinModelTransportError(model.provider, actualOrigin, expectedOrigins);
  }
}
