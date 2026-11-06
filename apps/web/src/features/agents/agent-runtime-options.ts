import { useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";

import {
  getComputerRuntimeCatalog,
  listComputers,
} from "#src/features/computers/computers.functions";
import {
  RUNTIME_PROVIDER,
  type RuntimeProvider,
  type RuntimeUnavailableCode,
} from "@lrm/coforge-sdk/internal";
import type { RuntimeOptions } from "./agent-runtime-fields";
import { RUNTIME_PROVIDER_DISPLAY_ORDER } from "./runtime-provider-display";

/** A Computer's runtimes as the runtime picker needs them: the ones this person may pick, and
 * the installed ones that cannot be used, each with its reason so the list explains itself. */
/** Best first: Pi, then Claude Code, then the runtime picker's own order, so a provider added later
 * is considered without being listed here. CoForge's runtime needs an API key and is not in that
 * order, so it is never chosen for the member. */
const RUNTIME_PREFERENCE: readonly RuntimeProvider[] = [
  RUNTIME_PROVIDER.PI,
  RUNTIME_PROVIDER.CLAUDE_CODE,
  ...RUNTIME_PROVIDER_DISPLAY_ORDER.filter(
    (provider) => provider !== RUNTIME_PROVIDER.PI && provider !== RUNTIME_PROVIDER.CLAUDE_CODE,
  ),
];

/** The runtime to start on among those a Computer reports as usable. */
export function preferredRuntimeProvider(
  detected: readonly RuntimeProvider[],
): RuntimeProvider | undefined {
  return RUNTIME_PREFERENCE.find((provider) => detected.includes(provider));
}

export function runtimeOptionsFromRuntimes(
  runtimes: readonly {
    provider: RuntimeProvider;
    unavailableCode?: RuntimeUnavailableCode | null;
    diagnostic?: string | null;
  }[],
): { providers: RuntimeProvider[]; unusable: RuntimeOptions["unusable"] } {
  return {
    providers: runtimes
      .filter((runtime) => !runtime.unavailableCode)
      .map((runtime) => runtime.provider),
    unusable: runtimes.flatMap((runtime) =>
      runtime.unavailableCode
        ? [
            {
              provider: runtime.provider,
              unavailableCode: runtime.unavailableCode,
              diagnostic: runtime.diagnostic,
            },
          ]
        : [],
    ),
  };
}

/**
 * The `AgentRuntimeFields.onLoad` loader shared by the full Agent detail page's edit dialog
 * (`agents.$agentId.tsx`) and the Profile panel's in-place runtime editor
 * (`profile-panel/agent-profile-panel.tsx`): the Computer's supported providers plus its model
 * catalog for the selected provider, one shared shape so neither caller copies the other.
 */
export function useAgentRuntimeOptionsLoader(): (computerId: string) => Promise<RuntimeOptions> {
  const loadComputers = useServerFn(listComputers);
  const loadCatalog = useServerFn(getComputerRuntimeCatalog);
  return useCallback(
    async (computerId: string): Promise<RuntimeOptions> => {
      const [computers, catalogs] = await Promise.all([
        loadComputers(),
        loadCatalog({ data: { computerId } }),
      ]);
      const runtimes = computers.find((computer) => computer.id === computerId)?.runtimes ?? [];
      return { ...runtimeOptionsFromRuntimes(runtimes), catalogs };
    },
    [loadComputers, loadCatalog],
  );
}
