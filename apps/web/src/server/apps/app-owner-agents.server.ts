import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { AppError } from "#src/lib/app-error";
import { isElevatedServerRole } from "#src/server/workspaces/member-role.server";
import type { ManagedApp, ManagedAppRow } from "./managed-app";
import { mintAppClientSecret } from "./app-client-secret.server";

/** The Agent making the call, as its Agent API key names it. */
export type OwnerAgentCaller = { workspaceId: string; agentId: string };

export type OwnerAgentApp = ManagedAppRow;

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

/** An Agent a transfer or recovery may name: alive, public, in the Workspace. */
export type OwnerCandidate = { id: string; name: string };

export interface AppOwnerAgentStore {
  agent(
    agentId: string,
  ): Promise<(LiveAgent & { archived: boolean; workspaceSlug: string }) | undefined>;
  /** The live public Agent of the Workspace named by `handle` (its name, `@name` or its id). */
  candidate(workspaceId: string, handle: string): Promise<OwnerCandidate | undefined>;
  /** An Agent's name and whether it is archived; none once its row is gone. */
  agentNamed(agentId: string): Promise<{ name: string; archived: boolean } | undefined>;
  /** Makes `to` the owner Agent of the Workspace's app `key`, only while its owner Agent is still
   * `from`; `false` when it is not, or there is no such app. */
  setOwner(key: string, workspaceId: string, from: string | null, to: string): Promise<boolean>;
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
    const { workspaceId } = await this.manager(caller, clientKey);
    const { secret, hash } = mintAppClientSecret();
    if (!(await this.store.rotate(clientKey, workspaceId, hash, this.now())))
      throw new AppError("CONFLICT");
    return { clientKey, clientSecret: secret };
  }

  /** The one place that decides who may manage an app: the app `clientKey`, as a `ManagedApp`, once
   * `canManage` holds (the Agent is read afresh, so an archived one never is a manager); anything
   * else is NOT_FOUND. */
  async manager(caller: OwnerAgentCaller, clientKey: string): Promise<ManagedApp> {
    const agent = await this.live(caller);
    const app = await this.store.find(clientKey);
    if (!app || !canManage(agent, app)) throw new AppError("NOT_FOUND");
    return { workspaceId: agent.workspaceId, workspaceSlug: agent.workspaceSlug, app };
  }

  /** Makes another live Agent of the Workspace the app's owner Agent; the current owner (or an
   * admin Agent) may. Naming the owner Agent already there changes nothing. */
  async transferOwner(caller: OwnerAgentCaller, clientKey: string, toAgent: string) {
    const { app } = await this.manager(caller, clientKey);
    const [target, previous] = await Promise.all([
      this.store.candidate(caller.workspaceId, toAgent),
      app.ownerAgentId ? this.store.agentNamed(app.ownerAgentId) : undefined,
    ]);
    if (!target) throw new AppError("INVALID_INPUT", { errorId: "app-owner-agent-invalid" });
    const receipt = {
      clientKey,
      ownerAgent: target.name,
      previousOwnerAgent: previous?.name ?? null,
      at: this.now().toISOString(),
    };
    if (app.ownerAgentId === target.id) return { ...receipt, changed: false };
    if (!(await this.store.setOwner(clientKey, caller.workspaceId, app.ownerAgentId, target.id)))
      throw new AppError("CONFLICT");
    return { ...receipt, changed: true };
  }

  /** What an `app:recover_owner` card may name when prepared: the app, which the caller manages,
   * must have no live owner Agent (CONFLICT `app-owner-active` otherwise), and `toAgent` must be a
   * live public Agent of the Workspace. */
  async prepareRecovery(caller: OwnerAgentCaller, clientKey: string, toAgent: string) {
    const { app } = await this.manager(caller, clientKey);
    if (await this.hasLiveOwner(app))
      throw new AppError("CONFLICT", { errorId: "app-owner-active" });
    const target = await this.store.candidate(caller.workspaceId, toAgent);
    if (!target) throw new AppError("INVALID_INPUT", { errorId: "app-owner-agent-invalid" });
    return { appName: app.name, target };
  }

  /** Commits a recovery a Workspace owner or admin approved (the caller judged the person): makes
   * the Agent `toAgentId` the owner Agent, if the app still has no live one. */
  async recover(workspaceId: string, clientKey: string, toAgentId: string) {
    const app = await this.store.find(clientKey);
    if (!app || app.ownerWorkspaceId !== workspaceId) throw new AppError("NOT_FOUND");
    if (await this.hasLiveOwner(app))
      throw new AppError("CONFLICT", { errorId: "app-owner-active" });
    const target = await this.store.candidate(workspaceId, toAgentId);
    if (!target) throw new AppError("INVALID_INPUT", { errorId: "app-owner-agent-invalid" });
    if (!(await this.store.setOwner(clientKey, workspaceId, app.ownerAgentId, target.id)))
      throw new AppError("CONFLICT");
    return { appName: app.name, ownerAgent: target.name };
  }

  private async hasLiveOwner(app: OwnerAgentApp): Promise<boolean> {
    if (!app.ownerAgentId) return false;
    const owner = await this.store.agentNamed(app.ownerAgentId);
    return owner !== undefined && !owner.archived;
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
  private async live(caller: OwnerAgentCaller): Promise<LiveAgent & { workspaceSlug: string }> {
    const agent = await this.store.agent(caller.agentId);
    if (!agent || agent.archived || agent.workspaceId !== caller.workspaceId)
      throw new AppError("NOT_FOUND");
    return agent;
  }
}

/** The owner Agent, or an admin-role Agent, of the app's Workspace. */
export function canManage(agent: LiveAgent, app: OwnerAgentApp): boolean {
  return (
    app.ownerWorkspaceId === agent.workspaceId &&
    (app.ownerAgentId === agent.id || isElevatedServerRole(agent.role))
  );
}
