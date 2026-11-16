import { useCallback, useEffect, useRef, useState } from "react";

import { JUMP_HIGHLIGHT_MS } from "#src/features/conversations/message-jump-highlight";

export function useFlash<T>(): [T | null, (value: T) => void] {
  const [flashed, setFlashed] = useState<T | null>(null);
  const timer = useRef<number>(undefined);
  const flash = useCallback((value: T) => {
    window.clearTimeout(timer.current);
    setFlashed(value);
    timer.current = window.setTimeout(() => setFlashed(null), JUMP_HIGHLIGHT_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [flashed, flash];
}
