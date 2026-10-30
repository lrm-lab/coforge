import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";

/** Workspace features as a launch identity or a delivery envelope states them. */
type WireFeatures = { features?: { taskConversations?: boolean } };

const NOTICE_HEAD = "CoForge notice: this workspace's features changed:";
const NOTICE_TAIL =
  "Your standing instructions now describe what is available here. No reply is needed.";

export const FEATURE_NOTICE_ON = `${NOTICE_HEAD} Task conversations turned on (a task has its own conversation: \`coforge task reply\`); ${NOTICE_TAIL}`;
export const FEATURE_NOTICE_OFF = `${NOTICE_HEAD} Task conversations turned off for new tasks (a task that already has a conversation keeps it); ${NOTICE_TAIL}`;

export type AgentFeatureSyncPorts = Readonly<{
  /** The Agent has a live session and launch that a restart would replace. */
  live(agentId: string): boolean;
  /** Keeps the delivery for the next launch, which presents it. */
  keep(message: AgentMessageDelivery): void;
  /** Ends the session and launches it again from fresh launch config, awaiting that launch. */
  restart(agentId: string): Promise<void>;
}>;

/**
 * The standing prompt of a live session cannot change, so a feature that changed since the session
 * launched restarts it: the delivery that reveals the change is kept, the Agent relaunches with
 * the fresh prompt, and its first input carries a one-line notice. A delivery with no `features`
 * (an older server) never restarts anything.
 */
export class AgentFeatureSync {
  readonly #launched = new Map<string, boolean>();
  readonly #notices = new Map<string, string>();

  constructor(private readonly ports: AgentFeatureSyncPorts) {}

  /** What the session being launched now was told, from its launch config identity. */
  launched(agentId: string, identity: WireFeatures | undefined): void {
    this.#launched.set(agentId, identity?.features?.taskConversations === true);
  }

  /** Restarts the Agent when `message` shows a changed feature; true when it took the delivery. */
  async restartIfChanged(message: AgentMessageDelivery): Promise<boolean> {
    const { agentId } = message;
    const wire = message.features;
    const was = this.#launched.get(agentId);
    if (!wire || was === undefined || !this.ports.live(agentId)) return false;
    const now = wire.taskConversations === true;
    if (now === was) return false;
    this.#notices.set(agentId, now ? FEATURE_NOTICE_ON : FEATURE_NOTICE_OFF);
    this.ports.keep(message);
    await this.ports.restart(agentId);
    return true;
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
