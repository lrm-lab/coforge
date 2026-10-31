import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/**
 * While key points are still being generated, reload the catalog every few
 * seconds so the finished text shows up without a manual refresh. This is the
 * one place that polls; both the personal and the team detail call it.
 */
export function useKeyPointGeneratingRefresh(active: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void router.invalidate();
    }, 4000);
    return () => clearInterval(timer);
  }, [active, router]);
}
