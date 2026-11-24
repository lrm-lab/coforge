import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { RuntimeRescanFailure } from "#src/server/computers/computer-model-catalog-refresh.server";
import type { ComputerDetailView } from "./computer-detail-view";
import type { RuntimeCatalogRefreshResult } from "./runtime-catalog-refresh-poll";
import { isRuntimeLoginStateProvider } from "./runtime-login-chip";

export type RuntimeRescanNotice =
  | { kind: "none" | "timeout" | "error" }
  | {
      kind: "reported";
      refreshed: readonly RuntimeProvider[];
      failures: readonly RuntimeRescanFailure[];
      signedOut: RuntimeProvider[];
    };

export function runtimeRescanNotice(
  result: RuntimeCatalogRefreshResult | undefined,
  auth?: ComputerDetailView["runtimeAuth"],
): RuntimeRescanNotice {
  if (!result || result.status === "refreshed") return { kind: "none" };
  if (result.status !== "reported") return { kind: result.status };
  const { refreshed, failures } = result;
  return {
    kind: "reported",
    refreshed,
    failures,
    signedOut: failures
      .map(({ provider }) => provider)
      .filter(
        (provider) =>
          isRuntimeLoginStateProvider(provider) && auth?.[provider]?.state === "logged_out",
      ),
  };
}

export type RuntimeDetectionStatus =
  | "none"
  | "detecting_empty"
  | "detecting_with_list"
  | "rescanning_with_list";

export function runtimeDetectionStatus(input: {
  hasRuntimes: boolean;
  runtimeDetecting?: boolean;
  rescanning: boolean;
  rescanButtonVisible: boolean;
}): RuntimeDetectionStatus {
  const detecting = input.rescanning || Boolean(input.runtimeDetecting);
  if (!detecting) return "none";
  if (!input.hasRuntimes) return "detecting_empty";
  if (input.rescanning && input.rescanButtonVisible) return "rescanning_with_list";
  return "detecting_with_list";
}
