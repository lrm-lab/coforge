import { antigravityRuntimeHost } from "#src/code-agent/antigravity/host";
import { commandCodeRuntimeHost } from "#src/code-agent/command-code/host";
import { devinRuntimeHost } from "#src/code-agent/devin/host";
import { grokRuntimeHost } from "#src/code-agent/grok/host";
import { kiroRuntimeHost } from "#src/code-agent/kiro/host";
import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type RuntimeMetadata,
  type RuntimeProvider,
  type RuntimeUnavailableCode,
} from "@lrm/coforge-sdk/internal";
import { codeAgentExecutableSearchPath } from "#src/platform/code-agent-path";
import { PI_SDK_VERSION } from "@coforge/agent";
import { COFORGE_AGENT_RUNTIME_METADATA } from "#src/code-agent/pi/metadata";
import { discoverCommandCodeCatalog } from "@lrm/coforge-anvil/command-code";
import { discoverDevinCatalog } from "@lrm/coforge-anvil/devin";
import { devinCatalogWithCachedEfforts } from "#src/code-agent/devin/effort-read";
import { discoverKiroCatalog, KIRO_ACP_ARGS } from "@lrm/coforge-anvil/kiro";
import { discoverCursorCatalog } from "@lrm/coforge-anvil/cursor";
import { discoverOpenCodeCatalog } from "@lrm/coforge-anvil/opencode";
import { discoverGrokCatalog } from "@lrm/coforge-anvil/grok";
import { discoverAntigravityCatalog } from "@lrm/coforge-anvil/antigravity";
import { CATALOG_DISCOVERY_TIMEOUT_MS } from "@lrm/coforge-anvil";
import { discoverPiCatalog, PI_CATALOG_DISCOVERY_TIMEOUT_MS } from "@lrm/coforge-anvil/pi";
import { runCatalogCommand } from "./catalog-command";
import { piRuntimeHost } from "./pi/host";
import { catalogCacheKeyFor, piCacheKeyPaths } from "./catalog-cache-key";
import type { CodeAgentDiscoveryOptions } from "./discovery-options";
import {
  externalCodeAgent,
  dshCodeAgent,
  resolveExternalCodeAgentExecutable,
  type ExternalCodeAgentProvider,
} from "./runtime-executable";
import {
  CATALOG_CACHE_TTL_MS,
  readInventoryCache,
  updateInventoryCache,
} from "./runtime-inventory-cache";
import { discoverExternalCodeAgents } from "./runtime-probe";
import { settleCatalogDiscoveries } from "./catalog-discovery-settle";
import { claudeStaticCatalog } from "@lrm/coforge-anvil/claude-code";
import { discoverCodexCatalog } from "@lrm/coforge-anvil/codex";
import { codexCatalogHost } from "./codex/host";
import { discoverCoforgeCatalog } from "./pi/catalog";
import { DshCatalogDiscovery } from "./dsh/catalog";
import { agentEnvironment } from "./environment";
import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

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
] as const;

async function dshCatalogOptions(options: CodeAgentDiscoveryOptions) {
  const environment = options.environment ?? Bun.env;
  const executable = await resolveExternalCodeAgentExecutable(
    dshCodeAgent,
    options.probe,
    codeAgentExecutableSearchPath(environment, options.platform),
    environment,
    options.platform ?? process.platform,
  );
  if (!executable) return undefined;
  return {
    command: options.commands?.dsh ?? [executable],
    cwd: options.cwd ?? process.cwd(),
    environment: agentEnvironment(undefined, environment),
    timeoutMs: options.catalogDiscoveryTimeoutMs,
    force: options.force,
  };
}

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
    if (!fresh || expired) needsRefresh = true;
  }
  // The replayed Devin catalog carries the efforts its sweep knew at publish time; overlay the
  // effort cache so a restart does not hide them, and refresh while a model still lacks a read.
  const devinIndex = catalogs.findIndex((catalog) => catalog.provider === RUNTIME_PROVIDER.DEVIN);
  if (devinIndex >= 0 && options.cacheDirectory) {
    const filled = await devinCatalogWithCachedEfforts(
      catalogs[devinIndex]!,
      options.cacheDirectory,
      runtimes.find((runtime) => runtime.provider === RUNTIME_PROVIDER.DEVIN)?.version,
    );
    catalogs[devinIndex] = filled.catalog;
    if (!filled.complete) needsRefresh = true;
  }
  if (usable(RUNTIME_PROVIDER.DSH)) {
    const dshOptions = await dshCatalogOptions(options);
    const cached = dshOptions ? await dshCatalogs.cached(dshOptions) : undefined;
    if (cached) catalogs.push(cached);
    else needsRefresh = true;
  }
  return { catalogs, needsRefresh, changedProviders };
}

