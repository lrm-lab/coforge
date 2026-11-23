import type { RuntimeRescanResult } from "./computer-detail-view";

export type RuntimeRescanNotice =
  | { kind: "none" }
  | { kind: "timeout" }
  | { kind: "error"; message?: string };

export function runtimeRescanNotice(result: RuntimeRescanResult | undefined): RuntimeRescanNotice {
  if (!result) return { kind: "none" };
  if (result.status === "timeout") return { kind: "timeout" };
  if (result.status === "error") return { kind: "error", message: result.message };
  return { kind: "none" };
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
