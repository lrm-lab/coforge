import { useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createAgent } from "./agents.functions";
import type { CreateAgentInput } from "./agent.schemas";
import { useRefreshAgentDirectory } from "./workspace-agents-realtime";

export function useCreateAgent() {
  const create = useServerFn(createAgent);
  const refreshDirectory = useRefreshAgentDirectory();
  return useCallback(
    async (input: CreateAgentInput) => {
      const created = await create({ data: input });
      await refreshDirectory().catch(() => undefined);
      return created;
    },
    [create, refreshDirectory],
  );
}
