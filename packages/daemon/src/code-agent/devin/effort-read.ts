import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROVIDER, type CodeAgentModelCatalog } from "@lrm/coforge-sdk/internal";
import {
  readDevinModelEfforts,
  type DevinEffortRead,
  type DevinRuntimeHost,
} from "@lrm/coforge-anvil/devin";
import { withDeadline } from "@lrm/coforge-anvil";
import {
  cachedEffortsForModels,
  dedupeEffortRead,
  effortCachePath,
  rememberEfforts,
} from "#src/code-agent/effort-cache";
import { resolveHostCodeAgentExecutable } from "#src/code-agent/runtime-executable";
import { devinRuntimeHost } from "./host";

const CACHE_FILE_NAME = "devin-effort-cache.json";
/** One `devin acp` sweep's overall budget; per-request bounds inside it stay `timeoutMs`. */
const DEVIN_EFFORT_SWEEP_TIMEOUT_MS = 120_000;

function cachePath(stateDirectory: string): string {
  return effortCachePath(stateDirectory, CACHE_FILE_NAME);
}

export type DevinCatalogEfforts = {
  /** False when at least one model's effort list could not be read or cached this round; the
   * caller may publish the model list but must not treat those models as effort-less. */
  complete: boolean;
  efforts: ReadonlyMap<string, readonly string[]>;
};

/** Cache-only lookup for the catalog path: publishing a model list must not wait on a process,
 * so discovery fills efforts from the cache alone and the effort sweep reports again later. */
export async function cachedDevinEfforts(
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
export async function devinCatalogWithCachedEfforts(
  catalog: CodeAgentModelCatalog,
  stateDirectory: string | undefined,
  version: string | undefined,
): Promise<{ catalog: CodeAgentModelCatalog; complete: boolean }> {
  const efforts = await cachedDevinEfforts(
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

type DevinEffortSweep = (
  modelIds: readonly string[],
) => Promise<ReadonlyMap<string, DevinEffortRead>>;

/**
 * The effort list for each catalog model, cached by CLI version plus model id like Command
 * Code's. Cached hits answer without a process; missing entries are read in one `devin acp`
 * sweep. A failed or uncached model leaves `complete` false: an unknown list is never published
 * as "this model has no efforts". A failed read is not stored; no version skips the cache.
 */
export async function readDevinEffortsForCatalog(input: {
  modelIds: readonly string[];
  stateDirectory: string | undefined;
  version: string | undefined;
  now?: () => number;
  live: DevinEffortSweep;
}): Promise<DevinCatalogEfforts> {
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
      ? `${input.stateDirectory}\0${version}\0devin-sweep\0${missing.join("\0")}`
      : undefined;
  const reads = missing.length
    ? await dedupeEffortRead(key, () =>
        input.live(missing).catch((): ReadonlyMap<string, DevinEffortRead> => new Map()),
      )
    : new Map<string, DevinEffortRead>();
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
  host: DevinRuntimeHost,
  modelIds: readonly string[],
): Promise<ReadonlyMap<string, DevinEffortRead>> {
  // node:fs mkdtemp and rm: the probe cwd must stay out of any user workspace, and the directory
  // has to be removed even when the CLI fails. Bun's file API does not own that temporary directory.
  const cwd = await mkdtemp(join(tmpdir(), "coforge-devin-effort-"));
  try {
    // A whole sweep of one CLI session gets one overall budget: a hung model cannot hold the
    // inventory report or a queued refresh for longer than this.
    return await withDeadline(
      readDevinModelEfforts(command, cwd, environment, host, modelIds),
      DEVIN_EFFORT_SWEEP_TIMEOUT_MS,
      () => new Error("Devin effort sweep timed out"),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Production read: this Computer's `devin`, cached by its version and the model id. */
export async function readHostDevinEfforts(
  stateDirectory: string | undefined,
  version: string | undefined,
  modelIds: readonly string[],
): Promise<DevinCatalogEfforts> {
  const executable = resolveHostCodeAgentExecutable(RUNTIME_PROVIDER.DEVIN);
  if (!executable)
    return {
      complete: modelIds.length === 0,
      efforts: new Map(),
    };
  return readDevinEffortsForCatalog({
    modelIds,
    stateDirectory,
    version,
    live: (missing) => sweepLive([executable], Bun.env, devinRuntimeHost, missing),
  });
}
