import { createContext, useContext } from "react";

/**
 * What a host showing one thread of a conversation alone gives it: the thread's root (`rootId`),
 * open whatever the `threadRootId` param says, and covered only by a profile; closing the thread
 * closes the host's pane (`onClose`), and "View in channel" shows the conversation at the root
 * (`onViewInConversation`). While it is given, the conversation is neither shown nor read.
 */
export type StandaloneThread = {
  rootId: string;
  onClose: () => void;
  onViewInConversation: (rootId: string) => void;
};

/** Null wherever the conversation is shown with its thread beside it (Chat, Search). */
export const StandaloneThreadContext = createContext<StandaloneThread | null>(null);

/** The host's handlers while the open thread is shown alone, else null. */
export function useStandaloneThread(): StandaloneThread | null {
  return useContext(StandaloneThreadContext);
}
