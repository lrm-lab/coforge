import { join } from "node:path";
import { z } from "zod";
import { CATALOG_CACHE_TTL_MS } from "#src/code-agent/runtime-inventory-cache";

const EFFORT_CACHE_ENTRY_LIMIT = 200;

export type EffortCacheEntry = { modelId: string; efforts: string[]; probedAt: number };
export type EffortCacheFile = { version: string; entries: EffortCacheEntry[] };

const effortCacheEntrySchema = z.object({
  modelId: z.string().min(1),
  probedAt: z.number(),
  efforts: z.array(z.unknown()),
});

const effortCacheFileSchema = z.object({
  version: z.string().min(1),
  entries: z.array(z.unknown()),
});

const inflight = new Map<string, Promise<unknown>>();
const writes = new Map<string, Promise<void>>();

export function effortCachePath(stateDirectory: string, fileName: string): string {
  return join(stateDirectory, fileName);
}

function parseEntry(value: unknown): EffortCacheEntry | undefined {
  const parsed = effortCacheEntrySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const efforts = parsed.data.efforts.filter(
    (effort): effort is string =>
      typeof effort === "string" && effort.length > 0 && effort !== "default",
  );
  return { modelId: parsed.data.modelId, efforts, probedAt: parsed.data.probedAt };
}

async function readCacheFile(path: string): Promise<EffortCacheFile | undefined> {
  try {
    const raw: unknown = await Bun.file(path).json();
    const parsed = effortCacheFileSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    return {
      version: parsed.data.version,
      entries: parsed.data.entries.flatMap((entry) => parseEntry(entry) ?? []),
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

/** One file read for many models: the cached effort list of each model that has a fresh entry.
 * Missing, stale or unversioned answers are absent, never empty. */
export async function cachedEffortsForModels(
  path: string,
  version: string,
  modelIds: readonly string[],
  now: number,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const efforts = new Map<string, readonly string[]>();
  const file = await readCacheFile(path);
  if (!file || file.version !== version) return efforts;
  for (const modelId of modelIds) {
    const entry = file.entries.find((candidate) => candidate.modelId === modelId);
    if (entry && now - entry.probedAt <= CATALOG_CACHE_TTL_MS) efforts.set(modelId, entry.efforts);
  }
  return efforts;
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
