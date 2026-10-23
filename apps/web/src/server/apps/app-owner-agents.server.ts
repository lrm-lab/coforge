import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { AppError } from "#src/lib/app-error";
import { isElevatedServerRole } from "#src/server/workspaces/member-role.server";
import { mintAppClientSecret } from "./app-client-secret.server";

/** The Agent making the call, as its Agent API key names it. */
export type OwnerAgentCaller = { workspaceId: string; agentId: string };

export type OwnerAgentApp = {
  key: string;
  name: string;
  ownerWorkspaceId: string;
  ownerAgentId: string | null;
};

/** An app with the Agent that owns it, as its row holds both. */
export type OwnedAppRow = OwnerAgentApp & {
  ownerAgent: {
    name: string;
    displayName: string | null;
    visibility: string;
    archived: boolean;
  } | null;
};

export type RegisterCardRow = {
  messageId: string;
  state: "pending" | "executed" | "cancelled";
  name: string;
  /** The key the card asks for, or the one the app got; null while it is to be made. */
  clientKey: string | null;
  committedBy?: string;
};

type LiveAgent = { id: string; workspaceId: string; role: string };

export interface AppOwnerAgentStore {
  agent(agentId: string): Promise<(LiveAgent & { archived: boolean }) | undefined>;
  find(key: string): Promise<OwnerAgentApp | undefined>;
  /** The Workspace's apps the Agent owns, or all of them with `all`. */
  managed(agent: LiveAgent, all: boolean): Promise<OwnerAgentApp[]>;
  /** The Workspace's apps that have an owner Agent, with that Agent. */
  withOwners(workspaceId: string): Promise<OwnedAppRow[]>;
  /** The Agent's register cards that still wait, only the one asking for `clientKey` if given. */
  pendingCards(agentId: string, clientKey?: string): Promise<RegisterCardRow[]>;
  /** The register card `messageId` this Agent prepared. */
  card(agentId: string, messageId: string): Promise<RegisterCardRow | undefined>;
  /** Writes the new secret's hash for the Workspace's app `key`. */
  rotate(key: string, workspaceId: string, clientSecretHash: string, at: Date): Promise<boolean>;
}

/**
 * An Agent managing the apps it registered through a committed `app:register` card: where a card
 * or an app stands, the apps it may manage, and secret rotation. The app stays its Workspace's. The
 * one rule is `canManage`: the owner Agent, or an admin-role Agent of the same Workspace. It is
 * checked on every call with the Agent read afresh, so an archived Agent has no right; what the
 * Agent may not manage is NOT_FOUND, so an app is not confirmed to exist.
 */
export class AppOwnerAgents {
  constructor(
    private readonly store: AppOwnerAgentStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The Agent's waiting register cards and the apps it may manage. */
  async list(caller: OwnerAgentCaller) {
    const agent = await this.live(caller);
    const [pending, managed] = await Promise.all([
      this.store.pendingCards(agent.id),
      this.store.managed(agent, isElevatedServerRole(agent.role)),
    ]);
    return {
      pending: pending.map(({ messageId, name, clientKey }) => ({
        cardMessageId: messageId,
        name,
        clientKey,
      })),
      apps: managed
        .map((app) => ({
          clientKey: app.key,
          name: app.name,
          role: app.ownerAgentId === agent.id ? ("owner" as const) : ("admin" as const),
        }))
        .sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner")),
    };
  }

  /** Where one register card (`card`) or one app (`client`) of this Agent stands. */
  async status(caller: OwnerAgentCaller, selector: { card?: string; client?: string }) {
    const agent = await this.live(caller);
    if (selector.card) {
      const card = await this.store.card(agent.id, selector.card);
      if (!card) throw new AppError("NOT_FOUND");
      return {
        status:
          card.state === "pending"
            ? ("card_pending" as const)
            : card.state === "executed"
              ? ("committed" as const)
              : ("cancelled" as const),
        cardMessageId: card.messageId,
        ...(card.clientKey ? { clientKey: card.clientKey } : {}),
        ...(card.committedBy ? { committedBy: card.committedBy } : {}),
      };
    }
    const key = selector.client ?? "";
    const app = await this.store.find(key);
    if (app && canManage(agent, app)) return { status: "committed" as const, clientKey: key };
    const [pending] = await this.store.pendingCards(agent.id, key);
    if (!pending) throw new AppError("NOT_FOUND");
    return { status: "card_pending" as const, cardMessageId: pending.messageId, clientKey: key };
  }

  /** A new client secret for an app this Agent may manage: the old one stops verifying at once,
   * and the new one is in the answer and nowhere else. */
  async rotateSecret(caller: OwnerAgentCaller, clientKey: string) {
    const agent = await this.live(caller);
    const app = await this.store.find(clientKey);
    if (!app || !canManage(agent, app)) throw new AppError("NOT_FOUND");
    const { secret, hash } = mintAppClientSecret();
    if (!(await this.store.rotate(clientKey, agent.workspaceId, hash, this.now())))
      throw new AppError("CONFLICT");
    return { clientKey, clientSecret: secret };
  }

  /** The owner Agent each of the Workspace's apps shows in Settings: only a live public Agent is
   * named, so a private or archived one never is. */
  async ownerNames(workspaceId: string): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const { key, ownerAgent } of await this.store.withOwners(workspaceId))
      if (ownerAgent && !ownerAgent.archived && ownerAgent.visibility === AGENT_VISIBILITY.PUBLIC)
        names.set(key, ownerAgent.displayName?.trim() || ownerAgent.name);
    return names;
  }

  /** The calling Agent, if it is in the Workspace its key names and not archived. */
  private async live(caller: OwnerAgentCaller): Promise<LiveAgent> {
    const agent = await this.store.agent(caller.agentId);
    if (!agent || agent.archived || agent.workspaceId !== caller.workspaceId)
      throw new AppError("NOT_FOUND");
    return agent;
  }
}

/** The owner Agent, or an admin-role Agent, of the app's Workspace. */
function canManage(agent: LiveAgent, app: OwnerAgentApp): boolean {
  return (
    app.ownerWorkspaceId === agent.workspaceId &&
    (app.ownerAgentId === agent.id || isElevatedServerRole(agent.role))
  );
}
