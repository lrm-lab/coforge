import { createContext, useContext, useState } from "react";

type MessageExpansion = {
  expanded: ReadonlySet<string>;
  toggle: (key: string) => void;
  collapsible: boolean;
};

export const MessageExpansionContext = createContext<MessageExpansion | null>(null);

export function useExpansion(key: string | undefined) {
  const shared = useContext(MessageExpansionContext);
  const [expandedHere, setExpandedHere] = useState(false);
  if (shared && key !== undefined)
    return {
      expanded: shared.expanded.has(key),
      toggle: () => shared.toggle(key),
      collapsible: shared.collapsible,
    };
  return {
    expanded: expandedHere,
    toggle: () => setExpandedHere((current) => !current),
    collapsible: shared?.collapsible ?? true,
  };
}
