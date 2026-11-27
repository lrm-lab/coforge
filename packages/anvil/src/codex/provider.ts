import {
  CODEX_COMPATIBLE_MODEL_PROVIDER,
  codexCompatibleEnvironment,
} from "@lrm/coforge-sdk/internal/codex-compatible-provider";
import type { AgentSession, AgentSessionOptions, UsageSnapshot } from "@coforge/agent";
import { asRecord, type CodeAgentProvider } from "@lrm/coforge-anvil";
import { JsonlProcess } from "@lrm/coforge-anvil/execution";
import { CodexAgentSession } from "./session";
import { CodexTokenUsageTracker } from "./context-usage";
import { rejectServerRequests } from "./server-requests";
import { codexAccountModel } from "./account-model";
import { codexVersion } from "./app-server-session";
import { openCodexThread } from "./thread-open";
import { codexReasoningSummary } from "./reasoning-summary";
import { readCodexRecycleBriefing } from "./recycle-briefing";
import { CODEX_IDLE_RECYCLE_MIN_COLD_GAP_MS, readCodexSessionResumeFacts } from "./session-rollout";
import { readCodexLiveUsage, readCodexUsage } from "./usage";
import { consumeCodexResetCredit } from "./reset-credit";
import type { CodexRuntimeHost } from "./host";
import { RUNTIME_PROVIDER, utf8Encoder, type ResetCreditOutcome } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { assertSkillsLoaded, codexServiceTierState } from "./provider-support";

const COMPATIBLE_API_KEY_ENV = "COFORGE_CODEX_COMPATIBLE_API_KEY";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CODEX]);

