import {
  diagnosticErrorName,
  type InboxResponse,
  type LocalInboxRequest,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import type { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import type { AgentAppInbox, MintAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import type { AgentProcessManager, AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { forgetLocalAgent, type AgentLocalFootprint } from "./agent-forget";
import { agentInbox, appInbox } from "./agent-inbox-factories";
import type { AgentInboxStateMachine } from "./agent-inbox-state-machine";
import type { AgentDeliveryQueue } from "./agent-delivery-queue";
import type { ActivityLaunch } from "./activity-launch";
import type { MentionDeliveryTracker } from "./mention-delivery-tracker";
import type { RuntimeRelease } from "./runtime-release";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export type AgentInboxCoordinatorPorts = {
  workspaceId: string;
  stateDirectory: string;
  consumedSeqs: AgentConsumedSeqStore;
  messageAttention: Pick<AgentMessageAttentionIndex, "check">;
  deliveryQueue: AgentDeliveryQueue;
  runtimeRelease: Pick<RuntimeRelease<ActivityLaunch>, "isRecovering">;
  processManager: Pick<AgentProcessManager, "session" | "restartConfig">;
  startAgent: (
    agentId: string,
    config: AgentRuntime["config"],
    sessionId?: string,
  ) => Promise<AgentRuntime>;
  currentActivityLaunch: (agentId: string) => ActivityLaunch | undefined;
  reconcileIdleTurn: (agentId: string, launch: ActivityLaunch) => boolean;
  mentionDeliveries: Pick<MentionDeliveryTracker, "settleRedelivery">;
  assertRunning: () => void;
  agentIdForContext: (context: string) => string;
};

/** Coordinates the per-Agent message and App Inbox state owned by a daemon runtime. */
export class AgentInboxCoordinator {
  readonly #agentInboxes = new Map<string, AgentInboxStateMachine>();
  readonly #appInboxes = new Map<string, Promise<AgentAppInbox>>();
  readonly #notifiedAppItems = new Map<string, Map<string, Promise<boolean>>>();

  constructor(private readonly ports: AgentInboxCoordinatorPorts) {}

  agentInbox(agentId: string): AgentInboxStateMachine {
    return agentInbox(this.#agentInboxes, (id) => this.ports.consumedSeqs.stateDb(id), agentId);
  }

  appInbox(agentId: string): Promise<AgentAppInbox> {
    return appInbox(this.#appInboxes, this.ports.stateDirectory, this.ports.workspaceId, agentId);
  }

  async appItemsPending(agentId: string): Promise<number> {
    return (await this.appInbox(agentId)).list().length;
  }

  async mintAppItem(agentId: string, input: MintAppItem) {
    const item = await (await this.appInbox(agentId)).upsert(input);
    await this.notifyAppItem(agentId, item.itemId);
    return item;
  }

  async removeAppItem(agentId: string, itemId: string): Promise<boolean> {
    const removed = await (await this.appInbox(agentId)).remove(itemId);
    this.#notifiedAppItems.get(agentId)?.delete(itemId);
    return removed;
  }

  async inbox(context: string, request: LocalInboxRequest): Promise<InboxResponse> {
    this.ports.assertRunning();
    const agentId = this.ports.agentIdForContext(context);
    const inbox = await this.appInbox(agentId);
    return {
      idempotencyKey: request.idempotencyKey,
      accepted: true,
      entries: [
        ...this.ports.messageAttention.check(agentId).map((messageTarget) => ({
          kind: "message_target" as const,
          messageTarget: { ...messageTarget, flags: [...messageTarget.flags] },
        })),
        ...(await inbox.read()).map((app) => ({ kind: "app" as const, app })),
      ],
    };
  }

  async drainAppInboxNotices(agentId: string): Promise<void> {
    for (const item of (await this.appInbox(agentId)).list())
      await this.notifyAppItem(agentId, item.itemId);
  }

  async notifyAppItem(
    agentId: string,
    itemId: string,
    { startStopped = true }: { startStopped?: boolean } = {},
  ): Promise<boolean> {
    const notified = this.#notifiedAppItems.get(agentId) ?? new Map<string, Promise<boolean>>();
    this.#notifiedAppItems.set(agentId, notified);
    const existing = notified.get(itemId);
    if (existing) return existing;
    const pending = Promise.resolve().then(async () => {
      // An ending runtime takes no notice: it waits for the launch that follows.
      if (this.ports.runtimeRelease.isRecovering(agentId)) {
        this.ports.deliveryQueue.holdAppItem(agentId, itemId);
        return false;
      }
      let session = this.ports.processManager.session(agentId);
      if (!session) {
        if (!startStopped) return false;
        const wakeable = this.ports.processManager.restartConfig(agentId);
        if (!wakeable) return false;
        session = (await this.ports.startAgent(agentId, wakeable.config, wakeable.sessionId))
          .session;
      }
      if (!session.notify) return false;
      // A queue_until_idle provider's session/notify has no safe busy path, same as an
      // ordinary message delivery — hold this app-item notice instead of sending it now, and
      // release it (re-attempting this same call) at the next turn end.
      if (this.ports.deliveryQueue.shouldHold(agentId)) {
        this.ports.deliveryQueue.holdAppItem(agentId, itemId);
        return false;
      }
      this.ports.deliveryQueue.busy(agentId);
      const launch = this.ports.currentActivityLaunch(agentId);
      try {
        await session.notify("New app item available. Run coforge inbox check.");
      } finally {
        if (launch && this.ports.processManager.session(agentId) === session)
          this.ports.reconcileIdleTurn(agentId, launch);
      }
      return true;
    });
    notified.set(itemId, pending);
    try {
      const accepted = await pending;
      if (!accepted && notified.get(itemId) === pending) notified.delete(itemId);
      return accepted;
    } catch (error) {
      if (notified.get(itemId) === pending) notified.delete(itemId);
      throw error;
    }
  }

  /** Re-attempts every app-item notice held by the delivery queue. */
  releaseHeldAppItems(agentId: string): void {
    for (const itemId of this.ports.deliveryQueue.releaseAppItems(agentId))
      void this.notifyAppItem(agentId, itemId).catch(() => {});
  }

  /** Redelivers fallback notice text held after a provider accepted but did not show it. */
  releaseFallbackNotices(agentId: string): void {
    const notices = this.ports.deliveryQueue.releaseFallbackNotices(agentId);
    if (!notices.length) return;
    const session = this.ports.processManager.session(agentId);
    for (const { text, deliveryIds = [], conversation } of notices) {
      if (!session?.notify) {
        void this.ports.mentionDeliveries.settleRedelivery(agentId, deliveryIds, false);
        continue;
      }
      const redelivery =
        deliveryIds.length || conversation
          ? session.notify(text, { deliveryIds, ...(conversation ? { conversation } : {}) })
          : session.notify(text);
      void redelivery.then(
        () => this.ports.mentionDeliveries.settleRedelivery(agentId, deliveryIds, true),
        (error: unknown) => {
          logger.warn("A steered notice could not be redelivered after its turn ended", {
            event: "agent.delivery_queue.fallback_notice_rejected",
            agent_id: agentId,
            error_code: diagnosticErrorName(error),
          });
          return this.ports.mentionDeliveries.settleRedelivery(agentId, deliveryIds, false);
        },
      );
    }
  }

  forgetAgent(
    agentId: string,
    footprint: Omit<AgentLocalFootprint, "agentInboxes" | "appInboxes">,
  ): void {
    forgetLocalAgent(agentId, {
      ...footprint,
      agentInboxes: this.#agentInboxes,
      appInboxes: this.#appInboxes,
    });
  }
}
