import { useMemo } from "react";

type RecentMessage = {
  senderKind: "user" | "agent" | "system";
  senderHandle?: string;
  sequence: number;
};

/** Ranks mention completion by the handles that recently authored messages in this stream. */
export function useRecentConversationHandles(messages: readonly RecentMessage[]) {
  return useMemo(() => {
    const handles: string[] = [];
    const seen = new Set<string>();
    for (const message of [...messages].sort((left, right) => right.sequence - left.sequence)) {
      if (message.senderKind === "system" || !message.senderHandle) continue;
      const key = message.senderHandle.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      handles.push(message.senderHandle);
    }
    return handles;
  }, [messages]);
}