/**
 * Live catalog discovery: spawns each provider's CLI as needed (Kiro and Pi are the slow ones;
 * Codex's `model/list` is comparatively cheap). Successful cacheable results are written back to
 * the probe cache in a single pass once every discovery has settled, avoiding concurrent
 * read-modify-write races between providers.
 */
export type CatalogDiscoveryFailure = {
  provider: RuntimeProvider;
  code: RuntimeUnavailableCode;
  diagnostic?: string;
};

export async function discoverCodeAgentCatalogs(
  runtimes: RuntimeMetadata[],
  options: CodeAgentDiscoveryOptions,
): Promise<{ catalogs: CodeAgentModelCatalog[]; failures: CatalogDiscoveryFailure[] }> {
  const probe = options.probe;
  const environment = options.environment ?? Bun.env;
  const searchPath = codeAgentExecutableSearchPath(environment, options.platform);
  const cwd = options.cwd ?? process.cwd();
  const commands = options.commands ?? {};
  const usable = (provider: RuntimeProvider) =>
    runtimes.some((runtime) => runtime.provider === provider && !runtime.unavailableCode);
  const resolveExecutable = (provider: ExternalCodeAgentProvider) =>
    resolveExternalCodeAgentExecutable(
      externalCodeAgent[provider],
      probe,
      searchPath,
      environment,
      options.platform ?? process.platform,
    );
  type Discovered = {
    keyPaths?: string[];
    catalog: CodeAgentModelCatalog | undefined;
  };
  const discoveries: Array<[RuntimeProvider, Promise<Discovered>]> = [];
  discoveries.push([
    RUNTIME_PROVIDER.COFORGE,
    Promise.resolve({ catalog: discoverCoforgeCatalog() }),
  ]);
  discoveries.push([
    RUNTIME_PROVIDER.PI,
    discoverPiCatalog(
      cwd,
      environment,
      piRuntimeHost,
      options.piModels,
      options.piCatalogDiscoveryTimeoutMs ?? PI_CATALOG_DISCOVERY_TIMEOUT_MS,
      options.force,
    ).then((catalog) => ({
      keyPaths: piCacheKeyPaths(environment),
      catalog,
    })),
  ]);
  if (usable(RUNTIME_PROVIDER.CODEX)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.CODEX);
    if (executable)
      discoveries.push([
        RUNTIME_PROVIDER.CODEX,
        discoverCodexCatalog(
          commands.codex ?? [executable, "app-server"],
          cwd,
          environment,
          codexCatalogHost,
          options.catalogDiscoveryTimeoutMs ?? CATALOG_DISCOVERY_TIMEOUT_MS,
          options.force,
        ).then((catalog) => ({
          keyPaths: [executable],
          catalog,
        })),
      ]);
  }
  if (usable(RUNTIME_PROVIDER.CLAUDE_CODE)) {
    discoveries.push([
      RUNTIME_PROVIDER.CLAUDE_CODE,
      Promise.resolve({ catalog: claudeStaticCatalog(installedClaudeCodeVersion(runtimes)) }),
    ]);
  }
  if (usable(RUNTIME_PROVIDER.KIRO)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.KIRO);
    if (executable)
      discoveries.push([
        RUNTIME_PROVIDER.KIRO,
        discoverKiroCatalog(
          commands.kiro ?? [executable, ...KIRO_ACP_ARGS],
          cwd,
          environment,
          kiroRuntimeHost,
        ).then((catalog) => ({
          keyPaths: [executable],
          catalog,
        })),
      ]);
  }
  if (usable(RUNTIME_PROVIDER.CURSOR)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.CURSOR);
    if (executable)
      discoveries.push([
        RUNTIME_PROVIDER.CURSOR,
        discoverCursorCatalog(
          commands.cursor ?? [executable, "models"],
          cwd,
          environment,
          runCatalogCommand,
        ).then((catalog) => ({
          keyPaths: [executable],
          catalog,
        })),
      ]);
  }
  // Grok was the cacheable provider this refresh had no branch for, so its catalog was never
  // probed: an Agent whose runtime is Grok Build saw an empty model list in the UI even though
  // `grok models` lists models fine on the CLI.
  if (usable(RUNTIME_PROVIDER.GROK)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.GROK);
    if (executable)
      discoveries.push([
        RUNTIME_PROVIDER.GROK,
        discoverGrokCatalog(commands.grok ?? [executable], cwd, environment, grokRuntimeHost).then(
          (catalog) => ({
            keyPaths: [executable],
            catalog,
          }),
        ),
      ]);
  }
  if (usable(RUNTIME_PROVIDER.ANTIGRAVITY)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.ANTIGRAVITY);
    if (executable)
      discoveries.push([
        RUNTIME_PROVIDER.ANTIGRAVITY,
        discoverAntigravityCatalog(
          commands.antigravity ?? [executable, "models"],
          cwd,
          environment,
          antigravityRuntimeHost.catalogCommandRunner,
        ).then((catalog) => ({
          keyPaths: [executable],
          catalog,
        })),
      ]);
  }
  // OpenCode was the one cacheable provider this refresh had no branch for, so its catalog was
  // never probed: an Agent whose runtime is OpenCode saw an empty model list in the UI even
  // though `opencode models` lists models fine on the CLI.
  if (usable(RUNTIME_PROVIDER.OPENCODE)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.OPENCODE);
    if (executable)
      discoveries.push([
        RUNTIME_PROVIDER.OPENCODE,
        discoverOpenCodeCatalog(
          commands.opencode ?? [executable, "models"],
          cwd,
          environment,
          runCatalogCommand,
        ).then((catalog) => ({
          keyPaths: [executable],
          catalog,
        })),
      ]);
  }
  // The model list is session/new's model select. Without this branch a refresh never probes
  // Command Code, so Edit Runtime Configuration stays empty and Refresh fails.
  if (usable(RUNTIME_PROVIDER.COMMAND_CODE)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.COMMAND_CODE);
    if (executable)
      discoveries.push([
        RUNTIME_PROVIDER.COMMAND_CODE,
        discoverCommandCodeCatalog(
          commands.commandCode ?? [executable],
          cwd,
          environment,
          commandCodeRuntimeHost,
        ).then((catalog) => ({
          keyPaths: [executable],
          catalog,
        })),
      ]);
  }
  if (usable(RUNTIME_PROVIDER.DEVIN)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.DEVIN);
    if (executable)
      discoveries.push([
        RUNTIME_PROVIDER.DEVIN,
        discoverDevinCatalog(
          commands.devin ?? [executable],
          cwd,
          environment,
          devinRuntimeHost,
        ).then(async (catalog) => {
          // A model list publishes at discovery speed: efforts fill from the cache only, and
          // the inventory-sync sweep reports the catalog again once `thought_level` is read.
          if (!catalog) return { keyPaths: [executable], catalog };
          const { catalog: filled } = await devinCatalogWithCachedEfforts(
            catalog,
            options.cacheDirectory,
            runtimes.find((runtime) => runtime.provider === RUNTIME_PROVIDER.DEVIN)?.version,
          );
          return { keyPaths: [executable], catalog: filled };
        }),
      ]);
  }
  if (usable(RUNTIME_PROVIDER.DSH)) {
    const dshOptions = await dshCatalogOptions(options);
    if (dshOptions)
      discoveries.push([
        RUNTIME_PROVIDER.DSH,
        dshCatalogs
          .discover(dshOptions)
          .catch(async (error) => {
            logger.warning("DSH model catalog discovery failed", {
              event: "code_agent_catalog:discovery_failed",
              provider: RUNTIME_PROVIDER.DSH,
              error_code: diagnosticErrorCode(error),
              outcome: "unavailable",
            });
            if (options.force) throw error;
            return dshCatalogs.cached(dshOptions);
          })
          .then((catalog) => ({ catalog })),
      ]);
    else if (options.force)
      discoveries.push([
        RUNTIME_PROVIDER.DSH,
        Promise.reject(new Error("DSH model catalog refresh failed")),
      ]);
  }
  const settled = await settleCatalogDiscoveries(
    options.provider
      ? discoveries.filter(([provider]) => provider === options.provider)
      : discoveries,
  );
  const results = settled.flatMap(({ provider, result }) =>
    result ? [{ provider, ...result }] : [],
  );
  const failures = settled.flatMap(({ provider, failure }) =>
    failure ? [{ provider, ...failure }] : [],
  );
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

export async function discoverCodeAgentInventory(
  options: CodeAgentDiscoveryOptions,
): Promise<CodeAgentInventory> {
  const runtimes = await discoverCodeAgentRuntimes(options);
  const { catalogs } = await discoverCodeAgentCatalogs(runtimes, options);
  return { runtimes, catalogs };
}

function installedClaudeCodeVersion(runtimes: readonly RuntimeMetadata[]): string | undefined {
  return runtimes.find(
    (runtime) => runtime.provider === RUNTIME_PROVIDER.CLAUDE_CODE && !runtime.unavailableCode,
  )?.version;
}
