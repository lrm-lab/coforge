import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Handled = { state: string; committedAt?: string; expiresAt?: string };

const RELEASE_WIDTH_DELTA_PX = 24;

function handledAt(card: Handled) {
  return card.committedAt ?? (card.state === "expired" ? card.expiresAt : undefined);
}

export function shouldReleaseHeldHeight(initialWidth: number, nextWidth: number) {
  return Math.abs(nextWidth - initialWidth) >= RELEASE_WIDTH_DELTA_PX;
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
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || !pending) return;
    const height = element.getBoundingClientRect().height;
    if (height > 0) pendingHeight.current = height;
    const observer = new ResizeObserver(([entry]) => {
      const block = entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height;
      if (block > 0) pendingHeight.current = block;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [pending]);
  useLayoutEffect(() => {
    if (!settles || held !== undefined) return;
    const height = pendingHeight.current;
    if (box.current && height > 0) box.current.style.minHeight = `${height}px`;
    setHeld(height);
  }, [settles, held]);
  useEffect(() => {
    const element = box.current;
    if (!element || typeof held !== "number" || held <= 0) return;
    let width: number | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.borderBoxSize[0]?.inlineSize ?? element.getBoundingClientRect().width;
      if (width === undefined) width = next;
      else if (shouldReleaseHeldHeight(width, next)) setHeld("released");
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [held]);
  return {
    box,
    settles,
    heldHeight: settles && typeof held === "number" && held > 0 ? held : undefined,
  };
}
