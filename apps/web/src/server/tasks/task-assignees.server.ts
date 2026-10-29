import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { AppError } from "#src/lib/app-error";
import type { Transaction, Member } from "./task-board-ports.server";

/** A task status as stored; a value outside the known set is corrupt data, not user input. */
const handleName = (handle: string) => handle.replace(/^@/, "");
/** An assignee picked by id: `user:<uuid>` or `agent:<uuid>`. */
export const BOUND_ASSIGNEE = new RegExp(`^(user|agent):(${UUID_LIKE_SOURCE})$`, "i");

/**
 * Whom an assignment receipt named, from its one mention row: a retried command answers as the
 * first one did, whatever the conversation's membership or the Task's owner became since.
 */
export async function receiptAssignee(tx: Transaction, receiptId: string) {
  const mention = await tx.messageMention.findFirst({
    where: { messageId: receiptId },
    select: { memberId: true, handle: true },
  });
  return mention && { memberId: mention.memberId, handle: `@${mention.handle}` };
}

/**
 * Browser assignees bind user:<id>/agent:<id>. Bare CLI @handles resolve human-first
 * when global usernames and Workspace Agent names clash, like unbound mentions.
 */
export async function assigneeMember(
  tx: Transaction,
  conversationId: string,
  workspaceId: string,
  handle: string,
) {
  const scope = {
    conversationId,
    workspaceId,
    // A deleted Agent (or anyone who left) is not an assignable member. Without
    // this, a deleted Agent stayed a valid Task assignee and still received delivery rows.
    ...ACTIVE_MEMBER_WHERE,
  };
  const select = {
    id: true,
    userId: true,
    agentId: true,
    user: { select: { username: true } },
    agent: { select: { name: true } },
  } as const;
  const bound = BOUND_ASSIGNEE.exec(handle);
  if (bound)
    return tx.conversationMember.findFirst({
      where: {
        ...scope,
        ...(bound[1] === "user"
          ? { userId: bound[2] }
          : { agentId: bound[2], agent: ACTIVE_AGENT_WHERE }),
      },
      select,
    });
  const name = handleName(handle);
  const matches = await tx.conversationMember.findMany({
    where: {
      ...scope,
      OR: [{ user: { username: name } }, { agent: { name, ...ACTIVE_AGENT_WHERE } }],
    },
    select,
  });
  return matches.find((member) => member.userId) ?? matches[0] ?? null;
}

/**
 * Whether this member manages Tasks whatever their status: a Workspace owner or admin for a
 * person, or an Agent whose own server role is one. An Agent never inherits its owner's role.
 */
export async function isTaskManager(tx: Transaction, workspaceId: string, member: Member) {
  if (member.agentId) return member.agent?.role === "owner" || member.agent?.role === "admin";
  const membership = member.userId
    ? await tx.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: member.userId } },
        select: { role: true },
      })
    : null;
  return membership?.role === "owner" || membership?.role === "admin";
}

/** Only Workspace owners and admins may delete or record receipts on Tasks they do not hold. */
export async function requireManager(tx: Transaction, workspaceId: string, member: Member) {
  const membership = member.userId
    ? await tx.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: member.userId } },
        select: { role: true },
      })
    : null;
  if (membership?.role !== "owner" && membership?.role !== "admin")
    throw new AppError("ACCESS_DENIED");
}
