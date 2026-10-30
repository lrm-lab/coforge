import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useServerFn } from "@tanstack/react-start";
import type { RuntimeProvider, RuntimeUnavailableCode } from "@lrm/coforge-sdk/internal";
import { refreshComputerRuntimeCatalog } from "#src/features/computers/computers.functions";
import type { RuntimeOptions } from "./agent-runtime-fields-state";

/**
 * The runtime form's catalog refresh button. Opening the list uses the stored catalog; only this
 * asks the Computer to re-probe that one provider, and merges the catalog it returns into
 * `setOptions`. A failed probe keeps the old list and names why the daemon could not refresh it.
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
  provider: RuntimeProvider;
  /** Whether the first catalog load for this Computer is still running. */
  isLoading: (computerId: string) => boolean;
  setOptions: Dispatch<SetStateAction<Record<string, RuntimeOptions | undefined>>>;
}) {
  const refreshingComputer = useRef<string | undefined>(undefined);
  const [refreshingComputerId, setRefreshingComputerId] = useState<string>();
  const [refreshFailure, setRefreshFailure] = useState<{
    computerId: string;
    code?: RuntimeUnavailableCode;
    diagnostic?: string;
  }>();
  const requestRefresh = useServerFn(refreshComputerRuntimeCatalog);

  const refresh = async () => {
    if (!open || !computerId || refreshingComputer.current || isLoading(computerId)) return;
    refreshingComputer.current = computerId;
    setRefreshingComputerId(computerId);
    setRefreshFailure(undefined);
    try {
      const result = await requestRefresh({ data: { computerId, provider } });
      if (result.status !== "refreshed" || !("catalog" in result) || !result.catalog) {
        setRefreshFailure({
          computerId,
          code: "code" in result ? result.code : undefined,
          diagnostic: "diagnostic" in result ? result.diagnostic : undefined,
        });
        return;
      }
      const refreshed = result.catalog;
      setOptions((current) => {
        const previous = current[computerId];
        return {
          ...current,
          [computerId]: {
            // The refresh re-reads one provider's catalog; whether each runtime is usable comes
            // from the Computer rows, which this dialog re-reads when it opens.
            providers: previous?.providers ?? [],
            unusable: previous?.unusable ?? [],
            catalogs: [
              ...(previous?.catalogs ?? []).filter(
                (catalog) => catalog.provider !== refreshed.provider,
              ),
              refreshed,
            ],
          },
        };
      });
    } catch {
      setRefreshFailure({ computerId });
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
    failure: refreshFailure?.computerId === computerId ? refreshFailure : undefined,
  };
}
