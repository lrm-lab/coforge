import { createContext, useContext, useLayoutEffect } from "react";

export const ChatListCrowdContext = createContext<((crowded: boolean) => void) | null>(null);

export function useReportChatListCrowd(crowded: boolean) {
  const report = useContext(ChatListCrowdContext);
  useLayoutEffect(() => {
    if (!report) return;
    report(crowded);
    return () => report(false);
  }, [report, crowded]);
}
