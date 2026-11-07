import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type RuntimeMetadata,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { codeAgentExecutableSearchPath } from "#src/platform/code-agent-path";
import { PI_SDK_VERSION } from "@coforge/agent";
import { COFORGE_AGENT_RUNTIME_METADATA } from "#src/code-agent/pi/metadata";
import { devinCatalogWithCachedEfforts } from "#src/code-agent/devin/effort-read";
import { openCodeCatalogWithCachedEfforts } from "#src/code-agent/opencode/effort-read";
import { catalogCacheKeyFor } from "./catalog-cache-key";
import type { CodeAgentDiscoveryOptions } from "./discovery-options";
import {
  CATALOG_CACHE_TTL_MS,
  readInventoryCache,
  updateInventoryCache,
} from "./runtime-inventory-cache";
import { discoverExternalCodeAgents } from "./runtime-probe";
import { settleCatalogDiscoveries } from "./catalog-discovery-settle";
import { claudeStaticCatalog } from "@lrm/coforge-anvil/claude-code";
import { discoverCoforgeCatalog } from "./pi/catalog";
import { DshCatalogDiscovery } from "./dsh/catalog";
import {
  dshCatalogOptions,
  installedClaudeCodeVersion,
  planCatalogDiscoveries,
} from "./catalog-discovery-plan";
import {
  collectCatalogDiscoveryResults,
  selectCatalogDiscoveries,
  type CatalogDiscoveryFailure,
} from "./catalog-discovery-results";

export type { CatalogDiscoveryFailure } from "./catalog-discovery-results";

const dshCatalogs = new DshCatalogDiscovery();

export type CodeAgentInventory = {
  runtimes: RuntimeMetadata[];
  catalogs: CodeAgentModelCatalog[];
};

/** A provider whose model catalog is expensive enough (spawns a CLI) to be worth caching. */
const CACHEABLE_CATALOG_PROVIDERS = [
  RUNTIME_PROVIDER.GROK,
  RUNTIME_PROVIDER.PI,
  RUNTIME_PROVIDER.CODEX,
  RUNTIME_PROVIDER.KIRO,
  RUNTIME_PROVIDER.CURSOR,
  RUNTIME_PROVIDER.OPENCODE,
  RUNTIME_PROVIDER.ANTIGRAVITY,
  RUNTIME_PROVIDER.COMMAND_CODE,
  RUNTIME_PROVIDER.DEVIN,
  RUNTIME_PROVIDER.DROID,
] as const;

/**
 * Runtimes-only discovery: cheap PATH lookups plus a version probe per external provider (the
 * only spawning one is Codex, which starts `app-server` for a handshake). This is the fast half
 * of Code Agent discovery and is safe to await before a daemon reports itself ready.
 */
export async function discoverCodeAgentRuntimes(
  options: CodeAgentDiscoveryOptions,
): Promise<RuntimeMetadata[]> {
  const probe = options.probe;
  const environment = options.environment ?? Bun.env;
  return [
    COFORGE_AGENT_RUNTIME_METADATA,
    { provider: RUNTIME_PROVIDER.PI, version: PI_SDK_VERSION, displayName: "Pi" },
    ...(await discoverExternalCodeAgents(
      probe,
      environment,
      options.platform,
      undefined,
      options.cacheDirectory,
      options.versionProbeTimeoutMs,
    )),
  ];
}

/**
 * Reads only what the on-disk probe cache already has, without spawning anything. Static catalogs
 * (CoForge, Claude Code) are always included since they cost nothing. Every cacheable provider
 * without a fresh cache entry is left out and flags `needsRefresh`, so the caller knows to run a
 * live `discoverCodeAgentCatalogs` in the background.
 */
