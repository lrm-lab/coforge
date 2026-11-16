import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export function useSurfaceIndex<Index>(
  root: RefObject<Element | null>,
  build: (root: Element) => Index | null,
  active: boolean,
) {
  const [revision, setRevision] = useState(0);
  const cache = useRef<{ index: Index | null; dirty: boolean }>({ index: null, dirty: true });
  const pending = useRef(false);

  useEffect(() => {
    const element = root.current;
    if (!active || !element) return;
    let frameId = 0;
    const markDirty = () => {
      cache.current.dirty = true;
      pending.current = true;
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        pending.current = false;
        setRevision((count) => count + 1);
      });
    };
    const observer = new MutationObserver(markDirty);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    markDirty();
    return () => {
      cancelAnimationFrame(frameId);
      pending.current = false;
      observer.disconnect();
      cache.current = { index: null, dirty: true };
    };
  }, [root, active]);

  const get = useCallback((): Index | null => {
    const element = root.current;
    if (!element || !cache.current.dirty) return cache.current.index;
    cache.current = { index: build(element), dirty: false };
    return cache.current.index;
  }, [root, build]);

  const settled = useCallback(() => !pending.current, []);

  return { get, settled, revision };
}
