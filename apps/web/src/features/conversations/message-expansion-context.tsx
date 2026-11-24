import { createContext, useContext, useState } from "react";

import { useMessageExpanded } from "./conversation-view-memory";

type MessageExpansion = {
  toggle: (key: string) => void;
  collapsible: boolean;
};

export const MessageExpansionContext = createContext<MessageExpansion | null>(null);

export function useExpansion(key: string | undefined) {
  const shared = useContext(MessageExpansionContext);
  const storedExpanded = useMessageExpanded(shared?.collapsible ? key : undefined);
  const [expandedHere, setExpandedHere] = useState(false);
  if (shared && key !== undefined)
    return {
      expanded: shared.collapsible && storedExpanded,
      toggle: () => shared.toggle(key),
      collapsible: shared.collapsible,
    };
  return {
    expanded: expandedHere,
    toggle: () => setExpandedHere((current) => !current),
    collapsible: shared?.collapsible ?? true,
  };
}
