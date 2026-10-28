import { antigravityRuntimeHost } from "#src/code-agent/antigravity/host";
import { commandCodeRuntimeHost } from "#src/code-agent/command-code/host";
import { devinRuntimeHost } from "#src/code-agent/devin/host";
import { grokRuntimeHost } from "#src/code-agent/grok/host";
import { kiroRuntimeHost } from "#src/code-agent/kiro/host";
import { join } from "node:path";
import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type RuntimeMetadata,
} from "@lrm/coforge-sdk/internal";
import { codeAgentExecutableSearchPath } from "#src/platform/code-agent-path";
import { PI_SDK_VERSION } from "@coforge/agent";
import { COFORGE_AGENT_RUNTIME_METADATA } from "#src/code-agent/pi/metadata";
import { discoverCommandCodeCatalog } from "@lrm/coforge-anvil/command-code";
import { discoverDevinCatalog, readDevinModelEfforts } from "@lrm/coforge-anvil/devin";
import { readDevinEffortsForCatalog } from "#src/code-agent/devin/effort-read";
import { discoverKiroCatalog, KIRO_ACP_ARGS } from "@lrm/coforge-anvil/kiro";
import { discoverCursorCatalog } from "@lrm/coforge-anvil/cursor";
import { discoverOpenCodeCatalog } from "@lrm/coforge-anvil/opencode";
import { discoverGrokCatalog } from "@lrm/coforge-anvil/grok";
import { discoverAntigravityCatalog } from "@lrm/coforge-anvil/antigravity";
import { CATALOG_DISCOVERY_TIMEOUT_MS } from "@lrm/coforge-anvil";
import {
  discoverPiCatalog,
  piAgentDirectory,
  PI_CATALOG_DISCOVERY_TIMEOUT_MS,
  type PiModelDiscovery,
} from "@lrm/coforge-anvil/pi";
import { runCatalogCommand } from "./catalog-command";
import {
  externalCodeAgent,
  dshCodeAgent,
  resolveExternalCodeAgentExecutable,
  type ExternalCodeAgentProbe,
  type ExternalCodeAgentProvider,
} from "./runtime-executable";
import {
  CATALOG_CACHE_TTL_MS,
  fileStatCacheKey,
  readInventoryCache,
  updateInventoryCache,
} from "./runtime-inventory-cache";
import { discoverExternalCodeAgents } from "./runtime-probe";
import { claudeStaticCatalog } from "@lrm/coforge-anvil/claude-code";
import { discoverCodexCatalog } from "@lrm/coforge-anvil/codex";
import { codexCatalogHost } from "./codex/host";
import { discoverCoforgeCatalog } from "./pi/catalog";
import { piRuntimeHost } from "./pi/host";
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

type CatalogCommands = {
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
  /** Each bounded wait of Codex or DSH model catalog discovery. Defaults are
   * `CATALOG_DISCOVERY_TIMEOUT_MS` for Codex and the native ACP 120-second budget for DSH.
   * The runtime probe's own `initialize` wait is not affected. */
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
  RUNTIME_PROVIDER.COMMAND_CODE,
  RUNTIME_PROVIDER.DEVIN,
] as const;

function piCacheKeyPaths(environment: Readonly<Record<string, string | undefined>>): string[] {
  const agentDir = piAgentDirectory(environment, piRuntimeHost);
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
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.DSH)) {
    const dshOptions = await dshCatalogOptions(options);
    const cached = dshOptions ? await dshCatalogs.cached(dshOptions) : undefined;
    if (cached) catalogs.push(cached);
    else needsRefresh = true;
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
      piRuntimeHost,
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
          codexCatalogHost,
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
          commands.kiro ?? [executable, ...KIRO_ACP_ARGS],
          cwd,
          environment,
          kiroRuntimeHost,
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
        discoverGrokCatalog(commands.grok ?? [executable], cwd, environment, grokRuntimeHost)
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
          antigravityRuntimeHost.catalogCommandRunner,
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
        discoverOpenCodeCatalog(
          commands.opencode ?? [executable, "models"],
          cwd,
          environment,
          runCatalogCommand,
        )
          .catch(() => undefined)
          .then((catalog) => ({
            provider: RUNTIME_PROVIDER.OPENCODE,
            keyPaths: [executable],
            catalog,
          })),
      );
  }
  // The model list is session/new's model select. Without this branch a refresh never probes
  // Command Code, so Edit Runtime Configuration stays empty and Refresh fails.
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.COMMAND_CODE)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.COMMAND_CODE);
    if (executable)
      discoveries.push(
        discoverCommandCodeCatalog(
          commands.commandCode ?? [executable],
          cwd,
          environment,
          commandCodeRuntimeHost,
        )
          .catch(() => undefined)
          .then((catalog) => ({
            provider: RUNTIME_PROVIDER.COMMAND_CODE,
            keyPaths: [executable],
            catalog,
          })),
      );
  }
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.DEVIN)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.DEVIN);
    if (executable)
      discoveries.push(
        discoverDevinCatalog(commands.devin ?? [executable], cwd, environment, devinRuntimeHost)
          .catch(() => undefined)
          .then(async (catalog) => {
            // A model whose efforts are unread is withheld, not published as effort-less:
            // the catalog reports again once every model's `thought_level` is known.
            if (!catalog)
              return { provider: RUNTIME_PROVIDER.DEVIN, keyPaths: [executable], catalog };
            const read = await readDevinEffortsForCatalog({
              modelIds: catalog.models.map((model) => model.id),
              stateDirectory: options.cacheDirectory,
              version: runtimes.find((runtime) => runtime.provider === RUNTIME_PROVIDER.DEVIN)
                ?.version,
              live: (modelIds) =>
                readDevinModelEfforts(
                  commands.devin ?? [executable],
                  cwd,
                  environment,
                  devinRuntimeHost,
                  modelIds,
                ),
            });
            if (!read.complete)
              return {
                provider: RUNTIME_PROVIDER.DEVIN,
                keyPaths: [executable],
                catalog: undefined,
              };
            return {
              provider: RUNTIME_PROVIDER.DEVIN,
              keyPaths: [executable],
              catalog: {
                ...catalog,
                models: catalog.models.map((model) => ({
                  ...model,
                  reasoningEfforts: [...(read.efforts.get(model.id) ?? [])],
                })),
              },
            };
          }),
      );
  }
  if (runtimes.some((runtime) => runtime.provider === RUNTIME_PROVIDER.DSH)) {
    const dshOptions = await dshCatalogOptions(options);
    if (dshOptions)
      discoveries.push(
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
      );
    else if (options.force)
      discoveries.push(Promise.reject(new Error("DSH model catalog refresh failed")));
  }
  const results = await Promise.all(discoveries);
  if (options.cacheDirectory) {
    const cacheDirectory = options.cacheDirectory;
    const probedAt = Date.now();
    const updates = (
      await Promise.all(
        results.map(async ({ provider, keyPaths, catalog }) => {
          if (!provider || !keyPaths || !catalog) return undefined;
          const key = await fileStatCacheKey(keyPaths);
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
