import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { readUsage } from "./computer-usage.functions";
import { readAgentUsage } from "./agent-usage.functions";
import { scanAgentRuntimeUsage, scanRuntimeUsage } from "./usage-scan";
import type { AgentUsageReadResult } from "#src/server/computers/agent-usage-access.server";

export function runtimeUsageQueryKey(computerId: string, provider: RuntimeProvider) {
  return ["runtime-usage", computerId, provider] as const;
}

export type AgentUsageQueryScope = { agentId: string; runtimeConfigRevision: number };
type UsageTarget = { computerId: string; provider: RuntimeProvider; agent?: AgentUsageQueryScope };
type UsageRead = Awaited<ReturnType<typeof readUsage>>;

function usageQueryKey({ agent, computerId, provider }: UsageTarget) {
  return agent
    ? (["agent-runtime-usage", computerId, agent.agentId, agent.runtimeConfigRevision] as const)
    : runtimeUsageQueryKey(computerId, provider);
}

function usageForTarget(reading: AgentUsageReadResult, { agent, computerId }: UsageTarget) {
  if (!agent || reading.unavailable) return reading;
  return reading.target?.runtimeConfigRevision === agent.runtimeConfigRevision &&
    reading.target.computerId === computerId
    ? reading
    : ({ state: "fresh", unavailable: true } as const);
}

/**
 * The scan's mutation: each scan names its own target, and its result is written under that
 * target's key. A mutation's callbacks are swapped for the latest render's, so a result keyed by
 * the hook's current target would land on whatever runtime is shown when the scan returns: a
 * Kiro scan finishing after the popup moved to a Claude Code Agent showed Kiro's credits under
 * Claude Code (task #513).
 */
export function runtimeUsageScanOptions(
  queryClient: QueryClient,
  scan: (computerId: string, provider: RuntimeProvider) => Promise<UsageRead>,
  afterWrite: () => Promise<void>,
  scanAgent: (agentId: string) => Promise<AgentUsageReadResult> = scanAgentRuntimeUsage,
) {
  return {
    mutationFn: ({ computerId, provider, agent }: UsageTarget) =>
      agent ? scanAgent(agent.agentId) : scan(computerId, provider),
    onSuccess: async (result: AgentUsageReadResult, target: UsageTarget) => {
      queryClient.setQueryData(usageQueryKey(target), usageForTarget(result, target));
      await afterWrite();
    },
  };
}

/**
 * One (Computer, provider) runtime's usage cache: read on mount, kept warm by at most one
 * automatic scan when that cached read comes back stale or missing, and a manual `refresh` for
 * everything else. `RuntimeUsage` is the only caller; it owns deciding whether a provider's usage
 * is worth reading at all (`enabled`) and whether the Computer is known offline.
 */
export function useRuntimeUsage(
  computerId: string,
  provider: RuntimeProvider,
  options: {
    enabled: boolean;
    computerOnline?: boolean;
    signedIn?: boolean;
    agent?: AgentUsageQueryScope;
  },
) {
  const { enabled, computerOnline, signedIn, agent } = options;
  const queryClient = useQueryClient();
  const router = useRouter();
  const target = { computerId, provider, agent };
  const queryKey = usageQueryKey(target);
  const query = useQuery<AgentUsageReadResult>({
    queryKey,
    queryFn: async () => {
      if (!agent) return readUsage({ data: { computerId, provider } });
      const reading = await readAgentUsage({ data: { agentId: agent.agentId } });
      return usageForTarget(reading, target);
    },
    enabled,
    staleTime: 15_000,
  });
  const scan = useMutation(
    runtimeUsageScanOptions(queryClient, scanRuntimeUsage, () => router.invalidate({ sync: true })),
  );
  // The scan in flight, or the last one, is this runtime's only if it was asked for this runtime.
  const scanIsShown =
    scan.variables?.computerId === computerId &&
    scan.variables.provider === provider &&
    scan.variables.agent?.agentId === agent?.agentId &&
    scan.variables.agent?.runtimeConfigRevision === agent?.runtimeConfigRevision;

  // A ref, not state: the guard must survive a scan that finishes still stale (no live session
  // to observe from) without firing again, and must reset only when the target itself changes.
  const autoScanTarget = JSON.stringify(queryKey);
  const autoScanned = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !query.data || computerOnline === false) return;
    if (query.data.state === "fresh") return;
    if (autoScanned.current === autoScanTarget) return;
    autoScanned.current = autoScanTarget;
    scan.mutate(target);
  }, [enabled, query.data, computerOnline, autoScanTarget, scan.mutate]);

  // A sign-in while shown: the usage read before it belongs to no account, however fresh.
  const wasSignedIn = useRef(signedIn);
  useEffect(() => {
    const signedInNow = signedIn && !wasSignedIn.current;
    wasSignedIn.current = signedIn;
    if (signedInNow && enabled && computerOnline !== false) scan.mutate(target);
  }, [signedIn, enabled, computerOnline, scan.mutate]);

  const resultStatus = query.data?.result?.status;
  return {
    data: query.data,
    scanning: scanIsShown && scan.isPending,
    /** The last scan got no result from the Computer in time; the cached result still shows. */
    scanFailed:
      (scanIsShown && scan.isError) ||
      (!!agent && (query.isError || resultStatus === "error" || resultStatus === "unavailable")),
    refresh: () => scan.mutate(target),
  };
}
