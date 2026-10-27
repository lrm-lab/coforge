import { useCallback, useState } from "react";

type GroupItem = { type: "systemGroup"; messages: readonly { id: string }[] } | { type: string };

/** Owns the open state for folded system-message groups and jump-target reveal. */
export function useSystemMessageGroups<T extends GroupItem>(items: readonly T[]) {
  const [openedMessages, setOpenedMessages] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = useCallback((messages: readonly { id: string }[]) => {
    setOpenedMessages((current) => {
      const next = new Set(current);
      const open = messages.some((message) => next.has(message.id));
      for (const message of messages) {
        if (open) next.delete(message.id);
        else next.add(message.id);
      }
      return next;
    });
  }, []);
  const revealGroupMessage = useCallback(
    (messageId: string) => {
      const group = items.find(
        (item) =>
          item.type === "systemGroup" &&
          "messages" in item &&
          item.messages.some((message) => message.id === messageId),
      );
      if (
        !group ||
        !("messages" in group) ||
        group.messages.some((message) => openedMessages.has(message.id))
      )
        return false;
      setOpenedMessages((current) => new Set(current).add(messageId));
      return true;
    },
    [items, openedMessages],
  );
  return { openedMessages, toggleGroup, revealGroupMessage };
}
