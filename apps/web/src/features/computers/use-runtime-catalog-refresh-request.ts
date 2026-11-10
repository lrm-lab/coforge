import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import {
  readRuntimeCatalogRefresh,
  startRuntimeCatalogRefresh,
} from "./runtime-catalog-refresh.functions";
import {
  awaitRuntimeCatalogRefresh,
  type RuntimeCatalogRefreshResult,
} from "./runtime-catalog-refresh-poll";

/**
 * Asks a Computer to re-probe its runtimes (one provider, or all) and resolves with its outcome:
 * the Agent form's refresh and the Computer page's Rescan runtimes. The probe is started and then
 * polled (`awaitRuntimeCatalogRefresh`), never held in one request. Only the asking component
 * unmounting ends the polling, as a timeout; the state its answer would merge into goes with it.
 */
export function useRuntimeCatalogRefreshRequest() {
  const start = useServerFn(startRuntimeCatalogRefresh);
  const read = useServerFn(readRuntimeCatalogRefresh);
  // Made when mounted rather than once, so a remount does not inherit a stopped controller.
  const mounted = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = controller;
    return () => controller.abort();
  }, []);

  return (input: {
    computerId: string;
    provider?: RuntimeProvider;
  }): Promise<RuntimeCatalogRefreshResult> =>
    awaitRuntimeCatalogRefresh({
      start: () => start({ data: input }),
      read: (requestId) => read({ data: { ...input, requestId } }),
      signal: mounted.current!.signal,
    });
}
