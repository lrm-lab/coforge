import {
  RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

import {
  getUsageCache,
  type UsageCacheKey,
  type UsageReadResult,
} from "#src/server/centrifugo/usage-cache.server";
import { defaultCloudComputerHiddenFromViewer } from "./computer-list-visibility.server";
import { runtimeVisibleToViewer } from "./computer-runtime-visibility.server";
import { drawnReading } from "./runtime-usage-access.server";

type ListUsageComputer = {
  id: string;
  ownerId: string;
  kind?: string;
  cloudSlot?: string | null;
};
type ListUsageRuntime = {
  computerId: string;
  provider: RuntimeProvider;
  isPublic?: boolean;
  unavailableCode: string | null;
};

export async function readListRuntimeUsages(input: {
  workspaceId: string;
  userId: string;
  canManage: boolean;
  computers: readonly ListUsageComputer[];
  runtimes: readonly ListUsageRuntime[];
  readMany?: (keys: readonly UsageCacheKey[]) => Promise<UsageReadResult[]>;
}): Promise<Map<string, Partial<Record<RuntimeProvider, UsageReadResult>>>> {
  const { workspaceId, userId, canManage, computers, runtimes } = input;
  const runtimesByComputer = new Map<string, ListUsageRuntime[]>();
  for (const runtime of runtimes) {
    if (runtime.unavailableCode || !RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[runtime.provider]) {
      continue;
    }
    const list = runtimesByComputer.get(runtime.computerId);
    if (list) list.push(runtime);
    else runtimesByComputer.set(runtime.computerId, [runtime]);
  }

  const requests: {
    key: UsageCacheKey;
    computerId: string;
    provider: RuntimeProvider;
    owned: boolean;
  }[] = [];

  for (const computer of computers) {
    if (
      computer.kind !== undefined &&
      defaultCloudComputerHiddenFromViewer(userId, {
        kind: computer.kind,
        cloudSlot: computer.cloudSlot ?? null,
        ownerId: computer.ownerId,
      })
    ) {
      continue;
    }
    const owned = computer.ownerId === userId;
    if (!owned && !canManage) continue;
    const computerRuntimes = runtimesByComputer.get(computer.id);
    if (!computerRuntimes) continue;
    for (const runtime of computerRuntimes) {
      if (
        !runtimeVisibleToViewer(userId, {
          ownerId: computer.ownerId,
          isPublic: runtime.isPublic ?? false,
        })
      ) {
        continue;
      }
      requests.push({
        key: { workspaceId, computerId: computer.id, provider: runtime.provider },
        computerId: computer.id,
        provider: runtime.provider,
        owned,
      });
    }
  }

  const byComputer = new Map<string, Partial<Record<RuntimeProvider, UsageReadResult>>>();
  if (requests.length === 0) return byComputer;
  const readMany = input.readMany ?? ((keys) => getUsageCache().readMany(keys));
  const readings = await readMany(requests.map((entry) => entry.key)).catch(() => []);
  requests.forEach((entry, index) => {
    const reading = readings[index];
    if (!reading || reading.state === "missing") return;
    const map = byComputer.get(entry.computerId) ?? {};
    map[entry.provider] = entry.owned ? reading : drawnReading(reading);
    byComputer.set(entry.computerId, map);
  });
  return byComputer;
}
