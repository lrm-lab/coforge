import type {
  CodeAgentModelCatalog,
  RuntimeMetadata,
  RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { CatalogDiscoveryFailure } from "#src/code-agent/runtime-inventory";

/**
 * The injectable half of Code Agent discovery. `runtimes` is the fast, always-awaited probe;
 * `cachedCatalogs` is a disk-only read (no spawning) used for the same report; `catalogs` is the
 * live, possibly-spawning discovery. Explicit refreshes forbid cached fallback.
 */
export type CodeAgentDiscovery = {
  runtimes(): Promise<RuntimeMetadata[]>;
  /** `changedProviders` names the catalogs whose on-disk key moved; a discovery that cannot tell
   * leaves it out. */
  cachedCatalogs(runtimes: RuntimeMetadata[]): Promise<{
    catalogs: CodeAgentModelCatalog[];
    needsRefresh: boolean;
    changedProviders?: RuntimeProvider[];
  }>;
  catalogs(
    runtimes: RuntimeMetadata[],
    options?: { force: boolean; provider?: RuntimeProvider },
  ): Promise<{
    catalogs: CodeAgentModelCatalog[];
    failures: CatalogDiscoveryFailure[];
  }>;
  /** This Computer's probe-cache directory. Absent only for test discoveries. */
  stateDirectory?: string;
};

/** What `reportRuntimes` reported, and whether its cached catalogs need a live refresh. */
export type CodeAgentRuntimesReport = { runtimes: RuntimeMetadata[]; needsCatalogRefresh: boolean };
