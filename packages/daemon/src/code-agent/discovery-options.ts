import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { PiModelDiscovery } from "@lrm/coforge-anvil/pi";
import type { ExternalCodeAgentProbe } from "./runtime-executable";

/** Catalog commands a test or a host may override; production runs each provider's default. */
export type CatalogCommands = {
  codex?: readonly string[];
  dsh?: readonly string[];
  kiro?: readonly string[];
  cursor?: readonly string[];
  opencode?: readonly string[];
  grok?: readonly string[];
  antigravity?: readonly string[];
  commandCode?: readonly string[];
  devin?: readonly string[];
};

/** Everything one Code Agent discovery pass takes. */
export type CodeAgentDiscoveryOptions = {
  /** Explicit refreshes may not substitute a provider's local cache for a failed live probe. */
  force?: boolean;
  /** A user-requested refresh covers only this provider's discovery. */
  provider?: RuntimeProvider;
  /** How external Code Agent CLIs are found and versioned; production passes `hostCodeAgentProbe`. */
  probe: ExternalCodeAgentProbe;
  commands?: CatalogCommands;
  /** Pi's in-process model discovery; production passes the Pi SDK's `discoverPiModels`. */
  piModels: PiModelDiscovery;
  cwd?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  /** The daemon state directory; when set, probe results are cached there across restarts. */
  cacheDirectory?: string;
  /** The wait for each external runtime's generic `--version` probe (`versionProbeOutput`);
   * `VERSION_PROBE_TIMEOUT_MS` when unset. Provider-specific probes keep their own bounds. */
  versionProbeTimeoutMs?: number;
  /** Each bounded wait of Codex or DSH model catalog discovery. Defaults are
   * `CATALOG_DISCOVERY_TIMEOUT_MS` for Codex and the native ACP 120-second budget for DSH.
   * The runtime probe's own `initialize` wait is not affected. */
  catalogDiscoveryTimeoutMs?: number;
  /** Pi's in-process catalog discovery; `PI_CATALOG_DISCOVERY_TIMEOUT_MS` when unset. */
  piCatalogDiscoveryTimeoutMs?: number;
};
