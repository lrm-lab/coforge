import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

import { ChannelPresence, useChannelPresence } from "#src/features/realtime/channel-presence";
import { workspacePresenceChannel } from "./presence-channel";

const WorkspacePresenceContext = createContext<ChannelPresence | undefined>(undefined);

export function WorkspacePresenceProvider({
  workspaceId,
  children,
}: {
  workspaceId?: string;
  children: ReactNode;
}) {
  const presence = useChannelPresence(
    workspaceId ? workspacePresenceChannel(workspaceId) : undefined,
  );
  return (
    <WorkspacePresenceContext.Provider value={presence}>
      {children}
    </WorkspacePresenceContext.Provider>
  );
}

export function useMemberOnline(userId: string): boolean | undefined {
  const presence = useContext(WorkspacePresenceContext);
  if (!presence) return undefined;
  return useSyncExternalStore(
    presence.subscribe,
    () => presence.isPresent(userId),
    () => undefined,
  );
}
