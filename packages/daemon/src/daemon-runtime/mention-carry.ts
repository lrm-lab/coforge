import {
  MENTION_DELIVERY_TERMINAL_CODES,
  type MentionDeliveryTerminalCode,
} from "@lrm/coforge-sdk/internal";
import { namesLaunch, type MentionEntries, type Tracked } from "./mention-delivery-entries";
import type { MentionDeliveryPorts } from "./mention-delivery-ports";
import type { MentionDeliveryReports } from "./mention-delivery-reports";
import type { TrackedMentionDelivery } from "./mention-delivery-tracker";

/** How a carried mention is settled, which the tracker owns. */
export type MentionSettlement = {
  drain(message: TrackedMentionDelivery): Promise<void>;
  refuse(message: TrackedMentionDelivery, code: MentionDeliveryTerminalCode): Promise<void>;
};

/**
 * The mentions an Agent's process left unsettled when it went away for a restart, and the ones
 * that arrive while it restarts: kept as entries of the tracker, then told by the next launch's
 * input without a second identity check. A notice that settles for a process the restart replaced
 * never refuses its mention.
 */
export class MentionCarry {
  constructor(
    private readonly entries: MentionEntries,
    private readonly ports: Pick<
      MentionDeliveryPorts,
      "consumed" | "remembered" | "process" | "relaunching" | "pull"
    >,
    private readonly reports: MentionDeliveryReports,
    private readonly settle: MentionSettlement,
  ) {}

  /**
   * Keeps a mention for the launch that is starting or about to start, instead of telling a
   * session: it is checked once, against the launch and session the Agent last reported, and told
   * by that launch's input without being checked again. A repeat of one already known adopts its
   * newer envelope and is reported coalesced, or ACKed again once drained; `fromQueue` says the
   * mention was waiting in an ended runtime's input, which only moves it, so nothing is reported.
   */
  hold(message: TrackedMentionDelivery, fromQueue = false): void {
    if (this.ports.consumed(message)) {
      void this.settle.drain(message);
      return;
    }
    const existing = this.entries.get(message.deliveryId);
    if (existing) {
      if (
        existing.message.agentId !== message.agentId ||
        existing.message.messageId !== message.messageId
      )
        void this.settle.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.INSTRUMENT_FAILED);
      else if (!fromQueue) {
        existing.message = message;
        if (existing.state === "drained") void this.reports.acknowledge(message);
        else this.reports.transition(message, "daemon_pending", "coalesced");
      }
      return;
    }
    const remembered = this.ports.remembered?.(message.agentId);
    if (!remembered || !namesLaunch(remembered, message.mentionDelivery)) {
      void this.settle.refuse(
        message,
        remembered
          ? MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_DRIFT
          : MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN,
      );
      return;
    }
    this.entries.set(message, "received");
    this.entries.get(message.deliveryId)!.carried = "waiting";
    this.reports.transition(message, "daemon_received", "accepted");
  }

  /**
   * The Agent's process ended for a restart that is coming. Each mention not yet settled is kept
   * for the next launch: one still being told, or waiting, always; one already told during a turn
   * only when that launch starts a fresh session, because a resumed session holds the notice
   * already. Returns, per target, how many of those the old session's unread count includes.
   */
  carryForRelaunch(agentId: string, freshSession: boolean): ReadonlyMap<string, number> {
    const counted = new Map<string, number>();
    for (const entry of this.entries.all()) {
      const { message } = entry;
      if (message.agentId !== agentId || entry.state === "drained") continue;
      // The redelivery of its lost notice tells a mention the session never showed, not this carry.
      if (entry.undelivered) {
        if (entry.state === "pending")
          counted.set(message.target!, (counted.get(message.target!) ?? 0) + 1);
        continue;
      }
      if (entry.state === "pending" && !freshSession) continue;
      if (this.ports.consumed(message)) {
        void this.settle.drain(message);
        continue;
      }
      if (entry.state === "pending" || entry.inflight)
        counted.set(message.target!, (counted.get(message.target!) ?? 0) + 1);
      // In place: a notice still being written for this entry finds it carried when it settles.
      entry.state = "received";
      delete entry.inflight;
      entry.carried ??= "waiting";
      this.entries.unpend(agentId, message.deliveryId);
    }
    return counted;
  }

  /** The restart did not happen: a mention whose notice failed while it was under way is lost. */
  abortRelaunch(agentId: string): void {
    for (const { message, state, inflight, carried } of this.entries.all())
      if (message.agentId === agentId && state === "received" && !inflight && !carried)
        void this.settle.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED);
  }

  /** The mentions kept for the Agent's next launch that its input has not taken yet. */
  takeCarried(agentId: string): TrackedMentionDelivery[] {
    const taken: TrackedMentionDelivery[] = [];
    for (const entry of this.entries.all())
      if (entry.message.agentId === agentId && entry.carried === "waiting") {
        entry.carried = "queued";
        taken.push(entry.message);
      }
    return taken;
  }

  /** An inbox purge: the Agent can no longer read these conversations, so their unsettled
   * mentions are rejected. */
  purge(agentId: string, conversationIds: ReadonlySet<string>): void {
    for (const { message, state } of this.entries.all())
      if (
        message.agentId === agentId &&
        state !== "drained" &&
        conversationIds.has(message.conversationId)
      )
        void this.settle.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED);
  }

  /** Whether a notice that failed or went unanswered belonged to a process a restart replaced or
   * is replacing: then the mention is the restart's to carry and is never refused. */
  replaced(entry: Tracked, agentId: string, process: unknown): boolean {
    if (entry.carried || this.ports.relaunching?.(agentId)) return true;
    const now = this.ports.process?.(agentId);
    if (process === undefined || now === undefined || now === process) return false;
    entry.carried = "waiting";
    this.ports.pull?.(agentId);
    return true;
  }
}
