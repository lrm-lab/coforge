import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useServerFn } from "@tanstack/react-start";
import { refreshComputerRuntimeCatalog } from "#src/features/computers/computers.functions";
import type { RuntimeOptions } from "./agent-runtime-fields-state";

/**
 * The runtime form's catalog refresh button. Opening the list uses the stored catalog; only this
 * asks the Computer for a fresh probe, and merges the catalogs it returns into `setOptions`. A
 * probe that does not return the selected runtime's catalog counts as failed.
 */
export function useRuntimeCatalogRefresh({
  open,
  computerId,
  provider,
  isLoading,
  setOptions,
}: {
  open: boolean;
  computerId: string;
  provider: string;
  /** Whether the first catalog load for this Computer is still running. */
  isLoading: (computerId: string) => boolean;
  setOptions: Dispatch<SetStateAction<Record<string, RuntimeOptions | undefined>>>;
}) {
  const refreshingComputer = useRef<string | undefined>(undefined);
  const [refreshingComputerId, setRefreshingComputerId] = useState<string>();
  const [refreshFailedComputerId, setRefreshFailedComputerId] = useState<string>();
  const requestRefresh = useServerFn(refreshComputerRuntimeCatalog);

  const refresh = async () => {
    if (!open || !computerId || refreshingComputer.current || isLoading(computerId)) return;
    refreshingComputer.current = computerId;
    setRefreshingComputerId(computerId);
    setRefreshFailedComputerId(undefined);
    try {
      const result = await requestRefresh({ data: { computerId } });
      if (
        result.status !== "refreshed" ||
        !result.catalogs.some((catalog) => catalog.provider === provider)
      ) {
        setRefreshFailedComputerId(computerId);
        return;
      }
      setOptions((current) => {
        const previous = current[computerId];
        const refreshedProviders = new Set<string>(
          result.catalogs.map((catalog) => catalog.provider),
        );
        return {
          ...current,
          [computerId]: {
            providers: previous?.providers ?? [],
            catalogs: [
              ...(previous?.catalogs ?? []).filter(
                (catalog) => !refreshedProviders.has(catalog.provider),
              ),
              ...result.catalogs,
            ],
          },
        };
      });
    } catch {
      setRefreshFailedComputerId(computerId);
    } finally {
      refreshingComputer.current = undefined;
      setRefreshingComputerId(undefined);
    }
  };

  return {
    refresh,
    /** Whether a refresh runs for any Computer; the button stays disabled until it ends. */
    busy: refreshingComputerId !== undefined,
    refreshing: refreshingComputerId === computerId,
    failed: refreshFailedComputerId === computerId,
  };
}
