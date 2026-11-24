import type { RuntimeAuthProvider, RuntimeAuthStatus } from "@lrm/coforge-anvil";
import {
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN,
  type AgentDisplaySnapshot,
  type RuntimeProvider,
  type RuntimeUnavailableCode,
} from "@lrm/coforge-sdk/internal";

import { humanLabel } from "#src/lib/human-label";
import type { UsageReadResult, UsageSnapshot } from "#src/server/centrifugo/usage-cache.server";
import {
  availableUpdateVersion,
  computerKind,
  computerLabel,
  operatingSystemLabel,
  type ComputerIdentity,
  type ComputerPlatformInfo,
} from "./computer-identity";
import { orderComputersOwnFirst } from "./computer-list-order";
import {
  isMachineDiskLow,
  machineUsedPercent,
  type MachineStatusView,
} from "./computer-machine-status";
import { activeRefusal, type ComputerConnectRefusal } from "./computer-refusal";
import type { ComputerUpgradeStatus } from "./computer.schemas";
import { isSignableRuntimeProvider } from "./runtime-login-chip";
import {
  accountProblem,
  shownAccount,
  usageReadForAuth,
  usageStatus,
} from "./runtime-usage-status";
import { usageLevel, type UsageLevel } from "./usage-level";

export type ComputerOverviewStatusFilter = "all" | "online" | "offline" | "attention";
export type ComputerOverviewRuntimeFilter = "all" | "other" | RuntimeProvider;
export type ComputerOverviewGroupBy = "none" | "owner" | "kind" | "prefix";
export type ComputerOverviewSortBy =
  | "attention"
  | "name"
  | "disk"
  | "memory"
  | `runtime:${RuntimeProvider}`;

export type ComputerOverviewItem = ComputerIdentity &
  ComputerPlatformInfo & {
    id: string;
    online: boolean;
    connectRefusal?: ComputerConnectRefusal | null;
    ownedByCurrentUser: boolean;
    canManageAgents?: boolean;
    computerVersion?: string | null;
    releaseChannel?: string;
    imageVersion?: string | null;
    imageUpdate?: { version: string } | null;
    upgrade?: ComputerUpgradeStatus | null;
    upgradeProgressRequestId?: string;
    machine?: MachineStatusView;
    creator?: {
      username: string;
      displayName: string | null;
      avatarUrl: string | null;
    } | null;
    runtimeAuth?: Partial<Record<RuntimeAuthProvider, RuntimeAuthStatus>>;
    runtimeUsages?: Partial<Record<RuntimeProvider, UsageReadResult>>;
    runtimes: {
      id: string;
      provider: RuntimeProvider;
      version: string;
      displayName: string;
      unavailableCode?: RuntimeUnavailableCode | null;
      diagnostic?: string | null;
      isPublic: boolean;
    }[];
    agents: {
      id: string;
      name: string;
      displayName: string;
      avatarUrl: string | null;
      provider?: RuntimeProvider;
      display?: AgentDisplaySnapshot;
    }[];
  };

export type RuntimeMeterView =
  | {
      kind: "meter";
      usedPercent: number;
      leftPercent: number;
      level: UsageLevel;
      limitReached: boolean;
    }
  | { kind: "attention" }
  | { kind: "unmeasured" };

const METERED_PROVIDER_ORDER: readonly RuntimeProvider[] = [
  RUNTIME_PROVIDER.CLAUDE_CODE,
  RUNTIME_PROVIDER.CODEX,
  RUNTIME_PROVIDER.GROK,
  RUNTIME_PROVIDER.ANTIGRAVITY,
  RUNTIME_PROVIDER.KIRO,
];

