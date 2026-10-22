import { join } from "node:path";
import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type CodeAgentModelMetadata,
} from "@lrm/coforge-sdk/internal";
import type { JsonlProcess } from "#src/code-agent/jsonl-process";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { getLogger } from "@logtape/logtape";
import { asRecord } from "#src/code-agent/json-record";
import {
  CatalogDiscoveryError,
  isModel,
  within,
  withJsonlProcess,
  type CatalogProgress,
} from "#src/code-agent/catalog-discovery";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

export async function discoverCodexCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  /** Each bounded wait: the `initialize` reply, then each `model/list` page. */
  timeoutMs: number,
  force = false,
): Promise<CodeAgentModelCatalog | undefined> {
  const live = await discoverCodexCatalogFromProcess(command, cwd, environment, timeoutMs).catch(
    () => undefined,
  );
  if (live) return live;
  if (force) return undefined;
  // Match the home inherited by the provider; CODEX_HOME is not in its allowlist.
  const home = environment.HOME ?? environment.USERPROFILE;
  if (!home) return undefined;
  try {
    const cache = asRecord(await Bun.file(join(home, ".codex", "models_cache.json")).json());
    if (!Array.isArray(cache?.models)) return undefined;
    const models = cache.models
      .map((value: unknown) => {
        const entry = asRecord(value);
        if (typeof entry?.slug !== "string" || !entry.slug.trim()) return undefined;
        if (entry.visibility && entry.visibility !== "public" && entry.visibility !== "list")
          return undefined;
        if (entry.supported_in_api === false) return undefined;
        return codexModel({
          model: entry.slug,
          displayName: entry.display_name,
          description: entry.description,
          defaultReasoningEffort: entry.default_reasoning_level,
          supportedReasoningEfforts: Array.isArray(entry.supported_reasoning_levels)
            ? entry.supported_reasoning_levels.map((level: unknown) => ({
                reasoningEffort: asRecord(level)?.effort,
              }))
            : [],
        });
      })
      .filter(isModel);
    if (!models.length) return undefined;
    logger.info("Code Agent model catalog loaded from cache", {
      event: "code_agent_catalog:cache_loaded",
      provider: RUNTIME_PROVIDER.CODEX,
      model_count: models.length,
    });
    return { provider: RUNTIME_PROVIDER.CODEX, models };
  } catch {
    return undefined;
  }
}

async function discoverCodexCatalogFromProcess(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<CodeAgentModelCatalog | undefined> {
  return withJsonlProcess(
    RUNTIME_PROVIDER.CODEX,
    command,
    cwd,
    async (process, progress) => {
      await initializeCodex(process, timeoutMs, progress);
      const models: CodeAgentModelMetadata[] = [];
      let cursor: string | undefined;
      do {
        progress.stage = "model/list";
        const response = await within(
          process.request({
            method: "model/list",
            params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
          }),
          timeoutMs,
        );
        const result = asRecord(response.result);
        progress.stage = "decode_catalog";
        if (!Array.isArray(result?.data))
          throw new CatalogDiscoveryError("Codex model catalog is unavailable");
        models.push(...result.data.map(codexModel).filter(isModel));
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      } while (cursor);
      return { provider: RUNTIME_PROVIDER.CODEX, models };
    },
    environment,
  );
}

/** Completes the Codex app-server handshake; a bounded wait guards the initialize reply. */
export async function initializeCodex(
  process: JsonlProcess,
  timeoutMs: number,
  progress?: CatalogProgress,
): Promise<void> {
  if (progress) progress.stage = "initialize";
  await within(
    process.request({
      method: "initialize",
      params: {
        clientInfo: {
          name: "coforge_daemon",
          title: "CoForge Daemon",
          version: COFORGE_DAEMON_VERSION,
        },
        capabilities: { experimentalApi: false },
      },
    }),
    timeoutMs,
  );
  if (progress) progress.stage = "initialized";
  await process.send({ method: "initialized", params: {} });
}

function codexModel(value: unknown): CodeAgentModelMetadata | undefined {
  const model = asRecord(value);
  if (typeof model?.model !== "string") return undefined;
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
        .map(asRecord)
        .map((effort) => effort?.reasoningEffort)
        .filter((effort): effort is string => typeof effort === "string")
    : [];
  return {
    id: model.model,
    displayName: typeof model.displayName === "string" ? model.displayName : model.model,
    description: typeof model.description === "string" ? model.description : "",
    modelProvider: "",
    reasoningEfforts: efforts,
    defaultReasoning:
      typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : "",
    recommended: model.isDefault === true,
  };
}
