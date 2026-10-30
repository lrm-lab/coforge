import {
  RUNTIME_PROVIDER,
  type RuntimeMetadata,
  type RuntimeUnavailableCode,
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
import { stderrHint } from "#src/code-agent/version-probe";
import { isKiroVersionUnsupported, logKiroVersionUnsupported } from "@lrm/coforge-anvil/kiro";
import { DSH_ACP_VERSION, dshVersionFromOutput } from "@lrm/coforge-anvil/dsh";
import { isGrokVersionUnsupported, logGrokVersionUnsupported } from "@lrm/coforge-anvil/grok";
import {
  isCommandCodeVersionUnsupported,
  logCommandCodeVersionUnsupported,
} from "@lrm/coforge-anvil/command-code";
import {
  devinVersionFromOutput,
  isDevinVersionUnsupported,
  logDevinVersionUnsupported,
} from "@lrm/coforge-anvil/devin";
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
      // The first stderr line is what a person needs when the CLI cannot start at all.
      stderr: "pipe",
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
      : { kind: "unavailable", code: "probe_failed" };
  }
  if (provider === RUNTIME_PROVIDER.CLAUDE_CODE) {
    const version = await probeClaudeCodeVersion(executable, (child) =>
      probe.spawn(child, withoutClaudeCodeMarker(probeEnvironment)),
    );
    return version
      ? { kind: "runtime", runtime: { provider, version, displayName: "Claude Code" } }
      : { kind: "unavailable", code: "probe_failed" };
  }
  const { output, exitCode, diagnostic } = await versionProbeOutput(
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
    // The CLI is installed but could not start: that is a start failure, never a version judgement.
    return { kind: "unavailable", code: "start_failed", diagnostic };
  }
  // Grok prints `grok <version> (<build hash>)`; the version is the dotted-numeric token, not the
  // last word. Devin reads its own launch gate's parser, so the two can never disagree.
  const version =
    provider === RUNTIME_PROVIDER.DEVIN
      ? devinVersionFromOutput(output)
      : provider === RUNTIME_PROVIDER.GROK
        ? output
            .trim()
            .split(/\s+/)
            .find((token) => /^\d+(\.\d+)*$/.test(token))
        : provider === RUNTIME_PROVIDER.DSH
          ? // Read exactly as DSH's launch reads it, so the two never disagree on the pin below.
            (dshVersionFromOutput(output) ?? output.trim())
          : lastWord(output);
  if (!version) return { kind: "unavailable", code: "probe_failed" };
  if (provider === RUNTIME_PROVIDER.KIRO && isKiroVersionUnsupported(version)) {
    logKiroVersionUnsupported(name, version);
    return { kind: "rejected", version };
  }
  if (provider === RUNTIME_PROVIDER.OPENCODE && isOpenCodeVersionUnsupported(version)) {
    logOpenCodeVersionUnsupported(name, version);
    return { kind: "rejected", version };
  }
  if (provider === RUNTIME_PROVIDER.GROK && isGrokVersionUnsupported(version)) {
    logGrokVersionUnsupported(name, version);
    return { kind: "rejected", version };
  }
  if (provider === RUNTIME_PROVIDER.ANTIGRAVITY && isAntigravityVersionUnsupported(version)) {
    logAntigravityVersionUnsupported(name, version);
    return { kind: "rejected", version };
  }
  if (provider === RUNTIME_PROVIDER.COMMAND_CODE && isCommandCodeVersionUnsupported(version)) {
    logCommandCodeVersionUnsupported(name, version);
    return { kind: "rejected", version };
  }
  if (provider === RUNTIME_PROVIDER.DEVIN && isDevinVersionUnsupported(version)) {
    logDevinVersionUnsupported(name, version);
    // A refused version is not a probe miss: the cached runtime must be dropped, not restored.
    return { kind: "rejected", version };
  }
  // The preview ACP is pinned to one release: any other version is refused, never offered.
  if (provider === RUNTIME_PROVIDER.DSH && version !== DSH_ACP_VERSION) {
    logger.warning("DeepSeek Harness version is not the pinned release", {
      event: "code_agent_runtime:version_unsupported",
      provider,
      executable_name: name,
      version,
      required_version: DSH_ACP_VERSION,
      outcome: "unavailable",
    });
    return { kind: "rejected", version };
  }
  return {
    kind: "runtime",
    runtime: { provider, version, displayName: externalRuntimeDisplayName(provider) },
  };
}

/**
 * `rejected` is a version the probe read and the gate refused. `unavailable` is a CLI that could
 * not be read: it exited non-zero (`start_failed`), or ran without printing a version
 * (`probe_failed`). Both keep the runtime in the inventory as unusable, with the code and the
 * redacted stderr line that say why; only `rejected` also drops the cached runtime.
 */
type RuntimeVersionProbe =
  | { kind: "runtime"; runtime: RuntimeMetadata }
  | { kind: "rejected"; version: string }
  | {
      kind: "unavailable";
      code: "start_failed" | "probe_failed";
      diagnostic?: string;
    };

