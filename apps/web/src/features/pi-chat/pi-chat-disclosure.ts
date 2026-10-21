import { createContext, useContext, useState } from "react";

export const PiChatDisclosureContext = createContext<{
  expanded: Set<string>;
  onInspect(): void;
} | null>(null);

/** Keep inspected content and its height stable when returning to a conversation. */
export function usePiChatDisclosure(key: string) {
  const context = useContext(PiChatDisclosureContext);
  const [open, setOpen] = useState(() => context?.expanded.has(key) ?? false);
  return {
    open,
    toggle() {
      context?.onInspect();
      if (open) context?.expanded.delete(key);
      else context?.expanded.add(key);
      setOpen(!open);
    },
  };
}
