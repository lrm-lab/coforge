import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";

/** Workspace features as a launch identity or a delivery envelope states them. A launch identity
 * states every switch it knows; a delivery may name only some — a switch it does not name is
 * unknown, never off, and never a reason to restart. */
type WireFeatures = { features?: { taskConversations?: boolean; artifacts?: boolean } };
type FeatureKey = "taskConversations" | "artifacts";
const FEATURE_KEYS: readonly FeatureKey[] = ["taskConversations", "artifacts"];

const NOTICE_HEAD = "CoForge notice: this workspace's features changed:";
const NOTICE_TAIL =
  "Your standing instructions now describe what is available here. No reply is needed.";

const FEATURE_NOTICES: Record<FeatureKey, { on: string; off: string }> = {
  taskConversations: {
    on: "Task conversations turned on (a task has its own conversation: `coforge task reply`)",
    off: "Task conversations turned off for new tasks (a task that already has a conversation keeps it)",
  },
  artifacts: {
    on: "Documents turned on (`coforge artifact` creates and edits them)",
    off: "Documents turned off (`coforge artifact` refuses; send files as attachments)",
  },
};

/** One notice phrase per switch the delivery shows changed since launch; empty when none did. */
function featureChanges(
  launched: WireFeatures["features"],
  wire: WireFeatures["features"],
): string[] {
  if (!launched || !wire) return [];
  const changes: string[] = [];
  for (const key of FEATURE_KEYS) {
    const was = launched[key];
    const now = wire[key];
    if (was !== undefined && now !== undefined && (was === true) !== (now === true))
      changes.push(now === true ? FEATURE_NOTICES[key].on : FEATURE_NOTICES[key].off);
  }
  return changes;
}

export type AgentFeatureSyncPorts = Readonly<{
  /** The Agent has a live session and launch that a restart would replace. */
  live(agentId: string): boolean;
  /** Keeps the delivery for the next launch, which presents it. */
  keep(message: AgentMessageDelivery): void;
  /** Ends the session and launches it again from fresh launch config, awaiting that launch. */
  restart(agentId: string): Promise<void>;
}>;

/**
 * The standing prompt and exported feature switches of a live session cannot change, so a
 * feature that changed since the session launched restarts it: the delivery that reveals the
 * change is kept, the Agent relaunches with the fresh prompt, and its first input carries a
 * one-line notice. A delivery with no `features` (an older server) never restarts anything.
 */
export class AgentFeatureSync {
  readonly #launched = new Map<string, WireFeatures["features"]>();
  readonly #notices = new Map<string, string>();

  constructor(private readonly ports: AgentFeatureSyncPorts) {}

  /** What the session being launched now was told, from its launch config identity. */
  launched(agentId: string, identity: WireFeatures | undefined): void {
    // A launch config that states no features (an older server, or a rollout mixing both) says
    // nothing to compare against, so no delivery restarts the session over it.
    if (identity?.features) this.#launched.set(agentId, identity.features);
    else this.#launched.delete(agentId);
  }

  /** Whether `message` shows a feature that changed since the session launched. Synchronous, so a
   * delivery that shows none is handled with no extra turn of the event loop. */
  changed(message: AgentMessageDelivery): boolean {
    const was = this.#launched.get(message.agentId);
    return Boolean(
      was !== undefined &&
      this.ports.live(message.agentId) &&
      featureChanges(was, message.features).length > 0,
    );
  }

  /** Restarts the Agent over the change `changed` found; the delivery waits for the new launch. */
  async restart(message: AgentMessageDelivery): Promise<void> {
    const { agentId } = message;
    const changes = featureChanges(this.#launched.get(agentId), message.features);
    this.#notices.set(
      agentId,
      `${NOTICE_HEAD}${changes.length > 0 ? ` ${changes.join("; ")}` : ""}; ${NOTICE_TAIL}`,
    );
    this.ports.keep(message);
    try {
      await this.ports.restart(agentId);
    } catch (error) {
      // The session keeps its old prompt, so the notice would say what is not true.
      this.#notices.delete(agentId);
      throw error;
    }
  }

  /** The notice line to put before the Agent's next input, once; empty when none is owed. */
  noticePrefix(agentId: string): string {
    const notice = this.#notices.get(agentId);
    this.#notices.delete(agentId);
    return notice ? `${notice}\n` : "";
  }

  forget(agentId: string): void {
    this.#launched.delete(agentId);
    this.#notices.delete(agentId);
  }
}
