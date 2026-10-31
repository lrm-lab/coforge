import { AppError } from "#src/lib/app-error";
import { compareHumanLabels } from "#src/lib/human-label";
import {
  assertCanChangeMemberRole,
  assertCanLeaveWorkspace,
  assertCanRemoveMember,
  type WorkspaceMemberRole,
} from "./member-role.server";
import {
  announceMemberChanged,
  type ConversationRealtime,
} from "#src/server/conversations/conversation-realtime.server";
import { announceConversationsRevoked } from "#src/server/conversations/channel-membership-signals.server";

import {
  createCentrifugoServerApi,
  reconnectDaemon,
} from "#src/server/centrifugo/server-api.server";
import { errorType } from "#src/server/errors/error-type.server";
import { getWorkspaceComputerInvalidation } from "#src/server/agents/workspace-computer-invalidation.server";

export type WorkspaceMemberRecord = {
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
  username: string;
  displayName: string | null;
  /** Where the browser reads this member's avatar; null when they have not uploaded one. */
  avatarUrl: string | null;
};

export type WorkspaceMemberDirectoryStore = {
  findMembership(
    workspaceId: string,
    userId: string,
  ): Promise<Pick<WorkspaceMemberRecord, "workspaceId" | "userId" | "role"> | null>;
  listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]>;
  updateRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
  ): Promise<WorkspaceMemberRecord>;
  /** Removes the person from the Workspace and leaves every conversation in it for them (their
   * rows stay, so what they wrote keeps its sender), and takes their Computers out of it (their
   * daemon keys for it revoked, their links to it removed); reports the channels they were an
   * active member of, whose member lists now changed, and the Computers whose daemons must
   * reconnect. */
  removeMember(
    workspaceId: string,
    userId: string,
  ): Promise<{
    leftChannelIds: string[];
    /** The channels and their task conversations: what the person no longer reads. */
    revokedConversationIds: string[];
    computerIds: string[];
  }>;
};

/** Who tells a departed member's Computers, after the commit, that their key is gone. */
export type WorkspaceMemberDaemons = {
  /** Each Computer's daemon connection for the Workspace reconnects at once, so the connect proxy
   * refuses it with `computer_unlinked` and it parks the binding now. */
  reconnectDaemons(workspaceId: string, computerIds: readonly string[]): Promise<void>;
};

/** Over Centrifugo, built only when there is a Computer to tell. */
const centrifugoMemberDaemons: WorkspaceMemberDaemons = {
  async reconnectDaemons(workspaceId, computerIds) {
    const api = createCentrifugoServerApi();
    await Promise.all(
      computerIds.map((computerId) => reconnectDaemon(api, workspaceId, computerId)),
    );
  },
};

/** Human Workspace membership directory: list, role changes, remove, leave. */
export class WorkspaceMemberDirectory {
  constructor(
    private readonly store: WorkspaceMemberDirectoryStore,
    private readonly realtime?: Pick<ConversationRealtime, "memberChanged" | "revokeConversations">,
    private readonly daemons: WorkspaceMemberDaemons = centrifugoMemberDaemons,
  ) {}

  async listMembers(input: { workspaceId: string; actorUserId: string }) {
    await this.requireMembership(input.workspaceId, input.actorUserId);
    const members = await this.store.listMembers(input.workspaceId);
    // By the name they are shown by; the store's order is not part of its contract.
    return [...members].sort(compareHumanLabels);
  }

  async updateRole(input: {
    workspaceId: string;
    actorUserId: string;
    targetUserId: string;
    role: string;
  }) {
    const actor = await this.requireMembership(input.workspaceId, input.actorUserId);
    const target = await this.store.findMembership(input.workspaceId, input.targetUserId);
    if (!target) throw new AppError("NOT_FOUND");
    const nextRole = assertCanChangeMemberRole(actor.role, target.role, input.role);
    return this.store.updateRole(input.workspaceId, input.targetUserId, nextRole);
  }

  async removeMember(input: { workspaceId: string; actorUserId: string; targetUserId: string }) {
    const actor = await this.requireMembership(input.workspaceId, input.actorUserId);
    const target = await this.store.findMembership(input.workspaceId, input.targetUserId);
    if (!target) throw new AppError("NOT_FOUND");
    assertCanRemoveMember(actor.role, target.role);
    await this.removeFromWorkspace(input.workspaceId, input.targetUserId);
  }

  async leave(input: { workspaceId: string; userId: string }) {
    const membership = await this.requireMembership(input.workspaceId, input.userId);
    assertCanLeaveWorkspace(membership.role);
    await this.removeFromWorkspace(input.workspaceId, input.userId);
  }

  /** Removes the person, then tells the channels they were in that their member lists changed,
   * ends their subscriptions to those channels (they read none of them now) and tells their
   * Computers' daemons to reconnect. All best effort: the removal has committed. */
  private async removeFromWorkspace(workspaceId: string, userId: string) {
    const { leftChannelIds, revokedConversationIds, computerIds } = await this.store.removeMember(
      workspaceId,
      userId,
    );
    await Promise.all([
      announceMemberChanged(this.realtime, { workspaceId, conversationIds: leftChannelIds }),
      announceConversationsRevoked(this.realtime, {
        workspaceId,
        userIds: [userId],
        conversationIds: revokedConversationIds,
      }),
      this.reconnectDaemons(workspaceId, computerIds),
      ...computerIds.map((computerId) =>
        Promise.resolve(getWorkspaceComputerInvalidation().notify(computerId)),
      ),
    ]);
  }

  private async reconnectDaemons(workspaceId: string, computerIds: readonly string[]) {
    if (computerIds.length === 0) return;
    try {
      await this.daemons.reconnectDaemons(workspaceId, computerIds);
    } catch (error) {
      // The keys are already revoked: the daemon is refused at its next reconnect instead.
      console.warn(
        JSON.stringify({
          event: "workspace_member:daemon_reconnect_failed",
          workspace_id: workspaceId,
          computer_count: computerIds.length,
          error_type: errorType(error),
        }),
      );
    }
  }

  private async requireMembership(workspaceId: string, userId: string) {
    const membership = await this.store.findMembership(workspaceId, userId);
    if (!membership) throw new AppError("ACCESS_DENIED");
    return membership;
  }
}
