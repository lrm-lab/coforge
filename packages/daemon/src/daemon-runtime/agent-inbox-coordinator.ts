import {
  diagnosticErrorName,
  type InboxResponse,
  type InboxSeal,
  type LocalInboxRequest,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { AgentNoticeSuppressedError } from "@coforge/agent";
import type { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import type { AppNotifiedStore } from "#src/persistence/app-notified-store";
import type {
  AgentAppInbox,
  AgentAppItem,
  MintAppItem,
} from "#src/agent-app-inbox/agent-app-inbox";
import {
  mergedReminderAppInboxNoticeText,
  reminderAppInboxNoticeText,
} from "#src/agent-reminder/reminder-app-inbox-text";
import { PROC_MEMORY_APP_ID } from "#src/agent-app-inbox/registry";
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
import { prepareFallbackNotice } from "./fallback-notice-submission";

const logger = getLogger(["coforge", "daemon", "runtime"]);

const GENERIC_APP_ITEM_NOTICE = "New app item available. Run coforge inbox check.";
const REMINDER_APP_ID = "system.reminder";
const REMINDER_DUE_CLASS = "due";

type AppItemNotice = Readonly<{ itemIds: readonly string[]; text: string; startStopped?: false }>;

const isDueReminder = (item: AgentAppItem) =>
  item.appId === REMINDER_APP_ID && item.notificationClass === REMINDER_DUE_CLASS;

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
      notices.push({
        itemIds: [item.itemId],
        text: GENERIC_APP_ITEM_NOTICE,
        ...(item.appId === PROC_MEMORY_APP_ID ? { startStopped: false } : {}),
      });
  return notices;
}

export type AgentInboxCoordinatorPorts = {
  workspaceId: string;
  stateDirectory: string;
  notifiedAppItems: AppNotifiedStore;
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

export class AgentInboxCoordinator {
  readonly #agentInboxes = new Map<string, AgentInboxStateMachine>();
  readonly #appInboxes = new Map<string, Promise<AgentAppInbox>>();
  readonly #appSeals = new Map<string, Promise<AgentAppInboxSeals>>();
  readonly #notifiedAppItems = new Map<string, Map<string, Promise<boolean>>>();

  constructor(private readonly ports: AgentInboxCoordinatorPorts) {}

  noteCoforgeWriteOrHold(agentId: string): void {
    this.ports.deliveryGate?.wakeLoop?.noteCoforgeWriteOrHold(agentId);
    this.ports.currentActivityLaunch(agentId)?.turnEvidence?.noteMessageSent();
  }

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

  async removeAppItem(agentId: string, itemId: string): Promise<boolean> {
    const removed = await (await this.appInbox(agentId)).remove(itemId);
    this.#notifiedAppItems.get(agentId)?.delete(itemId);
    await this.ports.notifiedAppItems.remove(agentId, itemId);
    return removed;
  }

  forgetAnnouncedAppItems(agentId: string): void {
    this.#notifiedAppItems.delete(agentId);
    void this.ports.notifiedAppItems.clear(agentId).catch((error: unknown) => {
      logger.warn("The App Inbox notices of one Agent could not be forgotten", {
        event: "inbox.app_notified_clear_failed",
        agent_id: agentId,
        error,
      });
    });
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
    const inFlight = items.flatMap((item) => {
      const pending = notified?.get(item.itemId);
      return pending ? [pending] : [];
    });
    const sessionId = this.#sessionId(agentId);
    const told = await this.ports.notifiedAppItems.read(agentId, sessionId);
    const present = new Set(items.map((item) => item.itemId));
    const gone = told.filter((itemId) => !present.has(itemId));
    if (gone.length > 0) {
      if (this.ports.notifiedAppItems.removeMany)
        await this.ports.notifiedAppItems.removeMany(agentId, gone);
      else for (const itemId of gone) await this.ports.notifiedAppItems.remove(agentId, itemId);
    }
    const toldSet = new Set(told);
    const fresh = items.filter((item) => !notified?.has(item.itemId) && !toldSet.has(item.itemId));
    await Promise.all(inFlight);
    await this.#notifyAppItemNotices(agentId, planAppItemNotices(fresh));
  }

  wakeable(agentId: string): boolean {
    const manager = this.ports.processManager;
    return !!manager.session(agentId) || !!manager.restartConfig(agentId);
  }

  #sessionId(agentId: string): string | undefined {
    return this.ports.processManager.restartConfig(agentId)?.sessionId;
  }

  async notifyAppItem(
    agentId: string,
    item: AgentAppItem | string,
    { startStopped = true }: { startStopped?: boolean } = {},
  ): Promise<boolean> {
    const itemId = typeof item === "string" ? item : item.itemId;
    const existing = this.#notifiedAppItems.get(agentId)?.get(itemId);
    if (existing) return existing;
    if (
      (await this.ports.notifiedAppItems.read(agentId, this.#sessionId(agentId))).includes(itemId)
    )
      return true;
    const resolved =
      typeof item === "string"
        ? (await this.appInbox(agentId)).list().find((entry) => entry.itemId === itemId)
        : item;
    const notices: AppItemNotice[] = resolved
      ? planAppItemNotices([resolved])
      : [{ itemIds: [itemId], text: GENERIC_APP_ITEM_NOTICE }];
    return this.#notifyAppItemNotices(agentId, notices, { startStopped });
  }

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
        if (this.ports.runtimeRelease.isRecovering(agentId)) {
          for (const itemId of itemIds) this.ports.deliveryGate.holdAppItem(agentId, itemId);
          return false;
        }
        let session = this.ports.processManager.session(agentId);
        if (!session) {
          if (!startStopped || notice.startStopped === false) return false;
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
        await this.#recordNotified(agentId, itemIds);
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

  async #recordNotified(agentId: string, itemIds: readonly string[]): Promise<void> {
    try {
      await this.ports.notifiedAppItems.add(agentId, this.#sessionId(agentId), itemIds);
    } catch (error) {
      logger.warn("App Inbox notices were sent but not recorded", {
        event: "inbox.app_notified_write_failed",
        agent_id: agentId,
        error,
      });
    }
  }

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
      void 0;
    }
  }

  releaseFallbackNotices(agentId: string): void {
    if (this.ports.currentActivityLaunch(agentId)?.modelQuotaInputHeld) return;
    const notices = this.ports.deliveryGate.releaseFallbackNotices(agentId);
    if (!notices.length) return;
    const session = this.ports.processManager.session(agentId);
    for (const notice of notices) {
      const { deliveryIds = [] } = notice;
      if (!session?.notify) {
        this.ports.mentionDeliveries.settleRedelivery(agentId, deliveryIds, false);
        continue;
      }
      const prepared = prepareFallbackNotice(agentId, notice);
      if (!prepared) continue;
      const redelivery = prepared.options
        ? session.notify(prepared.text, prepared.options)
        : session.notify(prepared.text);
      void redelivery.then(
        () => this.ports.mentionDeliveries.settleRedelivery(agentId, deliveryIds, true),
        (error: unknown) => {
          if (error instanceof AgentNoticeSuppressedError) return;
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
    void this.ports.notifiedAppItems.clear(agentId).catch((error: unknown) => {
      logger.warn("The App Inbox notices of a deleted Agent could not be removed", {
        event: "inbox.app_notified_clear_failed",
        agent_id: agentId,
        error,
      });
    });
  }
}
