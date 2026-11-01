import { getLogger } from "@logtape/logtape";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { diagnosticErrorName } from "@lrm/coforge-sdk/internal";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { ActivityLaunch } from "./activity-launch";
import type { AgentDeliveryQueue } from "./agent-delivery-queue";
import type { AgentInputDrain } from "./agent-input-drain";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { stalledTurnObservation } from "./stalled-turn-indicator";
import { recoveryHasContent, type AgentRecoveryContext } from "./runtime-launch-intent";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** The custody helpers' reach into the runtime: the collaborators it reconciles, plus the two
 * held-state releases `recover` runs regardless of recovery content. */
export type AgentLaunchCustodyPorts = Readonly<{
  messageAttention: AgentMessageAttentionIndex;
  deliveryQueue: AgentDeliveryQueue;
  inputDrain: AgentInputDrain;
  agentProcessManager: AgentProcessManager;
  currentActivityLaunches: ReadonlyMap<string, ActivityLaunch>;
  introducedAgents: Set<string>;
  releaseHeldAppItems(agentId: string): void;
  releaseFallbackNotices(agentId: string): void;
}>;

/**
 * What the daemon owes a launch at its boundary: delivery admission and custody acknowledgment,
 * the recovery-notice pass that reconciles held state, and the turn-open bookkeeping a prompt or
 * startup input performs. Launch teardown is not here — it belongs to the lifecycle paths.
 */
export class AgentLaunchCustody {
  constructor(private readonly ports: AgentLaunchCustodyPorts) {}

  /**
   * The daemon has taken this delivery into its own keeping (for a later launch, a batch, or to
   * drop it), so it acknowledges it now, as the server needs no further copy. A failed ACK only
   * means the server replays it on the next `ready`; nothing is lost, since a daemon restart
   * recovers unread messages from the cloud read boundary, not from ACK state.
   */
  acknowledge(message: AgentMessageDelivery): void {
    this.ports.messageAttention.acknowledgeCustody(message);
  }

  /** Queues a delivery as the Agent's next input; settles once the input drain handled it. */
  enqueueDelivery(agentId: string, message: AgentMessageDelivery): Promise<void> {
    return this.ports.inputDrain.enqueue(agentId, (completion) => ({
      kind: "delivery",
      message,
      completion,
    }));
  }

  async recover(agentId: string, context: AgentRecoveryContext): Promise<void> {
    const messages = [
      ...(context.wakeMessage ? [context.wakeMessage] : []),
      ...(context.resumeMessages ?? []),
    ];
    const hasRecoveryContent = recoveryHasContent(context);
    try {
      if (hasRecoveryContent)
        await this.ports.messageAttention.recover(
          agentId,
          messages,
          context.unreadSummary ?? {},
          context.unreadConversationIds ?? {},
        );
    } catch (error) {
      logger.warn("Agent recovery notice was not accepted; canonical unread state remains", {
        event: "agent.recovery_notice.rejected",
        agent_id: agentId,
        error_code: diagnosticErrorName(error),
      });
      throw error;
    }
    // Reconcile whatever AgentDeliveryQueue held across an unexpected exit now that
    // this launch's recovery pass has run. `recover()` above already told the Agent about the
    // same canonical unread state (the server's own unread ledger, not this in-memory queue, is
    // what a crashed-and-relaunched Agent's `resumeMessages`/`unreadSummary` are built from) —
    // drop the surviving held deliveries (acknowledged when they were held) instead of a second,
    // redundant notice for them.
    // When there was no recovery content, nothing else has told the Agent, so flush them now,
    // treating the freshly launched session as idle.
    if (hasRecoveryContent) this.#dropSurvivingDeliveryQueue(agentId);
    else this.flushSurvivingDeliveryQueue(agentId);
    // App items (reminders, etc.) are a separate subsystem from canonical Message unread state
    // (`agent-app-inbox/`); `recover()` above never mentions them, so a held one is always
    // released here regardless of `hasRecoveryContent`, never dropped. A surviving fallback
    // notice (Kiro's `notice-undelivered`) is treated the same way for the same reason: this
    // in-memory queue does not know whether the text it held came from a Message delivery
    // `recover()` already covers or an App Inbox notice it never mentions, so always releasing
    // it is the only choice that never silently drops one.
    this.ports.releaseHeldAppItems(agentId);
    this.ports.releaseFallbackNotices(agentId);
  }

  /** Drops whatever `AgentDeliveryQueue` held for `agentId` across an unexpected exit — used when
   * this launch's `recover()` pass already covered the same unread state, so notifying about them
   * again would be redundant. Each was acknowledged when the daemon took it. */
  #dropSurvivingDeliveryQueue(agentId: string): void {
    this.ports.deliveryQueue.discardPending(agentId);
  }

  /** Flushes whatever `AgentDeliveryQueue` held for `agentId` across an unexpected
   * exit, treating the (fresh or just-recovered) session as idle — used when nothing else has
   * told the Agent about it. */
  flushSurvivingDeliveryQueue(agentId: string): void {
    const held = this.ports.deliveryQueue.idle(agentId);
    if (!held.length) return;
    void this.ports.messageAttention.flush(agentId, held).catch((error: unknown) => {
      // Already acknowledged when held: they come back as unread on the next Start or daemon
      // restart, not from a `ready` replay.
      logger.warn("Held Agent deliveries were not accepted at launch", {
        event: "agent.delivery_queue.flush_rejected",
        agent_id: agentId,
        held_count: held.length,
        already_acknowledged: true,
        error_code: diagnosticErrorName(error),
      });
    });
  }

  /** Opens a turn with `text`: the resume prompt a user's Start sent, or the introduction the
   * server asks for. */
  async runPromptTurn(agentId: string, text: string, introduction?: true): Promise<void> {
    const session = this.ports.agentProcessManager.session(agentId);
    if (!session?.notify) {
      logger.debug("Agent prompt turn skipped: the session accepts no input", {
        event: "agent.prompt_turn.skipped",
        agent_id: agentId,
      });
      return;
    }
    if (introduction) this.ports.introducedAgents.add(agentId);
    this.noteTurnStarted(agentId);
    await session.notify(text);
  }

  noteTurnStarted(agentId: string): void {
    const launch = this.ports.currentActivityLaunches.get(agentId);
    if (!launch?.progress) return;
    launch.progress.noteTurnStarted();
    launch.stalled?.start(agentId, stalledTurnObservation(launch));
  }
}
