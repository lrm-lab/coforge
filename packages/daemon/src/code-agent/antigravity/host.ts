import type { AntigravityRuntimeHost } from "@lrm/coforge-anvil/antigravity";
import { perTurnSessionHost } from "#src/code-agent/per-turn-host";
import { readVersionOutput } from "#src/code-agent/version-probe";
import { runCatalogCommand } from "#src/code-agent/catalog-command";

/** Raw live inputs only; Antigravity's library-owned policy performs SSH filtering. */
export const antigravityRuntimeHost: AntigravityRuntimeHost = {
  sessionHost: perTurnSessionHost,
  versionReader: readVersionOutput,
  catalogCommandRunner: runCatalogCommand,
  readUsageEnvironment: () => Bun.env,
};
