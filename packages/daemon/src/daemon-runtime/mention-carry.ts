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
  hold(message: TrackedMentionDelivery, fromQueue = false): boolean {
    if (this.ports.consumed(message)) {
      void this.settle.drain(message);
      return false;
    }
    const existing = this.entries.get(message.deliveryId);
    if (existing) {
      if (
        existing.message.agentId !== message.agentId ||
        existing.message.messageId !== message.messageId
      ) {
        void this.settle.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.INSTRUMENT_FAILED);
        return false;
      }
      if (!fromQueue) {
        existing.message = message;
        if (existing.state === "drained") void this.reports.acknowledge(message);
        else this.reports.transition(message, "daemon_pending", "coalesced");
      }
      // Back from an ended runtime's input, it waits for the next launch to take it again. One
      // told to a process that has since gone has nobody left to settle it: the launch tells it.
      if (existing.state !== "drained")
        if (existing.carried ? fromQueue : !existing.undelivered && !this.#running(message.agentId))
          this.#keep(existing);
      return existing.state !== "drained";
    }
    const remembered = this.ports.remembered?.(message.agentId);
    if (!remembered || !namesLaunch(remembered, message.mentionDelivery)) {
      void this.settle.refuse(
        message,
        remembered
          ? MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_DRIFT
          : MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN,
      );
      return false;
    }
    this.entries.set(message, "received");
    this.entries.carry(this.entries.get(message.deliveryId)!, "waiting");
    this.reports.transition(message, "daemon_received", "accepted");
    return true;
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
      this.#keep(entry);
    }
    return counted;
  }

  /** Keeps the entry for the next launch, to be taken again whatever became of an earlier take. In
   * place: a notice still being written for it finds it carried when it settles. */
  #keep(entry: Tracked): void {
    entry.state = "received";
    delete entry.inflight;
    this.entries.unpend(entry.message.agentId, entry.message.deliveryId);
    this.entries.carry(entry, "waiting");
  }

  #running(agentId: string): boolean {
    return this.ports.process?.(agentId) !== undefined;
  }

  /** The restart did not happen: a mention whose notice failed while it was under way is lost. */
  abortRelaunch(agentId: string): void {
    for (const { message, state, inflight, carried } of this.entries.all())
      if (message.agentId === agentId && state === "received" && !inflight && !carried)
        void this.settle.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED);
  }

  /** Whether any mention is kept for the Agent's next launch. */
  hasCarried(agentId: string): boolean {
    return this.entries.carriedOf(agentId).length > 0;
  }

  /** No launch is coming after all: the mentions kept for it are refused with `code`. */
  refuseCarried(agentId: string, code: MentionDeliveryTerminalCode): void {
    for (const entry of this.entries.carriedOf(agentId))
      void this.settle.refuse(entry.message, code);
  }

  /** The Daemon is stopping: whatever any Agent's next launch would have told is forgotten, with no
   * report. */
  forgetAllCarried(): void {
    for (const entry of this.entries.all())
      if (entry.carried) this.entries.forget(entry.message.deliveryId);
  }

  /** The mentions kept for the Agent's next launch that its input has not taken yet. */
  takeCarried(agentId: string): TrackedMentionDelivery[] {
    const taken: TrackedMentionDelivery[] = [];
    for (const entry of this.entries.carriedOf(agentId))
      if (entry.carried === "waiting") {
        this.entries.carry(entry, "queued");
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
    this.entries.carry(entry, "waiting");
    this.ports.pull?.(agentId);
    return true;
  }
}
