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

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CODEX]);

export class CodexProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.CODEX;
  readonly compactionFailure = "does_not_stick";
  readonly reportsCompaction = true;
  readonly idleRecycleMinColdGapMs = CODEX_IDLE_RECYCLE_MIN_COLD_GAP_MS;
  readonly supportsSessionSummaryRecycle = true;
  readonly #command: readonly string[];
  readonly #host: CodexRuntimeHost;

  constructor(options: { host: CodexRuntimeHost; command?: readonly string[] }) {
    this.#host = options.host;
    this.#command = options.command ?? [RUNTIME_PROVIDER.CODEX, "app-server"];
  }

  async readUsage(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null> {
    return readCodexUsage(options.workingDirectory, {
      host: this.#host,
      command: this.#command,
      timeoutMs: options.timeoutMs,
    });
  }

  async consumeResetCredit(options: {
    workingDirectory: string;
    idempotencyKey: string;
  }): Promise<ResetCreditOutcome> {
    return consumeCodexResetCredit(options.workingDirectory, {
      host: this.#host,
      command: this.#command,
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
    const environment = this.#host.buildSessionEnvironment(options);
    const process = new JsonlProcess(
      this.#command,
      options.agentWorkspaceDirectory,
      environment,
      this.#host.processTreeSpawner,
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
      );
    } catch (error) {
      await process.dispose();
      throw error;
    } finally {
      stopReadingBaseline?.();
    }
  }
}
