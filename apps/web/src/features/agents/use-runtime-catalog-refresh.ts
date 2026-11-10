import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { useRuntimeCatalogRefreshRequest } from "#src/features/computers/use-runtime-catalog-refresh-request";
import type { RuntimeOptions } from "./agent-runtime-fields-state";
import { runtimeRefreshNote, type RuntimeRefreshNote } from "./runtime-refresh-note";

/**
 * The runtime form's catalog refresh button. Opening the list uses the stored catalog; only this
 * asks the Computer to re-probe that one provider, and merges the catalog it returns into
 * `setOptions`. Whether the probe found new models or failed, it leaves one line under the list:
 * how many models the provider offers, or why the daemon could not refresh it.
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
  const [refreshNote, setRefreshNote] = useState<{
    computerId: string;
    note: RuntimeRefreshNote;
  }>();
  const requestRefresh = useRuntimeCatalogRefreshRequest();

  const refresh = async () => {
    if (!open || !computerId || refreshingComputer.current || isLoading(computerId)) return;
    refreshingComputer.current = computerId;
    setRefreshingComputerId(computerId);
    setRefreshNote(undefined);
    try {
      const result = await requestRefresh({ computerId, provider });
      if (result.status !== "refreshed" || !("catalog" in result) || !result.catalog) {
        setRefreshNote({ computerId, note: runtimeRefreshNote(result) });
        return;
      }
      const refreshed = result.catalog;
      setRefreshNote({ computerId, note: runtimeRefreshNote(result) });
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
      setRefreshNote({ computerId, note: runtimeRefreshNote({ status: "error" }) });
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
    note: refreshNote?.computerId === computerId ? refreshNote.note : undefined,
  };
}
