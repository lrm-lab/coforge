import {
  RUNTIME_PROVIDER,
  type RuntimeMetadata,
  diagnosticErrorCode,
} from "@lrm/coforge-sdk/internal";
import { processSpawner } from "#src/code-agent/process-host";
import { agentEnvironment } from "./environment";
import { withoutClaudeCodeMarker } from "@lrm/coforge-anvil/claude-code";
import { JsonlProcess } from "@lrm/coforge-anvil/execution";
import {
  isOpenCodeVersionUnsupported,
  logOpenCodeVersionUnsupported,
} from "@lrm/coforge-anvil/opencode";
import {
  VERSION_PROBE_TIMEOUT_MS,
  withDeadline,
  type CodeAgentProbe,
  CATALOG_DISCOVERY_TIMEOUT_MS,
  within,
} from "@lrm/coforge-anvil";
import { isKiroVersionUnsupported, logKiroVersionUnsupported } from "@lrm/coforge-anvil/kiro";
import { isGrokVersionUnsupported, logGrokVersionUnsupported } from "@lrm/coforge-anvil/grok";
import {
  isCommandCodeVersionUnsupported,
  logCommandCodeVersionUnsupported,
} from "@lrm/coforge-anvil/command-code";
import {
  isAntigravityVersionUnsupported,
  logAntigravityVersionUnsupported,
} from "@lrm/coforge-anvil/antigravity";
import { probeClaudeCodeVersion } from "@lrm/coforge-anvil/claude-code";
import { resolveClaudeCodeExecutable } from "#src/code-agent/claude-code/runtime";
import { codeAgentExecutableSearchPath } from "#src/platform/code-agent-path";
import { getLogger } from "@logtape/logtape";
import {
  externalCodeAgents,
  resolveExternalCodeAgentExecutable,
  type ExternalCodeAgentProbe,
  type ExternalCodeAgentProvider,
} from "./runtime-executable";

import { initializeCodex } from "@lrm/coforge-anvil/codex";
import { codexClientInfo } from "./codex/host";
import {
  fileStatCacheKey,
  readInventoryCache,
  updateInventoryCache,
} from "./runtime-inventory-cache";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

/** Probes the Code Agent CLIs installed on this host: PATH lookups and real `--version` spawns. */
export const hostCodeAgentProbe: ExternalCodeAgentProbe = {
  which: (name, searchPath) => Bun.which(name, { PATH: searchPath }) ?? undefined,
  exists: (executable) => Bun.file(executable).exists(),
  spawn: (executable, env) =>
    Bun.spawn({
      cmd: [executable, "--version"],
      stdout: "pipe",
      stderr: "ignore",
      // Discovery augmented the PATH (npm prefix, nvm versions); a bare npm launcher only works
      // when the probe child sees the same environment the discovery saw.
      env: env ?? agentEnvironment(undefined),
    }),
  probe: async (provider, executable, env) => {
    if (provider !== RUNTIME_PROVIDER.CODEX) return undefined;
    const child = new JsonlProcess(
      [executable, "app-server"],
      process.cwd(),
      agentEnvironment(undefined, env ?? Bun.env),
      processSpawner,
    );
    try {
      await initializeCodex(child, CATALOG_DISCOVERY_TIMEOUT_MS, codexClientInfo);
    } finally {
      await child.dispose().catch(() => undefined);
    }
    return readVersionWithBun(executable, env);
  },
  resolve: async (provider, _name, searchPath) =>
    provider === RUNTIME_PROVIDER.CLAUDE_CODE
      ? await resolveClaudeCodeExecutable(
          (value) => Bun.which(value, { PATH: searchPath }) ?? undefined,
        )
      : undefined,
};

