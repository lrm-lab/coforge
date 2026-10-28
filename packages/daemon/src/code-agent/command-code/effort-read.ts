import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  readCommandCodeReasoningEfforts,
  type CommandCodeEffortRead,
  type CommandCodeRuntimeHost,
} from "@lrm/coforge-anvil/command-code";
import {
  cachedEfforts,
  dedupeEffortRead,
  effortCachePath,
  rememberEfforts,
} from "#src/code-agent/effort-cache";
import { resolveHostCodeAgentExecutable } from "#src/code-agent/runtime-executable";
import { commandCodeRuntimeHost } from "./host";

const CACHE_FILE_NAME = "command-code-effort-cache.json";

function cachePath(stateDirectory: string): string {
  return effortCachePath(stateDirectory, CACHE_FILE_NAME);
}

/** Same Computer is the daemon that holds the file. The key is CLI version plus model id.
 * A different version ignores the file. A failed read is not stored. No version skips the cache. */
export function readCommandCodeEffortsCached(input: {
  modelId: string;
  stateDirectory: string;
  version: string | undefined;
  now?: () => number;
  live: () => Promise<CommandCodeEffortRead>;
}): Promise<CommandCodeEffortRead> {
  const modelId = input.modelId.trim();
  if (!modelId) return Promise.resolve({ status: "failed", code: "model_missing" });
  const version = input.version?.trim() || undefined;
  const key = version ? `${input.stateDirectory}\0${version}\0${modelId}` : undefined;
  return dedupeEffortRead(key, () =>
    readCachedOrLive(input.stateDirectory, version, modelId, input.now ?? Date.now, input.live),
  );
}

async function readCachedOrLive(
  stateDirectory: string,
  version: string | undefined,
  modelId: string,
  now: () => number,
  live: () => Promise<CommandCodeEffortRead>,
): Promise<CommandCodeEffortRead> {
  if (version) {
    const efforts = await cachedEfforts(cachePath(stateDirectory), version, modelId, now());
    // An empty list is a real answer: this model has no effort control.
    if (efforts !== undefined) return { status: "ready", efforts };
  }
  const result = await live().catch((): CommandCodeEffortRead => ({
    status: "failed",
    code: "unavailable",
  }));
  if (version && result.status === "ready")
    await rememberEfforts(cachePath(stateDirectory), version, modelId, result.efforts, now());
  return result;
}

async function readLive(
  command: readonly string[],
  modelId: string,
  environment: Readonly<Record<string, string | undefined>>,
  host: CommandCodeRuntimeHost,
): Promise<CommandCodeEffortRead> {
  // node:fs mkdtemp and rm: the probe cwd must stay out of any user workspace, and the directory
  // has to be removed even when the CLI fails. Bun's file API does not own that temporary directory.
  const cwd = await mkdtemp(join(tmpdir(), "coforge-command-code-effort-"));
  try {
    return await readCommandCodeReasoningEfforts(command, cwd, environment, host, modelId);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Production read: this Computer's `cmd`, cached by its version and the model id. */
export async function readHostCommandCodeEfforts(
  stateDirectory: string,
  modelId: string,
  version?: string,
): Promise<CommandCodeEffortRead> {
  const executable = resolveHostCodeAgentExecutable(RUNTIME_PROVIDER.COMMAND_CODE);
  if (!executable) return { status: "failed", code: "unavailable" };
  return readCommandCodeEffortsCached({
    modelId,
    stateDirectory,
    version,
    live: () => readLive([executable], modelId, Bun.env, commandCodeRuntimeHost),
  });
}