export function isMeteredRuntime(runtime: {
  provider: RuntimeProvider;
  unavailableCode?: RuntimeUnavailableCode | null;
}): boolean {
  return (
    !runtime.unavailableCode && Boolean(RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[runtime.provider])
  );
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function snapshotPrimaryUsedPercent(snapshot: UsageSnapshot): {
  usedPercent: number;
  limitReached: boolean;
} | null {
  if (snapshot.primary?.usedPercent !== undefined) {
    return {
      usedPercent: clampPercent(snapshot.primary.usedPercent),
      limitReached:
        snapshot.primary.status === "limit_reached" || snapshot.health === "rate_limited",
    };
  }
  const bucket = snapshot.officialGroups?.flatMap((group) => group.buckets)[0];
  if (bucket) {
    const usedPercent =
      bucket.usedPercent !== undefined
        ? clampPercent(bucket.usedPercent)
        : bucket.remainingFraction !== undefined
          ? clampPercent((1 - Math.min(1, Math.max(0, bucket.remainingFraction))) * 100)
          : undefined;
    if (usedPercent !== undefined) {
      return {
        usedPercent,
        limitReached: bucket.status === "limit_reached" || snapshot.health === "rate_limited",
      };
    }
  }
  if (snapshot.creditUsage && snapshot.creditUsage.limit > 0) {
    const usedPercent = clampPercent(
      (snapshot.creditUsage.used / snapshot.creditUsage.limit) * 100,
    );
    return {
      usedPercent,
      limitReached: snapshot.health === "rate_limited" || usedPercent >= 100,
    };
  }
  return null;
}

export function computerRuntimeMeter(
  computer: Pick<ComputerOverviewItem, "runtimeAuth" | "runtimeUsages">,
  provider: RuntimeProvider,
): RuntimeMeterView {
  const rawUsage = computer.runtimeUsages?.[provider];
  const rawAccount = isSignableRuntimeProvider(provider)
    ? computer.runtimeAuth?.[provider]?.state
    : undefined;
  const account = shownAccount(rawAccount, rawUsage);
  if (accountProblem(account)) return { kind: "attention" };
  const usage = usageReadForAuth(rawUsage, account);
  const result = usage?.result;
  if (!result) return { kind: "unmeasured" };
  const status = usageStatus(result);
  if (result.status === "reauth") return { kind: "attention" };
  if (result.snapshot) {
    const primary = snapshotPrimaryUsedPercent(result.snapshot);
    if (primary) {
      const limitReached = primary.limitReached || status?.ok === false;
      const leftPercent = limitReached ? 0 : Math.max(0, 100 - primary.usedPercent);
      return {
        kind: "meter",
        usedPercent: primary.usedPercent,
        leftPercent,
        level: usageLevel(primary.usedPercent, limitReached),
        limitReached,
      };
    }
  }
  if (status && !status.ok) return { kind: "attention" };
  return { kind: "unmeasured" };
}

export function computerHasRuntimeAttention(computer: ComputerOverviewItem): boolean {
  return computer.runtimes.some((runtime) => {
    if (!isMeteredRuntime(runtime)) return false;
    const meter = computerRuntimeMeter(computer, runtime.provider);
    return meter.kind === "attention" || (meter.kind === "meter" && meter.level === "empty");
  });
}

export function computerNeedsAttention(computer: ComputerOverviewItem): boolean {
  if (!computer.online) return true;
  if (activeRefusal(computer)) return true;
  if (computer.upgrade?.status === "failed") return true;
  if (computer.machine?.disk && isMachineDiskLow(computer.machine.disk)) return true;
  if (computerHasRuntimeAttention(computer)) return true;
  return false;
}

export function computerAttentionScore(computer: ComputerOverviewItem): number {
  let score = 0;
  if (activeRefusal(computer)) score += 100;
  if (!computer.online) score += 60;
  if (computer.upgrade?.status === "failed") score += 40;
  if (computer.machine?.disk && isMachineDiskLow(computer.machine.disk)) score += 25;
  if (computerHasRuntimeAttention(computer)) score += 15;
  return score;
}

export type BatchUpgradeCandidate = {
  computerId: string;
  label: string;
  currentVersion: string | null | undefined;
  targetVersion: string;
};

export function batchUpgradeCandidates(
  computers: readonly ComputerOverviewItem[],
  options: {
    latestVersions?: ReadonlyMap<string, string | null>;
    upgradingIds?: ReadonlySet<string>;
  },
): BatchUpgradeCandidate[] {
  const candidates: BatchUpgradeCandidate[] = [];
  for (const computer of computers) {
    if (!computer.ownedByCurrentUser || !computer.online) continue;
    if (options.upgradingIds?.has(computer.id)) continue;
    const latest = options.latestVersions?.get(computer.releaseChannel ?? "latest");
    const offer = availableUpdateVersion(computer, latest);
    if (!offer) continue;
    candidates.push({
      computerId: computer.id,
      label: computerLabel(computer),
      currentVersion: computer.computerVersion,
      targetVersion: offer,
    });
  }
  return candidates;
}

export function computerSummaryCounts(computers: readonly ComputerOverviewItem[]) {
  let online = 0;
  let agents = 0;
  let attention = 0;
  for (const computer of computers) {
    if (computer.online) online += 1;
    agents += computer.agents.length;
    if (computerNeedsAttention(computer)) attention += 1;
  }
  return {
    total: computers.length,
    online,
    agents,
    attention,
  };
}

export function visibleMeteredProviders(
  computers: readonly ComputerOverviewItem[],
): RuntimeProvider[] {
  const present = new Set<RuntimeProvider>();
  for (const computer of computers) {
    for (const runtime of computer.runtimes) {
      if (isMeteredRuntime(runtime)) {
        present.add(runtime.provider);
      }
    }
  }
  const ordered = METERED_PROVIDER_ORDER.filter((provider) => present.has(provider));
  const extra = [...present]
    .filter((provider) => !METERED_PROVIDER_ORDER.includes(provider))
    .sort();
  return [...ordered, ...extra];
}

export function splitComputerRuntimes(computer: ComputerOverviewItem): {
  metered: ComputerOverviewItem["runtimes"];
  other: ComputerOverviewItem["runtimes"];
} {
  const metered: ComputerOverviewItem["runtimes"] = [];
  const other: ComputerOverviewItem["runtimes"] = [];
  for (const runtime of computer.runtimes) {
    if (isMeteredRuntime(runtime)) {
      metered.push(runtime);
    } else {
      other.push(runtime);
    }
  }
  metered.sort((a, b) => {
    const ai = METERED_PROVIDER_ORDER.indexOf(a.provider);
    const bi = METERED_PROVIDER_ORDER.indexOf(b.provider);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return { metered, other };
}

export function filterComputers<T extends ComputerOverviewItem>(
  computers: readonly T[],
  filter: {
    query: string;
    status: ComputerOverviewStatusFilter;
    runtime: ComputerOverviewRuntimeFilter;
  },
): T[] {
  const q = filter.query.trim().toLowerCase();
  return computers.filter((computer) => {
    if (filter.status === "online" && !computer.online) return false;
    if (filter.status === "offline" && computer.online) return false;
    if (filter.status === "attention" && !computerNeedsAttention(computer)) return false;

    if (filter.runtime === "other") {
      const hasOther = computer.runtimes.some((runtime) => !isMeteredRuntime(runtime));
      if (!hasOther) return false;
    } else if (filter.runtime !== "all") {
      if (!computer.runtimes.some((runtime) => runtime.provider === filter.runtime)) return false;
    }

    if (!q) return true;
    const haystacks = [
      computer.displayName,
      computer.name,
      operatingSystemLabel(computer) ?? "",
      computer.computerVersion ?? "",
      computer.creator ? humanLabel(computer.creator) : "",
      ...computer.agents.flatMap((agent) => [agent.displayName, agent.name]),
      ...computer.runtimes.flatMap((runtime) => [runtime.displayName, runtime.provider]),
    ];
    return haystacks.some((value) => value.toLowerCase().includes(q));
  });
}

function runtimeRemainingSortValue(
  computer: ComputerOverviewItem,
  provider: RuntimeProvider,
): number {
  const meter = computerRuntimeMeter(computer, provider);
  if (meter.kind === "meter") return meter.leftPercent;
  return -1;
}

export function sortComputers<T extends ComputerOverviewItem>(
  computers: readonly T[],
  sortBy: ComputerOverviewSortBy,
): T[] {
  const base = orderComputersOwnFirst(computers);
  if (sortBy === "attention") {
    return [...base].sort((a, b) => {
      const diff = computerAttentionScore(b) - computerAttentionScore(a);
      if (diff !== 0) return diff;
      if (a.ownedByCurrentUser !== b.ownedByCurrentUser) return a.ownedByCurrentUser ? -1 : 1;
      return computerLabel(a).localeCompare(computerLabel(b));
    });
  }
  if (sortBy === "name") {
    return [...base].sort((a, b) => computerLabel(a).localeCompare(computerLabel(b)));
  }
  if (sortBy === "disk") {
    return [...base].sort((a, b) => {
      const ap = a.machine?.disk ? machineUsedPercent(a.machine.disk) : -1;
      const bp = b.machine?.disk ? machineUsedPercent(b.machine.disk) : -1;
      if (bp !== ap) return bp - ap;
      return computerLabel(a).localeCompare(computerLabel(b));
    });
  }
  if (sortBy === "memory") {
    return [...base].sort((a, b) => {
      const ap = a.machine?.memory ? machineUsedPercent(a.machine.memory) : -1;
      const bp = b.machine?.memory ? machineUsedPercent(b.machine.memory) : -1;
      if (bp !== ap) return bp - ap;
      return computerLabel(a).localeCompare(computerLabel(b));
    });
  }
  const provider = sortBy.slice("runtime:".length) as RuntimeProvider;
  return [...base].sort((a, b) => {
    const ar = runtimeRemainingSortValue(a, provider);
    const br = runtimeRemainingSortValue(b, provider);
    if (br !== ar) return br - ar;
    return computerLabel(a).localeCompare(computerLabel(b));
  });
}

export type ComputerGroup<T extends ComputerOverviewItem> = {
  key: string;
  items: T[];
};

function namePrefix(computer: ComputerOverviewItem): string {
  const label = computerLabel(computer);
  const match = /^([a-zA-Z0-9\u4e00-\u9fff]+)[-_.\s]/.exec(label);
  return match?.[1]?.toLowerCase() ?? "other";
}

export function groupComputers<T extends ComputerOverviewItem>(
  computers: readonly T[],
  groupBy: ComputerOverviewGroupBy,
): ComputerGroup<T>[] {
  if (groupBy === "none") return [{ key: "all", items: [...computers] }];
  const buckets = new Map<string, T[]>();
  const keyOf = (computer: T): string => {
    if (groupBy === "owner") return computer.ownedByCurrentUser ? "mine" : "others";
    if (groupBy === "kind") return computerKind(computer.kind);
    return namePrefix(computer);
  };
  const orderedKeys =
    groupBy === "owner" ? ["mine", "others"] : groupBy === "kind" ? ["cloud", "local"] : [];
  for (const key of orderedKeys) buckets.set(key, []);
  for (const computer of computers) {
    const key = keyOf(computer);
    const list = buckets.get(key) ?? [];
    list.push(computer);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([key, items]) => ({ key, items }));
}
