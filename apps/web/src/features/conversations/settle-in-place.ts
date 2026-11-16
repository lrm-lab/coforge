import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Handled = { state: string; committedAt?: string; expiresAt?: string };

function handledAt(card: Handled) {
  return card.committedAt ?? (card.state === "expired" ? card.expiresAt : undefined);
}

export function useSettleInPlace(card: Handled, handledHere = false) {
  const pending = card.state === "pending";
  const [openedPending] = useState(pending);
  const [mountedAt] = useState(() => (openedPending ? Date.now() : 0));
  const at = handledAt(card);
  const settles =
    openedPending && !pending && (handledHere || (at !== undefined && Date.parse(at) > mountedAt));
  const box = useRef<HTMLDivElement>(null);
  const pendingHeight = useRef(0);
  const [held, setHeld] = useState<number | "released">();
  useEffect(() => {
    const element = box.current;
    if (!element || !pending) return;
    const observer = new ResizeObserver(([entry]) => {
      pendingHeight.current = entry?.borderBoxSize[0]?.blockSize ?? 0;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [pending]);
  useLayoutEffect(() => {
    if (settles && held === undefined) setHeld(pendingHeight.current);
  }, [settles, held]);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof held !== "number") return;
    let width: number | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.borderBoxSize[0]?.inlineSize;
      if (width === undefined) width = next;
      else if (next !== width) setHeld("released");
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [held]);
  return { box, settles, heldHeight: settles && typeof held === "number" ? held : undefined };
}
