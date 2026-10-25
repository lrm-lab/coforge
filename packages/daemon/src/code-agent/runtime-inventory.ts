import { join } from "node:path";
import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type RuntimeMetadata,
} from "@lrm/coforge-sdk/internal";
import { codeAgentExecutableSearchPath } from "#src/platform/code-agent-path";
import { PI_SDK_VERSION } from "@coforge/agent";
import { COFORGE_AGENT_RUNTIME_METADATA } from "#src/code-agent/pi/metadata";
import { discoverKiroCatalog } from "#src/code-agent/kiro/catalog";
import { discoverCursorCatalog } from "@lrm/coforge-anvil";
import { runCatalogCommand } from "./catalog-command";
import { discoverGrokCatalog } from "#src/code-agent/grok/catalog";
import { discoverAntigravityCatalog } from "#src/code-agent/antigravity/catalog";
import { discoverOpenCodeCatalog } from "#src/code-agent/opencode/catalog";
import {
  externalCodeAgent,
  resolveExternalCodeAgentExecutable,
  type ExternalCodeAgentProbe,
  type ExternalCodeAgentProvider,
} from "./runtime-executable";
import {
  CATALOG_CACHE_TTL_MS,
  fileStatCacheKey,
  readInventoryCache,
  writeInventoryCache,
} from "./runtime-inventory-cache";
import { CATALOG_DISCOVERY_TIMEOUT_MS } from "./catalog-discovery";
import { discoverExternalCodeAgents } from "./runtime-probe";
import { claudeStaticCatalog } from "./claude-code/catalog";
import { discoverCodexCatalog } from "./codex/catalog";
import {
  discoverCoforgeCatalog,
  discoverPiCatalog,
  piAgentDirectory,
  PI_CATALOG_DISCOVERY_TIMEOUT_MS,
  type PiModelDiscovery,
} from "./pi/catalog";

export type CodeAgentInventory = {
  runtimes: RuntimeMetadata[];
  catalogs: CodeAgentModelCatalog[];
};

type CatalogCommands = {
  codex?: readonly string[];
  kiro?: readonly string[];
  cursor?: readonly string[];
  opencode?: readonly string[];
  grok?: readonly string[];
  antigravity?: readonly string[];
};

export type CodeAgentDiscoveryOptions = {
  /** Explicit refreshes may not substitute a provider's local cache for a failed live probe. */
  force?: boolean;
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
  /** Each bounded wait of Codex's model catalog discovery; `CATALOG_DISCOVERY_TIMEOUT_MS` when
   * unset. The runtime probe's own `initialize` wait is not affected. */
  catalogDiscoveryTimeoutMs?: number;
  /** Pi's in-process catalog discovery; `PI_CATALOG_DISCOVERY_TIMEOUT_MS` when unset. */
  piCatalogDiscoveryTimeoutMs?: number;
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
] as const;

function piCacheKeyPaths(environment: Readonly<Record<string, string | undefined>>): string[] {
  const agentDir = piAgentDirectory(environment);
  return [join(agentDir, "models.json"), join(agentDir, "auth.json")];
}

