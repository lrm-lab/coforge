import { antigravityAcpRuntimeHost } from "#src/code-agent/antigravity/acp-host";
import { openCodeAcpRuntimeHost } from "#src/code-agent/opencode/acp-host";
import { openCodeCatalogWithCachedEfforts } from "#src/code-agent/opencode/effort-read";
import { commandCodeRuntimeHost } from "#src/code-agent/command-code/host";
import { devinRuntimeHost } from "#src/code-agent/devin/host";
import { grokRuntimeHost } from "#src/code-agent/grok/host";
import { kiroRuntimeHost } from "#src/code-agent/kiro/host";
import {
  RUNTIME_PROVIDER,
  type RuntimeMetadata,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { codeAgentExecutableSearchPath } from "#src/platform/code-agent-path";
import { discoverCommandCodeCatalog } from "@lrm/coforge-anvil/command-code";
import { discoverDevinCatalog } from "@lrm/coforge-anvil/devin";
import { devinCatalogWithCachedEfforts } from "#src/code-agent/devin/effort-read";
import { discoverKiroCatalog, KIRO_ACP_ARGS } from "@lrm/coforge-anvil/kiro";
import { discoverCursorAcpCatalog } from "@lrm/coforge-anvil/cursor";
import { cursorAcpRuntimeHost } from "#src/code-agent/cursor/acp-host";
import { discoverOpenCodeAcpCatalog } from "@lrm/coforge-anvil/opencode";
import { discoverGrokCatalog } from "@lrm/coforge-anvil/grok";
import { discoverAntigravityAcpCatalog } from "@lrm/coforge-anvil/antigravity";
import { CATALOG_DISCOVERY_TIMEOUT_MS } from "@lrm/coforge-anvil";
import { discoverPiCatalog, PI_CATALOG_DISCOVERY_TIMEOUT_MS } from "@lrm/coforge-anvil/pi";
import { piRuntimeHost } from "./pi/host";
import { piCacheKeyPaths } from "./catalog-cache-key";
import type { CodeAgentDiscoveryOptions } from "./discovery-options";
import {
  externalCodeAgent,
  dshCodeAgent,
  resolveExternalCodeAgentExecutable,
  type ExternalCodeAgentProvider,
} from "./runtime-executable";
import { claudeStaticCatalog } from "@lrm/coforge-anvil/claude-code";
import { discoverCodexCatalog } from "@lrm/coforge-anvil/codex";
import { codexCatalogHost } from "./codex/host";
import { discoverCoforgeCatalog } from "./pi/catalog";
import type { DshCatalogDiscovery } from "./dsh/catalog";
import { discoverDroidAcpCatalog } from "@lrm/coforge-anvil/droid";
import { droidAcpRuntimeHost } from "./droid/acp-host";
import { agentEnvironment } from "./environment";
import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import type { CatalogDiscoveryResult } from "./catalog-discovery-results";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

export async function dshCatalogOptions(options: CodeAgentDiscoveryOptions) {
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

export function installedClaudeCodeVersion(
  runtimes: readonly RuntimeMetadata[],
): string | undefined {
  return runtimes.find(
    (runtime) => runtime.provider === RUNTIME_PROVIDER.CLAUDE_CODE && !runtime.unavailableCode,
  )?.version;
}

/**
 * Builds the catalog discovery entries for every usable provider: which command each probe
 * runs and how its catalog is read. The caller selects the entries a refresh covers and starts
 * them.
 */
export async function planCatalogDiscoveries(
  runtimes: RuntimeMetadata[],
  options: CodeAgentDiscoveryOptions,
  dshCatalogs: DshCatalogDiscovery,
): Promise<Array<readonly [RuntimeProvider, () => Promise<CatalogDiscoveryResult>]>> {
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
  const discoveries: Array<[RuntimeProvider, () => Promise<CatalogDiscoveryResult>]> = [];
  discoveries.push([
    RUNTIME_PROVIDER.COFORGE,
    () => Promise.resolve({ catalog: discoverCoforgeCatalog() }),
  ]);
  discoveries.push([
    RUNTIME_PROVIDER.PI,
    () =>
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
        () =>
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
      () => Promise.resolve({ catalog: claudeStaticCatalog(installedClaudeCodeVersion(runtimes)) }),
    ]);
  }
  if (usable(RUNTIME_PROVIDER.KIRO)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.KIRO);
    if (executable)
      discoveries.push([
        RUNTIME_PROVIDER.KIRO,
        () =>
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
        () =>
          discoverCursorAcpCatalog(
            commands.cursor ?? [executable],
            cwd,
            environment,
            cursorAcpRuntimeHost,
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
        () =>
          discoverGrokCatalog(
            commands.grok ?? [executable],
            cwd,
            environment,
            grokRuntimeHost,
          ).then((catalog) => ({
            keyPaths: [executable],
            catalog,
          })),
      ]);
  }
  if (usable(RUNTIME_PROVIDER.ANTIGRAVITY)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.ANTIGRAVITY);
    if (executable)
      discoveries.push([
        RUNTIME_PROVIDER.ANTIGRAVITY,
        () =>
          discoverAntigravityAcpCatalog(
            commands.antigravity ?? [executable],
            cwd,
            agentEnvironment(undefined, environment),
            antigravityAcpRuntimeHost,
          ).then((catalog) => ({
            keyPaths: [executable],
            catalog,
          })),
      ]);
  }
  // The model list is session/new's model config option, the same select the session's own
  // `set_config_option` applies to — `opencode models` is no longer read.
  if (usable(RUNTIME_PROVIDER.OPENCODE)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.OPENCODE);
    if (executable)
      discoveries.push([
        RUNTIME_PROVIDER.OPENCODE,
        () =>
          discoverOpenCodeAcpCatalog(
            commands.opencode ?? [executable],
            cwd,
            environment,
            openCodeAcpRuntimeHost,
          ).then(async (catalog) => {
            // A model list publishes at discovery speed: efforts fill from the cache only, and
            // the inventory-sync sweep reports the catalog again once `thought_level` is read.
            if (!catalog) return { keyPaths: [executable], catalog };
            const { catalog: filled } = await openCodeCatalogWithCachedEfforts(
              catalog,
              options.cacheDirectory,
              runtimes.find((runtime) => runtime.provider === RUNTIME_PROVIDER.OPENCODE)?.version,
            );
            return { keyPaths: [executable], catalog: filled };
          }),
      ]);
  }
  // The model list is session/new's model select, efforts read in the same probe session; the
  // probe's cwd is the host's business (Droid keeps a session per cwd and cannot delete it).
  if (usable(RUNTIME_PROVIDER.DROID)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.DROID);
    if (executable)
      discoveries.push([
        RUNTIME_PROVIDER.DROID,
        () =>
          discoverDroidAcpCatalog(
            commands.droid ?? [executable],
            droidAcpRuntimeHost.catalogCwd?.(options.cacheDirectory, cwd) ?? cwd,
            environment,
            droidAcpRuntimeHost,
          ).then((catalog) => ({ keyPaths: [executable], catalog })),
      ]);
  }
  // The model list is session/new's model select. Without this branch a refresh never probes
  // Command Code, so Edit Runtime Configuration stays empty and Refresh fails.
  if (usable(RUNTIME_PROVIDER.COMMAND_CODE)) {
    const executable = await resolveExecutable(RUNTIME_PROVIDER.COMMAND_CODE);
    if (executable)
      discoveries.push([
        RUNTIME_PROVIDER.COMMAND_CODE,
        () =>
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
        () =>
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
        () =>
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
        () => Promise.reject(new Error("DSH model catalog refresh failed")),
      ]);
  }
  return discoveries;
}