/** The three probe strategies external providers use to turn a resolved executable into a version. */
async function probeRuntimeVersion(
  provider: ExternalCodeAgentProvider,
  name: string,
  executable: string,
  probe: ExternalCodeAgentProbe,
  /** The discovery environment: discovery already augmented its PATH the way an eventual
   * Agent process would get it, so version probing sees the same launchers. */
  environment: Readonly<Record<string, string | undefined>>,
  versionProbeTimeoutMs: number,
): Promise<RuntimeVersionProbe> {
  const probeEnvironment = agentEnvironment(undefined, environment);
  const providerProbe =
    provider === RUNTIME_PROVIDER.CODEX
      ? probe.probe?.(provider, executable, probeEnvironment)
      : undefined;
  if (providerProbe !== undefined) {
    const version = await within(providerProbe);
    return version
      ? { kind: "runtime", runtime: { provider, version, displayName: "Codex" } }
      : { kind: "unavailable" };
  }
  if (provider === RUNTIME_PROVIDER.CLAUDE_CODE) {
    const version = await probeClaudeCodeVersion(executable, (child) =>
      probe.spawn(child, withoutClaudeCodeMarker(probeEnvironment)),
    );
    return version
      ? { kind: "runtime", runtime: { provider, version, displayName: "Claude Code" } }
      : { kind: "unavailable" };
  }
  const { output, exitCode } = await versionProbeOutput(
    probe.spawn(executable, probeEnvironment),
    versionProbeTimeoutMs,
  );
  if (exitCode !== 0) {
    logger.warning("Code Agent version probe exited unsuccessfully", {
      event: "code_agent_runtime:probe_failed",
      provider,
      executable_name: name,
      exit_code: exitCode,
      outcome: "unavailable",
    });
    return { kind: "unavailable" };
  }
  // Grok prints `grok <version> (<build hash>)`; the version is the dotted-numeric token, not the
  // last word.
  const version =
    provider === RUNTIME_PROVIDER.GROK
      ? output
          .trim()
          .split(/\s+/)
          .find((token) => /^\d+(\.\d+)*$/.test(token))
      : lastWord(output);
  if (!version) return { kind: "unavailable" };
  if (provider === RUNTIME_PROVIDER.KIRO && isKiroVersionUnsupported(version)) {
    logKiroVersionUnsupported(name, version);
    return { kind: "unavailable" };
  }
  if (provider === RUNTIME_PROVIDER.OPENCODE && isOpenCodeVersionUnsupported(version)) {
    logOpenCodeVersionUnsupported(name, version);
    return { kind: "rejected" };
  }
  if (provider === RUNTIME_PROVIDER.GROK && isGrokVersionUnsupported(version)) {
    logGrokVersionUnsupported(name, version);
    return { kind: "unavailable" };
  }
  if (provider === RUNTIME_PROVIDER.ANTIGRAVITY && isAntigravityVersionUnsupported(version)) {
    logAntigravityVersionUnsupported(name, version);
    return { kind: "unavailable" };
  }
  if (provider === RUNTIME_PROVIDER.COMMAND_CODE && isCommandCodeVersionUnsupported(version)) {
    logCommandCodeVersionUnsupported(name, version);
    return { kind: "unavailable" };
  }
  return {
    kind: "runtime",
    runtime: { provider, version, displayName: externalRuntimeDisplayName(provider) },
  };
}

/** `rejected` is a version the probe read and the floor refused. `unavailable` is a miss: the
 * probe threw, exited non-zero, or printed nothing that could be gated. Only a miss may fall
 * back to a cached runtime. */
type RuntimeVersionProbe =
  | { kind: "runtime"; runtime: RuntimeMetadata }
  | { kind: "rejected" }
  | { kind: "unavailable" };

/** An older daemon cached this OpenCode build before the floor moved. Serving it, including as a
 * probe-failure fallback, would keep offering a CLI this build refuses to launch. */
function cachedOpenCodeBelowFloor(
  provider: ExternalCodeAgentProvider,
  name: string,
  runtime: RuntimeMetadata | undefined,
): boolean {
  if (
    provider !== RUNTIME_PROVIDER.OPENCODE ||
    runtime === undefined ||
    !isOpenCodeVersionUnsupported(runtime.version)
  ) {
    return false;
  }
  logOpenCodeVersionUnsupported(name, runtime.version);
  return true;
}

