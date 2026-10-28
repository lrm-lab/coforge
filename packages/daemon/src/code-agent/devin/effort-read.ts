import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  readDevinModelEfforts,
  type DevinEffortRead,
  type DevinRuntimeHost,
} from "@lrm/coforge-anvil/devin";
import {
  cachedEfforts,
  dedupeEffortRead,
  effortCachePath,
  rememberEfforts,
} from "#src/code-agent/effort-cache";
import { resolveHostCodeAgentExecutable } from "#src/code-agent/runtime-executable";
import { devinRuntimeHost } from "./host";

const CACHE_FILE_NAME = "devin-effort-cache.json";

function cachePath(stateDirectory: string): string {
  return effortCachePath(stateDirectory, CACHE_FILE_NAME);
}

export type DevinCatalogEfforts = {
  /** False when at least one model's effort list could not be read or cached this round; the
   * caller must not publish those models as effort-less. */
  complete: boolean;
  efforts: ReadonlyMap<string, readonly string[]>;
};

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
  for (const modelId of input.modelIds) {
    if (!version || !path) {
      missing.push(modelId);
      continue;
    }
    const cached = await cachedEfforts(path, version, modelId, now());
    if (cached === undefined) missing.push(modelId);
    else efforts.set(modelId, cached);
  }
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
    return await readDevinModelEfforts(command, cwd, environment, host, modelIds);
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
