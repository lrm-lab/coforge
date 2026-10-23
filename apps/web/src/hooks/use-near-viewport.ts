import { useEffect, useState } from "react";

/**
 * Whether an element is in, or within `margin` of, the viewport; false on the server and until the
 * browser reports. Attach the returned callback as the element's `ref`. With `enabled` off nothing
 * is observed and the answer is false, so a surface that will not use it pays nothing.
 */
export function useNearViewport(enabled: boolean, margin = "100px") {
  const [element, setElement] = useState<Element | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!enabled || !element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.at(-1)?.isIntersecting ?? false),
      { rootMargin: margin },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      setNear(false);
    };
  }, [enabled, element, margin]);
  return [setElement, near] as const;
}