export async function loadCachedCodeAgentCatalogs(
  runtimes: RuntimeMetadata[],
  options: CodeAgentDiscoveryOptions,
): Promise<{
  catalogs: CodeAgentModelCatalog[];
  needsRefresh: boolean;
  /** Providers without a fresh catalog; background discovery should select only these. */
  refreshProviders: RuntimeProvider[];
  /** Providers whose cached catalog no longer matches its on-disk key, or outlived the TTL: a
   * provider update, a sign-in or a sign-out happened since that catalog was scanned. */
  changedProviders: RuntimeProvider[];
}> {
  const probe = options.probe;
  const environment = options.environment ?? Bun.env;
  const searchPath = codeAgentExecutableSearchPath(environment, options.platform);
  const usable = (provider: RuntimeProvider) =>
    runtimes.some((runtime) => runtime.provider === provider && !runtime.unavailableCode);
  const catalogs: CodeAgentModelCatalog[] = [discoverCoforgeCatalog()];
  if (usable(RUNTIME_PROVIDER.CLAUDE_CODE))
    catalogs.push(claudeStaticCatalog(installedClaudeCodeVersion(runtimes)));
  const cache = options.cacheDirectory
    ? await readInventoryCache(options.cacheDirectory)
    : undefined;
  let needsRefresh = false;
  const refreshProviders: RuntimeProvider[] = [];
  const changedProviders: RuntimeProvider[] = [];
  const providers = CACHEABLE_CATALOG_PROVIDERS.filter(
    (provider) => provider === RUNTIME_PROVIDER.PI || usable(provider),
  );
  for (const provider of providers) {
    const version = runtimes.find((runtime) => runtime.provider === provider)?.version;
    const key = await catalogCacheKeyFor(
      provider,
      probe,
      searchPath,
      environment,
      options.platform ?? process.platform,
      version,
    );
    const cached = key && cache ? cache[provider] : undefined;
    const fresh = key !== undefined && cached?.key === key && cached.catalog !== undefined;
    const expired = Date.now() - (cached?.catalogProbedAt ?? 0) > CATALOG_CACHE_TTL_MS;
    if (fresh) catalogs.push(cached.catalog!);
    // A catalog that existed under another key, or outlived the TTL, was read before something
    // changed it: an update, a sign-in or a sign-out. A provider that never produced a catalog is
    // not this: re-spawning a broken CLI on every freshness check helps nobody.
    if (cached?.catalog !== undefined && key !== undefined && (!fresh || expired))
      changedProviders.push(provider);
    if (!fresh || expired) {
      needsRefresh = true;
      refreshProviders.push(provider);
    }
  }
  // A replayed catalog carries the efforts its sweep knew at publish time; overlay the effort
  // cache so a restart does not hide them, and refresh while a model still lacks a read.
  for (const [provider, fill] of [
    [RUNTIME_PROVIDER.DEVIN, devinCatalogWithCachedEfforts],
    [RUNTIME_PROVIDER.OPENCODE, openCodeCatalogWithCachedEfforts],
  ] as const) {
    const index = catalogs.findIndex((catalog) => catalog.provider === provider);
    if (index < 0 || !options.cacheDirectory) continue;
    const filled = await fill(
      catalogs[index]!,
      options.cacheDirectory,
      runtimes.find((runtime) => runtime.provider === provider)?.version,
    );
    catalogs[index] = filled.catalog;
    if (!filled.complete) {
      needsRefresh = true;
      refreshProviders.push(provider);
    }
  }
  if (usable(RUNTIME_PROVIDER.DSH)) {
    const dshOptions = await dshCatalogOptions(options);
    const cached = dshOptions ? await dshCatalogs.cached(dshOptions) : undefined;
    if (cached) catalogs.push(cached);
    else {
      needsRefresh = true;
      refreshProviders.push(RUNTIME_PROVIDER.DSH);
    }
  }
  return { catalogs, needsRefresh, refreshProviders, changedProviders };
}

/**
 * Live catalog discovery: spawns each provider's CLI as needed (Kiro and Pi are the slow ones;
 * Codex's `model/list` is comparatively cheap). Successful cacheable results are written back to
 * the probe cache in a single pass once every discovery has settled, avoiding concurrent
 * read-modify-write races between providers.
 */
export async function discoverCodeAgentCatalogs(
  runtimes: RuntimeMetadata[],
  options: CodeAgentDiscoveryOptions,
): Promise<{ catalogs: CodeAgentModelCatalog[]; failures: CatalogDiscoveryFailure[] }> {
  const probe = options.probe;
  const environment = options.environment ?? Bun.env;
  const searchPath = codeAgentExecutableSearchPath(environment, options.platform);
  const settled = await settleCatalogDiscoveries(
    selectCatalogDiscoveries(
      await planCatalogDiscoveries(runtimes, options, dshCatalogs),
      options.provider,
      options.providers,
    ).map(([provider, start]) => [provider, start()] as const),
  );
  const { results, failures } = collectCatalogDiscoveryResults(settled);
  if (options.cacheDirectory) {
    const cacheDirectory = options.cacheDirectory;
    const probedAt = Date.now();
    const updates = (
      await Promise.all(
        results.map(async ({ provider, keyPaths, catalog }) => {
          if (!provider || !keyPaths || !catalog) return undefined;
          const version = runtimes.find((runtime) => runtime.provider === provider)?.version;
          const key = await catalogCacheKeyFor(
            provider,
            probe,
            searchPath,
            environment,
            options.platform ?? process.platform,
            version,
          );
          return key ? { provider, key, catalog } : undefined;
        }),
      )
    ).filter((update) => update !== undefined);
    // Merge only these catalogs into the latest file. Writing the whole snapshot read above would
    // restore a runtime or entry another discovery changed or dropped in between.
    if (updates.length)
      await updateInventoryCache(cacheDirectory, (current) => {
        for (const { provider, key, catalog } of updates)
          current[provider] = { ...current[provider], key, catalog, catalogProbedAt: probedAt };
      });
  }
  return {
    catalogs: results.flatMap(({ catalog }) => (catalog ? [catalog] : [])),
    failures,
  };
}

export { discoverCodeAgentInventory } from "./runtime-inventory-facade";
