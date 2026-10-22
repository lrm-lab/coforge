import { createContext, useContext, useState } from "react";

export const PiChatDisclosureContext = createContext<{
  expanded: Set<string>;
  closed?: Set<string>;
  onInspect(): void;
} | null>(null);

/** Keep inspected content and its height stable when returning to a conversation. */
export function usePiChatDisclosure(key: string, defaultOpen = false) {
  const context = useContext(PiChatDisclosureContext);
  const [open, setOpen] = useState(() =>
    context?.closed?.has(key) ? false : context?.expanded.has(key) || defaultOpen,
  );
  return {
    open,
    toggle() {
      context?.onInspect();
      if (open) {
        context?.expanded.delete(key);
        context?.closed?.add(key);
      } else {
        context?.expanded.add(key);
        context?.closed?.delete(key);
      }
      setOpen(!open);
    },
  };
}
