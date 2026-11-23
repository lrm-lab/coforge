import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export const ChatListCrowdContext = createContext<
  ((source: string, crowded: boolean) => void) | null
>(null);

export function useChatListCrowdState() {
  const sources = useRef(new Set<string>());
  const [listCrowded, setListCrowded] = useState(false);
  const reportListCrowd = useCallback((source: string, crowded: boolean) => {
    if (crowded) sources.current.add(source);
    else sources.current.delete(source);
    setListCrowded(sources.current.size > 0);
  }, []);
  return { listCrowded, reportListCrowd };
}

export function useReportChatListCrowd(crowded: boolean) {
  const report = useContext(ChatListCrowdContext);
  const source = useId();
  useLayoutEffect(() => {
    if (!report) return;
    report(source, crowded);
    return () => report(source, false);
  }, [report, source, crowded]);
}
