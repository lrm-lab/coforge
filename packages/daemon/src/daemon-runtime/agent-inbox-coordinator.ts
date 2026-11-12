import {
  diagnosticErrorName,
  type InboxResponse,
  type InboxSeal,
  type LocalInboxRequest,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import type { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import type {
  AgentAppInbox,
  AgentAppItem,
  MintAppItem,
} from "#src/agent-app-inbox/agent-app-inbox";
import {
  mergedReminderAppInboxNoticeText,
  reminderAppInboxNoticeText,
} from "#src/agent-reminder/reminder-app-inbox-text";
import type { AgentAppInboxSeals } from "#src/agent-app-inbox/app-inbox-seals";
import type { AgentProcessManager, AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { forgetLocalAgent, type AgentLocalFootprint } from "./agent-forget";
import { agentInbox, appInbox, appInboxSeals } from "./agent-inbox-factories";
import type { AgentInboxStateMachine } from "./agent-inbox-state-machine";
import type { AgentDeliveryGate } from "./agent-delivery-gate";
import type { ActivityLaunch } from "./activity-launch";
import type { MentionDeliveryTracker } from "./mention-delivery-tracker";
import type { RuntimeRelease } from "./runtime-release";

const logger = getLogger(["coforge", "daemon", "runtime"]);

const GENERIC_APP_ITEM_NOTICE = "New app item available. Run coforge inbox check.";
const REMINDER_APP_ID = "system.reminder";
const REMINDER_DUE_CLASS = "due";

type AppItemNotice = Readonly<{ itemIds: readonly string[]; text: string }>;

const isDueReminder = (item: AgentAppItem) =>
  item.appId === REMINDER_APP_ID && item.notificationClass === REMINDER_DUE_CLASS;

/** The notices a set of pending App items produces: due reminders share one merged text while
 * every other item keeps the generic pointer, so only `system.reminder` ever names its content —
 * an App Inbox title or summary is never copied into a notice. */
function planAppItemNotices(items: readonly AgentAppItem[]): AppItemNotice[] {
  const reminders = items.filter(isDueReminder);
  const notices: AppItemNotice[] = [];
  if (reminders.length === 1)
    notices.push({
      itemIds: [reminders[0]!.itemId],
      text: reminderAppInboxNoticeText(reminders[0]!),
    });
  else if (reminders.length > 1)
    notices.push({
      itemIds: reminders.map((item) => item.itemId),
      text: mergedReminderAppInboxNoticeText(reminders),
    });
  for (const item of items)
    if (!isDueReminder(item))
      notices.push({ itemIds: [item.itemId], text: GENERIC_APP_ITEM_NOTICE });
  return notices;
}

export type AgentInboxCoordinatorPorts = {
  workspaceId: string;
  stateDirectory: string;
  consumedSeqs: AgentConsumedSeqStore;
  messageAttention: Pick<AgentMessageAttentionIndex, "check">;
  deliveryGate: AgentDeliveryGate;
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
  readonly #appSeals = new Map<string, Promise<AgentAppInboxSeals>>();
  readonly #notifiedAppItems = new Map<string, Map<string, Promise<boolean>>>();

  constructor(private readonly ports: AgentInboxCoordinatorPorts) {}

  agentInbox(agentId: string): AgentInboxStateMachine {
    return agentInbox(this.#agentInboxes, (id) => this.ports.consumedSeqs.stateDb(id), agentId);
  }

  appInbox(agentId: string): Promise<AgentAppInbox> {
    return appInbox(this.#appInboxes, this.ports.stateDirectory, this.ports.workspaceId, agentId);
  }

  appSeals(agentId: string): Promise<AgentAppInboxSeals> {
    return appInboxSeals(
      this.#appSeals,
      this.ports.stateDirectory,
      this.ports.workspaceId,
      agentId,
    );
  }

  async appItemsPending(agentId: string): Promise<number> {
    return (await this.appInbox(agentId)).list().length;
  }

  async mintAppItem(agentId: string, input: MintAppItem) {
    const item = await (await this.appInbox(agentId)).upsert(input);
    await this.notifyAppItem(agentId, item);
    return item;
  }

  /** Removes an App Inbox item and forgets that it was announced, so an item minted again under
   * the same id is announced again. */
  async removeAppItem(agentId: string, itemId: string): Promise<boolean> {
    const removed = await (await this.appInbox(agentId)).remove(itemId);
    this.#notifiedAppItems.get(agentId)?.delete(itemId);
    return removed;
  }

  /** Forgets which App Inbox items the Agent was told of, so its next launch announces them all:
   * for a Session replaced with a fresh one, which was told of none. */
  forgetAnnouncedAppItems(agentId: string): void {
    this.#notifiedAppItems.delete(agentId);
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
      seals: await this.#seals(agentId),
    };
  }

  /** The revisions of the App Inbox items one source identity has now: what a seal calls live. */
  async appItemRevisions(
    agentId: string,
    appId: string,
    notificationClass: string,
    sourceId: string,
  ): Promise<string[]> {
    return (await this.appInbox(agentId))
      .list()
      .filter(
        (item) =>
          item.appId === appId &&
          item.notificationClass === notificationClass &&
          item.sourceRef.id === sourceId,
      )
      .map((item) => item.sourceRef.revision);
  }

  /** Every sealed source identity with the state `inbox check` reports: its registered revision
   * against the source's live one, or DETACHED when it names no revision or nothing is live. */
  async #seals(agentId: string): Promise<InboxSeal[]> {
    const seals = await (await this.appSeals(agentId)).list();
    const items = (await this.appInbox(agentId)).list();
    return seals.map((seal) => {
      const live = items
        .filter(
          (item) =>
            item.appId === seal.appId &&
            item.notificationClass === seal.notificationClass &&
            item.sourceRef.id === seal.sourceId,
        )
        .map((item) => item.sourceRef.revision);
      const liveRevision = live.length ? String(Math.max(...live.map(Number))) : undefined;
      const state: InboxSeal["state"] =
        seal.sourceRevision === undefined || liveRevision === undefined
          ? "DETACHED"
          : seal.sourceRevision === liveRevision
            ? "SEALED"
            : "STALE";
      return {
        appId: seal.appId,
        notificationClass: seal.notificationClass,
        sourceRef: {
          kind: seal.sourceKind,
          id: seal.sourceId,
          ...(seal.sourceRevision === undefined ? {} : { revision: seal.sourceRevision }),
        },
        owner: seal.owner,
        until: seal.until,
        sealedAt: seal.sealedAt,
        state,
        ...(liveRevision === undefined ? {} : { liveRevision }),
      };
    });
  }

  async drainAppInboxNotices(agentId: string): Promise<void> {
    const notified = this.#notifiedAppItems.get(agentId);
    const items = (await this.appInbox(agentId)).list();
    // A notice already in flight keeps its own outcome: the drain waits on it exactly as the
    // per-item awaits did, so a rejected send still fails the drain.
    const inFlight = items.flatMap((item) => {
      const pending = notified?.get(item.itemId);
      return pending ? [pending] : [];
    });
    const fresh = items.filter((item) => !notified?.has(item.itemId));
    await Promise.all(inFlight);
    await this.#notifyAppItemNotices(agentId, planAppItemNotices(fresh));
  }

  async notifyAppItem(
    agentId: string,
    item: AgentAppItem | string,
    { startStopped = true }: { startStopped?: boolean } = {},
  ): Promise<boolean> {
    const itemId = typeof item === "string" ? item : item.itemId;
    const existing = this.#notifiedAppItems.get(agentId)?.get(itemId);
    if (existing) return existing;
    const resolved =
      typeof item === "string"
        ? (await this.appInbox(agentId)).list().find((entry) => entry.itemId === itemId)
        : item;
    const notices: AppItemNotice[] = resolved
      ? planAppItemNotices([resolved])
      : [{ itemIds: [itemId], text: GENERIC_APP_ITEM_NOTICE }];
    return this.#notifyAppItemNotices(agentId, notices, { startStopped });
  }

  /** Sends each planned notice through the gates `notifyAppItem` always ran — recovery, credential
   * hold, busy hold, session resolution — once per notice instead of once per item, in order and
   * stopping at the first failure exactly as the per-item drain did. Every item id keeps its own
   * notified bookkeeping, so dedup, hold/release and acknowledgement stay per item. */
  async #notifyAppItemNotices(
    agentId: string,
    notices: readonly AppItemNotice[],
    { startStopped = true }: { startStopped?: boolean } = {},
  ): Promise<boolean> {
    const notified = this.#notifiedAppItems.get(agentId) ?? new Map<string, Promise<boolean>>();
    this.#notifiedAppItems.set(agentId, notified);
    let accepted = true;
    for (const notice of notices) {
      const itemIds: string[] = [];
      const shared: Promise<boolean>[] = [];
      for (const itemId of notice.itemIds) {
        const pending = notified.get(itemId);
        if (pending) shared.push(pending);
        else itemIds.push(itemId);
      }
      const sharedResults = shared.length > 0 ? await Promise.all(shared) : undefined;
      if (itemIds.length === 0) {
        if (sharedResults) accepted = sharedResults.every(Boolean);
        continue;
      }
      const pending = Promise.resolve().then(async () => {
        // An ending runtime takes no notice: it waits for the launch that follows.
        if (this.ports.runtimeRelease.isRecovering(agentId)) {
          for (const itemId of itemIds) this.ports.deliveryGate.holdAppItem(agentId, itemId);
          return false;
        }
        let session = this.ports.processManager.session(agentId);
        if (!session) {
          if (!startStopped) return false;
          // A credential known invalid is no reason to start the Agent: the item waits with the rest.
          if (this.ports.deliveryGate.credentialHeld(agentId)) {
            for (const itemId of itemIds) this.ports.deliveryGate.holdAppItem(agentId, itemId);
            return false;
          }
          const wakeable = this.ports.processManager.restartConfig(agentId);
          if (!wakeable) return false;
          session = (await this.ports.startAgent(agentId, wakeable.config, wakeable.sessionId))
            .session;
        }
        if (!session.notify) return false;
        // A queue_until_idle provider's session/notify has no safe busy path, same as an
        // ordinary message delivery — hold these app-item notices instead of sending them now, and
        // release them (re-attempting this same call) at the next turn end.
        if (this.ports.deliveryGate.shouldHold(agentId)) {
          for (const itemId of itemIds) this.ports.deliveryGate.holdAppItem(agentId, itemId);
          return false;
        }
        this.ports.deliveryGate.busy(agentId);
        const launch = this.ports.currentActivityLaunch(agentId);
        try {
          await session.notify(notice.text);
        } finally {
          if (launch && this.ports.processManager.session(agentId) === session)
            this.ports.reconcileIdleTurn(agentId, launch);
        }
        return true;
      });
      for (const itemId of itemIds) notified.set(itemId, pending);
      try {
        const result = await pending;
        if (!result)
          for (const itemId of itemIds)
            if (notified.get(itemId) === pending) notified.delete(itemId);
        accepted = result;
      } catch (error) {
        for (const itemId of itemIds) if (notified.get(itemId) === pending) notified.delete(itemId);
        throw error;
      }
    }
    return accepted;
  }

  /** Re-attempts every app-item notice `AgentDeliveryGate` held for `agentId` — each
   * one re-checks `shouldHold` itself inside `notifyAppItem`, so one that is still busy (e.g. a
   * coalesced delivery flush that just re-armed busy) simply re-holds itself for the next
   * release rather than being lost or sent too early. */
  releaseHeldAppItems(agentId: string): void {
    const itemIds = this.ports.deliveryGate.releaseAppItems(agentId);
    if (itemIds.length === 0) return;
    void this.#notifyReleasedAppItems(agentId, itemIds);
  }

  async #notifyReleasedAppItems(agentId: string, itemIds: string[]): Promise<void> {
    try {
      const byId = new Map(
        (await this.appInbox(agentId)).list().map((item) => [item.itemId, item] as const),
      );
      const found = itemIds.flatMap((itemId) => {
        const item = byId.get(itemId);
        return item ? [item] : [];
      });
      const notices = planAppItemNotices(found);
      for (const itemId of itemIds)
        if (!byId.has(itemId)) notices.push({ itemIds: [itemId], text: GENERIC_APP_ITEM_NOTICE });
      await this.#notifyAppItemNotices(agentId, notices);
    } catch {
      // Best-effort, same as the per-item `.catch(() => {})` this replaces: a failed release
      // leaves its items unannounced for the next turn end.
    }
  }

  /**
   * Redelivers every fallback notice text `AgentDeliveryGate` held for `agentId`
   * (Kiro's `notice-undelivered` event) as a bare `session.notify` call — never through
   * `AgentMessageAttentionIndex`, since the delivery or App Inbox item this text originally
   * came from already settled its own ACK (or never had one); this call must never produce a second
   * one. If the Agent has gone busy again by the time this runs (e.g. its own steer of another
   * held text just started a fresh turn), `notify` steers this one into that turn instead of
   * losing it.
   */
  releaseFallbackNotices(agentId: string): void {
    const notices = this.ports.deliveryGate.releaseFallbackNotices(agentId);
    if (!notices.length) return;
    const session = this.ports.processManager.session(agentId);
    for (const { text, deliveryIds = [], conversation } of notices) {
      if (!session?.notify) {
        this.ports.mentionDeliveries.settleRedelivery(agentId, deliveryIds, false);
        continue;
      }
      // The tracked mentions it carries are drained once it is accepted, so it names them again.
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
    footprint: Omit<AgentLocalFootprint, "agentInboxes" | "appInboxes" | "appSeals">,
  ): void {
    forgetLocalAgent(agentId, {
      ...footprint,
      agentInboxes: this.#agentInboxes,
      appInboxes: this.#appInboxes,
      appSeals: this.#appSeals,
    });
  }
}
