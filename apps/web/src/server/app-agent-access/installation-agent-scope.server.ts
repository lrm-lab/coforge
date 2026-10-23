import {
  AGENT_ACCESS_SELECTION_MAX,
  type AgentAccessMode,
  type AgentAccessScopeView,
} from "#src/features/apps/agent-access-scope";
import { AppError } from "#src/lib/app-error";
import { roleCan } from "#src/features/workspaces/workspace-roles";
import {
  assertCanManageApps,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";
import { agentInScope } from "./access-rules.server";
import type { AgentAppAccessActor } from "./app-agent-access.server";

/** A request waiting for a person, for an app whose scope is being changed. */
export type ScopePendingRequest = { id: string; agentId: string; hasGrant: boolean };

type Scope = { installationId: string; mode: AgentAccessMode; agentIds: string[] };
type Candidate = { id: string; name: string };

export interface InstallationAgentScopeStore {
  /** The member's role; `undefined` for a non-member or a stored role that is not a known one. */
  findMemberRole(workspaceId: string, userId: string): Promise<WorkspaceMemberRole | undefined>;
  /** The Workspace's installation of the app `appKey` and its scope; the selection holds live
   * Agents only. */
  findScope(workspaceId: string, appKey: string): Promise<Scope | undefined>;
  /** The Agents an installation can select: live, and neither a system Agent nor the Workspace
   * Memory Agent. */
  listAgents(workspaceId: string): Promise<Candidate[]>;
  /** In one transaction: replaces the installation's mode and selection, then reads the app's
   * pending requests of live Agents and approves those `settle` names (as `input.userId`, with an
   * `automatic` grant). Returns the approved request ids. */
  setScope(input: {
    installationId: string;
    mode: AgentAccessMode;
    agentIds: string[];
    userId: string;
    settle: (pending: ScopePendingRequest[]) => string[];
  }): Promise<string[]>;
}

const viewOf = (scope: Scope, manager: Candidate[] | undefined): AgentAccessScopeView => ({
  mode: scope.mode,
  count: scope.mode === "selected" ? scope.agentIds.length : null,
  ...(manager && { agentIds: scope.agentIds, candidates: manager }),
});

/**
 * Which Agents may use an app installed in a Workspace (`AgentAccessMode`). Every member reads the
 * mode and how many Agents are selected; a Workspace owner or admin (`manageApps`) also reads the
 * selection and the Agents to choose from, and changes it. A change applies at once and the last
 * write wins. Switching revokes no grant; the use-time rule is `decideAgentAccess`. A change that
 * puts an Agent in scope also settles that Agent's pending request for the app (the automatic
 * grant its first use would have got), recorded as decided by the person who changed the scope.
 */
export class InstallationAgentScope {
  constructor(
    private readonly store: InstallationAgentScopeStore,
    /** Told once a request is settled, so browsers refresh its approval card. Best effort. */
    private readonly requestDecided: (
      workspaceId: string,
      requestId: string,
    ) => Promise<void> = async () => {},
  ) {}

  async view(actor: AgentAppAccessActor, appKey: string): Promise<AgentAccessScopeView> {
    const role = await this.store.findMemberRole(actor.workspaceId, actor.userId);
    if (!role) throw new AppError("ACCESS_DENIED");
    const scope = await this.store.findScope(actor.workspaceId, appKey);
    if (!scope) throw new AppError("NOT_FOUND");
    return viewOf(
      scope,
      roleCan(role, "manageApps") ? await this.store.listAgents(actor.workspaceId) : undefined,
    );
  }

  /** Sets the mode and, for `selected`, the Agents; the selection is kept, unused, under `all`.
   * An Agent that cannot be selected (not a live, non-system, non-Memory Agent of the Workspace)
   * is INVALID_INPUT. */
  async set(
    actor: AgentAppAccessActor,
    appKey: string,
    input: { mode: AgentAccessMode; agentIds: string[] },
  ): Promise<AgentAccessScopeView> {
    assertCanManageApps(await this.store.findMemberRole(actor.workspaceId, actor.userId));
    const found = await this.store.findScope(actor.workspaceId, appKey);
    if (!found) throw new AppError("NOT_FOUND");
    const candidates = await this.store.listAgents(actor.workspaceId);
    const chosen = [...new Set(input.agentIds)];
    if (
      chosen.length > AGENT_ACCESS_SELECTION_MAX ||
      chosen.some((id) => !candidates.some((candidate) => candidate.id === id))
    )
      throw new AppError("INVALID_INPUT");
    const scope: Scope = {
      installationId: found.installationId,
      mode: input.mode,
      agentIds: input.mode === "selected" ? chosen : found.agentIds,
    };
    const settled = await this.store.setScope({
      ...scope,
      userId: actor.userId,
      settle: (pending) =>
        pending
          .filter(
            (request) =>
              !request.hasGrant &&
              agentInScope(
                { agentAccess: scope.mode, selectedAgentIds: scope.agentIds },
                request.agentId,
              ),
          )
          .map((request) => request.id),
    });
    for (const requestId of settled)
      await this.requestDecided(actor.workspaceId, requestId).catch(() => {});
    return viewOf(scope, candidates);
  }
}
