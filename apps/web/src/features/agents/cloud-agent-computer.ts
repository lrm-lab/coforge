import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getCloudAgentComputer } from "./cloud-agents.functions";
import { useCurrentWorkspaceId } from "./workspace-agents-realtime";

const POLL_INTERVAL_MS = { starting: 2_000, offline: 10_000 } as const;

export type PlacedCloudAgentComputer = Exclude<
  Awaited<ReturnType<typeof getCloudAgentComputer>>,
  { state: "none" }
>;

export const cloudAgentComputerKey = (workspaceId: string | undefined) => [
  "cloud-agent-computer",
  workspaceId,
];

export function useCloudAgentComputer() {
  const workspaceId = useCurrentWorkspaceId();
  const read = useServerFn(getCloudAgentComputer);
  return useQuery({
    queryKey: cloudAgentComputerKey(workspaceId),
    queryFn: () => read(),
    staleTime: 0,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "starting" || state === "offline" ? POLL_INTERVAL_MS[state] : false;
    },
  });
}
