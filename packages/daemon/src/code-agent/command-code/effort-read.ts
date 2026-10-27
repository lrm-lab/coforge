import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  readCommandCodeReasoningEfforts,
  type CommandCodeEffortRead,
  type CommandCodeRuntimeHost,
} from "@lrm/coforge-anvil/command-code";
import { CATALOG_CACHE_TTL_MS } from "#src/code-agent/runtime-inventory-cache";
import { resolveHostCodeAgentExecutable } from "#src/code-agent/runtime-executable";
import { commandCodeRuntimeHost } from "./host";

const CACHE_FILE_NAME = "command-code-effort-cache.json";
const CACHE_ENTRY_LIMIT = 200;

type CacheEntry = { modelId: string; efforts: string[]; probedAt: number };
type CacheFile = { version: string; entries: CacheEntry[] };

const inflight = new Map<string, Promise<CommandCodeEffortRead>>();
let writes: Promise<void> = Promise.resolve();

function cachePath(stateDirectory: string): string {
  return join(stateDirectory, CACHE_FILE_NAME);
}

function parseEntry(value: unknown): CacheEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as { modelId?: unknown; efforts?: unknown; probedAt?: unknown };
  if (typeof entry.modelId !== "string" || !entry.modelId) return undefined;
  if (typeof entry.probedAt !== "number" || !Number.isFinite(entry.probedAt)) return undefined;
  if (!Array.isArray(entry.efforts)) return undefined;
  const efforts = entry.efforts.filter(
    (effort): effort is string =>
      typeof effort === "string" && effort.length > 0 && effort !== "default",
  );
  return { modelId: entry.modelId, efforts, probedAt: entry.probedAt };
}

async function readCacheFile(stateDirectory: string): Promise<CacheFile | undefined> {
  try {
    const raw: unknown = await Bun.file(cachePath(stateDirectory)).json();
    if (!raw || typeof raw !== "object") return undefined;
    const file = raw as { version?: unknown; entries?: unknown };
    if (typeof file.version !== "string" || !file.version || !Array.isArray(file.entries))
      return undefined;
    return {
      version: file.version,
      entries: file.entries.flatMap((entry) => parseEntry(entry) ?? []),
    };
  } catch {
    return undefined;
  }
}

async function cachedEfforts(
  stateDirectory: string,
  version: string,
  modelId: string,
  now: number,
): Promise<string[] | undefined> {
  const file = await readCacheFile(stateDirectory);
  if (!file || file.version !== version) return undefined;
  const entry = file.entries.find((candidate) => candidate.modelId === modelId);
  if (!entry || now - entry.probedAt > CATALOG_CACHE_TTL_MS) return undefined;
  return entry.efforts;
}

function remember(
  stateDirectory: string,
  version: string,
  modelId: string,
  efforts: string[],
  probedAt: number,
): Promise<void> {
  const write = writes
    .catch(() => undefined)
    .then(async () => {
      const current = await readCacheFile(stateDirectory);
      const entries = (current?.version === version ? current.entries : []).filter(
        (entry) => entry.modelId !== modelId,
      );
      entries.push({ modelId, efforts, probedAt });
      entries.sort((left, right) => right.probedAt - left.probedAt);
      await Bun.write(
        cachePath(stateDirectory),
        JSON.stringify({ version, entries: entries.slice(0, CACHE_ENTRY_LIMIT) }),
      );
    });
  writes = write;
  return write.catch(() => undefined);
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
  if (key) {
    const pending = inflight.get(key);
    if (pending) return pending;
  }
  const work = readCachedOrLive(
    input.stateDirectory,
    version,
    modelId,
    input.now ?? Date.now,
    input.live,
    key,
  );
  if (key) inflight.set(key, work);
  return work;
}

async function readCachedOrLive(
  stateDirectory: string,
  version: string | undefined,
  modelId: string,
  now: () => number,
  live: () => Promise<CommandCodeEffortRead>,
  key: string | undefined,
): Promise<CommandCodeEffortRead> {
  try {
    if (version) {
      const efforts = await cachedEfforts(stateDirectory, version, modelId, now());
      // An empty list is a real answer: this model has no effort control.
      if (efforts !== undefined) return { status: "ready", efforts };
    }
    const result = await live().catch((): CommandCodeEffortRead => ({
      status: "failed",
      code: "unavailable",
    }));
    if (version && result.status === "ready")
      await remember(stateDirectory, version, modelId, result.efforts, now());
    return result;
  } finally {
    if (key) inflight.delete(key);
  }
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