/** A live probe that read a refused version must erase this provider's cached runtime. A later
 * miss would otherwise restore an older, still-supported entry for a different executable. */
type DiscoveredExternalAgent =
  | { runtime: RuntimeMetadata; cacheKey: string | undefined }
  | { dropProvider: ExternalCodeAgentProvider };

export async function discoverExternalCodeAgents(
  probe: ExternalCodeAgentProbe,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
  platform: NodeJS.Platform = process.platform,
  requestedProvider?: RuntimeMetadata["provider"],
  cacheDirectory?: string,
  versionProbeTimeoutMs: number = VERSION_PROBE_TIMEOUT_MS,
): Promise<RuntimeMetadata[]> {
  const runtimes: RuntimeMetadata[] = [];
  const searchPath = codeAgentExecutableSearchPath(environment, platform);
  const cache = cacheDirectory ? await readInventoryCache(cacheDirectory) : undefined;
  const results = await Promise.all(
    externalCodeAgents
      .filter(({ provider }) => !requestedProvider || requestedProvider === provider)
      .map(async (agent): Promise<DiscoveredExternalAgent | undefined> => {
        const { provider, executable: name } = agent;
        let executable: string | undefined;
        try {
          executable = await resolveExternalCodeAgentExecutable(
            agent,
            probe,
            searchPath,
            environment,
            platform,
          );
          if (!executable) {
            logger.info("Code Agent executable was not found", {
              event: "code_agent_runtime:not_found",
              provider,
              executable_name: name,
              outcome: "unavailable",
            });
            return undefined;
          }
          const cacheKey = cache ? await fileStatCacheKey([executable]) : undefined;
          const cached = cacheKey ? cache?.[provider] : undefined;
          if (cacheKey && cached?.key === cacheKey && cached.runtime) {
            // A cache entry written by an older daemon build must be re-validated against the
            // current minimum before it is trusted; the executable itself has not changed, so a
            // too-old cached version would only reproduce the same gate on a live re-probe.
            if (
              provider === RUNTIME_PROVIDER.KIRO &&
              isKiroVersionUnsupported(cached.runtime.version)
            ) {
              logKiroVersionUnsupported(name, cached.runtime.version);
              return undefined;
            }
            if (cachedOpenCodeBelowFloor(provider, name, cached.runtime)) return undefined;
            if (
              provider === RUNTIME_PROVIDER.COMMAND_CODE &&
              isCommandCodeVersionUnsupported(cached.runtime.version)
            ) {
              logCommandCodeVersionUnsupported(name, cached.runtime.version);
              return undefined;
            }
            logger.info("Code Agent runtime probe served from cache", {
              event: "code_agent_runtime:cache_hit",
              provider,
              executable_name: name,
              outcome: "ok",
            });
            return { runtime: cached.runtime, cacheKey: undefined };
          }
          const probed = await probeRuntimeVersion(
            provider,
            name,
            executable,
            probe,
            environment,
            versionProbeTimeoutMs,
          );
          if (probed.kind === "runtime") return { runtime: probed.runtime, cacheKey };
          // The binary on disk was read and refused. Drop the cached runtime now; returning
          // nothing would leave an older supported entry for the next probe miss to restore.
          if (probed.kind === "rejected") return { dropProvider: provider };
          // A transient version/app-server failure must not make an installed runtime vanish
          // from the Computer inventory. Keep the last successful result when the executable
          // itself is unchanged; the next refresh will retry the live probe.
          if (cachedOpenCodeBelowFloor(provider, name, cached?.runtime)) return undefined;
          if (cached?.runtime) {
            logger.warning("Code Agent runtime probe failed; using cached runtime", {
              event: "code_agent_runtime:cache_fallback",
              provider,
              executable_name: name,
              outcome: "degraded",
            });
            return { runtime: cached.runtime, cacheKey: undefined };
          }
          return undefined;
        } catch (error) {
          logger.warning("Code Agent runtime probe failed", {
            event: "code_agent_runtime:probe_failed",
            provider,
            executable_name: name,
            error_code: diagnosticErrorCode(error),
            outcome: "unavailable",
          });
          // A transient probe failure must not erase an otherwise known installed runtime.
          const fallbackCacheKey = executable
            ? cache
              ? await fileStatCacheKey([executable])
              : undefined
            : undefined;
          const fallbackCached = fallbackCacheKey ? cache?.[provider] : undefined;
          if (cachedOpenCodeBelowFloor(provider, name, fallbackCached?.runtime)) return undefined;
          if (fallbackCached?.runtime) {
            logger.warning("Code Agent runtime probe failed; using cached runtime", {
              event: "code_agent_runtime:cache_fallback",
              provider,
              executable_name: name,
              outcome: "degraded",
            });
            return { runtime: fallbackCached.runtime, cacheKey: undefined };
          }
          // An executable without a usable version is not available inventory.
          return undefined;
        }
      }),
  );
  const dropped = new Set<ExternalCodeAgentProvider>();
  const probed: {
    provider: RuntimeMetadata["provider"];
    cacheKey: string;
    runtime: RuntimeMetadata;
  }[] = [];
  for (const result of results) {
    if (!result) continue;
    if ("dropProvider" in result) {
      dropped.add(result.dropProvider);
      continue;
    }
    runtimes.push(result.runtime);
    if (result.cacheKey)
      probed.push({
        provider: result.runtime.provider,
        cacheKey: result.cacheKey,
        runtime: result.runtime,
      });
  }
  // Persist only this discovery's own changes. Writing the whole snapshot it read earlier would
  // restore a provider another discovery dropped in between.
  if (cacheDirectory && (dropped.size > 0 || probed.length > 0)) {
    await updateInventoryCache(cacheDirectory, (current) => {
      for (const provider of dropped) delete current[provider];
      for (const entry of probed)
        current[entry.provider] = {
          ...current[entry.provider],
          key: entry.cacheKey,
          runtime: entry.runtime,
        };
    });
  }
  return runtimes;
}

