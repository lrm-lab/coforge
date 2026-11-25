import {
  RUNTIME_PROVIDER,
  type RuntimeMetadata,
  type RuntimeUnavailableCode,
  diagnosticErrorCode,
} from "@lrm/coforge-sdk/internal";
import { agentEnvironment } from "./environment";
import { withoutClaudeCodeMarker } from "@lrm/coforge-anvil/claude-code";
import {
  VERSION_PROBE_TIMEOUT_MS,
  withDeadline,
  type CodeAgentProbe,
  AgentProcessCleanupError,
  RuntimeStartFailedError,
  within,
} from "@lrm/coforge-anvil";
import { stderrHint } from "#src/code-agent/version-probe";
import {
  DSH_ACP_VERSION_RANGE,
  dshVersionFromOutput,
  isDshVersionSupported,
} from "@lrm/coforge-anvil/dsh";
import { devinVersionFromOutput } from "@lrm/coforge-anvil/devin";
import { probeClaudeCodeVersion } from "@lrm/coforge-anvil/claude-code";
import { resolveClaudeCodeExecutable } from "#src/code-agent/claude-code/runtime";
import { codeAgentExecutableSearchPath } from "#src/platform/code-agent-path";
import { getLogger } from "@logtape/logtape";
import {
  externalCodeAgents,
  readSelectedCodexExecutable,
  remainingCodexExecutables,
  rememberCodexExecutable,
  resolveExternalCodeAgentExecutable,
  type ExternalCodeAgentProbe,
  type ExternalCodeAgentProvider,
} from "./runtime-executable";

