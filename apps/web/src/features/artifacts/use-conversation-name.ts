import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { channelNamesQuery } from "#src/features/conversations/conversation-queries";
import { useWorkspaceDirectory } from "#src/features/conversations/workspace-directory-query";

export function useConversationNames(): ReadonlyMap<string, string> {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useQuery(channelNamesQuery(workspaceId)).data;
  const directory = useWorkspaceDirectory().data;
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const channel of channels ?? []) names.set(channel.id, `#${channel.name}`);
    for (const person of directory?.people ?? [])
      if (person.dmId && !names.has(person.dmId)) names.set(person.dmId, `@${person.name}`);
    for (const agent of directory?.agents ?? [])
      if (agent.dmId && !names.has(agent.dmId)) names.set(agent.dmId, `@${agent.name}`);
    return names;
  }, [channels, directory]);
}

export function useConversationName() {
  const names = useConversationNames();
  return useCallback((id: string) => names.get(id), [names]);
}
