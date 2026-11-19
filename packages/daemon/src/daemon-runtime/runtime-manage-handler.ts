import { getLogger } from "@logtape/logtape";
import {
  diagnosticErrorCode,
  type RuntimeManageRequest,
  type RuntimeManageResult,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import {
  externalCodeAgent,
  resolveExternalCodeAgentExecutable,
  type ExternalCodeAgentProvider,
} from "#src/code-agent/runtime-executable";
import { updateInventoryCache } from "#src/code-agent/runtime-inventory-cache";
import { discoverExternalCodeAgents, hostCodeAgentProbe } from "#src/code-agent/runtime-probe";
import { codeAgentExecutableSearchPath } from "#src/platform/code-agent-path";
import {
  isManagedRuntimeProvider,
  resolveRuntimeInstallPlan,
  resolveRuntimeUpgradePlan,
  runRuntimeManageSteps,
  sanitizeRuntimeManageDiagnostic,
  type RuntimePackagePlanDeps,
  type RuntimePackageStep,
  type RuntimePackageStepRunResult,
} from "#src/code-agent/runtime-package-plans";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";

const logger = getLogger(["coforge", "daemon", "runtime-manage"]);
const MAX_UINT32 = 4_294_967_295;

export type InspectedRuntime =
  | { installed: false }
  | {
      installed: true;
      executablePath: string;
      version?: string;
      unavailableCode?: string;
    };

export type RuntimeManageRunnerDeps = RuntimePackagePlanDeps & {
  now?: () => number;
  environment?: () => Readonly<Record<string, string | undefined>>;
  cacheDirectory?: string;
  inspectRuntime?: (provider: string) => Promise<InspectedRuntime>;
  runSteps?: (
    steps: readonly RuntimePackageStep[],
    options: { timeoutMs: number; signal: AbortSignal },
  ) => Promise<RuntimePackageStepRunResult>;
  rescan?: (provider: RuntimeProvider) => Promise<void>;
};

async function defaultInspectRuntime(
  provider: string,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  cacheDirectory?: string,
): Promise<InspectedRuntime> {
  const agent = externalCodeAgent[provider as ExternalCodeAgentProvider];
  if (!agent) return { installed: false };
  const searchPath = codeAgentExecutableSearchPath(environment, platform);
  const executablePath = await resolveExternalCodeAgentExecutable(
    agent,
    hostCodeAgentProbe,
    searchPath,
    environment,
    platform,
  );
  if (!executablePath) return { installed: false };
  const discovered = await discoverExternalCodeAgents(
    hostCodeAgentProbe,
    environment,
    platform,
    agent.provider,
    cacheDirectory,
  );
  const match = discovered.find((entry) => entry.provider === agent.provider);
  return {
    installed: true,
    executablePath,
    ...(match?.version ? { version: match.version } : {}),
    ...(match?.unavailableCode ? { unavailableCode: match.unavailableCode } : {}),
  };
}

type RuntimeManageOutcome = Omit<
  RuntimeManageResult,
  | "protocolMajor"
  | "requestId"
  | "workspaceId"
  | "computerId"
  | "provider"
  | "action"
  | "requestedByUserId"
  | "durationMs"
>;

export class RuntimeManageRunner {
  readonly #deps: RuntimeManageRunnerDeps;
  readonly #inFlight = new Set<string>();
  readonly #controllers = new Set<AbortController>();

  constructor(deps: RuntimeManageRunnerDeps = {}) {
    this.#deps = deps;
  }

  stopAll(): void {
    for (const controller of this.#controllers) {
      controller.abort();
    }
    this.#controllers.clear();
  }

  async execute(request: RuntimeManageRequest): Promise<RuntimeManageResult> {
    const now = this.#deps.now ?? Date.now;
    const startedAt = now();
    const base = {
      protocolMajor: request.protocolMajor,
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      computerId: request.computerId,
      provider: request.provider,
      action: request.action,
      requestedByUserId: request.requestedByUserId,
    };
    const finish = (rest: RuntimeManageOutcome): RuntimeManageResult => ({
      ...base,
      ...rest,
      durationMs: Math.min(MAX_UINT32, Math.max(0, Math.round(now() - startedAt))),
    });

    if (request.action === "plan") {
      try {
        return finish(await this.#plan(request.provider));
      } catch {
        return finish({ status: "error", reason: "internal" });
      }
    }

    if (this.#inFlight.has(request.provider)) {
      return finish({ status: "error", reason: "in_progress" });
    }
    this.#inFlight.add(request.provider);
    const controller = new AbortController();
    this.#controllers.add(controller);
    try {
      const outcome =
        request.action === "install"
          ? await this.#install(request.provider, request.timeoutMs, controller.signal)
          : await this.#upgrade(request.provider, request.timeoutMs, controller.signal);
      if (
        outcome.status === "installed" ||
        outcome.status === "upgraded" ||
        outcome.status === "unchanged"
      ) {
        await this.#deps.rescan?.(request.provider as RuntimeProvider).catch((error: unknown) => {
          logger.warning("Runtime rescan after manage action failed", {
            event: "runtime_manage:rescan_failed",
            provider: request.provider,
            error_code: diagnosticErrorCode(error),
            outcome: "failed",
          });
        });
      }
      return finish(outcome);
    } catch {
      return finish({ status: "error", reason: "internal" });
    } finally {
      this.#controllers.delete(controller);
      this.#inFlight.delete(request.provider);
    }
  }

  async #inspect(provider: string): Promise<InspectedRuntime> {
    if (this.#deps.inspectRuntime) return this.#deps.inspectRuntime(provider);
    const environment = this.#deps.environment ? this.#deps.environment() : Bun.env;
    const platform = this.#deps.platform ?? process.platform;
    return defaultInspectRuntime(provider, environment, platform, this.#deps.cacheDirectory);
  }

  async #invalidateCache(provider: string): Promise<void> {
    if (!this.#deps.cacheDirectory) return;
    await updateInventoryCache(this.#deps.cacheDirectory, (current) => {
      delete current[provider];
    });
  }

  async #plan(provider: string): Promise<RuntimeManageOutcome> {
    if (!isManagedRuntimeProvider(provider)) {
      return { status: "unsupported", reason: "unsupported_provider" };
    }
    const inspected = await this.#inspect(provider);
    if (inspected.installed && !inspected.unavailableCode) {
      return {
        status: "already_installed",
        ...(inspected.version ? { currentVersion: inspected.version } : {}),
      };
    }
    const plan = await resolveRuntimeInstallPlan(provider, this.#deps);
    if (plan.kind === "unsupported") {
      return { status: "unsupported", reason: plan.reason };
    }
    return {
      status: "planned",
      source: plan.source,
      steps: plan.steps.map((step) => step.display),
    };
  }

  async #install(
    provider: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<RuntimeManageOutcome> {
    if (!isManagedRuntimeProvider(provider)) {
      return { status: "unsupported", reason: "unsupported_provider" };
    }
    const before = await this.#inspect(provider);
    if (before.installed) {
      if (!before.unavailableCode) {
        return {
          status: "already_installed",
          ...(before.version ? { currentVersion: before.version } : {}),
        };
      }
      return { status: "unsupported", reason: "unsupported_installation" };
    }
    const plan = await resolveRuntimeInstallPlan(provider, this.#deps);
    if (plan.kind === "unsupported") {
      return { status: "unsupported", reason: plan.reason };
    }
    const runResult = await this.#runSteps(plan.steps, timeoutMs, signal);
    await this.#invalidateCache(provider);
    if (!runResult.ok) return failureFromRun(runResult, plan.source);
    const after = await this.#inspect(provider);
    if (!after.installed || after.unavailableCode) {
      return {
        status: "failed",
        reason: "command_failed",
        source: plan.source,
        diagnostic: "Installed executable could not be verified on PATH",
      };
    }
    return {
      status: "installed",
      source: plan.source,
      ...(after.version ? { currentVersion: after.version } : {}),
    };
  }

  async #upgrade(
    provider: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<RuntimeManageOutcome> {
    if (!isManagedRuntimeProvider(provider)) {
      return { status: "unsupported", reason: "unsupported_provider" };
    }
    const before = await this.#inspect(provider);
    if (!before.installed) {
      return { status: "not_installed" };
    }
    if (before.unavailableCode && before.unavailableCode !== "version_unsupported") {
      return { status: "unsupported", reason: "unsupported_installation" };
    }
    const plan = await resolveRuntimeUpgradePlan(provider, before.executablePath, this.#deps);
    if (plan.kind === "unsupported") {
      return { status: "unsupported", reason: plan.reason };
    }
    const runResult = await this.#runSteps(plan.steps, timeoutMs, signal);
    await this.#invalidateCache(provider);
    if (!runResult.ok) return failureFromRun(runResult, plan.source, before.version);
    const after = await this.#inspect(provider);
    if (!after.installed || after.unavailableCode) {
      return {
        status: "failed",
        reason: "command_failed",
        source: plan.source,
        ...(before.version ? { previousVersion: before.version } : {}),
        diagnostic: "Upgraded executable could not be verified on PATH",
      };
    }
    const currentVersion = after.version;
    const upgraded =
      currentVersion !== undefined &&
      (before.version === undefined || currentVersion !== before.version);
    return {
      status: upgraded ? "upgraded" : "unchanged",
      source: plan.source,
      ...(before.version ? { previousVersion: before.version } : {}),
      ...(currentVersion ? { currentVersion } : {}),
    };
  }

  #runSteps(
    steps: readonly RuntimePackageStep[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<RuntimePackageStepRunResult> {
    if (this.#deps.runSteps) return this.#deps.runSteps(steps, { timeoutMs, signal });
    const environment = this.#deps.environment ? this.#deps.environment() : Bun.env;
    return runRuntimeManageSteps(steps, {
      timeoutMs,
      signal,
      environment,
      platform: this.#deps.platform,
    });
  }
}

function failureFromRun(
  runResult: Extract<RuntimePackageStepRunResult, { ok: false }>,
  source: RuntimeManageResult["source"],
  previousVersion?: string,
): RuntimeManageOutcome {
  const diagnostic = sanitizeRuntimeManageDiagnostic(runResult.diagnostic);
  if (runResult.cancelled) {
    return {
      status: "error",
      reason: "cancelled",
      source,
      ...(previousVersion ? { previousVersion } : {}),
    };
  }
  if (runResult.timedOut) {
    return {
      status: "error",
      reason: "timeout",
      source,
      ...(previousVersion ? { previousVersion } : {}),
    };
  }
  return {
    status: "failed",
    reason: "command_failed",
    source,
    ...(previousVersion ? { previousVersion } : {}),
    ...(runResult.exitCode !== undefined ? { exitCode: runResult.exitCode } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

export function subscribeRuntimeManageQueries(
  transport: Pick<DaemonConnectionClient, "onRuntimeManage" | "sendRuntimeManageResult">,
  ports: {
    connection: { workspaceId: string; computerId: string };
    runner: RuntimeManageRunner;
    currentTransport(): Pick<DaemonConnectionClient, "sendRuntimeManageResult">;
    isStopping(): boolean;
  },
): (() => void) | undefined {
  return transport.onRuntimeManage?.(async (request) => {
    if (
      ports.isStopping() ||
      request.workspaceId !== ports.connection.workspaceId ||
      request.computerId !== ports.connection.computerId
    ) {
      return;
    }
    const result = await ports.runner.execute(request);
    logger.info("Code Agent runtime manage request completed", {
      event: "runtime_manage:completed",
      workspace_id: request.workspaceId,
      computer_id: request.computerId,
      request_id: request.requestId,
      provider: request.provider,
      action: request.action,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      duration_ms: result.durationMs,
      outcome:
        result.status === "planned" ||
        result.status === "installed" ||
        result.status === "already_installed" ||
        result.status === "upgraded" ||
        result.status === "unchanged"
          ? "ok"
          : "failed",
    });
    if (ports.isStopping()) return;
    const live = ports.currentTransport();
    if (!live.sendRuntimeManageResult) return;
    try {
      await live.sendRuntimeManageResult(result);
    } catch (error) {
      logger.warning("Failed to report runtime manage result", {
        event: "runtime_manage:result_send_failed",
        workspace_id: request.workspaceId,
        computer_id: request.computerId,
        request_id: request.requestId,
        provider: request.provider,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
    }
  });
}
