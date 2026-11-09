import { getLogger } from "@logtape/logtape";
import { HELD_NOTICE_CAP, HeldPublications } from "./held-publications";
import type { ListenerSlot } from "./listener-slot";

const logger = getLogger(["coforge", "daemon", "connection"]);

/** How a held publication replaces what came before it: an Agent's latest intent of one kind, or a
 * capped delivery notice. Absent: nothing later supersedes it. */
type HoldKind = "start" | "stop" | "probe" | "notice";

/**
 * The publications the cloud sent while a ready handshake was in flight. The cloud publishes Agent
 * control and delivery notices as soon as it wants them delivered, which is before it has answered
 * this Computer's ready; holding them here keeps the order the server sent, and a handshake that
 * fails and is retried keeps holding, because the cloud has no way to cancel them.
 *
 * It also reports {@link size}, so a start stuck behind a handshake can say how many publications
 * wait with it (task #630) — the runtime's own buffer only sees them after ready is accepted, so it
 * cannot describe this wait on its own.
 */
export class ReadyPublicationHold {
  #held: HeldPublications<() => void> | undefined;

  /** Whether a handshake is holding publications right now. */
  get holding(): boolean {
    return this.#held !== undefined;
  }

  /** Starts holding; a ready retried after a failure continues to hold what earlier attempts held. */
  hold(): void {
    this.#held ??= new HeldPublications();
  }

  /** Holds the publication instead of delivering it; returns whether it was held. */
  add(agentId: string, run: () => void, kind?: HoldKind): boolean {
    const held = this.#held;
    if (!held) return false;
    if (kind === "notice") held.notice(agentId, run);
    else if (kind) held.latestFor(agentId, kind, run);
    else held.add(run);
    return true;
  }

  /** Delivers a publication now, or holds it until the handshake is accepted; a held item replaces
   * its predecessor by `kind` and notices are capped. */
  deliver<Value>(slot: ListenerSlot<(value: Value) => void>, value: Value, kind?: HoldKind): void {
    // The common case: nothing is held, so nothing is allocated either.
    const agentId =
      typeof value === "object" &&
      value !== null &&
      "agentId" in value &&
      typeof value.agentId === "string"
        ? value.agentId
        : "";
    if (this.add(agentId, () => slot.current?.(value), kind)) return;
    slot.current?.(value);
  }

  /** How many publications wait behind the handshake, control intents and notices together. */
  size(): number {
    return this.#held?.size() ?? 0;
  }

  /** Delivers everything held, in the order it arrived, and stops holding. */
  dispatch(): void {
    const held = this.#held?.take();
    this.#held = undefined;
    if (!held) return;
    if (held.dropped > 0)
      logger.warning("Delivery notices held during ready were dropped; the cloud resends them", {
        event: "daemon_ready:notices_dropped",
        dropped: held.dropped,
        held_cap: HELD_NOTICE_CAP,
      });
    for (const run of held.items) run();
  }

  /** Drops everything held without delivering it, for a connection that is going away. */
  clear(): void {
    this.#held = undefined;
  }
}
