import {
  RUNTIME_PROVIDER,
  type RuntimeProvider,
  type RuntimeUnavailableCode,
} from "@lrm/coforge-sdk/internal";

import { m } from "#src/paraglide/messages";

export type CodexCompatibleSupportStatus = "supported" | "unsupported" | "checking";

export type CodexCompatibleComputerCandidate = {
  id: string;
  online?: boolean;
  runtimes?: readonly {
    provider: RuntimeProvider;
    unavailableCode?: RuntimeUnavailableCode | null;
  }[];
};

export type CodexCompatibleComputerIneligibilityReason =
  | "checking"
  | "offline"
  | "codex_unavailable"
  | "unsupported";

export function codexCompatibleSupportStatus(
  query: { data?: boolean; isPending?: boolean } | undefined,
): CodexCompatibleSupportStatus {
  if (query?.data === true) return "supported";
  if (query?.isPending) return "checking";
  return "unsupported";
}

export function codexCompatibleComputerIneligibility(
  computer: CodexCompatibleComputerCandidate,
  status: CodexCompatibleSupportStatus | undefined,
  restrictToCodexCompatible: boolean,
): CodexCompatibleComputerIneligibilityReason | undefined {
  if (!restrictToCodexCompatible) return undefined;
  if (status === "supported") return undefined;
  if (status === "checking" || status === undefined) return "checking";
  if (computer.online === false) return "offline";
  if (
    computer.runtimes !== undefined &&
    !computer.runtimes.some(
      (runtime) => runtime.provider === RUNTIME_PROVIDER.CODEX && !runtime.unavailableCode,
    )
  ) {
    return "codex_unavailable";
  }
  return "unsupported";
}

export function codexCompatibleComputerIneligibilityLabel(
  reason: CodexCompatibleComputerIneligibilityReason,
): string {
  switch (reason) {
    case "checking":
      return m.agent_form_codex_compatible_computer_checking();
    case "offline":
      return m.agent_form_codex_compatible_computer_offline();
    case "codex_unavailable":
      return m.agent_form_codex_compatible_computer_codex_unavailable();
    case "unsupported":
      return m.agent_form_codex_compatible_computer_unsupported();
  }
}
