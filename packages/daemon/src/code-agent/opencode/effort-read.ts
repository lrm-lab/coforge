import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  diagnosticErrorCode,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { readOpenCodeModelEfforts, type OpenCodeEffortRead } from "@lrm/coforge-anvil/opencode";
import {
  cachedEffortsForModels,
  dedupeEffortRead,
  effortCachePath,
  rememberEfforts,
} from "#src/code-agent/effort-cache";
import { resolveHostCodeAgentExecutable } from "#src/code-agent/runtime-executable";
import { openCodeAcpRuntimeHost } from "./acp-host";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.OPENCODE]);
const CACHE_FILE_NAME = "opencode-effort-cache.json";
/** One `opencode acp` sweep's overall budget; per-request bounds inside it stay `timeoutMs`. */
const OPENCODE_EFFORT_SWEEP_TIMEOUT_MS = 120_000;

function cachePath(stateDirectory: string): string {
  return effortCachePath(stateDirectory, CACHE_FILE_NAME);
}

export type OpenCodeCatalogEfforts = {
  /** False when at least one model's effort list could not be read or cached this round; the
   * caller may publish the model list but must not treat those models as effort-less. */
  complete: boolean;
  efforts: ReadonlyMap<string, readonly string[]>;
};

/** Cache-only lookup for the catalog path: publishing a model list must not wait on a process,
 * so discovery fills efforts from the cache alone and the effort sweep reports again later. */
export async function cachedOpenCodeEfforts(
  stateDirectory: string | undefined,
  version: string | undefined,
  modelIds: readonly string[],
  now = Date.now(),
): Promise<ReadonlyMap<string, readonly string[]>> {
  if (!stateDirectory || !version?.trim()) return new Map();
  return cachedEffortsForModels(cachePath(stateDirectory), version.trim(), modelIds, now);
}

/** A catalog's models with effort lists filled from the cache alone; `complete` is false while
 * a model has no fresh entry — unread, never proof that the model has no effort control. */
export async function openCodeCatalogWithCachedEfforts(
  catalog: CodeAgentModelCatalog,
  stateDirectory: string | undefined,
  version: string | undefined,
): Promise<{ catalog: CodeAgentModelCatalog; complete: boolean }> {
  const efforts = await cachedOpenCodeEfforts(
    stateDirectory,
    version,
    catalog.models.map((model) => model.id),
  );
  return {
    complete: catalog.models.every((model) => efforts.has(model.id)),
    catalog: {
      ...catalog,
      models: catalog.models.map((model) => {
        const cached = efforts.get(model.id);
        return cached ? { ...model, reasoningEfforts: [...cached] } : model;
      }),
    },
  };
}

type OpenCodeEffortSweep = (
  modelIds: readonly string[],
) => Promise<ReadonlyMap<string, OpenCodeEffortRead>>;

/**
 * The effort list for each catalog model, cached by CLI version plus model id like Command
 * Code's. Cached hits answer without a process; missing entries are read in one `opencode acp`
 * sweep. A failed or uncached model leaves `complete` false: an unknown list is never published
 * as "this model has no efforts". A failed read is not stored; no version skips the cache.
 */
export async function readOpenCodeEffortsForCatalog(input: {
  modelIds: readonly string[];
  stateDirectory: string | undefined;
  version: string | undefined;
  now?: () => number;
  live: OpenCodeEffortSweep;
}): Promise<OpenCodeCatalogEfforts> {
  const now = input.now ?? Date.now;
  const version = input.version?.trim() || undefined;
  const efforts = new Map<string, readonly string[]>();
  const path = input.stateDirectory ? cachePath(input.stateDirectory) : undefined;
  const missing: string[] = [];
  if (version && path) {
    const cached = await cachedEffortsForModels(path, version, input.modelIds, now());
    for (const modelId of input.modelIds) {
      const entry = cached.get(modelId);
      if (entry === undefined) missing.push(modelId);
      else efforts.set(modelId, entry);
    }
  } else missing.push(...input.modelIds);
  const key =
    version && input.stateDirectory
      ? `${input.stateDirectory}\0${version}\0opencode-sweep\0${missing.join("\0")}`
      : undefined;
  const reads = missing.length
    ? await dedupeEffortRead(key, () =>
        input.live(missing).catch((error): ReadonlyMap<string, OpenCodeEffortRead> => {
          logger.warn("code_agent_catalog:effort_sweep_live_failed", {
            provider: RUNTIME_PROVIDER.OPENCODE,
            error_code: diagnosticErrorCode(error),
            error_message: error instanceof Error ? error.message : String(error),
          });
          return new Map();
        }),
      )
    : new Map<string, OpenCodeEffortRead>();
  let complete = true;
  for (const modelId of missing) {
    const read = reads.get(modelId);
    if (read?.status === "ready") {
      efforts.set(modelId, read.efforts);
      if (version && path) {
        // An empty list is a real answer: this model has no effort control.
        await rememberEfforts(path, version, modelId, read.efforts, now());
      }
    } else complete = false;
  }
  return { complete, efforts };
}

async function sweepLive(
  command: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  modelIds: readonly string[],
): Promise<ReadonlyMap<string, OpenCodeEffortRead>> {
  // node:fs mkdtemp and rm: the probe cwd must stay out of any user workspace, and the directory
  // has to be removed even when the CLI fails. Bun's file API does not own that temporary directory.
  const cwd = await mkdtemp(join(tmpdir(), "coforge-opencode-effort-"));
  try {
    // The sweep's own budget disposes the transport on expiry — a hung model cannot hold the
    // inventory report or a queued refresh, and the reads already gathered come back.
    return await readOpenCodeModelEfforts(
      command,
      cwd,
      environment,
      openCodeAcpRuntimeHost,
      modelIds,
      undefined,
      OPENCODE_EFFORT_SWEEP_TIMEOUT_MS,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Production read: this Computer's `opencode`, cached by its version and the model id. */
export async function readHostOpenCodeEfforts(
  stateDirectory: string | undefined,
  version: string | undefined,
  modelIds: readonly string[],
): Promise<OpenCodeCatalogEfforts> {
  const executable = resolveHostCodeAgentExecutable(RUNTIME_PROVIDER.OPENCODE);
  if (!executable)
    return {
      complete: modelIds.length === 0,
      efforts: new Map(),
    };
  return readOpenCodeEffortsForCatalog({
    modelIds,
    stateDirectory,
    version,
    live: (missing) => sweepLive([executable], Bun.env, missing),
  });
}
