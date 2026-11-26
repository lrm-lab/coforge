import { getLogger } from "@logtape/logtape";
import { thrownMessage, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { isNonRetryableLaunchFailure } from "#src/agent-runtime/launch-failure";
import { agentStartupInput } from "#src/agent-runtime/agent-startup";
import { startupMemoryBlock } from "#src/agent-runtime/startup-memory-block";
import {
  composeWakeSections,
  decideWakeRecycle,
  describeRecycledSession,
  resolveWakeRecycleConfig,
  resolveWarmRecycleConfig,
} from "#src/agent-runtime/wake-session-recycle";
import type { CodeAgentProvider, SessionResumeFacts } from "@lrm/coforge-anvil";
import { runtimeDisplayName } from "./session-invalidate-activity";
import { resolveSessionResumeFacts, supportsSessionResume } from "./cold-idle-sweep";
import {
  queueHasInputContent,
  type AgentInput,
  type AgentInputQueue,
} from "./runtime-launch-intent";
const logger = getLogger(["coforge", "daemon", "runtime"]);
const RECYCLE_FAILURE_TTL_MS = 6 * 60 * 60 * 1000;
const BRIEFING_NOTE =
  "That is context carried over from your previous session, which was retired after sitting idle. Treat it as reference only and do not reply to it; your next input follows.";
export type WakeRecycleRequest = Readonly<{
  agentId: string;
  provider: RuntimeProvider;
  envVars?: Readonly<Record<string, string>>;
  configRevision: number | undefined;
  sessionId: string | undefined;
  sessionMode: "create" | "resume" | undefined;
  hasResumePrompt: boolean;
  agentWorkspaceDirectory: string;
}>;
export type RecycledWake = Readonly<{
  activityText: string;
  carriedMemoryBlock: boolean;
  recordFailure(error: unknown): void;
}>;
export type WakeRecyclePorts = Readonly<{
  provider(provider: RuntimeProvider): CodeAgentProvider;
  inputQueue(agentId: string): AgentInputQueue | undefined;
  hasQueuedDeliveries(agentId: string): boolean;
  readSummaryFacts?(agentId: string, sessionId: string): SessionResumeFacts | undefined;
}>;
type RecycleFailure = Readonly<{
  sessionId: string;
  provider: RuntimeProvider;
  configRevision: number | undefined;
  expiresAtMs: number;
}>;
export class WakeRecycle {
  readonly #failures = new Map<string, RecycleFailure>();
  readonly #ports: WakeRecyclePorts;
  constructor(ports: WakeRecyclePorts) {
    this.#ports = ports;
  }
  provider(provider: RuntimeProvider): CodeAgentProvider {
    return this.#ports.provider(provider);
  }
  readSummaryFacts(agentId: string, sessionId: string): SessionResumeFacts | undefined {
    return this.#ports.readSummaryFacts?.(agentId, sessionId);
  }
  forgetFailure(agentId: string): void {
    this.#failures.delete(agentId);
  }
  clearFailures(): void {
    this.#failures.clear();
  }
  async plan(request: WakeRecycleRequest): Promise<RecycledWake | undefined> {
    try {
      return await this.#plan(request);
    } catch (error) {
      logger.warn("Agent wake recycle failed; resuming the session", {
        event: "agent.runtime.wake_recycle_failed",
        agent_id: request.agentId,
        error: thrownMessage(error),
      });
      return undefined;
    }
  }
  async #plan(request: WakeRecycleRequest): Promise<RecycledWake | undefined> {
    const { agentId, sessionId } = request;
    if (!sessionId || request.sessionMode === "create") return undefined;
    const provider = this.#ports.provider(request.provider);
    const config = resolveWakeRecycleConfig(
      request.envVars,
      Bun.env,
      provider.idleRecycleMinColdGapMs,
    );
    const warmConfig = resolveWarmRecycleConfig(request.envVars, Bun.env);
    const supported = supportsSessionResume(provider);
    const canRecycle = config.enabled && supported && !request.hasResumePrompt;
    const failure = this.#failures.get(agentId);
    if (failure) {
      if (
        failure.sessionId !== sessionId ||
        failure.provider !== request.provider ||
        failure.configRevision !== request.configRevision ||
        failure.expiresAtMs <= Date.now()
      ) {
        this.#failures.delete(agentId);
      } else if (canRecycle) {
        logger.info("Agent wake resumed its session", {
          event: "agent.runtime.wake_recycle",
          outcome: "resume",
          reason: "recent_recycle_launch_failure",
          agent_id: agentId,
          session_id: sessionId,
        });
        return undefined;
      }
    }
    const facts = canRecycle
      ? await resolveSessionResumeFacts(provider, {
          agentId,
          sessionId,
          ...(request.envVars ? { envVars: request.envVars } : {}),
          readSummaryFacts: this.#ports.readSummaryFacts,
        })
      : undefined;
    const decision = decideWakeRecycle({
      config,
      warmConfig,
      supported,
      sessionId,
      hasResumePrompt: request.hasResumePrompt,
      facts,
      nowMs: Date.now(),
    });
    if (decision.action === "resume") {
      if (config.enabled && supported)
        logger.info("Agent wake resumed its session", {
          event: "agent.runtime.wake_recycle",
          outcome: "resume",
          reason: decision.reason,
          agent_id: agentId,
          session_id: sessionId,
          last_activity_at_ms: facts?.lastActivityAtMs,
          last_context_tokens: facts?.lastContextTokens,
          ...(facts?.cacheTier ? { cache_tier: facts.cacheTier } : {}),
        });
      return undefined;
    }
    const [memoryBlock, providerBriefing] = await Promise.all([
      startupMemoryBlock(request.agentWorkspaceDirectory),
      provider
        .readRecycleBriefing?.({
          sessionId,
          workingDirectory: request.agentWorkspaceDirectory,
          budgetTokens: config.panelTokens,
          ...(request.envVars ? { envVars: request.envVars } : {}),
        })
        .catch((error: unknown) => {
          logger.warn("Agent wake briefing could not be built; starting fresh without it", {
            event: "agent.runtime.wake_briefing_failed",
            agent_id: agentId,
            error: thrownMessage(error),
          });
          return undefined;
        }),
    ]);
    startFreshSession(
      this.#ports.inputQueue(agentId),
      composeWakeSections(memoryBlock?.text, providerBriefing),
      {
        memoryInContext: memoryBlock !== undefined,
        deliveriesQueued: this.#ports.hasQueuedDeliveries(agentId),
      },
    );
    logger.info("Agent wake retired its session and started a fresh one", {
      event: "agent.runtime.wake_recycle",
      outcome: "recycle",
      agent_id: agentId,
      prior_session_id: sessionId,
      idle_ms: decision.idleMs,
      prior_context_tokens: decision.priorContextTokens,
      ...(facts?.cacheTier ? { cache_tier: facts.cacheTier } : {}),
      has_memory_block: memoryBlock !== undefined,
      has_provider_briefing: providerBriefing !== undefined && providerBriefing.length > 0,
    });
    return {
      carriedMemoryBlock: memoryBlock !== undefined,
      activityText: `Starting a fresh ${runtimeDisplayName(request.provider)} session (${describeRecycledSession(decision.idleMs, decision.priorContextTokens)}) with a briefing`,
      recordFailure: (error) => {
        if (isNonRetryableLaunchFailure(error)) return;
        this.#failures.set(agentId, {
          sessionId,
          provider: request.provider,
          configRevision: request.configRevision,
          expiresAtMs: Date.now() + RECYCLE_FAILURE_TTL_MS,
        });
      },
    };
  }
}
function startFreshSession(
  queue: AgentInputQueue | undefined,
  briefing: string,
  context: Readonly<{
    memoryInContext: boolean;
    deliveriesQueued: boolean;
  }>,
): void {
  if (!queue || queue.closed) return;
  const starter = queue.items.find(
    (
      item,
    ): item is Extract<
      AgentInput,
      {
        kind: "startup";
      }
    > => item.kind === "startup",
  );
  if (starter) starter.text = agentStartupInput(false, context.memoryInContext, starter.openTasks);
  if (!briefing) return;
  const alone = !context.deliveriesQueued && !queueHasInputContent(queue.items);
  const turn = Promise.withResolvers<void>();
  turn.promise.catch(() => {});
  queue.items.unshift({
    kind: "prompt",
    text: composeWakeSections(briefing, starter && alone ? starter.text : BRIEFING_NOTE),
    ...((starter && alone ? starter.allowsEmptyCompletion : true)
      ? { allowsEmptyCompletion: true as const }
      : {}),
    completion: { resolve: turn.resolve, reject: turn.reject },
  });
}
