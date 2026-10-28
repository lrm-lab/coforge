import { join } from "node:path";
import { CATALOG_CACHE_TTL_MS } from "#src/code-agent/runtime-inventory-cache";

const EFFORT_CACHE_ENTRY_LIMIT = 200;

export type EffortCacheEntry = { modelId: string; efforts: string[]; probedAt: number };
export type EffortCacheFile = { version: string; entries: EffortCacheEntry[] };

const inflight = new Map<string, Promise<unknown>>();
const writes = new Map<string, Promise<void>>();

export function effortCachePath(stateDirectory: string, fileName: string): string {
  return join(stateDirectory, fileName);
}

function parseEntry(value: unknown): EffortCacheEntry | undefined {
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

async function readCacheFile(path: string): Promise<EffortCacheFile | undefined> {
  try {
    const raw: unknown = await Bun.file(path).json();
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

/** The cached effort list for one model, or undefined when the version's file has no entry,
 * or the entry is older than the catalog TTL. An empty list is a real answer. */
export async function cachedEfforts(
  path: string,
  version: string,
  modelId: string,
  now: number,
): Promise<string[] | undefined> {
  const file = await readCacheFile(path);
  if (!file || file.version !== version) return undefined;
  const entry = file.entries.find((candidate) => candidate.modelId === modelId);
  if (!entry || now - entry.probedAt > CATALOG_CACHE_TTL_MS) return undefined;
  return entry.efforts;
}

/** Best-effort write; a cache that cannot be persisted only costs the next restart a re-probe.
 * Writes for one file serialize so concurrent models cannot lose each other's entries. */
export function rememberEfforts(
  path: string,
  version: string,
  modelId: string,
  efforts: readonly string[],
  probedAt: number,
): Promise<void> {
  const write = (writes.get(path) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const current = await readCacheFile(path);
      const entries = (current?.version === version ? current.entries : []).filter(
        (entry) => entry.modelId !== modelId,
      );
      entries.push({ modelId, efforts: [...efforts], probedAt });
      entries.sort((left, right) => right.probedAt - left.probedAt);
      await Bun.write(
        path,
        JSON.stringify({ version, entries: entries.slice(0, EFFORT_CACHE_ENTRY_LIMIT) }),
      );
    });
  writes.set(path, write);
  return write.catch(() => undefined);
}

/**
 * One in-flight read per key: callers racing the same model share the same promise.
 * An undefined key never dedupes.
 */
export function dedupeEffortRead<T>(key: string | undefined, work: () => Promise<T>): Promise<T> {
  if (!key) return work();
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const promise = work().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}