import {
  CODEX_PROBE_TIMEOUT_MS,
  CODEX_PROBE_BUDGET_MULTIPLIER,
  probeCodexExecutable,
} from "./codex/executable-probe";
import {
  fileStatCacheKey,
  readInventoryCache,
  updateInventoryCache,
} from "./runtime-inventory-cache";
import {
  cachedBelowFloor,
  externalRuntimeDisplayName,
  versionGateFor,
} from "./runtime-version-floors";
import { recordRuntimeCliObservations } from "./runtime-version-tracker";

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
  probeCodex: probeCodexExecutable,
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
  codexProbeTimeoutMs: number,
): Promise<RuntimeVersionProbe> {
  const probeEnvironment = agentEnvironment(undefined, environment);
  if (provider === RUNTIME_PROVIDER.CODEX && (probe.probeCodex || probe.probe)) {
    const version = probe.probeCodex
      ? await probe.probeCodex(executable, probeEnvironment, codexProbeTimeoutMs)
      : await within(probe.probe!(provider, executable, probeEnvironment));
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
  // A refused version is not a probe miss: the cached runtime must be dropped, not restored.
  const gate = versionGateFor(provider);
  if (gate?.unsupported(version)) {
    gate.log(name, version);
    return { kind: "rejected", version };
  }
  // The preview ACP accepts the verified 0.2.1 line only: any other release is refused, never offered.
  if (provider === RUNTIME_PROVIDER.DSH && !isDshVersionSupported(version)) {
    logger.warning("DeepSeek Harness version is outside the supported preview line", {
      event: "code_agent_runtime:version_unsupported",
      provider,
      executable_name: name,
      version,
      required_range: DSH_ACP_VERSION_RANGE,
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
  | { runtime: RuntimeMetadata; executable?: string; cacheKey?: string; executableKey?: string }
  | { dropProvider: ExternalCodeAgentProvider; unusable: RuntimeMetadata };

function usableResult(
  result: DiscoveredExternalAgent,
): result is Extract<DiscoveredExternalAgent, { runtime: RuntimeMetadata }> {
  return "runtime" in result && !result.runtime.unavailableCode;
}

type DiscoveryEnvironment = Readonly<Record<string, string | undefined>>;
const codexProbes = new WeakMap<
  DiscoveryEnvironment,
  Promise<DiscoveredExternalAgent | undefined>
>();

function shareCodexProbe(
  environment: DiscoveryEnvironment,
  probe: () => Promise<DiscoveredExternalAgent | undefined>,
): Promise<DiscoveredExternalAgent | undefined> {
  const running = codexProbes.get(environment);
  if (running) return running;
  const pending = probe().finally(() => codexProbes.delete(environment));
  codexProbes.set(environment, pending);
  return pending;
}

export async function ensureCodexExecutable(
  environment: DiscoveryEnvironment = Bun.env,
  platform: NodeJS.Platform = process.platform,
  probe: ExternalCodeAgentProbe = hostCodeAgentProbe,
  cacheDirectory?: string,
  timeoutMs?: number,
): Promise<string | undefined> {
  const selected = await readSelectedCodexExecutable(environment);
  if (selected) return selected;
  const runtimes = await discoverExternalCodeAgents(
    probe,
    environment,
    platform,
    RUNTIME_PROVIDER.CODEX,
    cacheDirectory,
    undefined,
    timeoutMs,
  );
  const executable = await readSelectedCodexExecutable(environment);
  if (executable) return executable;
  if (!runtimes.length) return undefined;
  throw new RuntimeStartFailedError("No compatible Codex executable could be started");
}

export async function discoverExternalCodeAgents(
  ...args: Parameters<typeof discoverExternalCodeAgentDetails>
): Promise<RuntimeMetadata[]> {
  return (await discoverExternalCodeAgentDetails(...args)).map(({ runtime }) => runtime);
}

export async function discoverExternalCodeAgentDetails(
  probe: ExternalCodeAgentProbe,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
  platform: NodeJS.Platform = process.platform,
  requestedProvider?: RuntimeMetadata["provider"],
  cacheDirectory?: string,
  versionProbeTimeoutMs: number = VERSION_PROBE_TIMEOUT_MS,
  codexProbeTimeoutMs: number = CODEX_PROBE_TIMEOUT_MS,
): Promise<Array<{ runtime: RuntimeMetadata; executable?: string }>> {
  const runtimes: Array<{ runtime: RuntimeMetadata; executable?: string }> = [];
  const searchPath = codeAgentExecutableSearchPath(environment, platform);
  const cache = cacheDirectory ? await readInventoryCache(cacheDirectory) : undefined;
  const results = await Promise.all(
    externalCodeAgents
      .filter(({ provider }) => !requestedProvider || requestedProvider === provider)
      .map((agent) => {
        const hostCodex = agent.provider === RUNTIME_PROVIDER.CODEX && Boolean(probe.probeCodex);
        const discover = () => probeAgent(agent, hostCodex);
        return hostCodex ? shareCodexProbe(environment, discover) : discover();
      }),
  );

  async function probeAgent(
    agent: (typeof externalCodeAgents)[number],
    hostCodex: boolean,
  ): Promise<DiscoveredExternalAgent | undefined> {
    const { provider, executable: name } = agent;
    let primary: string | undefined;
    try {
      primary = await resolveExternalCodeAgentExecutable(
        agent,
        probe,
        searchPath,
        environment,
        platform,
      );
    } catch (error) {
      if (hostCodex) rememberCodexExecutable(environment, undefined);
      logFailure(error);
      return undefined;
    }
    if (!primary) {
      if (hostCodex) rememberCodexExecutable(environment, undefined);
      logger.info("Code Agent executable was not found", {
        event: "code_agent_runtime:not_found",
        provider,
        executable_name: name,
        outcome: "unavailable",
      });
      return undefined;
    }

    let cleanupFailed = false;
    async function probeExecutable(
      executable: string,
      timeoutMs: number,
    ): Promise<DiscoveredExternalAgent> {
      try {
        const cacheKey =
          cache || hostCodex ? await fileStatCacheKey([executable], hostCodex) : undefined;
        const cached = cacheKey ? cache?.[provider] : undefined;
        if (cacheKey && cached?.key === cacheKey && cached.runtime) {
          if (cachedBelowFloor(provider, name, cached.runtime))
            return {
              runtime: unusableRuntime(provider, cached.runtime.version, "version_unsupported"),
            };
          logger.info("Code Agent runtime probe served from cache", {
            event: "code_agent_runtime:cache_hit",
            provider,
            executable_name: name,
            outcome: "ok",
          });
          return { runtime: cached.runtime, executable, executableKey: cacheKey };
        }
        const probed = await probeRuntimeVersion(
          provider,
          name,
          executable,
          probe,
          environment,
          versionProbeTimeoutMs,
          timeoutMs,
        );
        if (probed.kind === "runtime") {
          if (hostCodex && (!cacheKey || cacheKey !== (await fileStatCacheKey([executable], true))))
            return { runtime: unusableRuntime(provider, "", "probe_failed") };
          return { runtime: probed.runtime, executable, cacheKey, executableKey: cacheKey };
        }
        if (probed.kind === "rejected")
          return {
            dropProvider: provider,
            unusable: unusableRuntime(provider, probed.version, "version_unsupported"),
          };
        return {
          runtime: unusableRuntime(
            provider,
            cached?.runtime?.version ?? "",
            probed.code,
            probed.diagnostic,
          ),
        };
      } catch (error) {
        cleanupFailed = error instanceof AgentProcessCleanupError;
        logFailure(error);
        const fallbackCacheKey = cache
          ? await fileStatCacheKey([executable], hostCodex)
          : undefined;
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
    }

    function logFailure(error: unknown): void {
      logger.warning("Code Agent runtime probe failed", {
        event: "code_agent_runtime:probe_failed",
        provider,
        executable_name: name,
        error_code: diagnosticErrorCode(error),
        outcome: "unavailable",
      });
    }

    const deadline = performance.now() + CODEX_PROBE_BUDGET_MULTIPLIER * codexProbeTimeoutMs;
    const first = await probeExecutable(primary, codexProbeTimeoutMs);
    if (!hostCodex) return first;

    let selected = first;
    if (!usableResult(first) && !cleanupFailed) {
      try {
        for await (const candidate of remainingCodexExecutables(
          primary,
          probe,
          searchPath,
          environment,
          platform,
        )) {
          const remainingMs = deadline - performance.now();
          if (remainingMs <= 0) break;
          const result = await probeExecutable(
            candidate,
            Math.min(remainingMs, codexProbeTimeoutMs),
          );
          if (usableResult(result)) {
            selected = result;
            break;
          }
          if (cleanupFailed) break;
        }
      } catch (error) {
        logFailure(error);
      }
    }
    rememberCodexExecutable(
      environment,
      usableResult(selected) && selected.executable && selected.executableKey
        ? { executable: selected.executable, key: selected.executableKey }
        : undefined,
    );
    return selected;
  }
  const dropped = new Set<ExternalCodeAgentProvider>();
  const probed: {
    provider: RuntimeMetadata["provider"];
    cacheKey: string;
    runtime: RuntimeMetadata;
  }[] = [];
  const observations: { provider: string; version: string; executablePath: string }[] = [];
  for (const result of results) {
    if (!result) continue;
    if ("dropProvider" in result) {
      dropped.add(result.dropProvider);
      runtimes.push({ runtime: result.unusable });
      continue;
    }
    runtimes.push({ runtime: result.runtime, executable: result.executable });
    if (result.executable && result.runtime.version && !result.runtime.unavailableCode) {
      observations.push({
        provider: result.runtime.provider,
        version: result.runtime.version,
        executablePath: result.executable,
      });
    }
    if (result.cacheKey)
      probed.push({
        provider: result.runtime.provider,
        cacheKey: result.cacheKey,
        runtime: result.runtime,
      });
  }
  if (cacheDirectory && (dropped.size > 0 || probed.length > 0)) {
    await updateInventoryCache(cacheDirectory, (current) => {
      for (const provider of dropped) delete current[provider];
      for (const entry of probed) {
        const previous = current[entry.provider];
        current[entry.provider] =
          previous?.key === entry.cacheKey
            ? { ...previous, key: entry.cacheKey, runtime: entry.runtime }
            : { key: entry.cacheKey, runtime: entry.runtime };
      }
    });
  }
  if (cacheDirectory && observations.length > 0) {
    const downgrades = await recordRuntimeCliObservations(cacheDirectory, observations);
    for (const downgrade of downgrades) {
      logger.warning("Code Agent CLI downgraded from previously observed version", {
        event: "code_agent_runtime:cli_downgraded",
        provider: downgrade.provider,
        previous_version: downgrade.previousVersion,
        current_version: downgrade.currentVersion,
        previous_path: downgrade.previousPath,
        current_path: downgrade.currentPath,
        outcome: "warning",
      });
    }
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
