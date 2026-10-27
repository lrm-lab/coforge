import { useCallback, useState } from "react";

/** Keeps long-message expansion independent from row mounting and virtualization. */
export function useMessageExpansion() {
  const [expandedMessages, setExpandedMessages] = useState<ReadonlySet<string>>(new Set());
  const toggleExpandedMessage = useCallback((messageId: string) => {
    setExpandedMessages((current) => {
      const next = new Set(current);
      if (!next.delete(messageId)) next.add(messageId);
      return next;
    });
  }, []);
  return { expandedMessages, toggleExpandedMessage };
}