/** The file(s) whose mtime+size stand in for "has this provider's install changed?". */
async function catalogCacheKeyPaths(
  provider: (typeof CACHEABLE_CATALOG_PROVIDERS)[number],
  probe: ExternalCodeAgentProbe,
  searchPath: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Promise<string[] | undefined> {
  if (provider === RUNTIME_PROVIDER.PI) return piCacheKeyPaths(environment);
  const executable = await resolveExternalCodeAgentExecutable(
    externalCodeAgent[provider],
    probe,
    searchPath,
    environment,
    platform,
  );
  return executable ? [executable] : undefined;
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
): Promise<{ catalogs: CodeAgentModelCatalog[]; needsRefresh: boolean }> {
  const probe = options.probe;
  const environment = options.environment ?? Bun.env;
  const searchPath = codeAgentExecutableSearchPath(environment, options.platform);
  const catalogs: CodeAgentModelCatalog[] = [discoverCoforgeCatalog()];
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.CLAUDE_CODE))
    catalogs.push(claudeStaticCatalog(installedClaudeCodeVersion(runtimes)));
  const cache = options.cacheDirectory
    ? await readInventoryCache(options.cacheDirectory)
    : undefined;
  let needsRefresh = false;
  const providers = CACHEABLE_CATALOG_PROVIDERS.filter(
    (provider) =>
      provider === RUNTIME_PROVIDER.PI || runtimes.some((runtime) => runtime.provider === provider),
  );
  for (const provider of providers) {
    const keyPaths = await catalogCacheKeyPaths(
      provider,
      probe,
      searchPath,
      environment,
      options.platform ?? process.platform,
    );
    const key = keyPaths ? await fileStatCacheKey(keyPaths) : undefined;
    const cached = key && cache ? cache[provider] : undefined;
    const fresh = key !== undefined && cached?.key === key && cached.catalog !== undefined;
    if (fresh) catalogs.push(cached.catalog!);
    if (!fresh || Date.now() - (cached?.catalogProbedAt ?? 0) > CATALOG_CACHE_TTL_MS)
      needsRefresh = true;
  }
  return { catalogs, needsRefresh };
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
): Promise<CodeAgentModelCatalog[]> {
  const probe = options.probe;
  const environment = options.environment ?? Bun.env;
  const searchPath = codeAgentExecutableSearchPath(environment, options.platform);
  const cwd = options.cwd ?? process.cwd();
  const commands = options.commands ?? {};
  const resolveExecutable = (provider: ExternalCodeAgentProvider) =>
    resolveExternalCodeAgentExecutable(
      externalCodeAgent[provider],
      probe,
      searchPath,
      environment,
      options.platform ?? process.platform,
    );
  type Discovered = {
    provider?: (typeof CACHEABLE_CATALOG_PROVIDERS)[number];
    keyPaths?: string[];
    catalog: CodeAgentModelCatalog | undefined;
  };
  const discoveries: Array<Promise<Discovered>> = [];
  discoveries.push(Promise.resolve({ catalog: discoverCoforgeCatalog() }));
  discoveries.push(
    discoverPiCatalog(
      cwd,
      environment,
      options.piModels,
      options.piCatalogDiscoveryTimeoutMs ?? PI_CATALOG_DISCOVERY_TIMEOUT_MS,
      options.force,
    ).then((catalog) => ({
      provider: RUNTIME_PROVIDER.PI,
      keyPaths: piCacheKeyPaths(environment),
      catalog,
    })),
  );
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.CODEX)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.CODEX);
    if (executable)
      discoveries.push(
        discoverCodexCatalog(
          commands.codex ?? [executable, "app-server"],
          cwd,
          environment,
          options.catalogDiscoveryTimeoutMs ?? CATALOG_DISCOVERY_TIMEOUT_MS,
          options.force,
        ).then((catalog) => ({
          provider: RUNTIME_PROVIDER.CODEX,
          keyPaths: [executable],
          catalog,
        })),
      );
  }
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.CLAUDE_CODE)) {
    discoveries.push(
      Promise.resolve({ catalog: claudeStaticCatalog(installedClaudeCodeVersion(runtimes)) }),
    );
  }
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.KIRO)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.KIRO);
    if (executable)
      discoveries.push(
        discoverKiroCatalog(
          commands.kiro ?? [executable, "acp", "--agent-engine", "v3", "--auth-method", "cli"],
          cwd,
          environment,
        )
          .catch(() => undefined)
          .then((catalog) => ({
            provider: RUNTIME_PROVIDER.KIRO,
            keyPaths: [executable],
            catalog,
          })),
      );
  }
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.CURSOR)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.CURSOR);
    if (executable)
      discoveries.push(
        discoverCursorCatalog(
          commands.cursor ?? [executable, "models"],
          cwd,
          environment,
          runCatalogCommand,
        )
          .catch(() => undefined)
          .then((catalog) => ({
            provider: RUNTIME_PROVIDER.CURSOR,
            keyPaths: [executable],
            catalog,
          })),
      );
  }
  // Grok was the cacheable provider this refresh had no branch for, so its catalog was never
  // probed: an Agent whose runtime is Grok Build saw an empty model list in the UI even though
  // `grok models` lists models fine on the CLI.
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.GROK)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.GROK);
    if (executable)
      discoveries.push(
        discoverGrokCatalog(commands.grok ?? [executable], cwd, environment)
          .catch(() => undefined)
          .then((catalog) => ({
            provider: RUNTIME_PROVIDER.GROK,
            keyPaths: [executable],
            catalog,
          })),
      );
  }
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.ANTIGRAVITY)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.ANTIGRAVITY);
    if (executable)
      discoveries.push(
        discoverAntigravityCatalog(
          commands.antigravity ?? [executable, "models"],
          cwd,
          environment,
        ).then((catalog) => ({
          provider: RUNTIME_PROVIDER.ANTIGRAVITY,
          keyPaths: [executable],
          catalog,
        })),
      );
  }
  // OpenCode was the one cacheable provider this refresh had no branch for, so its catalog was
  // never probed: an Agent whose runtime is OpenCode saw an empty model list in the UI even
  // though `opencode models` lists models fine on the CLI.
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.OPENCODE)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.OPENCODE);
    if (executable)
      discoveries.push(
        discoverOpenCodeCatalog(commands.opencode ?? [executable, "models"], cwd, environment)
          .catch(() => undefined)
          .then((catalog) => ({
            provider: RUNTIME_PROVIDER.OPENCODE,
            keyPaths: [executable],
            catalog,
          })),
      );
  }
  const results = await Promise.all(discoveries);
  if (options.cacheDirectory) {
    const cacheDirectory = options.cacheDirectory;
    const cache = await readInventoryCache(cacheDirectory);
    let dirty = false;
    for (const { provider, keyPaths, catalog } of results) {
      if (!provider || !keyPaths || !catalog) continue;
      const key = await fileStatCacheKey(keyPaths);
      if (!key) continue;
      cache[provider] = { ...cache[provider], key, catalog, catalogProbedAt: Date.now() };
      dirty = true;
    }
    if (dirty) await writeInventoryCache(cacheDirectory, cache);
  }
  return results.flatMap(({ catalog }) => (catalog ? [catalog] : []));
}

export async function discoverCodeAgentInventory(
  options: CodeAgentDiscoveryOptions,
): Promise<CodeAgentInventory> {
  const runtimes = await discoverCodeAgentRuntimes(options);
  const catalogs = await discoverCodeAgentCatalogs(runtimes, options);
  return { runtimes, catalogs };
}

function installedClaudeCodeVersion(runtimes: readonly RuntimeMetadata[]): string | undefined {
  return runtimes.find((runtime) => runtime.provider === RUNTIME_PROVIDER.CLAUDE_CODE)?.version;
}
