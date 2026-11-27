import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  codexCompatibleSupportStatus,
  type CodexCompatibleSupportStatus,
} from "#src/features/agents/codex-compatible-computer-eligibility";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { getComputerCodexCompatible } from "./computers.functions";

export function useCodexCompatibleSupport(computerId: string, enabled: boolean): boolean {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const read = useServerFn(getComputerCodexCompatible);
  const query = useQuery({
    queryKey: ["computer-codex-compatible", workspaceId, computerId],
    queryFn: () => read({ data: { computerId } }),
    enabled: enabled && Boolean(computerId),
    staleTime: 30_000,
    retry: false,
  });
  return query.data === true;
}

export function useCodexCompatibleSupportByComputer(
  computerIds: readonly string[],
  enabled: boolean,
): ReadonlyMap<string, CodexCompatibleSupportStatus> {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const read = useServerFn(getComputerCodexCompatible);
  const idsKey = computerIds.filter(Boolean).join("\0");
  const uniqueIds = useMemo(() => [...new Set(idsKey ? idsKey.split("\0") : [])], [idsKey]);
  const queries = useQueries({
    queries: uniqueIds.map((computerId) => ({
      queryKey: ["computer-codex-compatible", workspaceId, computerId],
      queryFn: () => read({ data: { computerId } }),
      enabled,
      staleTime: 30_000,
      retry: false,
    })),
  });
  return new Map(
    uniqueIds.map((computerId, index) => [
      computerId,
      codexCompatibleSupportStatus(queries[index]),
    ]),
  );
}
