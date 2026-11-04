import { AppError } from "#src/lib/app-error";
import {
  assertHasAgentControlCapability,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";
import { assertAgentLive } from "./active-agent.server";
import { canSeeAgent } from "./agent-visibility.server";
import {
  authorizedAgent,
  EXECUTE_CAPABILITY,
  type AgentControlAction,
  type AgentControlStore,
} from "./agent-control-types.server";

/** Who may read and change an Agent through the control operations. */
export class AgentControlAccess {
  constructor(private readonly store: AgentControlStore) {}
  async authorized(userId: string, workspaceId: string, agentId: string) {
    return authorizedAgent(await this.store.get(agentId), userId, workspaceId, agentId);
  }
  /**
   * execute() and stopMany() are the user-initiated control paths; they authorize by the actor's
   * current Workspace membership and Agent-control capability, not by Agent ownership (`authorized()`
   * above, still used unchanged by recover/publishStart/publishStop).
   */
  async authorizedForExecute(
    userId: string,
    workspaceId: string,
    agentId: string,
    action: AgentControlAction,
  ) {
    const role = await this.actorRole(workspaceId, userId, action);
    return this.controllableAgent(agentId, workspaceId, userId, role);
  }
  async actorRole(workspaceId: string, userId: string, action: AgentControlAction) {
    const role = await this.store.memberRole(workspaceId, userId);
    if (!role) throw new Error("Agent is not authorized or assigned");
    assertHasAgentControlCapability(role, EXECUTE_CAPABILITY[action]);
    return role;
  }
  async controllableAgent(
    agentId: string,
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
  ) {
    const agent = await this.store.get(agentId);
    if (!agent || agent.workspaceId !== workspaceId)
      throw new Error("Agent is not authorized or assigned");
    // A deleted Agent has no user-initiated control surface at all — not even Start.
    // Only the internal `recover`/`publishStop` paths may still touch one, to reconcile a process
    // the Daemon reports as running.
    assertAgentLive(agent);
    // "any current member may control" stops at a private Agent the actor cannot see —
    // the same absent shape every other visibility failure uses, never a detail leak. Owner/admin
    // always passes (`canSeeAgent`'s elevated-role branch), matching the visibility rule's one
    // carve-out that manage authority does not itself grant DM/open access.
    if (!canSeeAgent({ kind: "user", userId, role }, agent)) throw new AppError("NOT_FOUND");
    return agent;
  }
}