/** Collects a `--version` child's output, killing it if it outlives the probe budget. */
export async function versionProbeOutput(
  process: ReturnType<CodeAgentProbe["spawn"]>,
  timeoutMs: number = VERSION_PROBE_TIMEOUT_MS,
): Promise<{ output: string; exitCode: number }> {
  return withDeadline(
    Promise.all([new Response(process.stdout).text(), process.exited]).then(
      ([output, exitCode]) => ({ output, exitCode }),
    ),
    timeoutMs,
    () => {
      process.kill?.();
      return new Error("runtime version probe timed out");
    },
  );
}

function lastWord(output: string): string | undefined {
  return output.trim().split(/\s+/).pop() || undefined;
}

async function readVersionWithBun(
  executable: string,
  env?: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const process = Bun.spawn({
    cmd: [executable, "--version"],
    stdout: "pipe",
    stderr: "ignore",
    env: env ?? agentEnvironment(undefined),
  });
  try {
    const { output, exitCode } = await versionProbeOutput(process);
    return exitCode === 0 ? lastWord(output) : undefined;
  } finally {
    process.kill();
  }
}

function externalRuntimeDisplayName(provider: ExternalCodeAgentProvider): string {
  switch (provider) {
    case RUNTIME_PROVIDER.CODEX:
      return "Codex";
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      return "Claude Code";
    case RUNTIME_PROVIDER.KIRO:
      return "Kiro";
    case RUNTIME_PROVIDER.CURSOR:
      return "Cursor CLI";
    case RUNTIME_PROVIDER.OPENCODE:
      return "OpenCode";
    case RUNTIME_PROVIDER.GROK:
      return "Grok Build";
    case RUNTIME_PROVIDER.ANTIGRAVITY:
      return "Antigravity CLI";
    case RUNTIME_PROVIDER.COMMAND_CODE:
      return "Command Code";
    default: {
      const unreachable: never = provider;
      throw new Error(`Unhandled external Code Agent provider: ${unreachable}`);
    }
  }
}
