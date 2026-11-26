import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type RuntimeCliVersionObservation = {
  provider: string;
  version: string;
  executablePath: string;
};

export type RuntimeCliDowngrade = {
  provider: string;
  previousVersion: string;
  currentVersion: string;
  previousPath: string;
  currentPath: string;
  detectedAt: string;
};

type TrackedDowngrade = {
  currentVersion: string;
  currentPath: string;
  detectedAt: string;
};

type TrackedRuntimeEntry = {
  highestVersion: string;
  highestPath: string;
  highestObservedAt: string;
  downgrade?: TrackedDowngrade;
};

type PersistedRuntimeCliVersions = {
  schemaVersion: 1;
  providers: Record<string, TrackedRuntimeEntry>;
};

const VERSIONS_FILE_NAME = "runtime-cli-versions.json";
const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

const updateChains = new Map<string, Promise<void>>();

export function runtimeCliVersionsPath(stateDirectory: string): string {
  return join(stateDirectory, VERSIONS_FILE_NAME);
}

export function parseComparableSemver(
  version: string,
): readonly [number, number, number] | undefined {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return undefined;
  }
  return [major, minor, patch];
}

function normalizeSemver(version: string): string | undefined {
  const parsed = parseComparableSemver(version);
  return parsed ? `${parsed[0]}.${parsed[1]}.${parsed[2]}` : undefined;
}

export function compareSemver(a: string, b: string): number | undefined {
  const normalizedA = normalizeSemver(a);
  const normalizedB = normalizeSemver(b);
  if (!normalizedA || !normalizedB) return undefined;
  return Bun.semver.order(normalizedA, normalizedB);
}

export async function readRuntimeCliDowngrades(
  stateDirectory: string,
): Promise<RuntimeCliDowngrade[]> {
  const persisted = await readPersisted(runtimeCliVersionsPath(stateDirectory));
  const downgrades: RuntimeCliDowngrade[] = [];
  for (const provider of Object.keys(persisted.providers).sort()) {
    const entry = persisted.providers[provider];
    if (!entry?.downgrade) continue;
    downgrades.push({
      provider,
      previousVersion: entry.highestVersion,
      currentVersion: entry.downgrade.currentVersion,
      previousPath: entry.highestPath,
      currentPath: entry.downgrade.currentPath,
      detectedAt: entry.downgrade.detectedAt,
    });
  }
  return downgrades;
}

export async function recordRuntimeCliObservations(
  stateDirectory: string,
  observations: readonly RuntimeCliVersionObservation[],
  now: () => Date = () => new Date(),
): Promise<RuntimeCliDowngrade[]> {
  if (observations.length === 0) return [];
  const filePath = runtimeCliVersionsPath(stateDirectory);
  const previous = updateChains.get(filePath) ?? Promise.resolve();
  let newlyDetected: RuntimeCliDowngrade[] = [];
  const run = previous
    .catch(() => {})
    .then(async () => {
      const persisted = await readPersisted(filePath);
      const isoNow = now().toISOString();
      let dirty = false;
      const detected: RuntimeCliDowngrade[] = [];
      for (const observation of observations) {
        const normalizedVersion = normalizeSemver(observation.version);
        if (!normalizedVersion) continue;
        const existing = Object.hasOwn(persisted.providers, observation.provider)
          ? persisted.providers[observation.provider]
          : undefined;
        if (!existing) {
          persisted.providers[observation.provider] = {
            highestVersion: normalizedVersion,
            highestPath: observation.executablePath,
            highestObservedAt: isoNow,
          };
          dirty = true;
          continue;
        }
        const comparison = compareSemver(normalizedVersion, existing.highestVersion);
        if (comparison === undefined) continue;
        if (comparison > 0) {
          persisted.providers[observation.provider] = {
            highestVersion: normalizedVersion,
            highestPath: observation.executablePath,
            highestObservedAt: isoNow,
          };
          dirty = true;
        } else if (comparison === 0) {
          if (
            existing.downgrade ||
            existing.highestPath !== observation.executablePath ||
            existing.highestVersion !== normalizedVersion
          ) {
            persisted.providers[observation.provider] = {
              highestVersion: normalizedVersion,
              highestPath: observation.executablePath,
              highestObservedAt: existing.highestObservedAt,
            };
            dirty = true;
          }
        } else {
          const sameDowngrade =
            existing.downgrade !== undefined &&
            normalizeSemver(existing.downgrade.currentVersion) === normalizedVersion &&
            existing.downgrade.currentPath === observation.executablePath;
          if (!sameDowngrade) {
            const downgrade: TrackedDowngrade = {
              currentVersion: normalizedVersion,
              currentPath: observation.executablePath,
              detectedAt: isoNow,
            };
            persisted.providers[observation.provider] = {
              ...existing,
              downgrade,
            };
            dirty = true;
            detected.push({
              provider: observation.provider,
              previousVersion: existing.highestVersion,
              currentVersion: normalizedVersion,
              previousPath: existing.highestPath,
              currentPath: observation.executablePath,
              detectedAt: isoNow,
            });
          }
        }
      }
      newlyDetected = detected;
      if (dirty) await writePersisted(filePath, persisted);
    });
  const settled = run.catch(() => {});
  updateChains.set(filePath, settled);
  try {
    await run;
  } catch {
    return [];
  } finally {
    if (updateChains.get(filePath) === settled) updateChains.delete(filePath);
  }
  return newlyDetected;
}

async function readPersisted(filePath: string): Promise<PersistedRuntimeCliVersions> {
  try {
    const raw: unknown = await Bun.file(filePath).json();
    if (!isPersistedRecord(raw)) return { schemaVersion: 1, providers: {} };
    return raw;
  } catch {
    return { schemaVersion: 1, providers: {} };
  }
}

async function writePersisted(
  filePath: string,
  record: PersistedRuntimeCliVersions,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record) + "\n", { mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function isPersistedRecord(value: unknown): value is PersistedRuntimeCliVersions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.providers !== "object" ||
    record.providers === null ||
    Array.isArray(record.providers)
  ) {
    return false;
  }
  for (const entry of Object.values(record.providers as Record<string, unknown>)) {
    if (!isTrackedEntry(entry)) return false;
  }
  return true;
}

function isTrackedEntry(value: unknown): value is TrackedRuntimeEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.highestVersion !== "string" ||
    !parseComparableSemver(entry.highestVersion) ||
    typeof entry.highestPath !== "string" ||
    typeof entry.highestObservedAt !== "string"
  ) {
    return false;
  }
  if (entry.downgrade !== undefined) {
    if (
      typeof entry.downgrade !== "object" ||
      entry.downgrade === null ||
      Array.isArray(entry.downgrade)
    ) {
      return false;
    }
    const downgrade = entry.downgrade as Record<string, unknown>;
    if (
      typeof downgrade.currentVersion !== "string" ||
      !parseComparableSemver(downgrade.currentVersion) ||
      typeof downgrade.currentPath !== "string" ||
      typeof downgrade.detectedAt !== "string"
    ) {
      return false;
    }
  }
  return true;
}
