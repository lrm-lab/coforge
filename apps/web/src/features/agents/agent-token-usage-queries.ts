import { useEffect, useMemo } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AgentTokenUsageRange } from "./agent-token-usage-model";

export const AGENT_TOKEN_USAGE_INVALIDATE_WINDOW_MS = 250;

export const agentTokenUsageKeys = {
  all: ["agent-token-usage"] as const,
  agent: (agentId: string) => ["agent-token-usage", agentId] as const,
  agentRange: (agentId: string, range: AgentTokenUsageRange, timeZone: string) =>
    ["agent-token-usage", agentId, range, timeZone] as const,
  workspaceAll: ["workspace-agent-token-usage"] as const,
  workspace: (workspaceId: string) => ["workspace-agent-token-usage", workspaceId] as const,
  workspaceRange: (workspaceId: string, range: AgentTokenUsageRange, timeZone: string) =>
    ["workspace-agent-token-usage", workspaceId, range, timeZone] as const,
};

export type AgentTokenUsageInvalidationBatch = Readonly<{
  agentIds: ReadonlySet<string>;
  allAgents: boolean;
}>;

type TimeoutScheduler = {
  set(callback: () => void, delayMs: number): number;
  clear(timer: number): void;
};

export function createAgentTokenUsageInvalidator(
  invalidate: (batch: AgentTokenUsageInvalidationBatch) => void,
  scheduler: TimeoutScheduler = {
    set: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clear: (timer) => window.clearTimeout(timer),
  },
  delayMs = AGENT_TOKEN_USAGE_INVALIDATE_WINDOW_MS,
) {
  let timer: number | undefined;
  let allAgents = false;
  const agentIds = new Set<string>();

  function arm() {
    if (timer !== undefined) return;
    timer = scheduler.set(() => {
      timer = undefined;
      const batch: AgentTokenUsageInvalidationBatch = {
        agentIds: allAgents ? new Set() : new Set(agentIds),
        allAgents,
      };
      allAgents = false;
      agentIds.clear();
      invalidate(batch);
    }, delayMs);
  }

  return {
    schedule(agentId: string) {
      if (!allAgents) agentIds.add(agentId);
      arm();
    },
    scheduleAll() {
      allAgents = true;
      agentIds.clear();
      arm();
    },
    cancel() {
      if (timer !== undefined) scheduler.clear(timer);
      timer = undefined;
      allAgents = false;
      agentIds.clear();
    },
  };
}

export async function invalidateAgentTokenUsageQueries(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  workspaceId: string | undefined,
  batch: AgentTokenUsageInvalidationBatch,
): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (batch.allAgents) {
    tasks.push(
      queryClient.invalidateQueries({
        queryKey: agentTokenUsageKeys.all,
        refetchType: "active",
      }),
    );
  } else {
    for (const agentId of batch.agentIds) {
      tasks.push(
        queryClient.invalidateQueries({
          queryKey: agentTokenUsageKeys.agent(agentId),
          refetchType: "active",
        }),
      );
    }
  }
  if (workspaceId) {
    tasks.push(
      queryClient.invalidateQueries({
        queryKey: agentTokenUsageKeys.workspace(workspaceId),
        refetchType: "active",
      }),
    );
  }
  await Promise.all(tasks);
}

export function useAgentTokenUsageInvalidator(workspaceId: string | undefined) {
  const queryClient = useQueryClient();
  const invalidator = useMemo(
    () =>
      createAgentTokenUsageInvalidator((batch) => {
        void invalidateAgentTokenUsageQueries(queryClient, workspaceId, batch);
      }),
    [queryClient, workspaceId],
  );
  useEffect(() => () => invalidator.cancel(), [invalidator]);
  return invalidator;
}
