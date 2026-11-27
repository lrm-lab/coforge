import { selectsCodexCompatible } from "@lrm/coforge-sdk/internal/codex-compatible-provider";
import { configureCodexCompatibleProvider } from "./codex-compatible-config.server";
import {
  agentEnvironmentNameViolation,
  RUNTIME_PROVIDER,
  type AgentStartIntent,
  type AgentStopIntent,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { AppError, isAppError } from "#src/lib/app-error";
import type { AgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { assertAgentLive, assertNotAppBot } from "./active-agent.server";
import { AgentConfigApply, type AgentRestartOutcome } from "./agent-config-apply.server";
import {
  decryptAgentEnvironment,
  encryptAgentEnvironment,
  validateAgentEnvironment,
} from "./agent-environment.server";
import {
  agentRuntimeConfig,
  assertProviderSelectable,
  readableRuntimeConfig,
  requiredRuntimeConfig,
  type AgentRuntimeConfig,
} from "./agent-runtime-config.server";
import type { AgentRuntimeCredentials } from "./agent-runtime-credentials.server";
import type { AgentRuntimeLock } from "./agent-runtime-lock.server";
import { agentStartIntent, agentStopIntent } from "./manage-agents.server";

type BatchPrincipal = { userId: string; workspaceId: string };

type BatchRuntimeControl = {
  start(intent: AgentStartIntent, userId: string): Promise<void>;
  stop(intent: AgentStopIntent, userId: string): Promise<void>;
};

type BatchRuntimeAvailability = {
  canRun(
    workspaceId: string,
    userId: string,
    computerId: string,
    config: {
      provider: RuntimeProvider;
      model: string;
      modelProvider: string;
      reasoning: string;
      fastMode?: boolean;
      hasApiKey: boolean;
    },
  ): Promise<boolean>;
  refusal?(
    workspaceId: string,
    userId: string,
    computerId: string,
    config: {
      provider: RuntimeProvider;
      model: string;
      modelProvider: string;
      reasoning: string;
      fastMode?: boolean;
      hasApiKey: boolean;
    },
  ): Promise<string | null>;
};

export type BatchRuntimeSelectionInput = {
  provider: RuntimeProvider;
  model?: string;
  modelProvider?: string;
  reasoning?: string;
  fastMode?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  apiKey?: string;
  baseUrl?: string;
};

export type BatchEnvironmentPatchInput = {
  set: Record<string, string>;
  remove: string[];
};

export type BatchUpdateAgentRuntimeConfigInput = {
  computerId: string;
  agentIds: string[];
  runtime?: BatchRuntimeSelectionInput;
  environmentPatch?: BatchEnvironmentPatchInput;
};

export type BatchUpdateAgentRuntimeConfigResult = {
  succeeded: Array<{ agentId: string; restart: AgentRestartOutcome }>;
  skipped: Array<{ agentId: string; reason: "unchanged" | "not-owner" }>;
  failed: Array<{ agentId: string; errorId?: string; reason?: string }>;
};

const MAX_BATCH_CONCURRENCY = 4;

export class BatchAgentRuntimeConfig {
  constructor(
    private readonly agents: Pick<AgentRepository, "getById" | "update">,
    private readonly runtimeControl: BatchRuntimeControl,
    private readonly availability: BatchRuntimeAvailability,
    private readonly runtimeLock: AgentRuntimeLock,
    private readonly credentials: () =>
      | Pick<AgentRuntimeCredentials, "encrypt">
      | Promise<Pick<AgentRuntimeCredentials, "encrypt">>,
    private readonly environmentKey: () =>
      | Uint8Array<ArrayBuffer>
      | Promise<Uint8Array<ArrayBuffer>>,
    private readonly configApply = new AgentConfigApply(),
  ) {}

  async listEnvironmentKeys(
    principal: BatchPrincipal,
    computerId: string,
    agentIds: readonly string[],
  ): Promise<Record<string, string[]>> {
    const uniqueIds = [...new Set(agentIds)];
    const encryptionKey = await this.environmentKey();
    const entries = await runWithConcurrency(uniqueIds, MAX_BATCH_CONCURRENCY, async (agentId) => {
      const current = await this.agents.getById(agentId);
      if (
        !current ||
        current.workspaceId !== principal.workspaceId ||
        current.ownerId !== principal.userId ||
        current.computerId !== computerId ||
        current.deletedAt ||
        current.systemKind === "app-bot" ||
        current.hosting === "external"
      )
        return undefined;
      const config = readableRuntimeConfig(current.runtimeConfig, current.id);
      if (!config?.environment) return [agentId, [] as string[]] as const;
      try {
        const decrypted = await decryptAgentEnvironment(agentId, config.environment, encryptionKey);
        return [agentId, Object.keys(decrypted).sort()] as const;
      } catch {
        return [agentId, [] as string[]] as const;
      }
    });
    const keysByAgent: Record<string, string[]> = {};
    for (const entry of entries) {
      if (entry) keysByAgent[entry[0]] = entry[1];
    }
    return keysByAgent;
  }

  async apply(
    principal: BatchPrincipal,
    input: BatchUpdateAgentRuntimeConfigInput,
  ): Promise<BatchUpdateAgentRuntimeConfigResult> {
    const envPatch = normalizeEnvironmentPatch(input.environmentPatch);
    if (!input.runtime && !envPatch) {
      throw new AppError("INVALID_INPUT", { errorId: "agent-batch-empty-change" });
    }
    if (input.runtime) assertProviderSelectable(input.runtime.provider);

    const uniqueIds = [...new Set(input.agentIds)];
    const availabilityCache = new Map<string, string | null>();
    const checkAvailability = async (selection: {
      provider: RuntimeProvider;
      model: string;
      modelProvider: string;
      reasoning: string;
      fastMode: boolean;
      hasApiKey: boolean;
    }) => {
      const cacheKey = JSON.stringify(selection);
      if (availabilityCache.has(cacheKey)) return availabilityCache.get(cacheKey)!;
      const refusal =
        (await this.availability.refusal?.(
          principal.workspaceId,
          principal.userId,
          input.computerId,
          selection,
        )) ??
        ((await this.availability.canRun(
          principal.workspaceId,
          principal.userId,
          input.computerId,
          selection,
        ))
          ? null
          : "unavailable");
      availabilityCache.set(cacheKey, refusal);
      return refusal;
    };

    const outcomes = await runWithConcurrency(uniqueIds, MAX_BATCH_CONCURRENCY, (agentId) =>
      this.#applyOne(
        principal,
        input.computerId,
        agentId,
        input.runtime,
        envPatch,
        checkAvailability,
      ),
    );

    const result: BatchUpdateAgentRuntimeConfigResult = {
      succeeded: [],
      skipped: [],
      failed: [],
    };
    for (const outcome of outcomes) {
      if (outcome.kind === "succeeded") {
        result.succeeded.push({ agentId: outcome.agentId, restart: outcome.restart });
      } else if (outcome.kind === "skipped") {
        result.skipped.push({ agentId: outcome.agentId, reason: outcome.reason });
      } else {
        result.failed.push({
          agentId: outcome.agentId,
          errorId: outcome.errorId,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        });
      }
    }
    return result;
  }

  async #applyOne(
    principal: BatchPrincipal,
    computerId: string,
    agentId: string,
    runtimeInput: BatchRuntimeSelectionInput | undefined,
    envPatch: NormalizedEnvPatch | undefined,
    checkAvailability: (selection: {
      provider: RuntimeProvider;
      model: string;
      modelProvider: string;
      reasoning: string;
      fastMode: boolean;
      hasApiKey: boolean;
    }) => Promise<string | null>,
  ): Promise<
    | { kind: "succeeded"; agentId: string; restart: AgentRestartOutcome }
    | { kind: "skipped"; agentId: string; reason: "unchanged" | "not-owner" }
    | { kind: "failed"; agentId: string; errorId?: string; reason?: string }
  > {
    try {
      return await this.runtimeLock.run(agentId, async () => {
        const current = await this.agents.getById(agentId);
        if (!current || current.workspaceId !== principal.workspaceId) {
          return { kind: "skipped", agentId, reason: "not-owner" };
        }
        if (current.ownerId !== principal.userId) {
          return { kind: "skipped", agentId, reason: "not-owner" };
        }
        assertAgentLive(current);
        assertNotAppBot(current);
        if (current.hosting === "external") {
          throw new AppError("INVALID_INPUT", { errorId: "agent-external-no-runtime" });
        }
        if (current.computerId !== computerId) {
          throw new AppError("INVALID_INPUT", { errorId: "agent-computer-locked" });
        }

        const currentConfig = runtimeInput
          ? readableRuntimeConfig(current.runtimeConfig, current.id)
          : requiredRuntimeConfig(current);

        let nextConfigWithoutEnv: AgentRuntimeConfig;
        let runtimeSelectionChanged = false;
        let providerChanged = false;

        if (runtimeInput) {
          const apiKeyInput = runtimeInput.apiKey?.trim();
          const selection = {
            provider: runtimeInput.provider,
            model: runtimeInput.model?.trim() ?? "",
            modelProvider: runtimeInput.modelProvider?.trim() ?? "",
            reasoning: runtimeInput.reasoning?.trim() ?? "",
            fastMode: runtimeInput.fastMode === true,
            ...(runtimeInput.contextWindow === undefined
              ? {}
              : { contextWindow: runtimeInput.contextWindow }),
            ...(runtimeInput.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: runtimeInput.maxOutputTokens }),
          };
          const compatible = selectsCodexCompatible(selection.provider, selection.modelProvider);
          const compatibleProvider = compatible
            ? await configureCodexCompatibleProvider(
                current.id,
                { ...runtimeInput, model: selection.model },
                currentConfig?.provider,
                async () => this.environmentKey(),
              )
            : undefined;
          const sameProvider =
            currentConfig?.provider.kind === "coforge" &&
            currentConfig.runtime === selection.provider &&
            currentConfig.provider.providerId === selection.modelProvider;
          const preservedApiKey =
            sameProvider && currentConfig?.provider.kind === "coforge"
              ? currentConfig.provider.apiKey
              : undefined;
          const encryptedApiKey =
            apiKeyInput && !compatible
              ? await this.#encryptApiKey(current.id, selection.modelProvider, apiKeyInput)
              : undefined;
          const apiKey = encryptedApiKey ?? preservedApiKey;
          if (selection.provider === RUNTIME_PROVIDER.COFORGE && !apiKey) {
            throw new AppError("INVALID_INPUT", { errorId: "agent-api-key-required" });
          }
          nextConfigWithoutEnv = agentRuntimeConfig(
            selection,
            compatibleProvider ??
              (selection.modelProvider &&
              (selection.provider === RUNTIME_PROVIDER.COFORGE || apiKey)
                ? {
                    kind: "coforge",
                    providerId: selection.modelProvider,
                    ...(apiKey ? { apiKey } : {}),
                  }
                : { kind: "default" }),
            currentConfig?.environment,
          );
          runtimeSelectionChanged =
            JSON.stringify(currentConfig) !== JSON.stringify(nextConfigWithoutEnv);
          providerChanged =
            currentConfig?.runtime !== nextConfigWithoutEnv.runtime ||
            ((currentConfig?.provider.kind === "codex-compatible" || compatible) &&
              JSON.stringify(currentConfig?.provider) !==
                JSON.stringify(nextConfigWithoutEnv.provider));
          if (runtimeSelectionChanged) {
            const refusal = await checkAvailability({
              provider: selection.provider,
              model: selection.model,
              modelProvider: selection.modelProvider,
              reasoning: selection.reasoning,
              fastMode: selection.fastMode,
              hasApiKey: Boolean(apiKey || compatibleProvider),
            });
            if (refusal) {
              throw new AppError("INVALID_INPUT", {
                errorId: "agent-runtime-unavailable",
                details: { reason: refusal },
              });
            }
          }
        } else {
          nextConfigWithoutEnv = currentConfig!;
        }

        let finalConfig: AgentRuntimeConfig = nextConfigWithoutEnv;
        let environmentChanged = false;
        if (envPatch) {
          const encryptionKey = await this.environmentKey();
          const currentEnv = currentConfig?.environment
            ? await decryptAgentEnvironment(current.id, currentConfig.environment, encryptionKey)
            : {};
          const merged: Record<string, string> = { ...currentEnv };
          for (const key of envPatch.remove) delete merged[key];
          for (const [key, value] of Object.entries(envPatch.set)) merged[key] = value;

          const validated = validateAgentEnvironment(merged, nextConfigWithoutEnv.runtime);
          if (!envMapsEqual(currentEnv, validated)) {
            environmentChanged = true;
            const { environment: _prev, ...withoutEnv } = nextConfigWithoutEnv;
            finalConfig = Object.keys(validated).length
              ? {
                  ...withoutEnv,
                  environment: await encryptAgentEnvironment(current.id, validated, encryptionKey),
                }
              : withoutEnv;
          }
        }

        if (!runtimeSelectionChanged && !environmentChanged) {
          return { kind: "skipped", agentId, reason: "unchanged" };
        }

        const data = {
          displayName: current.displayName,
          description: current.description ?? "",
          runtimeConfig: finalConfig,
        };
        const attempt = await this.configApply.tryPush(
          current,
          {
            changed: true,
            computerChanged: false,
            providerChanged,
          },
          (fence) => this.agents.update(current.id, data, fence),
        );
        if (attempt.plan === "push") {
          return { kind: "succeeded", agentId, restart: attempt.restart };
        }
        if (attempt.plan === "restart" && current.computerId) {
          await this.runtimeControl.stop(agentStopIntent(current), principal.userId);
        }
        const updated = await this.agents.update(current.id, data);
        if (attempt.plan === "deferred") {
          return { kind: "succeeded", agentId, restart: "deferred" };
        }
        try {
          await this.runtimeControl.start(agentStartIntent(updated, computerId), principal.userId);
          return { kind: "succeeded", agentId, restart: "published" };
        } catch {
          return { kind: "succeeded", agentId, restart: "deferred" };
        }
      });
    } catch (error) {
      if (isAppError(error)) {
        const reason =
          error.errorId === "agent-runtime-unavailable"
            ? (error.details as { reason?: string } | undefined)?.reason
            : undefined;
        return {
          kind: "failed",
          agentId,
          errorId: error.errorId ?? "agent-update-failed",
          ...(reason ? { reason } : {}),
        };
      }
      return { kind: "failed", agentId, errorId: "agent-update-failed" };
    }
  }

  async #encryptApiKey(agentId: string, providerId: string, apiKey: string) {
    if (!providerId) {
      throw new AppError("INVALID_INPUT", { errorId: "agent-model-provider-required" });
    }
    return (await this.credentials()).encrypt(agentId, providerId, apiKey);
  }
}

type NormalizedEnvPatch = {
  set: Record<string, string>;
  remove: string[];
};

function normalizeEnvironmentPatch(
  patch: BatchEnvironmentPatchInput | undefined,
): NormalizedEnvPatch | undefined {
  if (!patch) return undefined;
  const set: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(patch.set)) {
    const key = rawKey.trim();
    if (!key) continue;
    const violation = agentEnvironmentNameViolation(key);
    if (violation)
      throw new AppError("INVALID_INPUT", { errorId: `agent-environment-${violation}` });
    set[key] = value;
  }
  const removeSet = new Set<string>();
  for (const rawKey of patch.remove) {
    const key = rawKey.trim();
    if (!key) continue;
    const violation = agentEnvironmentNameViolation(key);
    if (violation)
      throw new AppError("INVALID_INPUT", { errorId: `agent-environment-${violation}` });
    if (Object.hasOwn(set, key)) {
      throw new AppError("INVALID_INPUT", { errorId: "agent-batch-env-conflict" });
    }
    removeSet.add(key);
  }
  const remove = [...removeSet];
  if (Object.keys(set).length === 0 && remove.length === 0) return undefined;
  return { set, remove };
}

function envMapsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}