export class CodexProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.CODEX;
  readonly compactionFailure = "does_not_stick";
  readonly reportsCompaction = true;
  readonly idleRecycleMinColdGapMs = CODEX_IDLE_RECYCLE_MIN_COLD_GAP_MS;
  readonly supportsSessionSummaryRecycle = true;
  readonly #command: () => readonly string[] | Promise<readonly string[]>;
  readonly #host: CodexRuntimeHost;

  constructor(options: {
    host: CodexRuntimeHost;
    command?: readonly string[] | (() => Promise<readonly string[]>);
  }) {
    this.#host = options.host;
    const command = options.command ?? [RUNTIME_PROVIDER.CODEX, "app-server"];
    this.#command = typeof command === "function" ? command : () => command;
  }

  async readUsage(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null> {
    let command: readonly string[];
    try {
      command = await this.#command();
    } catch {
      return null;
    }
    return readCodexUsage(options.workingDirectory, {
      host: this.#host,
      command,
      timeoutMs: options.timeoutMs,
    });
  }

  async consumeResetCredit(options: {
    workingDirectory: string;
    idempotencyKey: string;
  }): Promise<ResetCreditOutcome> {
    let command: readonly string[];
    try {
      command = await this.#command();
    } catch {
      return "unknown";
    }
    return consumeCodexResetCredit(options.workingDirectory, {
      host: this.#host,
      command,
      idempotencyKey: options.idempotencyKey,
    });
  }

  readonly readSessionResumeFacts = (options: Parameters<typeof readCodexSessionResumeFacts>[0]) =>
    readCodexSessionResumeFacts(options, this.#host);
  readonly readRecycleBriefing = (options: Parameters<typeof readCodexRecycleBriefing>[0]) =>
    readCodexRecycleBriefing(options, this.#host);

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    let command = await this.#command();
    options.startupSignal?.throwIfAborted();
    const environment = this.#host.buildSessionEnvironment(options);
    const compatible = options.runtime?.modelProvider === CODEX_COMPATIBLE_MODEL_PROVIDER;
    if (compatible) command = configureCompatibleProvider(command, options, environment);
    const compatibleKey = compatible ? environment[COMPATIBLE_API_KEY_ENV] : undefined;
    const redact = compatibleKey
      ? (line: string) => line.replaceAll(compatibleKey, "[redacted]")
      : undefined;
    const process = new JsonlProcess(
      command,
      options.agentWorkspaceDirectory,
      environment,
      this.#host.processTreeSpawner,
      undefined,
      undefined,
      undefined,
      redact,
    );
    rejectServerRequests(process, options.agentId, options.runtimeId);
    let stopReadingBaseline: (() => void) | undefined;
    try {
      const initialized = await process.request({
        method: "initialize",
        params: {
          clientInfo: this.#host.clientInfo,
          capabilities: { experimentalApi: false },
        },
      });
      await process.send({ method: "initialized", params: {} });
      const skillsResponse = await process.request({
        method: "skills/list",
        params: { cwds: [options.agentWorkspaceDirectory], forceReload: true },
      });
      assertSkillsLoaded(skillsResponse, options.agentWorkspaceDirectory);
      const reasoningSummary = await codexReasoningSummary(environment, this.#host);
      const resumedUsage = options.sessionId ? new CodexTokenUsageTracker() : undefined;
      if (resumedUsage) {
        stopReadingBaseline = process.onRecord((record) => {
          if (record.method !== "thread/tokenUsage/updated") return;
          const params = asRecord(record.params);
          if (params?.threadId === options.sessionId) resumedUsage.seedBaseline(params);
        });
      }
      const { threadId, result, replacedSessionId, replacementWarning } = await openCodexThread(
        process,
        options,
        environment,
        reasoningSummary,
        codexVersion(asRecord(initialized.result)?.userAgent),
      );
      if (compatible && result?.modelProvider !== CODEX_COMPATIBLE_MODEL_PROVIDER)
        throw new Error("Codex did not select the compatible provider");
      const model = await codexAccountModel(process, result, options.runtime?.model, {
        agent_id: options.agentId,
        runtime_id: options.runtimeId,
      });
      await options.onSessionId?.(threadId, replacedSessionId);
      logger.info("Codex thread received standing instructions", {
        event: "codex.instructions.injected",
        agent_id: options.agentId,
        runtime_id: options.runtimeId,
        instruction_bytes: utf8Encoder.encode(options.instructions).byteLength,
        outcome: "ok",
      });
      return new CodexAgentSession(
        process,
        threadId,
        options.sessionId !== undefined && replacedSessionId === undefined,
        options.agentId,
        options.runtimeId,
        // Only a launch that asked for the Fast tier has anything to report about it.
        options.runtime?.fastMode ? codexServiceTierState(result?.serviceTier) : undefined,
        replacementWarning,
        model,
        (timeoutMs) =>
          readCodexLiveUsage(process, (label) => this.#host.maskAccountLabel(label), timeoutMs),
        replacedSessionId === undefined ? resumedUsage : undefined,
        redact,
      );
    } catch (error) {
      await process.dispose();
      throw error;
    } finally {
      stopReadingBaseline?.();
    }
  }
}

function configureCompatibleProvider(
  command: readonly string[],
  options: AgentSessionOptions,
  environment: Record<string, string>,
): readonly string[] {
  const pair = codexCompatibleEnvironment(options.runtime?.codexCompatibleEnvironment);
  if (!pair) throw new Error("Codex compatible provider requires an API key and a valid base URL");

  for (const name of Object.keys(environment)) {
    const upper = name.toUpperCase();
    if (
      upper === "OPENAI_BASE_URL" ||
      upper === "OPENAI_API_KEY" ||
      upper === COMPATIBLE_API_KEY_ENV
    )
      delete environment[name];
  }
  environment[COMPATIBLE_API_KEY_ENV] = pair.OPENAI_API_KEY;
  const provider = `model_providers.${CODEX_COMPATIBLE_MODEL_PROVIDER}`;
  return [
    ...command,
    "-c",
    `model_provider=${JSON.stringify(CODEX_COMPATIBLE_MODEL_PROVIDER)}`,
    "-c",
    `${provider}.name="OpenAI-compatible"`,
    "-c",
    `${provider}.base_url=${JSON.stringify(pair.OPENAI_BASE_URL)}`,
    "-c",
    `${provider}.env_key=${JSON.stringify(COMPATIBLE_API_KEY_ENV)}`,
    "-c",
    `${provider}.requires_openai_auth=false`,
    "-c",
    `${provider}.wire_api="responses"`,
  ];
}
