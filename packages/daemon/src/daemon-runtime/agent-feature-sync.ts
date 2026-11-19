import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { AgentServerFeatures } from "@lrm/coforge-sdk/internal";

/** Workspace features as a launch identity or a delivery envelope states them. A launch identity
 * states every switch it knows; a delivery may name only some — a switch it does not name is
 * unknown, never off, and never a reason to restart. */
type WireFeatures = {
  features?: { taskConversations?: boolean; artifacts?: boolean; agentContextView?: boolean };
};
type FeatureKey = "taskConversations" | "artifacts" | "agentContextView";
const FEATURE_KEYS: readonly FeatureKey[] = ["taskConversations", "artifacts", "agentContextView"];

const NOTICE_HEAD = "CoForge notice: this workspace's features changed:";
const NOTICE_TAIL =
  "Your standing instructions now describe what is available here. No reply is needed.";

const FEATURE_NOTICES: Record<FeatureKey, { on: string; off: string }> = {
  taskConversations: {
    on: "Task conversations turned on (a task has its own conversation: `coforge task reply`)",
    off: "Task conversations turned off for new tasks (a task that already has a conversation keeps it)",
  },
  artifacts: {
    on: "Artifacts turned on (`coforge artifact` creates and edits them)",
    off: "Artifacts turned off (`coforge artifact` refuses; send files as attachments)",
  },
  agentContextView: {
    on: "Agent context view turned on",
    off: "Agent context view turned off",
  },
};

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
  live(agentId: string): boolean;
  keep(message: AgentMessageDelivery): void;
  restart(agentId: string): Promise<void>;
  reportAvailability?(agentId: string): Promise<void>;
  observe?(agentId: string, features: WireFeatures["features"] | undefined): void;
}>;

export class AgentFeatureSync {
  readonly #launched = new Map<string, WireFeatures["features"]>();
  readonly #serverFeatures = new Map<string, WireFeatures["features"]>();
  readonly #notices = new Map<string, string>();
  readonly #serverRevisions = new Map<string, number>();

  constructor(private readonly ports: AgentFeatureSyncPorts) {}

  launched(agentId: string, identity: WireFeatures | undefined): void {
    if (identity?.features) this.#launched.set(agentId, identity.features);
    else this.#launched.delete(agentId);
    this.#serverFeatures.delete(agentId);
    this.ports.observe?.(agentId, identity?.features);
  }

  #effectiveFeatures(message: AgentMessageDelivery): WireFeatures["features"] {
    const pushed = this.#serverFeatures.get(message.agentId);
    if (!pushed) return message.features;
    return { ...pushed, ...message.features };
  }

  changed(message: AgentMessageDelivery): boolean {
    const was = this.#launched.get(message.agentId);
    return Boolean(
      was !== undefined &&
      this.ports.live(message.agentId) &&
      featureChanges(was, this.#effectiveFeatures(message)).length > 0,
    );
  }

  async restart(message: AgentMessageDelivery): Promise<void> {
    const { agentId } = message;
    const changes = featureChanges(this.#launched.get(agentId), this.#effectiveFeatures(message));
    this.#notices.set(
      agentId,
      `${NOTICE_HEAD}${changes.length > 0 ? ` ${changes.join("; ")}` : ""}; ${NOTICE_TAIL}`,
    );
    this.ports.keep(message);
    try {
      await this.ports.restart(agentId);
    } catch (error) {
      this.#notices.delete(agentId);
      throw error;
    }
  }

  noticePrefix(agentId: string): string {
    const notice = this.#notices.get(agentId);
    this.#notices.delete(agentId);
    return notice ? `${notice}\n` : "";
  }

  forget(agentId: string): void {
    this.#launched.delete(agentId);
    this.#serverFeatures.delete(agentId);
    this.#notices.delete(agentId);
  }

  applyServerFeatures(sync: AgentServerFeatures): void {
    const scope = `${sync.workspaceId}:${sync.computerId}`;
    const previous = this.#serverRevisions.get(scope) ?? 0;
    if (sync.revision <= previous) return;
    this.#serverRevisions.set(scope, sync.revision);
    const update: NonNullable<WireFeatures["features"]> = {
      ...(sync.agentContextView !== undefined ? { agentContextView: sync.agentContextView } : {}),
      ...(sync.artifacts !== undefined ? { artifacts: sync.artifacts } : {}),
    };
    const hasUpdate = Object.keys(update).length > 0;
    for (const agentId of sync.agentIds) {
      if (hasUpdate) {
        if (sync.artifacts !== undefined) {
          this.#serverFeatures.set(agentId, {
            ...this.#serverFeatures.get(agentId),
            artifacts: sync.artifacts,
          });
        }
        this.ports.observe?.(agentId, update);
      }
      if (sync.agentContextView === true && this.ports.live(agentId))
        void this.ports.reportAvailability?.(agentId).catch(() => {});
    }
  }
}