/** An older daemon cached an OpenCode or Devin build before the floor moved. Serving it, including
 * as a probe-failure fallback, would keep offering a CLI this build refuses to launch. */
function cachedBelowFloor(
  provider: ExternalCodeAgentProvider,
  name: string,
  runtime: RuntimeMetadata | undefined,
): boolean {
  if (runtime === undefined) return false;
  if (provider === RUNTIME_PROVIDER.OPENCODE && isOpenCodeVersionUnsupported(runtime.version)) {
    logOpenCodeVersionUnsupported(name, runtime.version);
    return true;
  }
  if (provider === RUNTIME_PROVIDER.DEVIN && isDevinVersionUnsupported(runtime.version)) {
    logDevinVersionUnsupported(name, runtime.version);
    return true;
  }
  return false;
}

/** An installed runtime that cannot be used keeps its place in the inventory, with the reason, so
 * the Computer page and the Agent runtime picker can say why instead of hiding it. `version` is
 * the last one read when this Computer knew it, and empty when the CLI never printed one. */
function unusableRuntime(
  provider: ExternalCodeAgentProvider,
  version: string,
  unavailableCode: RuntimeUnavailableCode,
  diagnostic?: string,
): RuntimeMetadata {
  return {
    provider,
    version,
    displayName: externalRuntimeDisplayName(provider),
    unavailableCode,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

/** A live probe that read a refused version must erase this provider's cached runtime. A later
 * miss would otherwise restore an older, still-supported entry for a different executable. */
type DiscoveredExternalAgent =
  | { runtime: RuntimeMetadata; cacheKey?: string }
  | { dropProvider: ExternalCodeAgentProvider; unusable: RuntimeMetadata };

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
              return {
                runtime: unusableRuntime(provider, cached.runtime.version, "version_unsupported"),
              };
            }
            if (cachedBelowFloor(provider, name, cached.runtime))
              return {
                runtime: unusableRuntime(provider, cached.runtime.version, "version_unsupported"),
              };
            if (
              provider === RUNTIME_PROVIDER.COMMAND_CODE &&
              isCommandCodeVersionUnsupported(cached.runtime.version)
            ) {
              logCommandCodeVersionUnsupported(name, cached.runtime.version);
              return {
                runtime: unusableRuntime(provider, cached.runtime.version, "version_unsupported"),
              };
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
          if (probed.kind === "rejected")
            return {
              dropProvider: provider,
              unusable: unusableRuntime(provider, probed.version, "version_unsupported"),
            };
          // A CLI that cannot be read stays in the inventory, unusable, with its own reason and
          // the redacted stderr line: hiding it is what left the Computer page saying nothing.
          return {
            runtime: unusableRuntime(
              provider,
              cached?.runtime?.version ?? "",
              probed.code,
              probed.diagnostic,
            ),
          };
        } catch (error) {
          logger.warning("Code Agent runtime probe failed", {
            event: "code_agent_runtime:probe_failed",
            provider,
            executable_name: name,
            error_code: diagnosticErrorCode(error),
            outcome: "unavailable",
          });
          if (!executable) return undefined;
          const fallbackCacheKey = cache ? await fileStatCacheKey([executable]) : undefined;
          const fallbackCached = fallbackCacheKey ? cache?.[provider] : undefined;
          if (fallbackCached?.runtime && cachedBelowFloor(provider, name, fallbackCached.runtime))
            return {
              runtime: unusableRuntime(
                provider,
                fallbackCached.runtime.version,
                "version_unsupported",
              ),
            };
          return {
            runtime: unusableRuntime(
              provider,
              fallbackCached?.runtime?.version ?? "",
              "probe_failed",
            ),
          };
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
      runtimes.push(result.unusable);
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
): Promise<{ output: string; exitCode: number; diagnostic?: string }> {
  return withDeadline(
    Promise.all([
      new Response(process.stdout).text(),
      process.stderr ? new Response(process.stderr).text() : Promise.resolve(""),
      process.exited,
    ]).then(([output, stderr, exitCode]) => ({
      output,
      exitCode,
      diagnostic: stderrHint(stderr),
    })),
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
    stderr: "pipe",
    env: env ?? agentEnvironment(undefined),
  });
  try {
    const { output, exitCode } = await versionProbeOutput(process);
    return exitCode === 0 ? lastWord(output) : undefined;
  } finally {
    await killProbeChild(process);
  }
}

/**
 * Ends a probe child and waits until it is really gone. On Windows a running executable keeps its
 * image locked, and killing it takes effect asynchronously: a caller that removes the
 * executable's directory right after the probe (a temp fixture, an uninstall) would get EBUSY
 * without this wait.
 */
export async function killProbeChild(process: ReturnType<CodeAgentProbe["spawn"]>): Promise<void> {
  process.kill?.();
  await process.exited.catch(() => undefined);
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
    case RUNTIME_PROVIDER.DEVIN:
      return "Devin";
    case RUNTIME_PROVIDER.DSH:
      return "DeepSeek Harness";
    default: {
      const unreachable: never = provider;
      throw new Error(`Unhandled external Code Agent provider: ${unreachable}`);
    }
  }
}
