import { getLogger } from "@logtape/logtape";
import { thrownMessage, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { agentStartupInput } from "#src/agent-runtime/agent-startup";
import { buildStartupMemoryBlock } from "#src/agent-runtime/startup-memory-block";
import {
  composeWakeSections,
  decideWakeRecycle,
  describeRecycledSession,
  resolveWakeRecycleConfig,
} from "#src/agent-runtime/wake-session-recycle";
import type { CodeAgentProvider } from "@lrm/coforge-anvil";
import { runtimeDisplayName } from "./session-invalidate-activity";
import { supportsSessionResume } from "./cold-idle-sweep";
import {
  queueHasInputContent,
  type AgentInput,
  type AgentInputQueue,
} from "./runtime-launch-intent";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** Closes a standalone briefing turn, which has no starter text of its own to say what to do. */
const BRIEFING_NOTE =
  "That is context carried over from your previous session, which was retired after sitting idle. Treat it as reference only and do not reply to it; your next input follows.";

export type WakeRecycleRequest = Readonly<{
  agentId: string;
  provider: RuntimeProvider;
  /** The Agent's own runtime variables, which override the daemon's environment. */
  envVars?: Readonly<Record<string, string>>;
  /** The session this launch would resume. */
  sessionId: string | undefined;
  sessionMode: "create" | "resume" | undefined;
  hasResumePrompt: boolean;
  /** A Memory Agent's conversation sessions are not the primary session's to retire. */
  memoryAgent: boolean;
  agentWorkspaceDirectory: string;
}>;

/** A launch that starts a fresh session in place of resuming the one it was asked to. */
export type RecycledWake = Readonly<{ activityText: string }>;

export type WakeRecyclePorts = Readonly<{
  provider(provider: RuntimeProvider): CodeAgentProvider;
  inputQueue(agentId: string): AgentInputQueue | undefined;
  /** Deliveries kept for this Agent's next launch, which the launch presents after its first input. */
  hasQueuedDeliveries(agentId: string): boolean;
}>;

/**
 * At a launch that would resume a prior session, decides between resuming it and a fresh session
 * whose first input is a briefing (MEMORY.md plus what the provider can carry over). When it
 * decides to recycle it also puts the briefing at the front of the Agent's launch input.
 */
export class WakeRecycle {
  readonly #ports: WakeRecyclePorts;

  constructor(ports: WakeRecyclePorts) {
    this.#ports = ports;
  }

  /** `undefined` means resume as usual. Never rejects: whatever cannot be read resumes. */
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
    // A `create` launch pins a session id it is given; there is nothing to resume.
    if (!sessionId || request.sessionMode === "create" || request.memoryAgent) return undefined;
    const config = resolveWakeRecycleConfig(request.envVars);
    const provider = this.#ports.provider(request.provider);
    const supported = supportsSessionResume(provider);
    const facts =
      config.enabled && supported && !request.hasResumePrompt
        ? await provider.readSessionResumeFacts?.({
            sessionId,
            ...(request.envVars ? { envVars: request.envVars } : {}),
          })
        : undefined;
    const decision = decideWakeRecycle({
      config,
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
        });
      return undefined;
    }
    const [memoryBlock, providerBriefing] = await Promise.all([
      buildStartupMemoryBlock({
        agentWorkspaceDirectory: request.agentWorkspaceDirectory,
        budgetTokens: config.memoryTokens,
      }),
      // A briefing that cannot be built leaves a bare fresh session, never a failed wake.
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
        memoryComplete: memoryBlock?.complete === true,
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
      has_memory_block: memoryBlock !== undefined,
      has_provider_briefing: providerBriefing !== undefined && providerBriefing.length > 0,
    });
    return {
      activityText: `Starting a fresh ${runtimeDisplayName(request.provider)} session (${describeRecycledSession(decision.idleMs, decision.priorContextTokens)}) with a briefing`,
    };
  }
}

/**
 * Makes the launch's first input the briefing: a turn of its own ahead of everything else, as an
 * introduction is. A starter the launch queued stays where it is, rewritten for a fresh session;
 * when nothing else has content, the briefing's turn ends with that starter's instructions, since
 * the drain skips the starter once a turn is live.
 */
function startFreshSession(
  queue: AgentInputQueue | undefined,
  briefing: string,
  context: Readonly<{ memoryComplete: boolean; deliveriesQueued: boolean }>,
): void {
  if (!queue || queue.closed) return;
  const starter = queue.items.find(
    (item): item is Extract<AgentInput, { kind: "startup" }> => item.kind === "startup",
  );
  if (starter)
    starter.text = agentStartupInput(false, context.memoryComplete && briefing.length > 0);
  if (!briefing) return;
  // The drain's own rule: the starter runs only when no other input has anything to say.
  const alone = !context.deliveriesQueued && !queueHasInputContent(queue.items);
  const turn = Promise.withResolvers<void>();
  // A queue that closes rejects its items; nobody waits on this turn.
  turn.promise.catch(() => {});
  queue.items.unshift({
    kind: "prompt",
    text: composeWakeSections(briefing, starter && alone ? starter.text : BRIEFING_NOTE),
    completion: { resolve: turn.resolve, reject: turn.reject },
  });
}
